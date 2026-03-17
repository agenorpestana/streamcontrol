import React, { useState, useEffect, useRef } from 'react';
import { Camera, Video, Play, Square, Settings, Plus, Trash2, LogOut, Activity, Monitor, Upload, Repeat, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { io } from 'socket.io-client';

// Types
interface CameraData {
  id: number;
  name: string;
  rtsp_url: string;
  is_active: boolean;
}

interface VideoData {
  id: number;
  title: string;
  file_path: string;
  created_at: string;
}

interface StreamStatus {
  current_source_type: 'camera' | 'video' | 'web' | 'none';
  current_source_id: number | string | null;
  is_streaming: boolean;
  youtube_key: string;
  loop_video: boolean;
}

const CameraPreview = ({ camId, className }: { camId: number, className?: string }) => {
  const token = localStorage.getItem('token');
  const getSnapshotUrl = () => `/api/cameras/${camId}/snapshot?token=${token}&t=${Date.now()}`;
  const [src, setSrc] = useState(getSnapshotUrl());
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Update src immediately when camId changes
    setSrc(getSnapshotUrl());
    setLoading(true);
    setError(false);

    const interval = setInterval(() => {
      setSrc(getSnapshotUrl());
    }, 1000); 
    return () => clearInterval(interval);
  }, [camId, token]);

  const refresh = () => {
    setLoading(true);
    setError(false);
    setSrc(getSnapshotUrl());
  };

  return (
    <div className={`relative bg-black/40 overflow-hidden ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
          <Activity className="w-4 h-4 text-emerald-500 animate-pulse" />
        </div>
      )}
      
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
          <p className="text-red-400 text-[10px] font-bold uppercase mb-2">Erro de Conexão</p>
          <button 
            onClick={refresh}
            className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors"
          >
            <RefreshCw className="w-4 h-4 text-white" />
          </button>
        </div>
      ) : (
        <img 
          src={src} 
          alt="Preview"
          className="w-full h-full object-cover"
          onLoad={() => setLoading(false)}
          onError={() => {
            setError(true);
            setLoading(false);
          }}
        />
      )}
    </div>
  );
};

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('token'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [cameras, setCameras] = useState<CameraData[]>([]);
  const [videos, setVideos] = useState<VideoData[]>([]);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'cameras' | 'videos' | 'settings'>('dashboard');
  const [newCam, setNewCam] = useState({ name: '', rtsp_url: '' });
  const [ytKey, setYtKey] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [ffmpegLogs, setFfmpegLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<any>(null);

  // Local Transmission State
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isLocalStreaming, setIsLocalStreaming] = useState(false);
  const isLocalStreamingRef = useRef(false);
  
  const updateLocalStreaming = (val: boolean) => {
    setIsLocalStreaming(val);
    isLocalStreamingRef.current = val;
  };

  const errorCountRef = useRef(0);

  const processChunkQueue = async () => {
    if (isSendingChunkRef.current || chunkQueueRef.current.length === 0 || !isLocalStreamingRef.current) return;
    
    isSendingChunkRef.current = true;
    const buffer = chunkQueueRef.current[0]; // Peek first chunk

    // If socket is connected, prefer socket for lower overhead
    if (socketRef.current && socketRef.current.connected) {
      try {
        socketRef.current.emit('web_data', buffer);
        chunkQueueRef.current.shift(); // Remove from queue after emit
        
        if (Math.random() < 0.1) {
          setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] Chunk enviado via Socket (Fila: ${chunkQueueRef.current.length})\n`]);
        }
        
        isSendingChunkRef.current = false;
        setTimeout(processChunkQueue, 10);
        return;
      } catch (err) {
        console.error("[CLIENTE] Erro ao emitir via socket:", err);
        // Fallback to POST below
      }
    }

    // Fallback to HTTP POST if socket is disconnected or failed
    const token = localStorage.getItem('token');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch('/api/stream/web-data', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/octet-stream',
          'Authorization': `Bearer ${token}`
        },
        body: buffer,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (res.status === 400) {
        const text = await res.text();
        if (text.includes("FFmpeg not running")) {
          console.error("[CLIENTE] Servidor informou que FFmpeg parou. Interrompendo envio local.");
          stopWebBroadcast();
          return;
        }
      }
      
      if (!res.ok) {
        const text = await res.text();
        const errorMsg = `HTTP ${res.status}: ${text}`;
        setFfmpegLogs(prev => [...prev.slice(-49), `[SISTEMA] Erro Servidor: ${errorMsg}\n`]);
        throw new Error(errorMsg);
      }
      
      chunkQueueRef.current.shift(); // Remove from queue on success
      errorCountRef.current = 0;
      
      if (Math.random() < 0.1) {
        setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] Chunk enviado via POST (Fila: ${chunkQueueRef.current.length})\n`]);
      }
      
      isSendingChunkRef.current = false;
      setTimeout(processChunkQueue, 50);
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error("[CLIENTE] Erro ao enviar chunk:", err);
      
      errorCountRef.current++;
      
      if (errorCountRef.current > 10) {
        setFfmpegLogs(prev => [...prev.slice(-49), "[SISTEMA] Falha crítica na conexão. Reiniciando broadcast...\n"]);
        errorCountRef.current = 0;
        isSendingChunkRef.current = false;
        chunkQueueRef.current = [];
        setTimeout(() => {
          if (isLocalStreamingRef.current) startWebBroadcast();
        }, 2000);
      } else {
        isSendingChunkRef.current = false;
        // If it's a timeout or network error, wait a bit before retrying the same chunk
        setTimeout(processChunkQueue, 1000);
      }
    }
  };

  const [pipPosition, setPipPosition] = useState<'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'>('bottom-right');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkQueueRef = useRef<ArrayBuffer[]>([]);
  const isSendingChunkRef = useRef(false);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (isLoggedIn) {
      fetchData();
      
      // Initialize socket with standard settings for better compatibility
      const socket = io(window.location.origin, {
        transports: ['websocket'], // Force websocket to avoid polling issues
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        setSocketConnected(true);
        const transport = socket.io.engine.transport.name;
        setFfmpegLogs(prev => [...prev.slice(-49), `[SISTEMA] Socket Conectado via ${transport.toUpperCase()}\n`]);
      });

      socket.on('disconnect', (reason) => {
        setSocketConnected(false);
        setFfmpegLogs(prev => [...prev.slice(-49), `[SISTEMA] Socket Desconectado: ${reason}\n`]);
        if (reason === 'io server disconnect') {
          // the disconnection was initiated by the server, you need to reconnect manually
          socket.connect();
        }
      });

      socket.on('connect_error', (err) => {
        setSocketConnected(false);
        console.error("Socket connection error:", err);
        setFfmpegLogs(prev => [...prev.slice(-49), `[SISTEMA] Erro de Conexão Socket: ${err.message}. Usando fallback POST.\n`]);
      });

      socket.on('stream_status', (newStatus: StreamStatus) => {
        setStatus(newStatus);
        // Use ref to avoid stale closure
        if (!newStatus.is_streaming && isLocalStreamingRef.current) {
          stopWebBroadcast();
        }
      });

      socket.on('ffmpeg_log', (log: string) => {
        setFfmpegLogs(prev => [...prev.slice(-49), log]);
      });

      socket.on('ffmpeg_log_clear', () => {
        setFfmpegLogs([]);
      });

    socket.on('server_ready_for_web', () => {
      setFfmpegLogs(prev => [...prev.slice(-49), "[CLIENTE] Recebido sinal de prontidão do servidor. Iniciando gravação...\n"]);
      // Use a small timeout to ensure state has propagated if needed, 
      // though we'll use the ref to be safe.
      setTimeout(() => startActualRecorder(), 100);
    });

      return () => {
        socket.disconnect();
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      };
    }
  }, [isLoggedIn]);

  // Sync streams to video elements
  useEffect(() => {
    if (screenVideoRef.current && screenStream) {
      screenVideoRef.current.srcObject = screenStream;
      screenVideoRef.current.play().catch(e => console.error("Erro ao dar play no vídeo da tela:", e));
    }
  }, [screenStream]);

  useEffect(() => {
    if (cameraVideoRef.current && cameraStream) {
      cameraVideoRef.current.srcObject = cameraStream;
      cameraVideoRef.current.play().catch(e => console.error("Erro ao dar play no vídeo da câmera:", e));
    }
  }, [cameraStream]);

  // Compositor Loop
  useEffect(() => {
    if ((screenStream || cameraStream) && canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d', { alpha: false });
      if (!ctx) return;

      const draw = () => {
        if (!ctx || !canvasRef.current) return;
        
        // Clear
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);

        // Draw Screen
        if (screenStream && screenVideoRef.current && screenVideoRef.current.readyState >= 2) {
          ctx.drawImage(screenVideoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
        }

        // Draw Camera PiP
        if (cameraStream && cameraVideoRef.current && cameraVideoRef.current.readyState >= 2) {
          const pipWidth = canvasRef.current.width / 4;
          const videoRatio = cameraVideoRef.current.videoHeight / cameraVideoRef.current.videoWidth || 0.75;
          const pipHeight = videoRatio * pipWidth;
          let x = 20, y = 20;

          if (pipPosition === 'top-right') x = canvasRef.current.width - pipWidth - 20;
          if (pipPosition === 'bottom-left') y = canvasRef.current.height - pipHeight - 20;
          if (pipPosition === 'bottom-right') {
            x = canvasRef.current.width - pipWidth - 20;
            y = canvasRef.current.height - pipHeight - 20;
          }

          // Shadow/Border for PiP
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, pipWidth, pipHeight);
          ctx.drawImage(cameraVideoRef.current, x, y, pipWidth, pipHeight);
        }

        animationFrameRef.current = requestAnimationFrame(draw);
      };

      draw();
    } else {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      // Clear canvas if no streams
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }, [screenStream, cameraStream, pipPosition]);

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    const headers = { Authorization: `Bearer ${token}` };

    try {
      const [camsRes, vidsRes, statusRes] = await Promise.all([
        fetch('/api/cameras', { headers }),
        fetch('/api/videos', { headers }),
        fetch('/api/status', { headers })
      ]);
      
      if (camsRes.ok) setCameras(await camsRes.json());
      if (vidsRes.ok) setVideos(await vidsRes.json());
      if (statusRes.ok) {
        const s = await statusRes.json();
        setStatus(s);
        setYtKey(s.youtube_key);

        // Watchdog: if server says it's not web anymore, but we are still streaming locally
        if (isLocalStreamingRef.current && s.current_source_type !== 'web' && !isSwitching) {
          console.warn("[CLIENTE] Servidor não está mais em modo web. Parando local...");
          stopWebBroadcast();
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        setIsLoggedIn(true);
      } else {
        alert('Falha no login');
      }
    } catch (e) {
      alert('Erro ao conectar com o servidor');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setIsLoggedIn(false);
  };

  const [isSwitching, setIsSwitching] = useState(false);

  const switchStream = async (type: 'camera' | 'video' | 'web', id: number | string) => {
    if (isSwitching) return;
    setIsSwitching(true);
    const token = localStorage.getItem('token');
    setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] Solicitando troca de stream para: ${type} (${id})...\n`]);
    
    // Optimistic update to show immediate response
    if (status) {
      setStatus({ ...status, is_streaming: true, current_source_type: type, current_source_id: id });
    }

    try {
      const response = await fetch('/api/stream/switch', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ type, id })
      });
      if (!response.ok) {
        throw new Error(`Erro na API: ${response.statusText}`);
      }
      setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] API respondeu com sucesso.\n`]);
    } catch (error: any) {
      setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] ERRO NA TROCA DE STREAM: ${error.message}\n`]);
    } finally {
      // Pequeno delay para o servidor salvar o DB antes de buscarmos
      setTimeout(() => {
        fetchData();
        setIsSwitching(false);
      }, 1000);
    }
  };

  const stopStream = async () => {
    const token = localStorage.getItem('token');
    
    // Optimistic
    if (status) {
      setStatus({ ...status, is_streaming: false, current_source_type: 'none', current_source_id: null });
    }

    if (isLocalStreaming) {
      stopWebBroadcast();
    }

    await fetch('/api/stream/stop', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchData();
  };

  // Local Source Handlers
  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setScreenStream(stream);
      stream.getVideoTracks()[0].onended = () => setScreenStream(null);
    } catch (e) {
      console.error("Erro ao compartilhar tela:", e);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setCameraStream(stream);
    } catch (e) {
      console.warn("Erro ao acessar câmera com áudio, tentando apenas vídeo:", e);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        setCameraStream(stream);
      } catch (e2) {
        console.error("Erro ao acessar câmera:", e2);
      }
    }
  };

  const stopLocalSources = () => {
    screenStream?.getTracks().forEach(t => t.stop());
    cameraStream?.getTracks().forEach(t => t.stop());
    setScreenStream(null);
    setCameraStream(null);
  };

  const startWebBroadcast = async () => {
    if (!canvasRef.current) return;
    
    // Resume AudioContext on user gesture
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();

    updateLocalStreaming(true);
    await switchStream('web', 'local');
  };

  const startActualRecorder = () => {
    setFfmpegLogs(prev => [...prev.slice(-49), "[CLIENTE] Executando startActualRecorder...\n"]);
    
    // Reset queue
    chunkQueueRef.current = [];
    isSendingChunkRef.current = false;

    // Stop any existing recorder first
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.error("Erro ao parar recorder anterior:", e);
      }
    }

    if (!canvasRef.current || !isLocalStreamingRef.current) {
      setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] ABORTADO: canvas=${!!canvasRef.current}, isLocalStreaming=${isLocalStreamingRef.current}\n`]);
      return;
    }

    // Small extra delay to ensure FFmpeg pipe is fully open
    setTimeout(() => {
      if (!canvasRef.current || !isLocalStreamingRef.current) {
        setFfmpegLogs(prev => [...prev.slice(-49), "[CLIENTE] ABORTADO no timeout (streaming parado).\n"]);
        return;
      }
      
      setFfmpegLogs(prev => [...prev.slice(-49), "[CLIENTE] Capturando stream do canvas...\n"]);
      const stream = canvasRef.current.captureStream(25);
      // Add audio if available, otherwise create a silent track
      const audioTrack = screenStream?.getAudioTracks()[0] || cameraStream?.getAudioTracks()[0];
      
      if (audioTrack) {
        stream.addTrack(audioTrack);
      } else {
        // Create silent audio track if none exists
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const dst = ctx.createMediaStreamDestination();
        oscillator.connect(gain);
        gain.connect(dst);
        oscillator.start();
        const silentTrack = dst.stream.getAudioTracks()[0];
        stream.addTrack(silentTrack);
      }

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
        ? 'video/webm;codecs=h264,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') 
          ? 'video/webm;codecs=vp8,opus' 
          : 'video/webm';
        
      setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] Usando mimeType: ${mimeType}\n`]);
      setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] Bitrate: 2500kbps (Recomendado pelo YouTube)\n`]);

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2500000, // Increased to match YouTube recommendation
        audioBitsPerSecond: 128000
      });

      recorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && isLocalStreamingRef.current) {
          try {
            const buffer = await event.data.arrayBuffer();
            chunkQueueRef.current.push(buffer);
            processChunkQueue();
            
            if (Math.random() < 0.1) {
              setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] Chunk enfileirado: ${event.data.size} bytes (Fila: ${chunkQueueRef.current.length})\n`]);
            }
          } catch (err: any) {
            console.error("[CLIENTE] Erro ao processar chunk:", err);
          }
        }
      };

      recorder.onstart = () => {
        setFfmpegLogs(prev => [...prev.slice(-49), "[CLIENTE] MediaRecorder iniciado com sucesso.\n"]);
      };

      recorder.onerror = (e) => {
        setFfmpegLogs(prev => [...prev.slice(-49), `[CLIENTE] ERRO NO MediaRecorder: ${e}\n`]);
      };

      recorder.start(4000); // 4 second chunks for better stability
      mediaRecorderRef.current = recorder;
    }, 500);
  };

  const stopWebBroadcast = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    updateLocalStreaming(false);
    chunkQueueRef.current = [];
    isSendingChunkRef.current = false;
    errorCountRef.current = 0;
  };

  const addCamera = async () => {
    const token = localStorage.getItem('token');
    await fetch('/api/cameras', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}` 
      },
      body: JSON.stringify(newCam)
    });
    setNewCam({ name: '', rtsp_url: '' });
    fetchData();
  };

  const deleteCamera = async (id: number) => {
    const token = localStorage.getItem('token');
    await fetch(`/api/cameras/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchData();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    console.log("Arquivo selecionado:", file?.name);
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('video', file);

    const token = localStorage.getItem('token');
    console.log("Iniciando upload para /api/videos...");
    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      console.log("Resposta do servidor:", res.status);
      if (res.ok) {
        console.log("Upload concluído com sucesso!");
        fetchData();
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error("Erro no upload:", errorData);
        alert('Erro ao enviar vídeo: ' + (errorData.error || res.statusText));
      }
    } catch (e) {
      console.error('Erro na conexão durante upload:', e);
      alert('Erro na conexão ao enviar vídeo');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteVideo = async (id: number) => {
    const token = localStorage.getItem('token');
    await fetch(`/api/videos/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchData();
  };

  const saveYtKey = async () => {
    const token = localStorage.getItem('token');
    await fetch('/api/status/key', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}` 
      },
      body: JSON.stringify({ key: ytKey })
    });
    alert('Chave do YouTube Salva');
  };

  const toggleLoop = async () => {
    const token = localStorage.getItem('token');
    const newLoop = !status?.loop_video;
    
    // Optimistic update
    if (status) {
      setStatus({ ...status, loop_video: newLoop });
    }

    try {
      await fetch('/api/status/loop', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ loop: newLoop })
      });
    } catch (e) {
      console.error("Erro ao alternar loop:", e);
      // Revert on error
      fetchData();
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4 font-sans text-white">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-[#151619] p-8 rounded-2xl border border-white/10 shadow-2xl"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-emerald-500/20">
              <Activity className="text-white w-8 h-8" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">StreamControl</h1>
            <p className="text-white/50 text-sm mt-2 font-mono uppercase tracking-widest">Sistema de Gerenciamento de Transmissão</p>
          </div>
          
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Usuário</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="admin"
              />
            </div>
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Senha</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="••••••••"
              />
            </div>
            <button 
              type="submit"
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 active:scale-[0.98]"
            >
              Acessar Painel
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col lg:flex-row font-sans">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 bg-[#151619] border-b lg:border-r border-white/10 flex flex-col">
        <div className="p-6 flex items-center gap-3">
          <Activity className="text-emerald-500 w-6 h-6" />
          <span className="text-xl font-bold tracking-tight">StreamControl</span>
        </div>
        
        <nav className="flex-1 px-4 py-4 space-y-2">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'dashboard' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-white/60 hover:bg-white/5'}`}
          >
            <Monitor size={20} />
            <span className="font-medium">Painel</span>
          </button>
          <button 
            onClick={() => setActiveTab('cameras')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'cameras' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-white/60 hover:bg-white/5'}`}
          >
            <Camera size={20} />
            <span className="font-medium">Câmeras</span>
          </button>
          <button 
            onClick={() => setActiveTab('videos')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'videos' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-white/60 hover:bg-white/5'}`}
          >
            <Video size={20} />
            <span className="font-medium">Vídeos</span>
          </button>
          <button 
            onClick={() => setActiveTab('local')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'local' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-white/60 hover:bg-white/5'}`}
          >
            <Monitor size={20} />
            <span className="font-medium">Transmissão Local</span>
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'settings' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-white/60 hover:bg-white/5'}`}
          >
            <Settings size={20} />
            <span className="font-medium">Configurações</span>
          </button>
        </nav>

        <div className="p-4 border-t border-white/10">
          <button 
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-red-400 hover:bg-red-400/10 transition-all"
          >
            <LogOut size={20} />
            <span className="font-medium">Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-6 lg:p-10">
        {/* Hidden elements for capture and composition - persistent across tabs */}
        <div className="fixed opacity-0 pointer-events-none w-0 h-0 overflow-hidden">
          <canvas 
            ref={canvasRef} 
            width={1280} 
            height={720} 
          />
          <video ref={screenVideoRef} autoPlay muted playsInline />
          <video ref={cameraVideoRef} autoPlay muted playsInline />
        </div>

        <header className="mb-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold capitalize">{activeTab === 'dashboard' ? 'Painel de Controle' : activeTab === 'cameras' ? 'Câmeras' : activeTab === 'videos' ? 'Vídeos Comerciais' : 'Configurações'}</h2>
            <p className="text-white/40 mt-1">Gerencie sua infraestrutura de transmissão ao vivo</p>
          </div>
          
          <div className="flex items-center gap-4 bg-[#151619] p-2 rounded-2xl border border-white/10">
            <div className={`w-3 h-3 rounded-full ${status?.is_streaming ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`} />
            <span className="text-sm font-mono uppercase tracking-wider">
              {status?.is_streaming ? 'Ao Vivo' : 'Em Espera'}
            </span>
            {status?.is_streaming && (
              <button 
                onClick={stopStream}
                className="bg-red-500/20 hover:bg-red-500/30 text-red-400 px-4 py-1.5 rounded-lg text-xs font-bold transition-all"
              >
                PARAR
              </button>
            )}
          </div>
        </header>

        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="grid grid-cols-1 xl:grid-cols-3 gap-8"
            >
              {/* Live Preview / Program */}
              <div className="xl:col-span-2 space-y-6">
                <div className="bg-[#151619] rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
                    <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20">
                      <span className="text-xs font-mono uppercase tracking-widest text-white/40">Saída do Programa</span>
                      <div className="flex items-center gap-3">
                        {status?.is_streaming && status.current_source_type === 'video' && isLocalStreaming && (
                          <button 
                            onClick={() => switchStream('web', 'local')}
                            className="bg-blue-500 hover:bg-blue-600 text-white text-[10px] font-bold px-3 py-1 rounded uppercase tracking-tight transition-all flex items-center gap-1"
                          >
                            <Monitor size={12} />
                            Voltar para Local
                          </button>
                        )}
                        {status?.is_streaming && (
                          <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter">No Ar</span>
                        )}
                      </div>
                    </div>
                  <div className="aspect-video bg-black flex items-center justify-center relative">
                    {status?.is_streaming ? (
                      <div className="w-full h-full relative">
                        {status.current_source_type === 'video' ? (
                          <video 
                            key={status.current_source_id}
                            src={`/${videos.find(v => v.id === status.current_source_id)?.file_path}`}
                            autoPlay
                            muted
                            loop={status.loop_video}
                            className="w-full h-full object-contain"
                          />
                        ) : status.current_source_type === 'web' ? (
                          <div className="w-full h-full flex flex-col items-center justify-center">
                            <div className="w-full h-full max-h-[90%] relative">
                               <canvas 
                                 id="dashboard-preview-canvas"
                                 className="w-full h-full object-contain"
                                 ref={(el) => {
                                   if (el && canvasRef.current) {
                                     const ctx = el.getContext('2d');
                                     const sourceCanvas = canvasRef.current;
                                     let active = true;
                                     const render = () => {
                                       if (!active) return;
                                       if (ctx && sourceCanvas) {
                                         ctx.drawImage(sourceCanvas, 0, 0, el.width, el.height);
                                         requestAnimationFrame(render);
                                       }
                                     };
                                     render();
                                     // This is still a bit hacky but better with the 'active' flag if we could clean it up.
                                     // In React, it's better to use a dedicated component for this.
                                   }
                                 }}
                                 width={1280}
                                 height={720}
                               />
                            </div>
                            <p className="font-mono text-[10px] text-white/40 mt-2 uppercase tracking-widest">Transmissão Local Ativa</p>
                          </div>
                        ) : status.current_source_type === 'camera' ? (
                          <div className="w-full h-full relative">
                            <CameraPreview camId={status.current_source_id as number} className="w-full h-full object-contain" />
                            <div className="absolute inset-0 bg-black/20 pointer-events-none" />
                            <div className="absolute bottom-4 left-4 flex items-center gap-2">
                              <Activity className="w-4 h-4 text-emerald-500 animate-pulse" />
                              <span className="text-[10px] font-mono text-white/60 uppercase tracking-widest">
                                Streaming: Câmera #{status.current_source_id}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full">
                            <Activity className="w-12 h-12 text-emerald-500 mx-auto mb-4 animate-pulse" />
                            <p className="font-mono text-sm text-white/60">Fonte Atual: Câmera #{status.current_source_id}</p>
                          </div>
                        )}
                        <div className="absolute top-4 right-4 flex gap-2">
                          {status.current_source_type === 'video' && isLocalStreaming && (
                            <button 
                              onClick={() => switchStream('web', 'local')}
                              className="bg-blue-500 hover:bg-blue-600 text-white text-[10px] font-bold px-3 py-1 rounded uppercase tracking-tight shadow-lg flex items-center gap-1"
                            >
                              <Square size={10} /> Parar Comercial
                            </button>
                          )}
                          <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter">No Ar</span>
                          {status.loop_video && status.current_source_type === 'video' && (
                            <span className="bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter flex items-center gap-1">
                              <Repeat size={10} /> Loop
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center p-10">
                        <Monitor className="w-16 h-16 text-white/10 mx-auto mb-4" />
                        <p className="text-white/30 font-medium">Nenhuma transmissão ativa</p>
                        <p className="text-white/10 text-xs mt-2">Selecione uma câmera ou vídeo abaixo para iniciar</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {cameras.map(cam => (
                    <div key={cam.id} className={`bg-[#151619] rounded-2xl border transition-all overflow-hidden group ${status?.current_source_id === cam.id && status.current_source_type === 'camera' ? 'border-emerald-500 shadow-lg shadow-emerald-500/10' : 'border-white/10 hover:border-white/20'}`}>
                      <div className="aspect-video bg-black/40 relative">
                        <CameraPreview camId={cam.id} className="w-full h-full opacity-40 group-hover:opacity-60 transition-opacity" />
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/60">
                          <button 
                            onClick={() => switchStream('camera', cam.id)}
                            className="bg-emerald-500 text-white p-4 rounded-full shadow-xl transform scale-90 group-hover:scale-100 transition-transform"
                          >
                            <Play fill="currentColor" size={24} />
                          </button>
                        </div>
                        <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md px-3 py-1 rounded-lg text-[10px] font-mono uppercase tracking-wider">
                          CAM {cam.id}
                        </div>
                      </div>
                      <div className="p-4 flex items-center justify-between">
                        <div>
                          <h4 className="font-bold">{cam.name}</h4>
                          <p className="text-xs text-white/40 font-mono truncate max-w-[150px]">{cam.rtsp_url}</p>
                        </div>
                        {status?.current_source_id === cam.id && status.current_source_type === 'camera' && (
                          <div className="flex items-center gap-2 text-emerald-500">
                            <Activity size={16} className="animate-pulse" />
                            <span className="text-[10px] font-bold uppercase tracking-widest">Ativo</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sidebar Info */}
              <div className="space-y-6">
                <div className="bg-[#151619] rounded-3xl border border-white/10 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold flex items-center gap-2">
                      <Activity size={18} className="text-emerald-500" />
                      Status do Sistema
                    </h3>
                    <button 
                      onClick={() => setShowLogs(!showLogs)}
                      className="text-[10px] font-bold text-emerald-500 hover:underline uppercase tracking-widest"
                    >
                      {showLogs ? 'Ocultar Logs' : 'Ver Logs FFmpeg'}
                    </button>
                  </div>
                  
                  {showLogs ? (
                    <div className="bg-black/40 rounded-xl p-3 font-mono text-[10px] h-64 overflow-y-auto space-y-1 border border-white/5">
                      {ffmpegLogs.length === 0 ? (
                        <p className="text-white/20">Aguardando logs...</p>
                      ) : (
                        ffmpegLogs.map((log, i) => (
                          <p key={i} className="text-white/60 break-all">{log}</p>
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex justify-between items-center p-3 bg-black/20 rounded-xl">
                        <span className="text-sm text-white/40">Uso de CPU</span>
                        <span className="text-sm font-mono">12%</span>
                      </div>
                      <div className="flex justify-between items-center p-3 bg-black/20 rounded-xl">
                        <span className="text-sm text-white/40">Memória</span>
                        <span className="text-sm font-mono">450MB</span>
                      </div>
                      <div className="flex justify-between items-center p-3 bg-black/20 rounded-xl">
                        <span className="text-sm text-white/40">FFmpeg</span>
                        <span className={`text-sm font-mono ${status?.is_streaming ? 'text-emerald-500' : 'text-white/20'}`}>
                          {status?.is_streaming ? 'EXECUTANDO' : 'OCIOSO'}
                        </span>
                      </div>
                      <div className="pt-2">
                        <button 
                          onClick={toggleLoop}
                          className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${status?.loop_video ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' : 'bg-black/20 border-white/5 text-white/40 hover:border-white/20'}`}
                        >
                          <div className="flex items-center gap-3">
                            <Repeat size={16} />
                            <span className="text-sm font-medium">Repetir Vídeo (Loop)</span>
                          </div>
                          <div className={`w-8 h-4 rounded-full relative transition-colors ${status?.loop_video ? 'bg-emerald-500' : 'bg-white/10'}`}>
                            <div className={`absolute top-1 w-2 h-2 rounded-full bg-white transition-all ${status?.loop_video ? 'left-5' : 'left-1'}`} />
                          </div>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-[#151619] rounded-3xl border border-white/10 p-6">
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <Video size={18} className="text-emerald-500" />
                    Comerciais Rápidos
                  </h3>
                  <div className="space-y-3">
                    {videos.length === 0 ? (
                      <div className="text-center py-6 border-2 border-dashed border-white/5 rounded-2xl">
                        <p className="text-white/20 text-xs">Nenhum vídeo</p>
                      </div>
                    ) : (
                      videos.slice(0, 3).map(vid => (
                        <button 
                          key={vid.id}
                          onClick={() => switchStream('video', vid.id)}
                          className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${status?.current_source_id === vid.id && status.current_source_type === 'video' ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' : 'bg-black/20 border-white/5 text-white/60 hover:border-white/20'}`}
                        >
                          <div className="flex items-center gap-3 overflow-hidden">
                            <Video size={16} />
                            <span className="text-xs font-medium truncate">{vid.title}</span>
                          </div>
                          <Play size={12} fill="currentColor" />
                        </button>
                      ))
                    )}
                    <button 
                      onClick={() => setActiveTab('videos')}
                      className="w-full text-center text-[10px] font-bold text-emerald-500 hover:underline mt-2 uppercase tracking-widest"
                    >
                      Ver Todos os Vídeos
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'cameras' && (
            <motion.div 
              key="cameras"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="max-w-4xl"
            >
              <div className="bg-[#151619] rounded-3xl border border-white/10 p-8 mb-8">
                <h3 className="text-xl font-bold mb-6">Adicionar Nova Câmera</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                  <div>
                    <label className="block text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Nome da Câmera</label>
                    <input 
                      type="text" 
                      value={newCam.name}
                      onChange={(e) => setNewCam({ ...newCam, name: e.target.value })}
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500 transition-colors"
                      placeholder="Entrada Principal"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-mono uppercase tracking-wider text-white/40 mb-2">URL RTSP</label>
                    <input 
                      type="text" 
                      value={newCam.rtsp_url}
                      onChange={(e) => setNewCam({ ...newCam, rtsp_url: e.target.value })}
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500 transition-colors"
                      placeholder="rtsp://usuario:senha@ip:porta/stream"
                    />
                    <div className="mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                      <p className="text-[10px] text-amber-200 leading-relaxed">
                        <span className="font-bold">AVISO:</span> Para câmeras locais, a URL deve ser acessível pela internet (IP Público ou Redirecionamento de Portas). Se a câmera estiver em sua rede local privada, o servidor na nuvem não conseguirá conectar.
                      </p>
                    </div>
                  </div>
                </div>
                <button 
                  onClick={addCamera}
                  className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-8 py-3 rounded-xl transition-all flex items-center gap-2"
                >
                  <Plus size={20} />
                  Adicionar Câmera
                </button>
              </div>

              <div className="space-y-4">
                {cameras.map(cam => (
                  <div key={cam.id} className="bg-[#151619] rounded-2xl border border-white/10 p-6 flex items-center justify-between group">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-black/40 rounded-xl flex items-center justify-center text-white/20">
                        <Camera size={24} />
                      </div>
                      <div>
                        <h4 className="font-bold text-lg">{cam.name}</h4>
                        <p className="text-sm text-white/40 font-mono">{cam.rtsp_url}</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => deleteCamera(cam.id)}
                      className="p-3 text-white/20 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {activeTab === 'videos' && (
            <motion.div 
              key="videos"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="max-w-4xl"
            >
              <div className="bg-[#151619] rounded-3xl border border-white/10 p-8 mb-8">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold">Vídeos Comerciais</h3>
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-500/50 text-white font-bold px-6 py-2.5 rounded-xl transition-all flex items-center gap-2"
                  >
                    {isUploading ? <Activity className="animate-pulse" size={18} /> : <Upload size={18} />}
                    {isUploading ? 'Enviando...' : 'Upload de Vídeo'}
                  </button>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileUpload} 
                    accept="video/*" 
                    className="hidden" 
                  />
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {videos.length === 0 ? (
                    <div className="col-span-full text-center py-20 border-2 border-dashed border-white/5 rounded-3xl">
                      <Video className="w-12 h-12 text-white/10 mx-auto mb-4" />
                      <p className="text-white/30">Nenhum vídeo comercial disponível</p>
                    </div>
                  ) : (
                    videos.map(vid => (
                      <div key={vid.id} className="bg-black/20 rounded-2xl border border-white/5 p-4 flex items-center justify-between group hover:border-white/10 transition-all">
                        <div className="flex items-center gap-4 overflow-hidden">
                          <div className="w-10 h-10 bg-emerald-500/10 rounded-lg flex items-center justify-center text-emerald-500">
                            <Video size={20} />
                          </div>
                          <div className="overflow-hidden">
                            <h4 className="font-bold text-sm truncate">{vid.title}</h4>
                            <p className="text-[10px] text-white/30 font-mono">{new Date(vid.created_at).toLocaleDateString()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => switchStream('video', vid.id)}
                            className={`p-2 rounded-lg transition-all ${status?.current_source_id === vid.id && status.current_source_type === 'video' ? 'bg-emerald-500 text-white' : 'text-white/20 hover:text-emerald-500 hover:bg-emerald-500/10'}`}
                          >
                            <Play size={16} fill="currentColor" />
                          </button>
                          <button 
                            onClick={() => deleteVideo(vid.id)}
                            className="p-2 text-white/10 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'local' && (
            <motion.div 
              key="local"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                  <div className="bg-[#151619] rounded-3xl border border-white/10 overflow-hidden">
                    <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20">
                      <span className="text-xs font-mono uppercase tracking-widest text-white/40">Preview do Compositor</span>
                      <div className="flex gap-2">
                        {screenStream && <span className="bg-blue-500/20 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase">Tela Ativa</span>}
                        {cameraStream && <span className="bg-purple-500/20 text-purple-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase">Câmera Ativa</span>}
                      </div>
                    </div>
                    <div className="aspect-video bg-black relative">
                      <canvas 
                        id="local-preview-canvas"
                        className="w-full h-full object-contain"
                        ref={(el) => {
                          if (el && canvasRef.current) {
                            const ctx = el.getContext('2d');
                            const sourceCanvas = canvasRef.current;
                            let active = true;
                            const render = () => {
                              if (!active) return;
                              if (ctx && sourceCanvas) {
                                ctx.drawImage(sourceCanvas, 0, 0, el.width, el.height);
                                requestAnimationFrame(render);
                              }
                            };
                            render();
                          }
                        }}
                        width={1280}
                        height={720}
                      />
                      
                      {!screenStream && !cameraStream && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-white/20">
                          <Monitor size={48} className="mb-4" />
                          <p>Nenhuma fonte local selecionada</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <button 
                        onClick={screenStream ? () => screenStream.getTracks().forEach(t => t.stop()) : startScreenShare}
                        className={`w-full p-6 rounded-3xl border transition-all flex flex-col items-center gap-4 ${screenStream ? 'bg-blue-500/10 border-blue-500 text-blue-500' : 'bg-[#151619] border-white/10 text-white/40 hover:border-white/20'}`}
                      >
                        <Monitor size={32} />
                        <div className="text-center">
                          <p className="font-bold">{screenStream ? 'Trocar Compartilhamento' : 'Compartilhar Tela'}</p>
                          <p className="text-xs opacity-60">Janela ou Tela Inteira</p>
                        </div>
                      </button>
                      {screenStream && (
                        <button 
                          onClick={() => {
                            screenStream.getTracks().forEach(t => t.stop());
                            setScreenStream(null);
                          }}
                          className="w-full py-2 bg-red-500/10 text-red-500 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition-all"
                        >
                          Parar Tela
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      <button 
                        onClick={cameraStream ? () => cameraStream.getTracks().forEach(t => t.stop()) : startCamera}
                        className={`w-full p-6 rounded-3xl border transition-all flex flex-col items-center gap-4 ${cameraStream ? 'bg-purple-500/10 border-purple-500 text-purple-500' : 'bg-[#151619] border-white/10 text-white/40 hover:border-white/20'}`}
                      >
                        <Camera size={32} />
                        <div className="text-center">
                          <p className="font-bold">{cameraStream ? 'Trocar Câmera' : 'Ativar Câmera Local'}</p>
                          <p className="text-xs opacity-60">Webcam do Computador</p>
                        </div>
                      </button>
                      {cameraStream && (
                        <button 
                          onClick={() => {
                            cameraStream.getTracks().forEach(t => t.stop());
                            setCameraStream(null);
                          }}
                          className="w-full py-2 bg-red-500/10 text-red-500 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition-all"
                        >
                          Parar Câmera
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="bg-[#151619] rounded-3xl border border-white/10 p-6">
                    <h3 className="text-lg font-bold mb-4">Configurações PiP</h3>
                    <p className="text-sm text-white/40 mb-6">Posição da câmera sobre a tela</p>
                    
                    <div className="grid grid-cols-2 gap-3">
                      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map(pos => (
                        <button
                          key={pos}
                          onClick={() => setPipPosition(pos)}
                          className={`p-3 rounded-xl border text-xs font-mono uppercase transition-all ${pipPosition === pos ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-black/20 border-white/5 text-white/40 hover:border-white/20'}`}
                        >
                          {pos.replace('-', ' ')}
                        </button>
                      ))}
                    </div>

                    <div className="mt-8 space-y-4">
                      <button
                        disabled={!screenStream && !cameraStream}
                        onClick={isLocalStreaming ? stopStream : startWebBroadcast}
                        className={`w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all ${isLocalStreaming ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/20' : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 disabled:opacity-20 disabled:cursor-not-allowed'}`}
                      >
                        {isLocalStreaming ? <Square size={20} /> : <Play size={20} />}
                        {isLocalStreaming ? 'PARAR TRANSMISSÃO' : 'TRANSMITIR AGORA'}
                      </button>
                      
                      <button 
                        onClick={() => setShowLogs(!showLogs)}
                        className="w-full py-2 text-[10px] font-bold text-emerald-500 hover:bg-emerald-500/10 rounded-xl uppercase tracking-widest transition-all"
                      >
                        {showLogs ? 'Ocultar Logs de Transmissão' : 'Ver Logs de Transmissão'}
                      </button>

                      {showLogs && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between px-1">
                            <div className="flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                              <span className="text-[9px] text-white/40 uppercase tracking-widest">
                                {socketConnected ? 'Socket Conectado' : 'Socket Desconectado'}
                              </span>
                              {!socketConnected && (
                                <button 
                                  onClick={() => socketRef.current?.connect()}
                                  className="text-[9px] text-emerald-500 hover:underline uppercase tracking-widest ml-2"
                                >
                                  Reconectar
                                </button>
                              )}
                            </div>
                            {isLocalStreaming && (
                              <button 
                                onClick={() => startActualRecorder()}
                                className="text-[9px] text-emerald-500 hover:underline uppercase tracking-widest"
                              >
                                Forçar Início Manual
                              </button>
                            )}
                          </div>
                          <div className="bg-black/40 rounded-xl p-3 font-mono text-[10px] h-48 overflow-y-auto space-y-1 border border-white/5">
                            {ffmpegLogs.length === 0 ? (
                              <p className="text-white/20">Aguardando logs...</p>
                            ) : (
                              ffmpegLogs.map((log, i) => (
                                <p key={i} className="text-white/60 break-all">{log}</p>
                              ))
                            )}
                          </div>
                        </div>
                      )}

                      <p className="text-[10px] text-center text-white/20 uppercase tracking-widest">
                        A transmissão será enviada diretamente para o YouTube
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div 
              key="settings"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="max-w-2xl"
            >
              <div className="bg-[#151619] rounded-3xl border border-white/10 p-8">
                <h3 className="text-xl font-bold mb-6">Configurações de Transmissão</h3>
                <div className="space-y-6">
                  <div>
                    <label className="block text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Chave de Transmissão do YouTube</label>
                    <div className="flex gap-4">
                      <input 
                        type="password" 
                        value={ytKey}
                        onChange={(e) => setYtKey(e.target.value)}
                        className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="xxxx-xxxx-xxxx-xxxx"
                      />
                      <button 
                        onClick={saveYtKey}
                        className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-6 py-3 rounded-xl transition-all"
                      >
                        Salvar
                      </button>
                    </div>
                    <p className="text-[10px] text-white/20 mt-2 font-mono">Encontrada no painel do YouTube Studio</p>
                  </div>

                  <div className="pt-6 border-t border-white/10">
                    <h4 className="font-bold mb-4">Configuração de Saída</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 bg-black/20 rounded-xl border border-white/5">
                        <span className="block text-[10px] font-mono text-white/40 uppercase mb-1">Resolução</span>
                        <span className="font-bold">1080p (1920x1080)</span>
                      </div>
                      <div className="p-4 bg-black/20 rounded-xl border border-white/5">
                        <span className="block text-[10px] font-mono text-white/40 uppercase mb-1">Bitrate</span>
                        <span className="font-bold">3000 kbps</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
