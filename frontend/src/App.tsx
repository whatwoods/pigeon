import { AnimatePresence, motion } from 'motion/react';
import React, { useState, useRef, useEffect } from 'react';
import { 
  FileUp, 
  ClipboardPaste, 
  Lock, 
  X, 
  Feather, 
  Check, 
  FileText, 
  Smartphone, 
  Laptop,
  Plus,
  Download,
  Copy,
  Link
} from 'lucide-react';

type AppState = 'idle' | 'file_preview' | 'sending' | 'success' | 'sharing_link' | 'enter_code';

interface UIState {
  status: AppState;
  file: File | null;
  clipboardText: string;
  progress: number;
  shareCode?: string;
}

const NoiseOverlay = () => (
  <svg 
    className="pointer-events-none fixed inset-0 z-50 opacity-[0.025] mix-blend-overlay w-full h-full" 
    xmlns="http://www.w3.org/2000/svg"
  >
    <filter id="noiseFilter">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
    </filter>
    <rect width="100%" height="100%" filter="url(#noiseFilter)" />
  </svg>
);

export default function App() {
  const [state, setState] = useState<UIState>({
    status: 'idle',
    file: null,
    clipboardText: '',
    progress: 0,
  });
  
  const [dragActive, setDragActive] = useState(false);
  const [roomId, setRoomId] = useState<string>('');
  const [devicesCount, setDevicesCount] = useState<number>(1);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [receiveCode, setReceiveCode] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const r = urlParams.get('r');
    const rc = urlParams.get('rc');
    
    let currentRoom = localStorage.getItem('roomId');
    let currentDevices = parseInt(localStorage.getItem('devicesCount') || '1', 10);
    
    if (r) {
      currentRoom = r;
      localStorage.setItem('roomId', r);
      window.history.replaceState({}, '', window.location.pathname);
      currentDevices = 2; // Simulated joining
      localStorage.setItem('devicesCount', '2');
    } else if (!currentRoom) {
      currentRoom = Math.random().toString(36).substring(2, 9);
      localStorage.setItem('roomId', currentRoom);
    }
    
    setRoomId(currentRoom);
    setDevicesCount(currentDevices);
    
    if (rc) {
      setState(prev => ({ ...prev, status: 'enter_code' }));
      setReceiveCode(rc);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Handle file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setState(prev => ({ ...prev, status: 'file_preview', file: selectedFile }));
    }
  };

  const startSendProgress = () => {
    let progressValue = 0;
    const interval = setInterval(() => {
      progressValue += Math.random() * 15;
      if (progressValue >= 100) {
        progressValue = 100;
        clearInterval(interval);
        setState(prev => ({ ...prev, progress: 100 }));
        
        setTimeout(() => {
          setState(prev => ({ ...prev, status: 'success' }));
          
          // Auto reset after success
          setTimeout(() => {
            reset();
          }, 3000);
        }, 500);
      } else {
        setState(prev => ({ ...prev, progress: progressValue }));
      }
    }, 200);
  };

  // Handle clipboard paste
  const handlePasteClick = async () => {
    try {
      if (!navigator.clipboard.read) {
        throw new Error("Clipboard API read not supported");
      }
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageTypes = item.types.filter(type => type.startsWith('image/'));
        if (imageTypes.length > 0) {
          const blob = await item.getType(imageTypes[0]);
          const ext = blob.type.split('/')[1] || 'png';
          const file = new File([blob], `pasted_image.${ext}`, { type: blob.type });
          setState(prev => ({ ...prev, status: 'file_preview', file }));
          return;
        }
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();
          if (text) {
            setState(prev => ({ ...prev, status: 'file_preview', clipboardText: text }));
            return;
          }
        }
      }
    } catch (err) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          setState(prev => ({ ...prev, status: 'file_preview', clipboardText: text }));
        }
      } catch (e) {
        alert("无法自动读取剪贴板。请授予权限，或直接按 Ctrl+V / Cmd+V 进行粘贴。");
      }
    }
  };

  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Only handle paste if we are in one of the states where pasting makes sense
      if (state.status !== 'idle' && state.status !== 'enter_code') return;
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) {
             setState(prev => ({ ...prev, status: 'file_preview', file }));
             return;
          }
        }
      }
      
      const text = e.clipboardData?.getData('text');
      if (text) {
         if (state.status === 'enter_code' && text.length <= 6) {
           setReceiveCode(text.toUpperCase());
         } else {
           setState(prev => ({ ...prev, status: 'file_preview', clipboardText: text, file: null }));
         }
      }
    };

    window.addEventListener('paste', handleGlobalPaste as EventListener);
    return () => window.removeEventListener('paste', handleGlobalPaste as EventListener);
  }, [state.status]);

  // Simulate sending process
  const performSend = () => {
    setState(prev => ({ ...prev, status: 'sending', progress: 0 }));
    startSendProgress();
  };
  
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (state.status === 'idle' && e.dataTransfer.files && e.dataTransfer.files[0]) {
      setState(prev => ({ ...prev, status: 'file_preview', file: e.dataTransfer.files[0], clipboardText: '' }));
    }
  };

  const reset = () => {
    setState({ status: 'idle', file: null, clipboardText: '', progress: 0 });
    setReceiveCode('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const handleCopyShareLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/?rc=${state.shareCode}`);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyShareCode = () => {
    navigator.clipboard.writeText(state.shareCode || '');
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const isPreviewingText = state.status === 'file_preview' && !!state.clipboardText && !state.file;

  return (
    <div 
      className="min-h-[100dvh] bg-[#FAF9F6] text-[#4A4947] font-sans flex flex-col items-center justify-center p-4 sm:p-12 overflow-hidden relative selection:bg-stone-200"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <AnimatePresence>
        {showAddDevice && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="absolute inset-0 bg-[#FAF9F6]/80 backdrop-blur-sm" onClick={() => setShowAddDevice(false)} />
            <motion.div 
              initial={{opacity:0, y: 20, scale:0.95}} 
              animate={{opacity:1, y:0, scale:1}} 
              exit={{opacity:0, y:20, scale:0.95}} 
              className="bg-white/70 backdrop-blur-2xl border border-white p-8 rounded-[32px] shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] relative z-10 w-full max-w-sm flex flex-col items-center text-center"
            >
              <div className="w-12 h-12 bg-[#F2F7F2] rounded-full flex items-center justify-center text-[#567D56] mb-6 shadow-sm">
                <Laptop className="w-6 h-6 opacity-80" />
              </div>
              <h3 className="text-xl font-serif italic mb-2 text-[#4A4947]">连接新设备</h3>
              <p className="text-[13px] opacity-60 text-[#4A4947] mb-8 leading-relaxed">在需要连接的设备浏览器中输入或打开下方链接，即可自动连接您的房间。</p>
              
              <div className="bg-white/50 p-4 rounded-2xl w-full font-mono text-sm border border-white/60 shadow-[inset_0_2px_4px_rgba(0,0,0,0.02)] mb-6 text-[#4A4947] opacity-80 overflow-hidden text-ellipsis whitespace-nowrap">
                {window.location.origin}/?r={roomId}
              </div>
              
              <button 
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/?r=${roomId}`);
                  setCopiedLink(true);
                  setTimeout(() => setCopiedLink(false), 2000);
                }}
                className="w-full py-3.5 bg-[#4A4947] text-white rounded-full text-[13px] font-medium transition-colors hover:bg-black flex items-center justify-center space-x-2"
              >
                {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copiedLink ? '已复制链接' : '复制房间链接'}</span>
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {dragActive && state.status === 'idle' && (
        <div 
          className="absolute inset-0 z-[100] bg-[#FAF9F6]/80 backdrop-blur-sm border-4 border-dashed border-[#7FB3D5]/50 flex items-center justify-center rounded-3xl m-4 sm:m-8"
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
           <div className="text-2xl font-serif italic text-[#4A4947] opacity-80 pointer-events-none">
             松开鼠标即可传送
           </div>
        </div>
      )}
      <NoiseOverlay />
      
      {/* Abstract Organic Background Elements */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden z-0 flex items-center justify-center isolate">
        <motion.div 
          animate={{ 
            rotate: [0, 5, -5, 0],
            scale: [1, 1.05, 0.95, 1]
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
          className="absolute w-[120vw] h-[120vw] max-w-[900px] max-h-[900px] bg-[#EAE5D9]/40 rounded-full blur-[120px] opacity-60 select-none -translate-x-1/4 -translate-y-1/4"
        />
        <motion.div 
          animate={{ 
            rotate: [0, -5, 5, 0],
            scale: [1, 0.95, 1.05, 1]
          }}
          transition={{ duration: 25, repeat: Infinity, ease: "easeInOut", delay: 1 }}
          className="absolute w-[100vw] h-[100vw] max-w-[700px] max-h-[700px] bg-[#D5E0EC]/40 rounded-full blur-[100px] opacity-60 select-none translate-x-1/4 translate-y-1/4"
        />
        <motion.div 
          animate={{ 
            rotate: [0, 10, -10, 0]
          }}
          transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
          className="absolute w-[80vw] h-[80vw] max-w-[500px] max-h-[500px] bg-white/40 rounded-full blur-[80px] opacity-50 select-none"
        />
      </div>

      {/* Header / Brand */}
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="absolute top-6 left-6 right-6 sm:top-8 sm:left-8 sm:right-8 flex justify-between items-center z-10"
      >
        <div className="flex items-center space-x-3 cursor-pointer" onClick={reset}>
          <div className="w-8 h-8 bg-[#4A4947] rounded-full flex items-center justify-center shadow-lg">
            <Feather className="w-4 h-4 text-[#FAF9F6]" strokeWidth={2} />
          </div>
          <span className="text-xl font-serif italic font-medium opacity-90 text-[#4A4947]">Pigeon</span>
        </div>
        <div className="flex items-center space-x-6">
          {devicesCount > 1 ? (
            <button onClick={() => setShowAddDevice(true)} className="flex items-center space-x-2 bg-white/50 hover:bg-white/80 transition-colors px-3 py-1.5 rounded-full border border-white/60 shadow-[inset_0_2px_4px_rgba(255,255,255,1)] text-[#4A4947]">
               <div className="w-2 h-2 bg-green-400 rounded-full shadow-sm"></div>
               <span className="text-[11px] uppercase tracking-wider font-bold opacity-80">{devicesCount} 台设备在线</span>
            </button>
          ) : (
            <button onClick={() => setShowAddDevice(true)} className="flex items-center space-x-2 bg-white/50 hover:bg-white/80 transition-colors px-3 py-1.5 rounded-full border border-white/60 shadow-[inset_0_2px_4px_rgba(255,255,255,1)] text-[#4A4947]">
               <Plus className="w-3.5 h-3.5 opacity-80" strokeWidth={2.5} />
               <span className="text-[11px] uppercase tracking-wider font-bold opacity-80">添加设备</span>
            </button>
          )}
        </div>
      </motion.div>

      {/* Main Interactive Area */}
      <main className="w-full max-w-sm relative z-10 flex flex-col items-center min-h-[400px] justify-center pt-8">
        <AnimatePresence mode="wait">
          
          {/* IDLE STATE */}
          {state.status === 'idle' && (
            <motion.div 
              key="idle"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
              transition={{ duration: 0.4 }}
              className="w-full bg-white/70 backdrop-blur-2xl rounded-[32px] sm:rounded-[48px] p-6 sm:p-8 border border-white/60 shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col items-center justify-between min-h-[400px] sm:min-h-[460px] relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
              
              <div className="text-center mt-2 relative z-10">
                <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold opacity-50 text-[#4A4947] mb-2">准备就绪</h3>
                <p className="text-sm italic font-serif opacity-70 text-[#4A4947]">选择或拖入文件，即可分享</p>
              </div>

              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
              />
              
              <div className="relative flex items-center justify-center w-48 h-48 my-4 z-10">
                <motion.div 
                  animate={{ scale: [1, 1.05, 1], opacity: [0.3, 0.6, 0.3] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                  className="absolute inset-0 bg-[#E8E5E0]/50 rounded-full blur-xl" 
                />
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => fileInputRef.current?.click()}
                  className="relative z-10 w-40 h-40 bg-white border border-white/60 rounded-full shadow-[0_16px_32px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col items-center justify-center group hover:shadow-[0_20px_40px_rgba(30,30,30,0.06),inset_0_2px_4px_rgba(255,255,255,1)] hover:border-white transition-all focus:outline-none"
                >
                  <FileUp strokeWidth={1.5} className="w-10 h-10 mb-2 text-[#4A4947] opacity-70 group-hover:opacity-100 transition-opacity" />
                  <span className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-60 group-hover:opacity-100 transition-opacity text-[#4A4947]">选择文件</span>
                </motion.button>
              </div>

              <div className="w-full space-y-3 relative z-10 mb-2">
                <button 
                  onClick={handlePasteClick}
                  className="w-full py-3.5 bg-white/40 border border-[#E8E5E0]/60 shadow-[inset_0_2px_4px_rgba(255,255,255,0.8)] rounded-full flex items-center justify-center space-x-2 text-[#4A4947] hover:bg-white/60 transition-colors focus:outline-none"
                >
                  <ClipboardPaste className="w-4 h-4 opacity-60" />
                  <span className="text-[13px] font-medium opacity-90">粘贴投送</span>
                </button>
                <button 
                  onClick={() => setState(prev => ({...prev, status: 'enter_code'}))}
                  className="w-full py-3.5 bg-[#E8E5E0]/40 rounded-full flex items-center justify-center space-x-2 text-[#4A4947] hover:bg-[#E8E5E0]/60 transition-colors focus:outline-none"
                >
                  <Download className="w-4 h-4 opacity-60" />
                  <span className="text-[13px] font-medium opacity-90">接收文件</span>
                </button>
              </div>
            </motion.div>
          )}

          {/* FILE/TEXT PREVIEW STATE */}
          {state.status === 'file_preview' && (
            <motion.div 
              key="file_preview"
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
              transition={{ duration: 0.4 }}
              className="w-full bg-white/70 backdrop-blur-2xl rounded-[32px] sm:rounded-[48px] p-6 sm:p-8 border border-white/60 shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col min-h-[400px] sm:min-h-[460px] relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
              <div className="relative z-10 flex flex-col h-full">
                <div className="flex justify-between items-center mb-8">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] uppercase tracking-widest font-bold opacity-60 text-[#4A4947]">已选择内容</span>
                    <div className="px-2 py-0.5 bg-blue-50/50 text-[#6B9AB8] rounded-md text-[9px] font-bold uppercase tracking-wider flex items-center gap-1">
                      <Lock className="w-2 h-2" />
                      <span>端到端加密</span>
                    </div>
                  </div>
                  <button onClick={reset} className="p-2 -mr-2 text-[#4A4947]/40 hover:text-[#4A4947] bg-[#E8E5E0]/0 hover:bg-[#E8E5E0]/30 transition-all rounded-full flex items-center justify-center">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              
                {isPreviewingText ? (
                  <div className="flex-1 flex flex-col justify-center mb-8 w-full relative group">
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-white/90 z-10 rounded-xl pointer-events-none" />
                    <div className="text-[13px] sm:text-sm text-[#4A4947] bg-white/50 p-5 rounded-2xl max-h-40 overflow-hidden break-words font-mono opacity-80 leading-relaxed border border-white shadow-[inset_0_2px_4px_rgba(0,0,0,0.02)]">
                      {state.clipboardText}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col justify-center mb-8 w-full">
                    <div className="self-start w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-[#567D56] shadow-[0_8px_16px_rgba(30,30,30,0.03),inset_0_2px_4px_rgba(255,255,255,1)] border border-[#E8E5E0]/50 mb-6">
                      <FileText strokeWidth={1.5} className="w-8 h-8 opacity-80" />
                    </div>
                    <h3 className="text-xl sm:text-2xl font-serif italic mb-2 text-[#4A4947] line-clamp-2 leading-snug break-all sm:break-normal" title={state.file?.name}>
                      {state.file?.name}
                    </h3>
                    <p className="text-[13px] opacity-70 text-[#4A4947] font-medium tracking-wide">
                      {state.file ? formatFileSize(state.file.size) : ''}
                    </p>
                  </div>
                )}

                <div className="w-full space-y-3 relative z-10 mt-auto">
                  <button 
                    onClick={performSend}
                    className="w-full py-3.5 bg-[#4A4947] text-white text-[13px] font-medium rounded-full hover:bg-black transition-colors shadow-md flex items-center justify-center"
                  >
                    发给我的设备
                  </button>
                  <button 
                    onClick={() => {
                      setState(prev => ({...prev, status: 'sharing_link', shareCode: Math.random().toString().substring(2, 8).toUpperCase()}));
                    }}
                    className="w-full py-3.5 bg-white/40 border border-[#E8E5E0]/60 shadow-[inset_0_2px_4px_rgba(255,255,255,0.8)] rounded-full flex items-center justify-center space-x-2 text-[#4A4947] hover:bg-white/60 transition-colors focus:outline-none"
                  >
                    <Link className="w-4 h-4 opacity-40" />
                    <span className="text-[13px] font-medium opacity-70">分享给他人</span>
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* GENERATE LINK/CODE STATE */}
          {state.status === 'sharing_link' && (
            <motion.div 
              key="sharing_link"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.4 }}
              className="w-full bg-white/70 backdrop-blur-2xl rounded-[32px] sm:rounded-[48px] p-6 sm:p-8 border border-white/60 shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col min-h-[400px] sm:min-h-[460px] relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
              <div className="relative z-10 flex flex-col h-full">
                <div className="flex justify-between items-center mb-8">
                  <span className="text-[10px] uppercase tracking-widest font-bold opacity-60 text-[#4A4947]">分享文件</span>
                  <button onClick={reset} className="p-2 -mr-2 text-[#4A4947]/60 hover:text-[#4A4947] bg-[#E8E5E0]/0 hover:bg-[#E8E5E0]/30 transition-all rounded-full flex items-center justify-center">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="flex-1 flex flex-col items-center justify-center mb-8 w-full">
                   <h3 className="text-2xl font-serif italic mb-2 text-[#4A4947] text-center">文件已就绪</h3>
                   <p className="text-[13px] opacity-80 text-[#4A4947] text-center mb-8">对方输入提取码或访问链接即可接收</p>
                   
                   <div className="text-[2.5rem] leading-none font-mono tracking-[0.2em] font-medium text-[#4A4947] opacity-100 my-2">
                     {state.shareCode}
                   </div>
                </div>
                
                <div className="flex gap-4 w-full mt-auto">
                   <button onClick={handleCopyShareCode} className="flex-1 py-3 bg-white hover:bg-[#FAF9F6] text-[#4A4947] border border-[#E8E5E0] shadow-[inset_0_2px_4px_rgba(255,255,255,1)] text-[13px] font-medium rounded-full transition-all flex items-center justify-center gap-2">
                     {copiedCode ? <Check className="w-4 h-4 opacity-80"/> : <Copy className="w-4 h-4 opacity-80"/>}
                     <span>{copiedCode ? '已复制' : '复制密码'}</span>
                   </button>
                   <button onClick={handleCopyShareLink} className="flex-1 py-3 bg-[#4A4947] hover:bg-black text-white text-[13px] font-medium rounded-full transition-all shadow-md flex items-center justify-center gap-2">
                     {copiedLink ? <Check className="w-4 h-4 opacity-100"/> : <Link className="w-4 h-4 opacity-100"/>}
                     <span>{copiedLink ? '已复制' : '复制链接'}</span>
                   </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* ENTER RECEIVE CODE STATE */}
          {state.status === 'enter_code' && (
            <motion.div 
              key="enter_code"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.4 }}
              className="w-full bg-white/70 backdrop-blur-2xl rounded-[32px] sm:rounded-[48px] p-6 sm:p-8 border border-white/60 shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col min-h-[400px] sm:min-h-[460px] relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
              <div className="relative z-10 flex flex-col h-full">
                <div className="flex justify-between items-center mb-8">
                  <span className="text-[10px] uppercase tracking-widest font-bold opacity-60 text-[#4A4947]">接收文件</span>
                  <button onClick={reset} className="p-2 -mr-2 text-[#4A4947]/60 hover:text-[#4A4947] bg-[#E8E5E0]/0 hover:bg-[#E8E5E0]/30 transition-all rounded-full flex items-center justify-center">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="flex-1 flex flex-col justify-center items-center mb-8 w-full max-w-[240px] mx-auto">
                   <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-[#6B9AB8] shadow-[0_8px_16px_rgba(30,30,30,0.03),inset_0_2px_4px_rgba(255,255,255,1)] border border-[#E8E5E0]/50 mb-8">
                      <Download strokeWidth={1.5} className="w-8 h-8 opacity-100" />
                   </div>
                   
                   <input 
                     type="text" 
                     placeholder="输入6位提取码" 
                     value={receiveCode}
                     onChange={(e) => setReceiveCode(e.target.value.toUpperCase())}
                     className="w-full text-center text-3xl tracking-widest font-mono bg-transparent border-b-2 border-[#E8E5E0] focus:border-[#4A4947] focus:outline-none pb-2 text-[#4A4947] placeholder:opacity-40 placeholder:text-xl transition-colors uppercase" 
                     maxLength={6} 
                     autoFocus
                   />
                </div>
                
                <div className="mt-auto">
                  <button 
                    disabled={receiveCode.length < 6}
                    onClick={() => { setState(prev => ({...prev, status: 'success'})); setTimeout(() => reset(), 3000); }} 
                    className="w-full py-3.5 bg-[#4A4947] disabled:bg-[#E8E5E0] disabled:text-[#4A4947]/40 text-white rounded-full text-[13px] font-medium transition-colors hover:bg-black focus:outline-none focus:ring-2 focus:ring-[#4A4947] focus:ring-offset-2"
                  >
                    开始接收
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* SENDING STATE */}
          {state.status === 'sending' && (
             <motion.div 
              key="sending"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              transition={{ duration: 0.5, type: 'spring', damping: 20 }}
              className="w-full bg-white/70 backdrop-blur-2xl rounded-[32px] sm:rounded-[48px] p-6 sm:p-8 border border-white/60 shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col items-center justify-center min-h-[400px] sm:min-h-[460px] relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
              <div className="relative z-10 flex flex-col items-center w-full">
                <div className="relative w-48 h-48 mb-8 flex items-center justify-center">
                  {/* Background Ring */}
                <svg className="absolute inset-0 w-full h-full -rotate-90">
                  <circle 
                    cx="96" cy="96" r="94" 
                    fill="none" 
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="text-[#E8E5E0]"
                  />
                  {/* Progress Ring */}
                  <motion.circle 
                    cx="96" cy="96" r="94" 
                    fill="none" 
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="text-[#7FB3D5]"
                    initial={{ strokeDasharray: "0 600" }}
                    animate={{ strokeDasharray: `${(state.progress / 100) * 590} 600` }}
                    transition={{ ease: "linear", duration: 0.2 }}
                  />
                </svg>
                
                {/* Center subtle animation */}
                <motion.div 
                  animate={{ y: [-4, 4, -4] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  className="text-stone-300"
                >
                   <Feather strokeWidth={1.5} className="w-10 h-10 transform rotate-12 text-[#4A4947]/80" />
                </motion.div>
              </div>

              <motion.div 
                 initial={{ opacity: 0, y: 10 }}
                 animate={{ opacity: 1, y: 0 }}
                 transition={{ delay: 0.2 }}
                 className="flex flex-col items-center gap-3"
              >
                <div className="flex items-center gap-4 text-[#4A4947]/40">
                  <Laptop className="w-4 h-4" />
                  <motion.div 
                    animate={{ opacity: [0.3, 1, 0.3], x: [0, 20, 0] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="w-16 h-[1px] bg-gradient-to-r from-transparent via-[#4A4947]/40 to-transparent"
                  />
                  <Smartphone className="w-4 h-4" />
                </div>
                <p className="text-[13px] font-serif italic text-[#4A4947] opacity-80">
                  正在飞向其他设备...
                </p>
                <button 
                  onClick={reset}
                  className="mt-6 text-[11px] uppercase tracking-widest font-bold opacity-50 text-[#4A4947] hover:opacity-80 transition-opacity"
                >
                  取消
                </button>
              </motion.div>
              </div>
            </motion.div>
          )}

          {/* SUCCESS STATE */}
          {state.status === 'success' && (
             <motion.div 
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, type: "spring" }}
              className="w-full bg-white/70 backdrop-blur-2xl rounded-[32px] sm:rounded-[48px] p-6 sm:p-8 border border-white/60 shadow-[0_24px_48px_rgba(30,30,30,0.04),inset_0_2px_4px_rgba(255,255,255,0.8)] flex flex-col items-center justify-center min-h-[400px] sm:min-h-[460px] text-center relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
              <div className="relative z-10 flex flex-col items-center w-full">
                <motion.div 
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 15, delay: 0.1 }}
                className="w-24 h-24 bg-[#F2F7F2] rounded-full flex items-center justify-center mb-8 relative"
              >
                <Check className="w-10 h-10 text-[#567D56] opacity-80" strokeWidth={1.5} />
                <motion.div
                  initial={{ opacity: 0, y: 10, x: -10, rotate: -20 }}
                  animate={{ opacity: [0, 1, 0], y: -30, x: 20, rotate: 20 }}
                  transition={{ duration: 2, delay: 0.3 }}
                  className="absolute"
                >
                  <Feather className="w-5 h-5 text-[#4A4947]/30" strokeWidth={1} />
                </motion.div>
              </motion.div>

              <motion.h2 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-2xl font-serif italic mb-2 text-[#567D56]"
              >
                成功送达
              </motion.h2>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-[13px] opacity-80 px-8 leading-relaxed text-[#4A4947] text-center"
              >
                已安全传输
              </motion.p>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </main>

      {/* Footer */}
      <motion.footer 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 1 }}
        className="absolute bottom-6 sm:bottom-8 left-0 right-0 flex justify-center items-center px-6 sm:px-12 text-[10px] opacity-50 font-medium tracking-widest uppercase text-[#4A4947] z-10"
      >
        <div className="flex space-x-4">
          <a href="#" className="hover:opacity-100 transition-opacity">隐私政策</a>
          <span>/</span>
          <a href="#" className="hover:opacity-100 transition-opacity">使用条款</a>
        </div>
      </motion.footer>

    </div>
  );
}
