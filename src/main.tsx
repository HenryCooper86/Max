import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import { HelmetVisual, type TurnState } from "./components/HelmetVisual";
import { SignalBars, WeatherReadout, type Weather } from "./components/Instruments";
import { type SupportedLanguage, detectLanguage } from "../shared/language";
import "./styles.css";

type AgentEvent =
  | { type: "session.started"; provider: string; mode: string }
  | { type: "status"; state: string; detail: string }
  | { type: "transcript"; speaker: "rider" | "agent"; text: string; final?: boolean }
  | { type: "metric"; latencyMs: number }
  | { type: "weather"; description: string; temperatureC: number; windSpeedKmh: number; isDay: boolean }
  | { type: "error"; message: string };

type TranscriptItem = {
  id: number;
  speaker: "rider" | "agent";
  text: string;
};

// Messages posted from public/pcm-worklet.js.
type WorkletMessage = { type: "frame"; pcm: ArrayBuffer } | { type: "level"; value: number };

type RiderLocation = { lat: number; lon: number };

const SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const MAX_RECONNECT_ATTEMPTS = 6;

// BCP-47 locales per supported language, used for the browser-TTS fallback.
const VOICE_LOCALE: Record<SupportedLanguage, string> = {
  zh: "zh-CN",
  en: "en-US"
};

type VoiceGender = "female" | "male";

// Voice-name hints per gender and language. `\bmale\b` avoids matching "female".
const VOICE_HINTS: Record<VoiceGender, Record<SupportedLanguage, RegExp>> = {
  female: {
    zh: /female|女|xiaoxiao|xiaoyi|ting-?ting|jupiter/i,
    en: /female|samantha|victoria|zira|aria|jenny|fiona/i
  },
  male: {
    zh: /\bmale\b|男|kangkang|yunyang|yunxi|yunjian|liang/i,
    en: /\bmale\b|daniel|alex|david|mark|guy|fred|thomas/i
  }
};

/**
 * Picks a voice for the language and gender. Returns `matched: false` when no
 * genuinely gendered voice is installed, so the caller can compensate via pitch.
 */
function selectVoice(language: SupportedLanguage, gender: VoiceGender) {
  const voices = window.speechSynthesis.getVoices();
  const matches = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  const describe = (voice: SpeechSynthesisVoice) => `${voice.name} ${voice.voiceURI}`;

  const exact = matches.find((voice) => VOICE_HINTS[gender][language].test(describe(voice)));
  if (exact) return { voice: exact, matched: true };

  // No gendered voice for this language: skip the opposite gender's obvious
  // voice if we can, but still return something so the reply is spoken.
  const opposite = VOICE_HINTS[gender === "male" ? "female" : "male"][language];
  const neutral = matches.find((voice) => !opposite.test(describe(voice)));
  return { voice: neutral ?? matches[0], matched: false };
}

function createAgentSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${window.location.host}/agent`);
}

// Best-effort rider geolocation for live weather. Resolves null when the rider
// declines, the API is missing, or the lookup times out — weather is optional.
function getRiderLocation(): Promise<RiderLocation | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 300000 }
    );
  });
}

// Folds a server status event into the conversational turn state. Unknown
// states leave the turn state unchanged.
function mapTurnState(state: string, previous: TurnState): TurnState {
  switch (state) {
    case "listening":
    case "ready":
      return "listening";
    case "hearing":
    case "asr":
      return "hearing";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "closed":
      return "idle";
    default:
      return previous;
  }
}

function useHelmetAgent() {
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("离线");
  const [provider, setProvider] = useState("mock");
  const [latencyMs, setLatencyMs] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [voiceGender, setVoiceGenderState] = useState<VoiceGender>("female");
  const [turnState, setTurnState] = useState<TurnState>("idle");
  const [weather, setWeather] = useState<Weather | null>(null);

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
  const isLiveRef = useRef(false);
  const voiceGenderRef = useRef<VoiceGender>("female");
  const locationRef = useRef<RiderLocation | null>(null);

  const pushTranscript = useCallback((speaker: "rider" | "agent", text: string) => {
    setTranscript((items) => [...items.slice(-7), { id: Date.now() + Math.random(), speaker, text }]);
  }, []);

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

  // Browser-TTS fallback, used when Doubao returns reply text but no audio.
  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window) || !text.trim()) return;
    window.speechSynthesis.cancel();
    // Speak each reply in its own language; forcing a Chinese voice makes
    // English replies fall silent.
    const language = detectLanguage(text);
    const gender = voiceGenderRef.current;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = VOICE_LOCALE[language];

    const { voice, matched } = selectVoice(language, gender);
    if (voice) utterance.voice = voice;

    // Most systems ship a single (female) voice per language. When no real
    // gendered voice is found, shift pitch so the toggle is still audible.
    if (gender === "male") {
      utterance.pitch = matched ? 0.9 : 0.6;
      utterance.rate = 0.98;
    } else {
      utterance.pitch = matched ? 1.06 : 1.16;
      utterance.rate = 1.04;
    }
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
      const location = locationRef.current;
      socket.send(
        JSON.stringify({
          type: "session.start",
          sampleRate: SAMPLE_RATE,
          channels: 1,
          voiceGender: voiceGenderRef.current,
          ...(location ? { lat: location.lat, lon: location.lon } : {})
        })
      );
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
          isLiveRef.current = event.mode !== "mock";
          setStatus(event.mode === "mock" ? "模拟路线已启用" : "豆包实时语音在线");
        }
        if (event.type === "status") {
          setStatus(event.detail);
          if (transmittingRef.current) setTurnState((prev) => mapTurnState(event.state, prev));
        }
        if (event.type === "transcript") {
          if (event.speaker === "rider") stopAgentSpeech();
          pushTranscript(event.speaker, event.text);
          if (event.speaker === "agent" && event.final !== false) speak(event.text);
        }
        if (event.type === "metric") setLatencyMs(event.latencyMs);
        if (event.type === "weather") {
          setWeather({
            description: event.description,
            temperatureC: event.temperatureC,
            windSpeedKmh: event.windSpeedKmh,
            isDay: event.isDay
          });
        }
        if (event.type === "error") setStatus(event.message);
      } catch {
        setStatus("收到异常代理消息");
      }
    });

    socket.addEventListener("close", () => {
      // Ignore a socket already superseded by a newer one (e.g. a restart).
      if (socketRef.current !== socket) return;
      setConnected(false);
      socketRef.current = null;
      isLiveRef.current = false;
      if (intentionalCloseRef.current) {
        setStatus("离线");
        return;
      }

      // Unexpected drop: reconnect with exponential backoff.
      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current = 0;
        setStatus("语音中继连接失败，请重新开启免提");
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

  // Reopen the relay so a fresh realtime session picks up changed settings
  // (e.g. the voice gender). The mic graph is untouched, so capture continues.
  const restartSession = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.close();
    connect();
  }, [connect]);

  // Switch the assistant voice. The live Doubao speaker is fixed at session
  // start, so restart the session; the mock path just uses browser TTS.
  const setVoiceGender = useCallback(
    (gender: VoiceGender) => {
      voiceGenderRef.current = gender;
      setVoiceGenderState(gender);
      if (isLiveRef.current) {
        setStatus(gender === "male" ? "正在切换到男声…" : "正在切换到女声…");
        restartSession();
      } else {
        speak(gender === "male" ? "已切换到男声。" : "已切换到女声。");
      }
    },
    [restartSession, speak]
  );

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

  // Acquire the mic + AudioWorklet graph once and reuse it across sessions.
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

  // Start the hands-free session: grab geolocation (for live weather), open the
  // relay, and stream the mic continuously — Doubao's VAD handles turn-taking.
  const startMic = useCallback(async () => {
    try {
      if (!locationRef.current) locationRef.current = await getRiderLocation();
      const socket = await waitForSocket();
      await ensureMic();
      stopAgentSpeech();
      streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = true));
      transmittingRef.current = true;
      setListening(true);
      setTurnState("listening");
      setStatus("免提已开启，请讲话");
      socket.send(JSON.stringify({ type: "audio.start" }));
    } catch (error) {
      transmittingRef.current = false;
      setListening(false);
      setTurnState("idle");
      setStatus(error instanceof Error ? error.message : "无法访问麦克风");
    }
  }, [ensureMic, stopAgentSpeech, waitForSocket]);

  // Stops transmitting but keeps the audio graph alive (the track is disabled,
  // so no real audio is captured) for an instant restart next time.
  const stopMic = useCallback(() => {
    transmittingRef.current = false;
    streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = false));
    setVoiceLevel(0);
    setListening(false);
    setTurnState("idle");
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.stop" }));
    }
  }, []);

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
    setTurnState("idle");
    setStatus("离线");
  }, [releaseMic, stopAgentSpeech, stopMic]);

  useEffect(() => () => disconnect(), [disconnect]);

  return {
    connected,
    listening,
    status,
    provider,
    latencyMs,
    voiceLevel,
    transcript,
    voiceGender,
    turnState,
    weather,
    setVoiceGender,
    startMic,
    stopMic
  };
}

function App() {
  const agent = useHelmetAgent();

  const agentState = useMemo(() => {
    if (agent.listening) return "免提中";
    if (agent.connected) return "待命";
    return "离线";
  }, [agent.connected, agent.listening]);

  const latencyTone = agent.latencyMs < 140 ? "good" : agent.latencyMs < 280 ? "warn" : "alert";

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
          <div className="topbarControls">
            <div className="voiceToggle" role="group" aria-label="语音性别">
              <button
                type="button"
                className={agent.voiceGender === "female" ? "active" : ""}
                onClick={() => agent.setVoiceGender("female")}
              >
                女声
              </button>
              <button
                type="button"
                className={agent.voiceGender === "male" ? "active" : ""}
                onClick={() => agent.setVoiceGender("male")}
              >
                男声
              </button>
            </div>
            <div className={`signal ${agent.connected ? "online" : ""}`}>
              <span />
              {agent.provider.toUpperCase()}
            </div>
          </div>
        </div>

        <div className="grid">
          <section className="hudPanel helmetPanel">
            <HelmetVisual
              connected={agent.connected}
              listening={agent.listening}
              voiceLevel={agent.voiceLevel}
              turnState={agent.turnState}
            />
            <div className="handsFree">
              <button
                className={`micButton ${agent.listening ? "active" : ""}`}
                onClick={agent.listening ? agent.stopMic : agent.startMic}
                type="button"
              >
                {agent.listening ? "结束免提" : "开启免提"}
              </button>
              <p className="handsFreeHint">
                {agent.listening
                  ? "免提已开启 — 直接说话即可，Max 会自动聆听并回答。"
                  : "开启后无需再次点击，全程语音交互。需要麦克风与定位权限。"}
              </p>
            </div>
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
            <WeatherReadout weather={agent.weather} />
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
                      text: "你好，我是 Max，摩托车头盔 AI 助手。开启免提后直接说话，问我天气、路线或摩托车问题。"
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
