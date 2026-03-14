import React, { useState, useEffect, useRef } from 'react';
import { Camera, Video, Play, Square, Settings, Plus, Trash2, LogOut, Activity, Monitor, Upload, Repeat } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

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
  current_source_type: 'camera' | 'video' | 'none';
  current_source_id: number | null;
  is_streaming: boolean;
  youtube_key: string;
  loop_video: boolean;
}

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isLoggedIn) {
      fetchData();
    }
  }, [isLoggedIn]);

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

  const switchStream = async (type: 'camera' | 'video', id: number) => {
    const token = localStorage.getItem('token');
    await fetch('/api/stream/switch', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}` 
      },
      body: JSON.stringify({ type, id })
    });
    fetchData();
  };

  const stopStream = async () => {
    const token = localStorage.getItem('token');
    await fetch('/api/stream/stop', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchData();
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
    await fetch('/api/status/loop', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}` 
      },
      body: JSON.stringify({ loop: newLoop })
    });
    // Status will be updated via socket or next fetch
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
                    {status?.is_streaming && (
                      <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter">No Ar</span>
                    )}
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
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full">
                            <Activity className="w-12 h-12 text-emerald-500 mx-auto mb-4 animate-pulse" />
                            <p className="font-mono text-sm text-white/60">Fonte Atual: Câmera #{status.current_source_id}</p>
                          </div>
                        )}
                        <div className="absolute top-4 right-4 flex gap-2">
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
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <Activity size={18} className="text-emerald-500" />
                    Status do Sistema
                  </h3>
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
