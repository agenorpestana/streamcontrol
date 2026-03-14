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
        { id: 1, name: "Camera 01", rtsp_url: "rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4", is_active: true },
        { id: 2, name: "Camera 02", rtsp_url: "rtsp://demo:demo@static.cartesian.io:554/live/ch0", is_active: true }
      ],
      videos: [],
      stream_status: { current_source_type: "none", current_source_id: null, is_streaming: false, youtube_key: "" }
    }, null, 2));
  }
};
initDb();

const getDb = () => JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
const saveDb = (data: any) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" }
  });

  const PORT = 3000;
  const JWT_SECRET = process.env.JWT_SECRET || "stream-control-secret-123";

  app.use(cors());
  app.use(express.json());
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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
      source = vid.file_path;
    }

    const youtubeKey = db.stream_status.youtube_key;
    if (!youtubeKey) return;

    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`;

    // FFmpeg Command
    // Note: In a real VPS, this would send to Nginx RTMP first or directly to YT
    const args = [
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
    ];

    console.log("Starting FFmpeg with source:", source);
    ffmpegProcess = spawn("ffmpeg", args);

    ffmpegProcess.stderr?.on("data", (data) => {
      // console.log(`FFmpeg: ${data}`);
    });

    ffmpegProcess.on("close", (code) => {
      console.log(`FFmpeg process exited with code ${code}`);
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
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  // API Routes
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const db = getDb();
    const user = db.users.find((u: any) => u.username === username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Invalid credentials" });
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

  app.get("/api/status", authenticate, (req, res) => {
    res.json(getDb().stream_status);
  });

  app.post("/api/status/key", authenticate, (req, res) => {
    const db = getDb();
    db.stream_status.youtube_key = req.body.key;
    saveDb(db);
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

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
