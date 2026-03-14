import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import cors from "cors";
import multer from "multer";

// Mock Database for Preview (In production, use MySQL)
const DB_FILE = path.join(process.cwd(), "data.json");
const initDb = () => {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: [
        { id: 1, username: "admin", password: bcrypt.hashSync("admin123", 10), role: "admin" },
        { id: 2, username: "suporte@unityautomacoes.com.br", password: bcrypt.hashSync("200616", 10), role: "admin" }
      ],
      cameras: [
        { id: 1, name: "Câmera 01", rtsp_url: "rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4", is_active: true },
        { id: 2, name: "Câmera 02", rtsp_url: "rtsp://demo:demo@static.cartesian.io:554/live/ch0", is_active: true }
      ],
      videos: [],
      stream_status: { current_source_type: "none", current_source_id: null, is_streaming: false, youtube_key: "", loop_video: false }
    }, null, 2));
  }
};
initDb();

const getDb = () => JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
const saveDb = (data: any) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" }
  });

  const PORT = Number(process.env.PORT) || 3000;
  const JWT_SECRET = process.env.JWT_SECRET || "stream-control-secret-123";

  app.use(cors());
  app.use(express.json());
  app.use("/uploads", express.static(uploadsDir));

  // FFmpeg Management
  let ffmpegProcess: ChildProcess | null = null;

  const stopStream = () => {
    if (ffmpegProcess) {
      ffmpegProcess.kill("SIGKILL");
      ffmpegProcess = null;
    }
    const db = getDb();
    db.stream_status.is_streaming = false;
    db.stream_status.current_source_type = "none";
    db.stream_status.current_source_id = null;
    saveDb(db);
    io.emit("stream_status", db.stream_status);
  };

  const startStream = (type: "camera" | "video", id: number) => {
    stopStream();
    const db = getDb();
    let source = "";
    
    if (type === "camera") {
      const cam = db.cameras.find((c: any) => c.id === id);
      if (!cam) return;
      source = cam.rtsp_url;
    } else {
      const vid = db.videos.find((v: any) => v.id === id);
      if (!vid) return;
      source = path.join(process.cwd(), vid.file_path);
    }

    const youtubeKey = db.stream_status.youtube_key;
    if (!youtubeKey) return;

    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`;

    // FFmpeg Command
    const args = [];
    
    // Add loop if it's a video and loop is enabled
    if (type === "video" && db.stream_status.loop_video) {
      args.push("-stream_loop", "-1");
    }

    args.push(
      "-re",
      "-i", source,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-b:v", "3000k",
      "-maxrate", "3000k",
      "-bufsize", "6000k",
      "-pix_fmt", "yuv420p",
      "-g", "50",
      "-c:a", "aac",
      "-b:a", "128k",
      "-f", "flv",
      rtmpUrl
    );

    console.log("Iniciando FFmpeg com fonte:", source);
    ffmpegProcess = spawn("ffmpeg", args);

    ffmpegProcess.on("close", (code) => {
      console.log(`Processo FFmpeg encerrado com código ${code}`);
      stopStream();
    });

    db.stream_status.is_streaming = true;
    db.stream_status.current_source_type = type;
    db.stream_status.current_source_id = id;
    saveDb(db);
    io.emit("stream_status", db.stream_status);
  };

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Não autorizado" });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (e) {
      res.status(401).json({ error: "Token inválido" });
    }
  };

  // API Routes
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const db = getDb();
    const user = db.users.find((u: any) => u.username === username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.get("/api/cameras", authenticate, (req, res) => {
    res.json(getDb().cameras);
  });

  app.post("/api/cameras", authenticate, (req, res) => {
    const db = getDb();
    const newCam = { id: Date.now(), ...req.body };
    db.cameras.push(newCam);
    saveDb(db);
    res.json(newCam);
  });

  app.delete("/api/cameras/:id", authenticate, (req, res) => {
    const db = getDb();
    db.cameras = db.cameras.filter((c: any) => c.id !== parseInt(req.params.id));
    saveDb(db);
    res.json({ success: true });
  });

  app.get("/api/videos", authenticate, (req, res) => {
    res.json(getDb().videos);
  });

  app.post("/api/videos", authenticate, upload.single("video"), (req, res) => {
    console.log("Recebendo requisição de upload de vídeo...");
    if (!req.file) {
      console.log("Nenhum arquivo recebido na requisição.");
      return res.status(400).json({ error: "Nenhum arquivo enviado" });
    }
    console.log("Arquivo recebido:", req.file.originalname, "Salvo em:", req.file.path);
    
    const db = getDb();
    const newVideo = {
      id: Date.now(),
      title: req.file.originalname,
      file_path: `uploads/${req.file.filename}`,
      created_at: new Date()
    };
    db.videos.push(newVideo);
    saveDb(db);
    console.log("Vídeo salvo no banco de dados:", newVideo.id);
    res.json(newVideo);
  });

  app.delete("/api/videos/:id", authenticate, (req, res) => {
    const db = getDb();
    const video = db.videos.find((v: any) => v.id === parseInt(req.params.id));
    if (video) {
      const fullPath = path.join(process.cwd(), video.file_path);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      db.videos = db.videos.filter((v: any) => v.id !== video.id);
      saveDb(db);
    }
    res.json({ success: true });
  });

  app.get("/api/status", authenticate, (req, res) => {
    res.json(getDb().stream_status);
  });

  app.post("/api/status/key", authenticate, (req, res) => {
    const db = getDb();
    db.stream_status.youtube_key = req.body.key;
    saveDb(db);
    res.json({ success: true });
  });

  app.post("/api/status/loop", authenticate, (req, res) => {
    const { loop } = req.body;
    const db = getDb();
    db.stream_status.loop_video = loop;
    saveDb(db);
    
    // Se estiver transmitindo um vídeo, reinicia para aplicar o loop
    if (db.stream_status.is_streaming && db.stream_status.current_source_type === "video") {
      startStream("video", db.stream_status.current_source_id!);
    }
    
    io.emit("stream_status", db.stream_status);
    res.json({ success: true });
  });

  app.post("/api/stream/switch", authenticate, (req, res) => {
    const { type, id } = req.body;
    startStream(type, id);
    res.json({ success: true });
  });

  app.post("/api/stream/stop", authenticate, (req, res) => {
    stopStream();
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Erro não tratado no servidor:", err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ error: "Erro interno no servidor", details: err.message });
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

startServer();
