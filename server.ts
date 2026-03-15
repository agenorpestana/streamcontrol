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

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingTimeout: 120000, // 2 minutes tolerance
    pingInterval: 30000, // 30 seconds heartbeat
    maxHttpBufferSize: 1e8, // 100MB
    connectTimeout: 45000
  });

  // Server-side connection error logging
  io.on("connection_error", (err) => {
    console.error("Erro de conexão Socket.io no servidor:", err.message);
    console.error("Contexto do erro:", err.context);
  });

  io.on("connection", (socket) => {
    console.log("Cliente conectado:", socket.id, "Transporte:", socket.conn.transport.name);
    socket.emit("stream_status", getDb().stream_status);
    
    // Enviar logs existentes para o novo cliente
    ffmpegLogs.forEach(log => socket.emit("ffmpeg_log", log));

    socket.on("web_data", (data) => {
      if (ffmpegProcess && getDb().stream_status.current_source_type === "web") {
        if (ffmpegProcess.stdin && ffmpegProcess.stdin.writable) {
          try {
            // Socket.io handles binary data automatically
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            
            // Log only every 100th chunk to avoid flooding but keep visible
            if (Math.random() < 0.01) {
              const msg = `[SERVER] Recebido chunk web_data: ${buffer.length} bytes`;
              console.log(msg);
              addLog(`${msg}\n`);
            }
            ffmpegProcess.stdin.write(buffer);
          } catch (e) {
            console.error("Erro ao escrever no stdin do FFmpeg:", e);
            addLog(`ERRO STDIN: ${e}\n`);
          }
        }
      }
    });

    socket.on("web_ready_to_start", () => {
      // Handshake is now handled globally in startStream to ensure FFmpeg is alive
    });

    socket.on("disconnect", () => {
      console.log("Cliente desconectado:", socket.id);
    });
  });

  const PORT = Number(process.env.PORT) || 3000;
  const JWT_SECRET = process.env.JWT_SECRET || "stream-control-secret-123";

  app.use(cors());
  app.use(express.json());
  app.use("/uploads", express.static(uploadsDir));

  // FFmpeg Management
  let ffmpegProcess: ChildProcess | null = null;
  let ffmpegLogs: string[] = [];

  const addLog = (data: string) => {
    ffmpegLogs.push(data);
    if (ffmpegLogs.length > 100) ffmpegLogs.shift();
    io.emit("ffmpeg_log", data);
  };

  const stopStream = (isSwitching = false) => {
    console.log(`[SERVER] stopStream chamado (isSwitching=${isSwitching})`);
    if (ffmpegProcess) {
      ffmpegProcess.removeAllListeners("close");
      ffmpegProcess.kill("SIGKILL");
      ffmpegProcess = null;
    }
    ffmpegLogs = [];
    if (!isSwitching) {
      const db = getDb();
      db.stream_status.is_streaming = false;
      db.stream_status.current_source_type = "none";
      db.stream_status.current_source_id = null;
      saveDb(db);
      io.emit("stream_status", db.stream_status);
    }
  };

  const startStream = (type: "camera" | "video" | "web", id: number | string) => {
    const msg = `[SERVER] startStream chamado: type=${type}, id=${id}`;
    console.log(msg);
    
    stopStream(true);
    
    // Limpar logs antigos no servidor e avisar clientes
    ffmpegLogs = [];
    io.emit("ffmpeg_log_clear");
    
    setTimeout(() => {
      addLog(`${msg}\n`);
    }, 100);

    const db = getDb();
    const youtubeKey = db.stream_status.youtube_key;
    if (!youtubeKey) {
      addLog("ERRO: Chave do YouTube não configurada nas configurações.\n");
      return;
    }

    let inputArgs: string[] = [];
    let mappingArgs: string[] = [];
    
    if (type === "camera") {
      const cam = db.cameras.find((c: any) => c.id === id);
      if (!cam) return;
      // Input 0: RTSP Camera
      // Input 1: Silent Audio (Fallback for YouTube)
      inputArgs = [
        "-rtsp_transport", "tcp", 
        "-analyzeduration", "10M", 
        "-probesize", "10M", 
        "-i", cam.rtsp_url,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"
      ];
      // Map video from camera and audio from silence
      mappingArgs = ["-map", "0:v:0", "-map", "1:a:0"];
    } else if (type === "video") {
      const vid = db.videos.find((v: any) => v.id === id);
      if (!vid) return;
      const videoPath = path.join(process.cwd(), vid.file_path);
      
      if (db.stream_status.loop_video) {
        inputArgs = ["-stream_loop", "-1"];
      }
      inputArgs.push("-re", "-fflags", "+genpts", "-i", videoPath);
      // Map everything from the video file
      mappingArgs = ["-map", "0:v:0", "-map", "0:a:0?"]; // ? makes audio optional
    } else if (type === "web") {
      // Input 0: Browser Stream (WebM)
      inputArgs = [
        "-fflags", "+nobuffer+genpts+igndts",
        "-f", "webm",
        "-i", "pipe:0",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"
      ];
      // Map video from browser (input 0) and audio from silence (input 1)
      mappingArgs = ["-map", "0:v:0", "-map", "1:a:0"];
    }

    // RTMP is generally more compatible for direct pipe streaming
    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`;

    // FFmpeg Command: Inputs first, then Encoding, then Mapping, then Output
    // Optimized for YouTube: Constant GOP (2s), High Profile, CBR-like bitrate
    const args = [
      ...inputArgs,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-level", "4.1",
      "-pix_fmt", "yuv420p",
      "-r", "25",
      "-g", "50",
      "-keyint_min", "50",
      "-sc_threshold", "0", 
      "-b:v", "2500k",
      "-maxrate", "2500k",
      "-bufsize", "5000k",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      ...mappingArgs,
      "-f", "flv",
      "-flvflags", "no_duration_filesize",
      "-max_muxing_queue_size", "1024",
      "-threads", "0",
      rtmpUrl
    ];

    console.log("Iniciando FFmpeg:", args.join(" "));
    addLog(`Comando: ffmpeg ${args.join(" ")}\n`);

    try {
      ffmpegProcess = spawn("ffmpeg", args);
      console.log("Processo FFmpeg iniciado com PID:", ffmpegProcess.pid);
      addLog(`[SERVER] Processo FFmpeg iniciado com PID: ${ffmpegProcess.pid}\n`);
    } catch (e: any) {
      console.error("Erro ao iniciar FFmpeg:", e);
      addLog(`ERRO AO INICIAR FFMPEG: ${e.message}\n`);
      return;
    }

    ffmpegProcess.on("error", (err) => {
      console.error("Erro no processo FFmpeg:", err);
      addLog(`ERRO NO PROCESSO FFMPEG: ${err.message}\n`);
    });

    if (type === "web") {
      const msgWeb = "[SERVER] Modo WEB detectado. Aguardando 2s para sinalizar prontidão do pipe...";
      console.log(msgWeb);
      addLog(`${msgWeb}\n`);
      
      // Give FFmpeg a moment to initialize the pipe before telling the client to send data
      setTimeout(() => {
        const msgReady = "[SERVER] Sinalizando server_ready_for_web para o cliente.";
        console.log(msgReady);
        addLog(`${msgReady}\n`);
        io.emit("server_ready_for_web");
      }, 2000);
    }

    ffmpegProcess.on("close", (code) => {
      console.log(`Processo FFmpeg encerrado com código ${code}`);
      addLog(`FFmpeg encerrado com código ${code}\n`);
      if (ffmpegProcess) {
        stopStream();
      }
    });

    ffmpegProcess.stderr?.on("data", (data) => {
      const log = data.toString();
      addLog(log);
      // console.log(`FFmpeg: ${log}`);
    });

    db.stream_status.is_streaming = true;
    db.stream_status.current_source_type = type;
    db.stream_status.current_source_id = id as any;
    saveDb(db);
    io.emit("stream_status", db.stream_status);
  };

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.split(" ")[1] || req.query.token;
    if (!token) return res.status(401).json({ error: "Não autorizado" });
    try {
      const decoded = jwt.verify(token as string, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (e) {
      res.status(401).json({ error: "Token inválido" });
    }
  };

  // Binary data endpoint for Web Local streaming
  app.post("/api/stream/web-data", authenticate, express.raw({ type: 'application/octet-stream', limit: '10mb' }), (req, res) => {
    if (ffmpegProcess && getDb().stream_status.current_source_type === "web") {
      if (ffmpegProcess.stdin && ffmpegProcess.stdin.writable) {
        try {
          const buffer = req.body;
          if (buffer && buffer.length > 0) {
            ffmpegProcess.stdin.write(buffer);
            res.status(200).send("OK");
            return;
          }
        } catch (e) {
          console.error("Erro ao escrever no stdin via POST:", e);
        }
      }
    }
    res.status(400).send("FFmpeg not ready or wrong source");
  });

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

  app.get("/api/cameras/:id/snapshot", authenticate, (req, res) => {
    const db = getDb();
    const cam = db.cameras.find((c: any) => c.id === parseInt(req.params.id));
    if (!cam) return res.status(404).json({ error: "Câmera não encontrada" });

    const args = [
      "-rtsp_transport", "tcp",
      "-i", cam.rtsp_url,
      "-frames:v", "1",
      "-an", // Disable audio for faster snapshot
      "-f", "image2",
      "-vcodec", "mjpeg",
      "pipe:1"
    ];

    const ffmpeg = spawn("ffmpeg", args);
    
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      if (!res.headersSent) res.status(504).end();
    }, 8000);

    // Log snapshot errors to the main log buffer for debugging
    ffmpeg.stderr.on("data", (data) => {
      const log = data.toString();
      if (log.includes("Error") || log.includes("failed")) {
        addLog(`[Snapshot Cam ${cam.id}] ${log}`);
      }
    });

    ffmpeg.on("close", () => clearTimeout(timeout));

    res.setHeader("Content-Type", "image/jpeg");
    ffmpeg.stdout.pipe(res);
    
    ffmpeg.on("error", () => {
      clearTimeout(timeout);
      if (!res.headersSent) res.status(500).end();
    });
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

  app.get("/api/status/logs", authenticate, (req, res) => {
    res.json({ logs: ffmpegLogs });
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
