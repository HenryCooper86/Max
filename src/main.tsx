import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import { HelmetVisual } from "./components/HelmetVisual";
import { ArcGauge, Compass, SignalBars } from "./components/Instruments";
import { QuickPhrases } from "./components/QuickPhrases";
import { SUPPORTED_LANGUAGE_MESSAGE, isSupportedLanguageText } from "../shared/language";
import "./styles.css";

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionEvent = {
  resultIndex?: number;
  results: ArrayLike<{
    0: {
      transcript: string;
    };
    isFinal: boolean;
  }>;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type AgentEvent =
  | { type: "session.started"; provider: string; mode: string }
  | { type: "status"; state: string; detail: string }
  | { type: "transcript"; speaker: "rider" | "agent"; text: string; final?: boolean }
  | { type: "metric"; noiseDb: number; latencyMs: number }
  | { type: "error"; message: string };

type TranscriptItem = {
  id: number;
  speaker: "rider" | "agent";
  text: string;
};

// Messages posted from public/pcm-worklet.js.
type WorkletMessage = { type: "frame"; pcm: ArrayBuffer } | { type: "level"; value: number };

const SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const MAX_RECONNECT_ATTEMPTS = 6;

function selectChineseFemaleVoice() {
  const voices = window.speechSynthesis.getVoices();
  const zhVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("zh"));
  return (
    zhVoices.find((voice) => /female|女|xiaoxiao|xiaoyi|tingting|jupiter/i.test(`${voice.name} ${voice.voiceURI}`)) ??
    zhVoices[0] ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ??
    voices[0]
  );
}

function createAgentSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${window.location.host}/agent`);
}

function useHelmetAgent() {
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("离线");
  const [provider, setProvider] = useState("mock");
  const [noiseDb, setNoiseDb] = useState(42);
  const [latencyMs, setLatencyMs] = useState(0);
  const [commandText, setCommandText] = useState("");
  const [arkBusy, setArkBusy] = useState(false);
  const [speechListening, setSpeechListening] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const transmittingRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const speechRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechContinuousRef = useRef(false);
  const speechBufferRef = useRef("");
  const speechFlushTimerRef = useRef<number | null>(null);
  const arkBusyRef = useRef(false);

  const pushTranscript = useCallback((speaker: "rider" | "agent", text: string) => {
    setTranscript((items) => [...items.slice(-7), { id: Date.now() + Math.random(), speaker, text }]);
  }, []);

  const clearSpeechFlushTimer = useCallback(() => {
    if (speechFlushTimerRef.current) window.clearTimeout(speechFlushTimerRef.current);
    speechFlushTimerRef.current = null;
  }, []);

  const stopSpeechCapture = useCallback(() => {
    speechContinuousRef.current = false;
    clearSpeechFlushTimer();
    speechBufferRef.current = "";
    speechRef.current?.stop();
    setSpeechListening(false);
  }, [clearSpeechFlushTimer]);

  // Barge-in: silence whatever the agent is currently saying so the rider can
  // interrupt. Covers both browser TTS and queued Doubao voice audio.
  const stopAgentSpeech = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    for (const source of playbackSourcesRef.current) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* source already finished */
      }
    }
    playbackSourcesRef.current = [];
    if (playbackContextRef.current) {
      playbackCursorRef.current = playbackContextRef.current.currentTime;
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    const voice = selectChineseFemaleVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    utterance.pitch = 1.06;
    window.speechSynthesis.speak(utterance);
  }, []);

  const playPcm16 = useCallback((audioData: ArrayBuffer) => {
    const audioContext = playbackContextRef.current ?? new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    playbackContextRef.current = audioContext;

    const pcm = new Int16Array(audioData);
    if (!pcm.length) return;

    const buffer = audioContext.createBuffer(1, pcm.length, PLAYBACK_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = Math.max(-1, Math.min(1, pcm[i] / 0x8000));
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    if (audioContext.state === "suspended") void audioContext.resume();

    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter((item) => item !== source);
    };
    playbackSourcesRef.current.push(source);

    const startAt = Math.max(audioContext.currentTime, playbackCursorRef.current);
    source.start(startAt);
    playbackCursorRef.current = startAt + buffer.duration;
  }, []);

  const connect = useCallback(() => {
    const existing = socketRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }
    intentionalCloseRef.current = false;
    setStatus(reconnectAttemptsRef.current > 0 ? `重新连接中…（第 ${reconnectAttemptsRef.current} 次）` : "连接中");

    const socket = createAgentSocket();
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      setStatus("就绪");
      socket.send(JSON.stringify({ type: "session.start", sampleRate: SAMPLE_RATE, channels: 1 }));
      // Resume the audio stream if the rider was transmitting before the drop.
      if (transmittingRef.current) socket.send(JSON.stringify({ type: "audio.start" }));
    });

    socket.addEventListener("message", (message) => {
      if (message.data instanceof ArrayBuffer) {
        playPcm16(message.data);
        return;
      }

      try {
        const event = JSON.parse(String(message.data)) as AgentEvent;
        if (event.type === "session.started") {
          setProvider(event.provider);
          setStatus(event.mode === "mock" ? "模拟路线已启用" : "豆包实时语音在线");
        }
        if (event.type === "status") setStatus(event.detail);
        if (event.type === "transcript") {
          if (event.speaker === "rider") stopAgentSpeech();
          pushTranscript(event.speaker, event.text);
          if (event.speaker === "agent" && event.final !== false) speak(event.text);
        }
        if (event.type === "metric") {
          setNoiseDb(event.noiseDb);
          setLatencyMs(event.latencyMs);
        }
        if (event.type === "error") setStatus(event.message);
      } catch {
        setStatus("收到异常代理消息");
      }
    });

    socket.addEventListener("close", () => {
      setConnected(false);
      if (socketRef.current === socket) socketRef.current = null;
      if (intentionalCloseRef.current) {
        setStatus("离线");
        return;
      }

      // Unexpected drop: reconnect with exponential backoff.
      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current = 0;
        setStatus("语音中继连接失败，请点击连接重试");
        return;
      }
      const delay = Math.min(8000, 1000 * 2 ** (reconnectAttemptsRef.current - 1));
      setStatus(`连接已断开，${Math.round(delay / 1000)} 秒后自动重连…`);
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
    });

    socket.addEventListener("error", () => {
      setStatus("连接错误");
    });
  }, [playPcm16, pushTranscript, speak, stopAgentSpeech]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const waitForSocket = useCallback(async () => {
    connect();
    const socket = socketRef.current;
    if (!socket) throw new Error("语音连接未创建");
    if (socket.readyState === WebSocket.OPEN) return socket;

    return new Promise<WebSocket>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve(socket);
      };
      const handleError = () => {
        cleanup();
        reject(new Error("语音连接打开失败"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
  }, [connect]);

  // Acquire the mic + AudioWorklet graph once and reuse it across PtT presses.
  const ensureMic = useCallback(async () => {
    if (streamRef.current && audioContextRef.current && workletNodeRef.current) {
      if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const audioContext = new AudioContext();
    if (!audioContext.audioWorklet) {
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
      throw new Error("此浏览器不支持 AudioWorklet 麦克风采集");
    }

    await audioContext.audioWorklet.addModule("/pcm-worklet.js");
    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit"
    });

    workletNode.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data;
      if (message.type === "frame") {
        if (!transmittingRef.current) return;
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(message.pcm);
      } else if (message.type === "level") {
        setVoiceLevel(transmittingRef.current ? message.value : 0);
      }
    };

    source.connect(workletNode);
    workletNode.connect(audioContext.destination);

    streamRef.current = stream;
    audioContextRef.current = audioContext;
    workletNodeRef.current = workletNode;
  }, []);

  const releaseMic = useCallback(() => {
    transmittingRef.current = false;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setVoiceLevel(0);
  }, []);

  const startMic = useCallback(async () => {
    try {
      const socket = await waitForSocket();
      await ensureMic();
      stopAgentSpeech();
      streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = true));
      transmittingRef.current = true;
      setListening(true);
      setStatus("正在收听");
      socket.send(JSON.stringify({ type: "audio.start" }));
    } catch (error) {
      transmittingRef.current = false;
      setListening(false);
      setStatus(error instanceof Error ? error.message : "无法访问麦克风");
    }
  }, [ensureMic, stopAgentSpeech, waitForSocket]);

  // Stops transmitting but keeps the audio graph alive (the track is disabled,
  // so no real audio is captured) for an instant restart on the next press.
  const stopMic = useCallback(() => {
    transmittingRef.current = false;
    streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = false));
    setVoiceLevel(0);
    setListening(false);
    stopSpeechCapture();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.stop" }));
    }
  }, [stopSpeechCapture]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    stopMic();
    releaseMic();
    stopAgentSpeech();
    if (playbackContextRef.current) {
      void playbackContextRef.current.close();
      playbackContextRef.current = null;
    }
    playbackCursorRef.current = 0;
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
    setStatus("离线");
  }, [releaseMic, stopAgentSpeech, stopMic]);

  const submitCommand = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? commandText).trim();
      if (!text || arkBusyRef.current) return;

      stopAgentSpeech();
      pushTranscript("rider", text);
      setCommandText("");
      if (!isSupportedLanguageText(text)) {
        pushTranscript("agent", SUPPORTED_LANGUAGE_MESSAGE);
        speak(SUPPORTED_LANGUAGE_MESSAGE);
        setStatus("语言不支持");
        return;
      }

      arkBusyRef.current = true;
      setArkBusy(true);
      setStatus("Ark 正在思考");
      const startedAt = performance.now();

      try {
        const response = await fetch("/ark/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
        const payload = (await response.json()) as { reply?: string; error?: string; fallback?: boolean };
        if (!response.ok) throw new Error(payload.error ?? "Ark 请求失败");
        const reply = payload.reply ?? "";
        pushTranscript("agent", reply);
        speak(reply);
        setProvider("ark");
        setLatencyMs(Math.round(performance.now() - startedAt));
        setStatus(payload.fallback ? "本地备用回复已就绪" : "Ark 回复已就绪");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Ark 请求失败";
        const reply = `我听到了，但暂时无法连接 Ark：${message}`;
        pushTranscript("agent", reply);
        speak(reply);
        setStatus(message);
      } finally {
        arkBusyRef.current = false;
        setArkBusy(false);
      }
    },
    [commandText, pushTranscript, speak, stopAgentSpeech]
  );

  const flushSpeechCommand = useCallback(() => {
    clearSpeechFlushTimer();
    const text = speechBufferRef.current.trim().replace(/\s+/g, " ");
    speechBufferRef.current = "";
    if (!text) return;
    setCommandText(text);
    void submitCommand(text);
  }, [clearSpeechFlushTimer, submitCommand]);

  function startSpeechCapture(continuous: boolean) {
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus("此浏览器不支持语音识别");
      return;
    }

    stopAgentSpeech();
    speechContinuousRef.current = continuous;
    clearSpeechFlushTimer();
    speechBufferRef.current = "";
    speechRef.current?.stop();

    const recognition = new SpeechRecognition();
    speechRef.current = recognition;
    recognition.continuous = continuous;
    recognition.interimResults = continuous;
    recognition.lang = "zh-CN";
    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      const startIndex = event.resultIndex ?? 0;
      const newResults = results.slice(startIndex);
      const finalText = newResults
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();

      if (!continuous) {
        const command = (finalText || results.map((result) => result[0]?.transcript ?? "").join(" ")).trim();
        setCommandText(command);
        void submitCommand(command);
        return;
      }

      if (finalText) {
        speechBufferRef.current = `${speechBufferRef.current} ${finalText}`.trim();
      }

      const interimText = newResults
        .filter((result) => !result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      setCommandText(`${speechBufferRef.current} ${interimText}`.trim());

      if (speechBufferRef.current) {
        clearSpeechFlushTimer();
        speechFlushTimerRef.current = window.setTimeout(flushSpeechCommand, 1300);
      }
    };
    recognition.onerror = () => {
      setSpeechListening(false);
      if (!continuous) setStatus("语音指令失败");
    };
    recognition.onend = () => {
      setSpeechListening(false);
      if (speechContinuousRef.current) {
        window.setTimeout(() => {
          try {
            recognition.start();
            setSpeechListening(true);
          } catch {
            setStatus("语音识别重启失败");
          }
        }, 250);
      }
    };
    setSpeechListening(true);
    setStatus(continuous ? "正在使用 Ark 语音备用模式收听" : "正在收听指令");
    recognition.start();
  }

  const startSpeechCommand = () => startSpeechCapture(false);

  useEffect(
    () => () => {
      stopSpeechCapture();
      disconnect();
    },
    [disconnect, stopSpeechCapture]
  );

  return {
    connected,
    listening,
    status,
    provider,
    noiseDb,
    latencyMs,
    commandText,
    arkBusy,
    speechListening,
    voiceLevel,
    transcript,
    setCommandText,
    connect,
    startMic,
    stopMic,
    disconnect,
    submitCommand,
    startSpeechCommand
  };
}

function App() {
  const agent = useHelmetAgent();
  const [pttActive, setPttActive] = useState(false);
  const pttActiveRef = useRef(false);
  const pttOwnsMicRef = useRef(false);

  const agentState = useMemo(() => {
    if (agent.listening) return "收听中";
    if (agent.connected) return "待命";
    return "离线";
  }, [agent.connected, agent.listening]);

  const latencyTone = agent.latencyMs < 140 ? "good" : agent.latencyMs < 280 ? "warn" : "alert";

  const handleTalkStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (pttActiveRef.current) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pttActiveRef.current = true;
      setPttActive(true);
      // Only this press should release the mic if it was not already live.
      if (!agent.listening) {
        pttOwnsMicRef.current = true;
        void agent.startMic();
      } else {
        pttOwnsMicRef.current = false;
      }
    },
    [agent]
  );

  const handleTalkEnd = useCallback(() => {
    if (!pttActiveRef.current) return;
    pttActiveRef.current = false;
    setPttActive(false);
    if (pttOwnsMicRef.current) {
      agent.stopMic();
      pttOwnsMicRef.current = false;
    }
  }, [agent]);

  return (
    <main className="shell">
      <section className="visor" aria-label="头盔语音助手座舱">
        <div className="topbar">
          <div className="brand">
            <svg className="logoMark" viewBox="0 0 44 44" aria-hidden="true">
              <path className="logoShell" d="M8 24a14 14 0 0 1 28 0v4a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z" />
              <rect className="logoVisor" x="13" y="18" width="22" height="7" rx="3.5" />
            </svg>
            <div>
              <p className="eyebrow">HCT Helmet OS</p>
              <h1>Max 摩托车头盔 AI</h1>
            </div>
          </div>
          <div className={`signal ${agent.connected ? "online" : ""}`}>
            <span />
            {agent.provider.toUpperCase()}
          </div>
        </div>

        <div className="grid">
          <section className="hudPanel helmetPanel">
            <HelmetVisual connected={agent.connected} listening={agent.listening} voiceLevel={agent.voiceLevel} />
            <div className="primaryControls">
              <button className="mainButton" onClick={agent.listening ? agent.stopMic : agent.startMic} type="button">
                {agent.listening ? "静音麦克风" : "开始语音"}
              </button>
              <button
                className={`talkButton ${pttActive ? "active" : ""}`}
                type="button"
                onPointerDown={handleTalkStart}
                onPointerUp={handleTalkEnd}
                onPointerLeave={handleTalkEnd}
                onPointerCancel={handleTalkEnd}
              >
                {pttActive ? "松开结束" : "按住说话"}
              </button>
              <button
                className="ghostButton"
                onClick={agent.connected ? agent.disconnect : agent.connect}
                type="button"
              >
                {agent.connected ? "断开" : "连接"}
              </button>
            </div>
            <QuickPhrases onSelect={(text) => void agent.submitCommand(text)} disabled={agent.arkBusy} />
            <form
              className="commandBar"
              onSubmit={(event) => {
                event.preventDefault();
                void agent.submitCommand();
              }}
            >
              <input
                aria-label="骑手指令"
                placeholder="问 Max：回家路线、前方天气、最近加油站..."
                value={agent.commandText}
                onChange={(event) => agent.setCommandText(event.target.value)}
              />
              <button className="ghostButton" type="button" onClick={agent.startSpeechCommand}>
                {agent.speechListening ? "收听中" : "语音指令"}
              </button>
              <button className="mainButton" type="submit" disabled={agent.arkBusy}>
                {agent.arkBusy ? "发送中" : "询问 Ark"}
              </button>
            </form>
          </section>

          <section className="hudPanel statusPanel">
            <div className="stateBlock">
              <div className="stateMain">
                <p>助手</p>
                <strong>{agentState}</strong>
              </div>
              <SignalBars active={agent.connected} />
            </div>
            <p className="stateDetail">{agent.status}</p>
            <Compass route="US-101 N" instruction="1.4 英里后转弯" />
            <div className="instrumentRow">
              <ArcGauge label="风噪" value={agent.noiseDb} unit="dB" min={30} max={95} />
              <div className={`instrument latency ${latencyTone}`}>
                <div className="instrumentHead">
                  <span>延迟</span>
                </div>
                <div className="latencyValue">
                  <strong>{agent.latencyMs}</strong>
                  <span>ms</span>
                </div>
                <div className="latencyBar">
                  <i style={{ width: `${Math.min(100, agent.latencyMs / 4)}%` }} />
                </div>
              </div>
            </div>
          </section>

          <section className="hudPanel transcriptPanel">
            <div className="panelHeader">
              <h2>对话</h2>
              <span>{agent.transcript.length ? "实时" : "空闲"}</span>
            </div>
            <div className="transcriptList">
              {(agent.transcript.length
                ? agent.transcript
                : [
                    {
                      id: 1,
                      speaker: "agent" as const,
                      text: "你好，我是 Max，摩托车头盔 AI 助手。你可以问我路线、天气、附近停靠点或摩托车问题。"
                    }
                  ]
              ).map((item) => (
                <article className={`message ${item.speaker}`} key={item.id}>
                  <span>{item.speaker === "rider" ? "骑手" : "Max"}</span>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
