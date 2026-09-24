import React, { useState, useEffect, useRef, useCallback } from 'react';

// Types and Enums
type RecorderState = 'idle' | 'recording' | 'paused' | 'encoding' | 'finished';

interface AudioDevice {
  deviceId: string;
  label: string;
}

const BITRATE_OPTIONS = [
  { value: '16', label: '16 kbps (低占用/清晰语音)' },
  { value: '32', label: '32 kbps (标准语音)' },
  { value: '64', label: '64 kbps (高品质语音)' },
  { value: '128', label: '128 kbps (高保真)' },
];

export default function App() {
  const [recordState, setRecordState] = useState<RecorderState>('idle');
  const [recordName, setRecordName] = useState('语音录音');
  const [selectedBitrate, setSelectedBitrate] = useState('16');
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>('');
  const [timerText, setTimerText] = useState('00:00:00');
  const [toastMsg, setToastMsg] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Dropdown UI states
  const [isMicDropdownOpen, setIsMicDropdownOpen] = useState(false);
  const [isBitrateDropdownOpen, setIsBitrateDropdownOpen] = useState(false);

  // Locked record name for current session
  const lockedRecordNameRef = useRef<string>('语音录音');

  // Audio Context & Pipeline Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const encoderWorkerRef = useRef<Worker | null>(null);
  const isWorkerReadyRef = useRef<boolean>(false);

  // Object URL memory management ref
  const currentAudioUrlRef = useRef<string | null>(null);
  const savedFileNameRef = useRef<string>('');

  // Device disconnection & duration continuity tracking
  const isDeviceDisconnectedRef = useRef<boolean>(false);
  const activeDeviceIdRef = useRef<string>('');
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSilenceTickRef = useRef<number>(0);

  // Recording timing refs
  const recordStartTimeRef = useRef<Date | null>(null);
  const totalRecordedMsRef = useRef<number>(0);
  const lastTimerTickRef = useRef<number>(0);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Visualizer canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const barHeightsRef = useRef<Float32Array>(new Float32Array(28).fill(0));
  const globalFreqDataRef = useRef<Uint8Array>(new Uint8Array(128));

  // Sample Rate matched with Bitrate
  const getTargetSampleRate = useCallback((bitrateKbps: number) => {
    if (bitrateKbps <= 32) return 16000;
    if (bitrateKbps <= 64) return 32000;
    return 44100;
  }, []);

  // Linear resampler fallback
  const resampleLinear = (input16: Int16Array, fromRate: number, toRate: number) => {
    if (fromRate === toRate) return input16;
    const ratio = fromRate / toRate;
    const outLength = Math.floor(input16.length / ratio);
    const output = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcIdx = i * ratio;
      const idxFloor = Math.floor(srcIdx);
      const idxCeil = Math.min(idxFloor + 1, input16.length - 1);
      const frac = srcIdx - idxFloor;
      output[i] = Math.round((1 - frac) * input16[idxFloor] + frac * input16[idxCeil]);
    }
    return output;
  };

  // Canvas visualizer rendering
  const drawRoundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  };

  const drawStaticVisualizer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rectWidth = canvas.getBoundingClientRect().width;
    const rectHeight = canvas.getBoundingClientRect().height;
    if (!rectWidth || !rectHeight) return;

    ctx.clearRect(0, 0, rectWidth, rectHeight);

    const totalBars = 28;
    const totalSegs = 8;
    const gapX = 4;
    const barWidth = (rectWidth - (totalBars - 1) * gapX) / totalBars;
    const segGapY = 1.5;
    const segHeight = (rectHeight - (totalSegs - 1) * segGapY) / totalSegs;

    for (let i = 0; i < totalBars; i++) {
      barHeightsRef.current[i] = 0;
      for (let s = 0; s < totalSegs; s++) {
        const segIdxFromBottom = s;
        const x = i * (barWidth + gapX);
        const y = rectHeight - (segIdxFromBottom + 1) * segHeight - segIdxFromBottom * segGapY;

        ctx.fillStyle = (segIdxFromBottom === 0 && recordState === 'idle')
          ? 'rgba(59, 130, 246, 0.25)'
          : 'rgba(255, 255, 255, 0.05)';

        drawRoundedRect(ctx, x, y, barWidth, segHeight, 1.5);
      }
    }
  }, [recordState]);

  const drawVisualizerFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rectWidth = canvas.getBoundingClientRect().width;
    const rectHeight = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, rectWidth, rectHeight);

    if (analyserNodeRef.current && recordState === 'recording' && !isDeviceDisconnectedRef.current) {
      analyserNodeRef.current.getByteFrequencyData(globalFreqDataRef.current);
    } else {
      globalFreqDataRef.current.fill(0);
    }

    const totalBars = 28;
    const totalSegs = 8;
    const gapX = 4;
    const barWidth = (rectWidth - (totalBars - 1) * gapX) / totalBars;
    const segGapY = 1.5;
    const segHeight = (rectHeight - (totalSegs - 1) * segGapY) / totalSegs;

    for (let i = 0; i < totalBars; i++) {
      let targetSegCount = 0;

      if (recordState === 'recording' && !isDeviceDisconnectedRef.current) {
        const fftIdx = Math.floor(Math.pow(i / totalBars, 1.5) * 60) + 1;
        const rawVal = globalFreqDataRef.current[fftIdx] || 0;
        targetSegCount = (rawVal / 255) * totalSegs;
      }

      if (targetSegCount > barHeightsRef.current[i]) {
        barHeightsRef.current[i] += (targetSegCount - barHeightsRef.current[i]) * 0.8;
      } else {
        barHeightsRef.current[i] -= (barHeightsRef.current[i] - targetSegCount) * 0.15;
      }

      const currentActiveSegs = Math.round(barHeightsRef.current[i]);

      for (let s = 0; s < totalSegs; s++) {
        const segIdxFromBottom = s;
        const x = i * (barWidth + gapX);
        const y = rectHeight - (segIdxFromBottom + 1) * segHeight - segIdxFromBottom * segGapY;

        const isActive = segIdxFromBottom < currentActiveSegs;

        if (isActive) {
          if (segIdxFromBottom >= 6) {
            ctx.fillStyle = '#ef4444';
          } else if (segIdxFromBottom >= 4) {
            ctx.fillStyle = '#f59e0b';
          } else {
            ctx.fillStyle = '#3b82f6';
          }
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        }

        drawRoundedRect(ctx, x, y, barWidth, segHeight, 1.5);
      }
    }
  }, [recordState]);

  const renderVisualizerLoop = useCallback(() => {
    if (recordState !== 'recording') {
      animFrameIdRef.current = null;
      return;
    }
    drawVisualizerFrame();
    animFrameIdRef.current = requestAnimationFrame(renderVisualizerLoop);
  }, [recordState, drawVisualizerFrame]);

  // Manage visualizer start / stop based on state
  useEffect(() => {
    if (recordState === 'recording') {
      animFrameIdRef.current = requestAnimationFrame(renderVisualizerLoop);
    } else {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
        animFrameIdRef.current = null;
      }
      drawStaticVisualizer();
    }
    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
        animFrameIdRef.current = null;
      }
    };
  }, [recordState, renderVisualizerLoop, drawStaticVisualizer]);

  // Resize listener for Canvas DPI
  const setupCanvasDPI = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStaticVisualizer();
  }, [drawStaticVisualizer]);

  useEffect(() => {
    setupCanvasDPI();
    window.addEventListener('resize', setupCanvasDPI);
    return () => window.removeEventListener('resize', setupCanvasDPI);
  }, [setupCanvasDPI]);

  // Prevent accidental close
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (recordState === 'recording' || recordState === 'paused') {
        e.preventDefault();
        e.returnValue = '录音正在进行中，关闭或刷新页面将导致数据丢失，确定要离开吗？';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [recordState]);

  // Timer utilities
  const updateTimerDisplay = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    setTimerText(`${pad(hours)}:${pad(minutes)}:${pad(seconds)}`);
  };

  const startTimer = () => {
    lastTimerTickRef.current = Date.now();
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      const now = Date.now();
      totalRecordedMsRef.current += (now - lastTimerTickRef.current);
      lastTimerTickRef.current = now;
      updateTimerDisplay(totalRecordedMsRef.current);
    }, 100);
  };

  const pauseTimer = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    const now = Date.now();
    if (lastTimerTickRef.current) {
      totalRecordedMsRef.current += (now - lastTimerTickRef.current);
      lastTimerTickRef.current = 0;
    }
  };

  const sanitizeFileName = (rawName: string) => {
    if (!rawName) return '录音';
    let sanitized = rawName.replace(/[\\/:*?"<>|]/g, '_');
    sanitized = sanitized.trim().replace(/\s+/g, ' ');
    return sanitized || '录音';
  };

  const generateFileName = (startTime: Date, customName: string) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const year = startTime.getFullYear();
    const month = pad(startTime.getMonth() + 1);
    const day = pad(startTime.getDate());
    const hours = pad(startTime.getHours());
    const minutes = pad(startTime.getMinutes());
    const seconds = pad(startTime.getSeconds());
    const safeName = sanitizeFileName(customName);
    return `${safeName}_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.mp3`;
  };

  const triggerDownload = (url: string, fileName: string) => {
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
  };

  // Silence generator during device disconnection to preserve exact timeline & duration
  const startSilenceFeeder = useCallback(() => {
    if (silenceIntervalRef.current) return;
    lastSilenceTickRef.current = Date.now();
    const kbps = parseInt(selectedBitrate, 10);
    const targetRate = getTargetSampleRate(kbps);

    silenceIntervalRef.current = setInterval(() => {
      if (!isDeviceDisconnectedRef.current) return;
      const now = Date.now();
      const deltaMs = Math.max(1, now - lastSilenceTickRef.current);
      lastSilenceTickRef.current = now;

      const samplesCount = Math.round((targetRate * deltaMs) / 1000);
      if (samplesCount > 0 && encoderWorkerRef.current) {
        const silentPcm = new Int16Array(samplesCount);
        encoderWorkerRef.current.postMessage(
          { cmd: 'encode', buffer: silentPcm.buffer },
          [silentPcm.buffer]
        );
      }
    }, 100);
  }, [selectedBitrate, getTargetSampleRate]);

  const stopSilenceFeeder = useCallback(() => {
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
  }, []);

  // Worker setup with Local priority, CDN fallback, and dual-error handling
  const initEncoderWorker = useCallback(() => {
    if (encoderWorkerRef.current) return;

    const workerSource = `
      let lameLoaded = false;
      try {
        importScripts('/lame.min.js');
        if (typeof lamejs !== 'undefined') {
          lameLoaded = true;
        }
      } catch (errLocal) {
        // Local load failed, proceed to CDN fallback
      }

      if (!lameLoaded) {
        try {
          importScripts('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js');
          if (typeof lamejs !== 'undefined') {
            lameLoaded = true;
          }
        } catch (errCdn) {
          // CDN also failed
        }
      }

      if (!lameLoaded) {
        self.postMessage({
          cmd: 'error',
          error: '无法加载 MP3 编码库，请检查网络或本地文件，避免录音结束后无法下载为 MP3'
        });
      }

      let mp3Encoder = null;
      let mp3Chunks = [];
      let remainderBuffer = new Int16Array(0);

      self.onmessage = function(e) {
          const data = e.data;
          if (data.cmd === 'init') {
              if (typeof lamejs === 'undefined') {
                  self.postMessage({
                      cmd: 'error',
                      error: '无法加载 MP3 编码库，请检查网络或本地文件，避免录音结束后无法下载为 MP3'
                  });
                  return;
              }
              mp3Chunks = [];
              remainderBuffer = new Int16Array(0);
              mp3Encoder = new lamejs.Mp3Encoder(1, data.sampleRate, data.bitrate);
              self.postMessage({ cmd: 'ready' });
          } else if (data.cmd === 'encode') {
              if (!mp3Encoder) return;
              const input = new Int16Array(data.buffer);
              const combined = new Int16Array(remainderBuffer.length + input.length);
              combined.set(remainderBuffer, 0);
              combined.set(input, remainderBuffer.length);

              const CHUNK_SIZE = 1152 * 4;
              let offset = 0;
              while (offset + CHUNK_SIZE <= combined.length) {
                  const chunk = combined.subarray(offset, offset + CHUNK_SIZE);
                  const mp3buf = mp3Encoder.encodeBuffer(chunk);
                  if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
                  offset += CHUNK_SIZE;
              }
              remainderBuffer = combined.subarray(offset);
          } else if (data.cmd === 'finish') {
              if (mp3Encoder) {
                  if (remainderBuffer.length > 0) {
                      const mp3buf = mp3Encoder.encodeBuffer(remainderBuffer);
                      if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
                      remainderBuffer = new Int16Array(0);
                  }
                  const flushBuf = mp3Encoder.flush();
                  if (flushBuf.length > 0) mp3Chunks.push(flushBuf);
                  
                  const blob = new Blob(mp3Chunks, { type: 'audio/mp3' });
                  self.postMessage({ cmd: 'result', blob: blob });
                  mp3Chunks = [];
                  mp3Encoder = null;
              }
          }
      };
    `;

    const blob = new Blob([workerSource], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);

    worker.onmessage = (e) => {
      if (e.data.cmd === 'ready') {
        isWorkerReadyRef.current = true;
      } else if (e.data.cmd === 'error') {
        isWorkerReadyRef.current = false;
        setToastMsg(`⚠ ${e.data.error}`);
      } else if (e.data.cmd === 'result') {
        const resultBlob = e.data.blob as Blob;
        try {
          if (!resultBlob || resultBlob.size === 0) throw new Error('无有效音频数据录入');

          // Release previous object URL to prevent memory leaks
          if (currentAudioUrlRef.current) {
            URL.revokeObjectURL(currentAudioUrlRef.current);
            currentAudioUrlRef.current = null;
          }

          const url = URL.createObjectURL(resultBlob);
          currentAudioUrlRef.current = url;
          const fileName = generateFileName(recordStartTimeRef.current || new Date(), lockedRecordNameRef.current);
          savedFileNameRef.current = fileName;
          setAudioUrl(url);
          triggerDownload(url, fileName);
          setToastMsg('');
          setRecordState('finished');
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          setToastMsg('⚠ ' + message);
          setRecordState('idle');
        }
      }
    };

    worker.onerror = (err) => {
      console.error('Worker 内部错误:', err);
      setToastMsg('⚠ 编码器子线程发生异常，请检查网络或本地文件，避免录音结束后无法下载为 MP3');
    };

    encoderWorkerRef.current = worker;
  }, []);

  // AudioWorklet initialization
  const setupAudioWorklet = async (context: AudioContext) => {
    const workletCode = `
      class RecorderWorklet extends AudioWorkletProcessor {
          constructor() {
              super();
              this.BUFFER_SIZE = 2048;
              this.pcmBuffer = new Int16Array(this.BUFFER_SIZE);
              this.bufIndex = 0;
              this.isRecording = false;

              this.port.onmessage = (e) => {
                  if (e.data.cmd === 'start') {
                      this.isRecording = true;
                  } else if (e.data.cmd === 'pause') {
                      this.isRecording = false;
                      this.flushBuffer();
                  } else if (e.data.cmd === 'flush') {
                      this.isRecording = false;
                      this.flushBuffer();
                      this.port.postMessage({ cmd: 'flushed' });
                  }
              };
          }

          flushBuffer() {
              if (this.bufIndex > 0) {
                  const trimmed = this.pcmBuffer.slice(0, this.bufIndex);
                  this.port.postMessage(trimmed.buffer, [trimmed.buffer]);
                  this.bufIndex = 0;
              }
          }

          process(inputs) {
              if (!this.isRecording) return true;
              const input = inputs[0];
              if (input && input.length > 0) {
                  const channelData = input[0];
                  for (let i = 0; i < channelData.length; i++) {
                      let s = Math.max(-1, Math.min(1, channelData[i]));
                      this.pcmBuffer[this.bufIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                      if (this.bufIndex >= this.BUFFER_SIZE) {
                          const copy = new Int16Array(this.pcmBuffer);
                          this.port.postMessage(copy.buffer, [copy.buffer]);
                          this.bufIndex = 0;
                      }
                  }
              }
              return true;
          }
      }
      registerProcessor('recorder-worklet', RecorderWorklet);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    await context.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
  };

  const handleWorkletAudioData = (buffer: ArrayBuffer, targetRate: number) => {
    if (!encoderWorkerRef.current || !audioCtxRef.current) return;
    if (isDeviceDisconnectedRef.current) return;

    let pcmData = new Int16Array(buffer);
    if (audioCtxRef.current.sampleRate !== targetRate) {
      pcmData = resampleLinear(pcmData, audioCtxRef.current.sampleRate, targetRate);
    }

    encoderWorkerRef.current.postMessage(
      { cmd: 'encode', buffer: pcmData.buffer },
      [pcmData.buffer]
    );
  };

  // Keep latest state accessible in async callbacks and listeners without re-triggering effects
  const recordStateRef = useRef<RecorderState>('idle');
  recordStateRef.current = recordState;

  const selectedBitrateRef = useRef<string>(selectedBitrate);
  selectedBitrateRef.current = selectedBitrate;

  const switchMicStreamRef = useRef<(newDeviceId?: string, isManualSwitch?: boolean) => Promise<boolean>>(() => Promise.resolve(false));
  const refreshMicListRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Handle device unplugged during recording/pausing without interrupting recording duration
  const handleDeviceUnplugged = useCallback(() => {
    isDeviceDisconnectedRef.current = true;
    setToastMsg('⚠ 检测不到录音设备，请重新接入原设备或手动选择可用设备。');

    // If recording is active, do not pause or stop! Keep duration intact via silence generator
    if (recordStateRef.current === 'recording') {
      startSilenceFeeder();
    }
  }, [startSilenceFeeder]);

  // Stream switching & setup with Anti-Aliasing Lowpass Filter
  const switchMicStream = useCallback(async (newDeviceId?: string, isManualSwitch = false) => {
    let newStream: MediaStream | null = null;
    try {
      const kbps = parseInt(selectedBitrateRef.current, 10);
      const targetRate = getTargetSampleRate(kbps);

      if (audioCtxRef.current && audioCtxRef.current.sampleRate !== targetRate) {
        await audioCtxRef.current.close();
        audioCtxRef.current = null;
        workletNodeRef.current = null;
        filterNodeRef.current = null;
        analyserNodeRef.current = null;
      }

      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: newDeviceId ? { exact: newDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        },
      };

      newStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (!audioCtxRef.current) {
        const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        try {
          audioCtxRef.current = new AudioCtxClass({ sampleRate: targetRate });
        } catch {
          audioCtxRef.current = new AudioCtxClass();
        }
        await setupAudioWorklet(audioCtxRef.current);
      }

      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }

      // Anti-Aliasing Lowpass Filter if hardware sampleRate > targetRate
      if (audioCtxRef.current.sampleRate > targetRate) {
        if (!filterNodeRef.current) {
          const filter = audioCtxRef.current.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.setValueAtTime(targetRate * 0.45, audioCtxRef.current.currentTime);
          filter.Q.setValueAtTime(0.707, audioCtxRef.current.currentTime);
          filterNodeRef.current = filter;
        }
      } else {
        if (filterNodeRef.current) {
          filterNodeRef.current.disconnect();
          filterNodeRef.current = null;
        }
      }

      if (!analyserNodeRef.current) {
        analyserNodeRef.current = audioCtxRef.current.createAnalyser();
        analyserNodeRef.current.fftSize = 256;
        analyserNodeRef.current.smoothingTimeConstant = 0.3;
      }

      if (!workletNodeRef.current) {
        workletNodeRef.current = new AudioWorkletNode(audioCtxRef.current, 'recorder-worklet');
        workletNodeRef.current.port.onmessage = (e) => {
          if (e.data && e.data.byteLength) {
            handleWorkletAudioData(e.data, targetRate);
          }
        };
      }

      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }

      sourceNodeRef.current = audioCtxRef.current.createMediaStreamSource(newStream);

      // Connect pipeline with low-pass filter if active
      if (filterNodeRef.current) {
        sourceNodeRef.current.connect(filterNodeRef.current);
        filterNodeRef.current.connect(analyserNodeRef.current);
        filterNodeRef.current.connect(workletNodeRef.current);
      } else {
        sourceNodeRef.current.connect(analyserNodeRef.current);
        sourceNodeRef.current.connect(workletNodeRef.current);
      }

      if (currentStreamRef.current) {
        currentStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      currentStreamRef.current = newStream;
      const actualDeviceId = newDeviceId || (newStream.getAudioTracks()[0] ? newStream.getAudioTracks()[0].getSettings().deviceId : '');
      if (actualDeviceId) {
        setActiveDeviceId(actualDeviceId);
        activeDeviceIdRef.current = actualDeviceId;
      }

      // Device successfully acquired or recovered! Stop silence feeder and clear warning
      isDeviceDisconnectedRef.current = false;
      stopSilenceFeeder();
      setToastMsg('');

      const tracks = newStream.getAudioTracks();
      if (tracks.length > 0) {
        tracks[0].onended = () => {
          handleDeviceUnplugged();
        };
      }

      return true;
    } catch (err) {
      console.error('切换麦克风失败:', err);
      if (newStream) {
        newStream.getTracks().forEach((track) => track.stop());
      }
      if (isManualSwitch) {
        setToastMsg('⚠ 无法连接所选麦克风，请重试。');
      }
      return false;
    }
  }, [getTargetSampleRate, stopSilenceFeeder, handleDeviceUnplugged]);

  switchMicStreamRef.current = switchMicStream;

  // Device list refresh & Auto-recovery listener (stable, zero reactive dependencies)
  const refreshMicList = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices.filter((d) => d.kind === 'audioinput');

      if (audioInputs.length === 0) {
        setDevices([]);
        if (recordStateRef.current === 'recording' || recordStateRef.current === 'paused') {
          handleDeviceUnplugged();
        }
        return;
      }

      const formatted: AudioDevice[] = audioInputs.map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || (d.deviceId === 'default' ? '默认麦克风' : `麦克风输入 ${index + 1}`),
      }));

      setDevices(formatted);

      // Check if previously active device is present
      const previousDeviceId = activeDeviceIdRef.current;
      const isOriginalDevicePresent = formatted.some((d) => d.deviceId === previousDeviceId);

      if (isDeviceDisconnectedRef.current && isOriginalDevicePresent && previousDeviceId) {
        // Original device reconnected! Re-bind without user intervention
        await switchMicStreamRef.current(previousDeviceId);
      } else if (!previousDeviceId && formatted.length > 0) {
        const defaultDev = formatted.find((d) => d.deviceId === 'default') || formatted[0];
        setActiveDeviceId(defaultDev.deviceId);
        activeDeviceIdRef.current = defaultDev.deviceId;
      }
    } catch (err) {
      console.error('设备列表枚举失败:', err);
    }
  }, [handleDeviceUnplugged]);

  refreshMicListRef.current = refreshMicList;

  // Request mic permission on mount STRICTLY ONCE
  useEffect(() => {
    let isMounted = true;

    async function initMic() {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach((t) => t.stop());
        if (!isMounted) return;
        await refreshMicListRef.current();
      } catch (err: unknown) {
        if (!isMounted) return;
        console.error('权限请求失败:', err);
        const name = (err as { name?: string }).name;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setToastMsg('⚠ 无法访问麦克风，请允许网页使用麦克风权限。');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          setToastMsg('⚠ 未检测到可用的麦克风设备。');
        } else {
          setToastMsg('⚠ 麦克风初始化失败。');
        }
      }
    }

    initMic();
    initEncoderWorker();

    const handleDeviceChange = () => {
      refreshMicListRef.current();
    };
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange);
    return () => {
      isMounted = false;
      navigator.mediaDevices?.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [initEncoderWorker]);

  // Clean audio resources
  const releaseAudioResources = () => {
    stopSilenceFeeder();
    if (currentStreamRef.current) {
      currentStreamRef.current.getTracks().forEach((t) => t.stop());
      currentStreamRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (filterNodeRef.current) {
      filterNodeRef.current.disconnect();
      filterNodeRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current = null;
    }
    if (analyserNodeRef.current) {
      analyserNodeRef.current.disconnect();
      analyserNodeRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      releaseAudioResources();
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }
      if (encoderWorkerRef.current) {
        encoderWorkerRef.current.terminate();
        encoderWorkerRef.current = null;
      }
    };
  }, []);

  // Action handlers
  const handleStart = async () => {
    // Lock file name strictly at the moment recording begins
    const confirmedName = recordName.trim() || '语音录音';
    lockedRecordNameRef.current = confirmedName;

    setToastMsg('');
    setAudioUrl(null);
    initEncoderWorker();

    const kbps = parseInt(selectedBitrate, 10);
    const targetRate = getTargetSampleRate(kbps);

    encoderWorkerRef.current?.postMessage({
      cmd: 'init',
      sampleRate: targetRate,
      bitrate: kbps,
    });

    totalRecordedMsRef.current = 0;
    updateTimerDisplay(0);

    const ok = await switchMicStream(activeDeviceId);
    if (!ok || !currentStreamRef.current) {
      setToastMsg('⚠ 无法开启麦克风，请检查麦克风权限或设备连接。');
      return;
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ cmd: 'start' });
    }

    recordStartTimeRef.current = new Date();
    startTimer();
    setRecordState('recording');
  };

  const handlePause = () => {
    pauseTimer();
    stopSilenceFeeder();
    if (currentStreamRef.current) {
      currentStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ cmd: 'pause' });
    }
    setRecordState('paused');
  };

  const handleResume = async () => {
    setToastMsg('');
    let isStreamValid = false;

    if (!isDeviceDisconnectedRef.current && currentStreamRef.current && currentStreamRef.current.getAudioTracks().length > 0) {
      const track = currentStreamRef.current.getAudioTracks()[0];
      if (track && track.readyState === 'live') {
        track.enabled = true;
        isStreamValid = true;
      }
    }

    if (!isStreamValid && !isDeviceDisconnectedRef.current) {
      const reconnected = await switchMicStream(activeDeviceId);
      if (!reconnected) {
        handleDeviceUnplugged();
      }
    }

    if (isDeviceDisconnectedRef.current) {
      startSilenceFeeder();
    } else if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ cmd: 'start' });
    }

    startTimer();
    setRecordState('recording');
  };

  const handleStop = async () => {
    pauseTimer();
    stopSilenceFeeder();
    setRecordState('encoding');

    // Flush worklet buffer and ensure all remaining frames reach the worker before finishing
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ cmd: 'flush' });
    }

    if (currentStreamRef.current) {
      currentStreamRef.current.getTracks().forEach((track) => track.stop());
      currentStreamRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    setToastMsg('正在导出 MP3 文件...');

    // Wait a brief tick (60ms) for worklet flushed samples to transfer to worker
    setTimeout(() => {
      encoderWorkerRef.current?.postMessage({ cmd: 'finish' });
    }, 60);
  };

  const handleManualDownload = () => {
    if (audioUrl && savedFileNameRef.current) {
      triggerDownload(audioUrl, savedFileNameRef.current);
    }
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handleOutsideClick = () => {
      setIsMicDropdownOpen(false);
      setIsBitrateDropdownOpen(false);
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  const activeDeviceObj = devices.find((d) => d.deviceId === activeDeviceId);
  const activeDeviceLabel = activeDeviceObj ? activeDeviceObj.label : (devices.length > 0 ? devices[0].label : '正在检测设备...');
  const activeBitrateObj = BITRATE_OPTIONS.find((b) => b.value === selectedBitrate) || BITRATE_OPTIONS[0];

  return (
    <main className="w-full max-w-xl glass-card rounded-2xl glow-effect p-6 md:p-8 flex flex-col gap-6 text-slate-100">
      {/* Header Section */}
      <header className="flex items-center justify-between border-b border-slate-700/50 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center border border-blue-500/30">
            <i className="fa-solid fa-microphone-lines text-xl"></i>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100 tracking-tight">录音机</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Version Badge updated to v1.8.1 */}
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/60">
            v1.8.1
          </span>
          {/* Status Badge */}
          <div className="px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                recordState === 'recording'
                  ? 'bg-red-500 recording-pulse'
                  : recordState === 'paused'
                  ? 'bg-amber-500'
                  : recordState === 'encoding'
                  ? 'bg-blue-500 animate-ping'
                  : recordState === 'finished'
                  ? 'bg-emerald-500'
                  : 'bg-slate-500'
              }`}
            />
            <span>
              {recordState === 'recording' && '正在录音'}
              {recordState === 'paused' && '已暂停'}
              {recordState === 'encoding' && '打包中...'}
              {recordState === 'finished' && '完成'}
              {recordState === 'idle' && '就绪'}
            </span>
          </div>
        </div>
      </header>

      {/* Toast Alert Box */}
      {toastMsg && (
        <div className="px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2 transition-all">
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Controls Form Panel */}
      <section className="flex flex-col gap-4">
        {/* File Name Input */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="recordName" className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
            <i className="fa-solid fa-pen-to-square text-slate-400"></i> 录音文件名
          </label>
          <input
            type="text"
            id="recordName"
            value={recordName}
            onChange={(e) => setRecordName(e.target.value)}
            placeholder="请输入文件名..."
            disabled={recordState === 'recording' || recordState === 'paused' || recordState === 'encoding'}
            className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/60 border border-slate-700/60 text-sm text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        {/* Microphone & Bitrate Selection: 固定双列并排 */}
        <div className="grid grid-cols-2 gap-3 md:gap-4">
          {/* Microphone Selection */}
          <div className="flex flex-col gap-1.5 min-w-0">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5 truncate">
              <i className="fa-solid fa-microphone text-slate-400"></i> 输入设备
            </label>
            <div className="relative select-none">
              <button
                type="button"
                onClick={(e) => {
                  if (recordState === 'encoding') return;
                  e.stopPropagation();
                  setIsBitrateDropdownOpen(false);
                  setIsMicDropdownOpen(!isMicDropdownOpen);
                }}
                disabled={recordState === 'encoding'}
                className="w-full px-3.5 py-2.5 rounded-xl text-xs text-slate-200 flex items-center justify-between text-left bg-slate-900/60 border border-white/10 hover:border-white/25 hover:bg-slate-900/80 transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                <span className="truncate">{activeDeviceLabel}</span>
                <i className="fa-solid fa-chevron-down text-slate-400 text-xs ml-1 shrink-0"></i>
              </button>

              {isMicDropdownOpen && (
                <div className="absolute top-[calc(100%+6px)] left-0 right-0 bg-[#0f172a] border border-white/12 rounded-xl shadow-2xl z-50 max-h-52 overflow-y-auto select-dropdown-scroll">
                  {devices.length === 0 ? (
                    <div className="px-4 py-2.5 text-xs text-slate-400">未检测到麦克风</div>
                  ) : (
                    devices.map((device) => (
                      <div
                        key={device.deviceId}
                        onClick={async (e) => {
                          e.stopPropagation();
                          setActiveDeviceId(device.deviceId);
                          activeDeviceIdRef.current = device.deviceId;
                          setIsMicDropdownOpen(false);
                          if (recordState === 'recording' || recordState === 'paused') {
                            await switchMicStream(device.deviceId, true);
                          }
                        }}
                        className={`px-4 py-2.5 text-xs cursor-pointer truncate transition-colors ${
                          activeDeviceId === device.deviceId
                            ? 'bg-blue-600/25 text-blue-400 font-medium'
                            : 'text-slate-300 hover:bg-blue-500/15 hover:text-white'
                        }`}
                        title={device.label}
                      >
                        {device.label}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Bitrate Selection */}
          <div className="flex flex-col gap-1.5 min-w-0">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5 truncate">
              <i className="fa-solid fa-sliders text-slate-400"></i> 编码比特率
            </label>
            <div className="relative select-none">
              <button
                type="button"
                onClick={(e) => {
                  if (recordState !== 'idle' && recordState !== 'finished') return;
                  e.stopPropagation();
                  setIsMicDropdownOpen(false);
                  setIsBitrateDropdownOpen(!isBitrateDropdownOpen);
                }}
                disabled={recordState !== 'idle' && recordState !== 'finished'}
                className="w-full px-3.5 py-2.5 rounded-xl text-xs text-slate-200 flex items-center justify-between text-left bg-slate-900/60 border border-white/10 hover:border-white/25 hover:bg-slate-900/80 transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                <span className="truncate">{activeBitrateObj.label}</span>
                <i className="fa-solid fa-chevron-down text-slate-400 text-xs ml-1 shrink-0"></i>
              </button>

              {isBitrateDropdownOpen && (
                <div className="absolute top-[calc(100%+6px)] left-0 right-0 bg-[#0f172a] border border-white/12 rounded-xl shadow-2xl z-50 max-h-52 overflow-y-auto select-dropdown-scroll">
                  {BITRATE_OPTIONS.map((opt) => (
                    <div
                      key={opt.value}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedBitrate(opt.value);
                        setIsBitrateDropdownOpen(false);
                      }}
                      className={`px-4 py-2.5 text-xs cursor-pointer truncate transition-colors ${
                        selectedBitrate === opt.value
                          ? 'bg-blue-600/25 text-blue-400 font-medium'
                          : 'text-slate-300 hover:bg-blue-500/15 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Audio Visualizer Canvas & Timer Segment */}
      <section className="flex flex-col items-center justify-center bg-slate-900/80 rounded-xl p-4 md:p-5 border border-slate-800 gap-3">
        {/* Timer Display */}
        <div className="text-4xl md:text-5xl font-mono font-bold tracking-wider text-slate-100 drop-shadow-md">
          {timerText}
        </div>

        {/* Equalizer Visualizer Canvas */}
        <div className="w-full h-14 relative flex items-center justify-center">
          <canvas ref={canvasRef} className="w-full h-full block"></canvas>
        </div>
      </section>

      {/* Control Action Buttons */}
      <section className="flex items-center justify-center gap-4 py-2">
        {/* Start Button (Visible on Idle or Finished) */}
        {(recordState === 'idle' || recordState === 'finished') && (
          <button
            onClick={handleStart}
            className="cursor-pointer px-6 py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-blue-600/30 transition-all"
          >
            <i className="fa-solid fa-circle text-xs text-red-400"></i> 开始录音
          </button>
        )}

        {/* Pause Button (Visible on Recording) */}
        {recordState === 'recording' && (
          <button
            onClick={handlePause}
            className="cursor-pointer px-6 py-3.5 rounded-xl bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-amber-600/30 transition-all"
          >
            <i className="fa-solid fa-pause"></i> 暂停录音
          </button>
        )}

        {/* Resume Button (Visible on Paused) */}
        {recordState === 'paused' && (
          <button
            onClick={handleResume}
            className="cursor-pointer px-6 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-emerald-600/30 transition-all"
          >
            <i className="fa-solid fa-play"></i> 继续录音
          </button>
        )}

        {/* Stop Button (Visible on Recording or Paused) */}
        {(recordState === 'recording' || recordState === 'paused') && (
          <button
            onClick={handleStop}
            className="cursor-pointer px-6 py-3.5 rounded-xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-rose-600/30 transition-all"
          >
            <i className="fa-solid fa-square"></i> 停止录制
          </button>
        )}

        {/* Download Button (Visible on Finished) */}
        {recordState === 'finished' && audioUrl && (
          <button
            onClick={handleManualDownload}
            className="cursor-pointer px-6 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-indigo-600/30 transition-all"
          >
            <i className="fa-solid fa-download"></i> 下载 MP3
          </button>
        )}
      </section>

      {/* Bottom Preview Audio Player Container */}
      {recordState === 'finished' && audioUrl && (
        <section className="flex flex-col gap-2 pt-2 border-t border-slate-700/50">
          <span className="text-xs text-slate-400 flex items-center gap-1.5">
            <i className="fa-solid fa-circle-check text-emerald-400"></i> 录音完成，可直接预览播放：
          </span>
          <audio controls src={audioUrl} className="w-full h-10 rounded-lg accent-blue-500 bg-slate-900" />
        </section>
      )}
    </main>
  );
}
