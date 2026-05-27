import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import { HelmetVisual, type TurnState } from "./components/HelmetVisual";
import { SignalBars, WeatherReadout, type Weather } from "./components/Instruments";
import type {
  AgentEvent,
  AgentHealth,
  ConnectionState,
  HazardLevel,
  ProviderCapabilities,
  VoicePersonality
} from "../shared/agent";
import { createPacketWindow, recordDroppedFrame, recordSentFrame, type PacketWindow } from "../shared/audio";
import { type SupportedLanguage, detectLanguage } from "../shared/language";
import {
  combineHazardLevels,
  scenarioDefaultMode,
  scenarioLabel,
  type DemoScenario,
  type RideMode
} from "../shared/ride";
import "./styles.css";

type TranscriptItem = {
  id: number;
  at: number;
  speaker: "rider" | "agent";
  text: string;
  final: boolean;
  language: SupportedLanguage;
};

// Messages posted from public/pcm-worklet.js.
type WorkletMessage = { type: "frame"; pcm: ArrayBuffer } | { type: "level"; value: number };

type RiderLocation = { lat: number; lon: number };

type RideHudContext = {
  mode: RideMode;
  modeLabel: string;
  scenario: DemoScenario;
  scenarioLabel: string;
  speedKmh: number;
  routePhase: string;
  network: "online" | "degraded" | "offline";
  batteryPct: number;
  hazardLevel: HazardLevel;
  glanceableFocus: string;
};

type Telemetry = {
  asrMs: number;
  thinkMs: number;
  firstAudioMs: number;
  totalMs: number;
};

type SessionMemoryState = {
  language: "zh" | "en";
  destination?: string;
  lastIntent?: string;
  responseMode: "concise" | "normal" | "emergency";
};

type PacketStats = {
  outgoingFrames: number;
  outgoingFps: number;
  droppedFrames: number;
};

type PermissionStateLabel = "granted" | "prompt" | "denied" | "unknown";

type AudioProcessingState = {
  echoCancellation: boolean | "unknown";
  noiseSuppression: boolean | "unknown";
  autoGainControl: boolean | "unknown";
  sampleRate?: number;
  channelCount?: number;
};

const SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const MAX_RECONNECT_ATTEMPTS = 6;
const DEFAULT_RIDE_CONTEXT: RideHudContext = {
  mode: "navigation",
  modeLabel: "导航",
  scenario: "commute",
  scenarioLabel: "通勤",
  speedKmh: 0,
  routePhase: "等待骑行上下文",
  network: "offline",
  batteryPct: 0,
  hazardLevel: "normal",
  glanceableFocus: "下一步提示"
};

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  serverVad: false,
  synthesizedAudio: false,
  transcriptEvents: false,
  bargeIn: false,
  voiceSelection: false,
  weatherContext: false,
  sessionMemory: false,
  emergencyMode: false
};

const DEFAULT_MEMORY: SessionMemoryState = {
  language: "zh",
  responseMode: "concise"
};

const DEFAULT_PACKET_STATS: PacketStats = {
  outgoingFrames: 0,
  outgoingFps: 0,
  droppedFrames: 0
};

const DEFAULT_AUDIO_PROCESSING: AudioProcessingState = {
  echoCancellation: "unknown",
  noiseSuppression: "unknown",
  autoGainControl: "unknown"
};

const RIDE_MODE_LABELS: Record<RideMode, string> = {
  ride: "骑行",
  stop: "停车",
  navigation: "导航",
  emergency: "紧急"
};

const SCENARIOS: DemoScenario[] = ["commute", "wind", "fuel", "group", "emergency"];
const RIDE_MODES: RideMode[] = ["ride", "navigation", "stop", "emergency"];
const SCENARIO_HAZARDS: Record<DemoScenario, HazardLevel> = {
  commute: "normal",
  wind: "caution",
  fuel: "normal",
  group: "normal",
  emergency: "critical"
};

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  offline: "离线",
  connecting: "连接中",
  relay: "中继在线",
  provider: "代理握手",
  ready: "已就绪",
  degraded: "降级"
};

const RESPONSE_MODE_LABELS: Record<SessionMemoryState["responseMode"], string> = {
  concise: "极简",
  normal: "正常",
  emergency: "紧急"
};

const HAZARD_LABELS: Record<HazardLevel, string> = {
  normal: "稳定",
  caution: "注意",
  critical: "高风险"
};

const HAZARD_ACTIONS: Record<HazardLevel, string> = {
  normal: "保持节奏，专注下一步提示",
  caution: "放缓一点，扩大车距",
  critical: "优先靠边，确认安全"
};

const NETWORK_LABELS: Record<RideHudContext["network"], string> = {
  online: "在线",
  degraded: "弱网",
  offline: "离线"
};

const PERMISSION_LABELS: Record<PermissionStateLabel, string> = {
  granted: "已授权",
  prompt: "待授权",
  denied: "已拒绝",
  unknown: "未确认"
};

const AUDIO_PROCESSING_LABELS: Record<"true" | "false" | "unknown", string> = {
  true: "开启",
  false: "关闭",
  unknown: "未知"
};

const CREDENTIAL_LABELS: Record<NonNullable<AgentHealth["credentials"]>, string> = {
  configured: "ok",
  missing: "missing",
  "not-required": "mock"
};

const VOICE_PERSONALITIES: VoicePersonality[] = ["concise", "friendly", "technical", "rally"];
const PERSONALITY_LABELS: Record<VoicePersonality, string> = {
  concise: "极简",
  friendly: "友好",
  technical: "技术",
  rally: "领航"
};

const UI_TEXT = {
  zh: {
    assistant: "助手",
    conversation: "对话",
    rideHistory: "骑行记录",
    onboarding: "启动检查",
    mic: "麦克风",
    location: "定位",
    audio: "降噪",
    server: "服务",
    provider: "代理",
    voice: "声音",
    ready: "就绪",
    idle: "空闲",
    live: "实时",
    lastCommand: "上一指令",
    lastReply: "上一回复",
    connection: "连接",
    weather: "天气"
  },
  en: {
    assistant: "Assistant",
    conversation: "Conversation",
    rideHistory: "Ride Log",
    onboarding: "Preflight",
    mic: "Mic",
    location: "Location",
    audio: "Noise",
    server: "Server",
    provider: "Provider",
    voice: "Voice",
    ready: "Ready",
    idle: "Idle",
    live: "Live",
    lastCommand: "Last command",
    lastReply: "Last reply",
    connection: "Connection",
    weather: "Weather"
  }
};

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

async function fetchAgentHealth(): Promise<AgentHealth | null> {
  try {
    const response = await fetch("/health");
    if (!response.ok) return null;
    return (await response.json()) as AgentHealth;
  } catch {
    return null;
  }
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

function audioProcessingLabel(value: AudioProcessingState["echoCancellation"]) {
  return AUDIO_PROCESSING_LABELS[String(value) as "true" | "false" | "unknown"];
}

function readAudioProcessingSettings(track: MediaStreamTrack): AudioProcessingState {
  const settings = track.getSettings() as MediaTrackSettings & {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };

  return {
    echoCancellation: settings.echoCancellation ?? "unknown",
    noiseSuppression: settings.noiseSuppression ?? "unknown",
    autoGainControl: settings.autoGainControl ?? "unknown",
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount
  };
}

function formatClockTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
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
  const [connectionState, setConnectionState] = useState<ConnectionState>("offline");
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities>(DEFAULT_CAPABILITIES);
  const [latencyMs, setLatencyMs] = useState(0);
  const [packetStats, setPacketStats] = useState<PacketStats>(DEFAULT_PACKET_STATS);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [voiceGender, setVoiceGenderState] = useState<VoiceGender>("female");
  const [voicePersonality, setVoicePersonalityState] = useState<VoicePersonality>("concise");
  const [turnState, setTurnState] = useState<TurnState>("idle");
  const [weather, setWeather] = useState<Weather | null>(null);
  const [rideContext, setRideContext] = useState<RideHudContext>(DEFAULT_RIDE_CONTEXT);
  const [telemetry, setTelemetry] = useState<Telemetry>({ asrMs: 0, thinkMs: 0, firstAudioMs: 0, totalMs: 0 });
  const [sessionMemory, setSessionMemory] = useState<SessionMemoryState>(DEFAULT_MEMORY);
  const [micPermission, setMicPermission] = useState<PermissionStateLabel>("unknown");
  const [locationPermission, setLocationPermission] = useState<PermissionStateLabel>("unknown");
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingState>(DEFAULT_AUDIO_PROCESSING);

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
  const voicePersonalityRef = useRef<VoicePersonality>("concise");
  const locationRef = useRef<RiderLocation | null>(null);
  const rideModeRef = useRef<RideMode>(DEFAULT_RIDE_CONTEXT.mode);
  const scenarioRef = useRef<DemoScenario>(DEFAULT_RIDE_CONTEXT.scenario);
  const frameWindowRef = useRef<PacketWindow>(createPacketWindow());
  const transcriptTurnRef = useRef(0);

  const pushTranscript = useCallback((speaker: "rider" | "agent", text: string, final = true) => {
    const cleanText = text.trim();
    if (!cleanText) return;
    const language = detectLanguage(cleanText);
    const now = Date.now();
    setTranscript((items) => {
      const last = items.at(-1);
      if (last?.speaker === speaker && !last.final) {
        return [
          ...items.slice(0, -1),
          {
            ...last,
            at: now,
            text: cleanText,
            final,
            language
          }
        ];
      }

      transcriptTurnRef.current += 1;
      return [
        ...items.slice(-39),
        {
          id: transcriptTurnRef.current,
          at: now,
          speaker,
          text: cleanText,
          final,
          language
        }
      ];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAgentHealth().then((nextHealth) => {
      if (cancelled || !nextHealth) return;
      setHealth(nextHealth);
      setProvider(nextHealth.provider);
      setCapabilities(nextHealth.capabilities);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!navigator.permissions?.query) return;
    const trackPermission = async (name: PermissionName, setter: (state: PermissionStateLabel) => void) => {
      try {
        const status = await navigator.permissions.query({ name });
        const update = () => setter(status.state);
        update();
        status.addEventListener("change", update);
      } catch {
        setter("unknown");
      }
    };
    void trackPermission("microphone" as PermissionName, setMicPermission);
    void trackPermission("geolocation", setLocationPermission);
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
    if (transmittingRef.current) {
      setTurnState("listening");
      setStatus("已打断 Max，继续听你说");
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
    setConnectionState("connecting");
    setStatus(reconnectAttemptsRef.current > 0 ? `重新连接中…（第 ${reconnectAttemptsRef.current} 次）` : "连接中");

    const socket = createAgentSocket();
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      setConnectionState("relay");
      setStatus("就绪");
      const location = locationRef.current;
      socket.send(
        JSON.stringify({
          type: "session.start",
          sampleRate: SAMPLE_RATE,
          channels: 1,
          voiceGender: voiceGenderRef.current,
          voicePersonality: voicePersonalityRef.current,
          rideMode: rideModeRef.current,
          scenario: scenarioRef.current,
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
          setCapabilities(event.capabilities);
          isLiveRef.current = event.mode !== "mock";
          setConnectionState("ready");
          setStatus(event.mode === "mock" ? "模拟路线已启用" : "豆包实时语音在线");
        }
        if (event.type === "connection") {
          setConnectionState(event.state);
          setStatus(event.detail);
        }
        if (event.type === "status") {
          setStatus(event.detail);
          if (event.state === "connecting") setConnectionState("provider");
          if (event.state === "ready") setConnectionState("ready");
          if (event.state === "closed") setConnectionState("offline");
          if (transmittingRef.current) setTurnState((prev) => mapTurnState(event.state, prev));
        }
        if (event.type === "transcript") {
          if (event.speaker === "rider") stopAgentSpeech();
          pushTranscript(event.speaker, event.text, event.final !== false);
          if (event.speaker === "agent" && event.final !== false) speak(event.text);
        }
        if (event.type === "metric") {
          setLatencyMs(event.latencyMs);
          setPacketStats((stats) => ({
            ...stats,
            outgoingFps: event.outgoingFps ?? stats.outgoingFps,
            droppedFrames: event.droppedFrames ?? stats.droppedFrames
          }));
        }
        if (event.type === "weather") {
          setWeather({
            description: event.description,
            temperatureC: event.temperatureC,
            windSpeedKmh: event.windSpeedKmh,
            isDay: event.isDay,
            riskLevel: event.riskLevel ?? "normal",
            riderAdvice: event.riderAdvice ?? "天气风险较低，保持正常安全骑行。"
          });
          setRideContext((context) => ({
            ...context,
            hazardLevel: combineHazardLevels(context.hazardLevel, event.riskLevel ?? "normal")
          }));
        }
        if (event.type === "ride.context") {
          setRideContext({
            mode: event.mode,
            modeLabel: event.modeLabel,
            scenario: event.scenario,
            scenarioLabel: event.scenarioLabel,
            speedKmh: event.speedKmh ?? 0,
            routePhase: event.routePhase ?? "等待路线信息",
            network: event.network ?? "online",
            batteryPct: event.batteryPct ?? 0,
            hazardLevel: event.hazardLevel,
            glanceableFocus: event.glanceableFocus
          });
        }
        if (event.type === "session.memory") {
          setSessionMemory({
            language: event.language,
            destination: event.destination,
            lastIntent: event.lastIntent,
            responseMode: event.responseMode
          });
        }
        if (event.type === "telemetry") {
          setTelemetry({
            asrMs: Math.max(0, event.asrMs),
            thinkMs: Math.max(0, event.thinkMs),
            firstAudioMs: Math.max(0, event.firstAudioMs),
            totalMs: Math.max(0, event.totalMs)
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
      setConnectionState("offline");
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
        setConnectionState("degraded");
        setStatus("语音中继连接失败，请重新开启免提");
        return;
      }
      const delay = Math.min(8000, 1000 * 2 ** (reconnectAttemptsRef.current - 1));
      setStatus(`连接已断开，${Math.round(delay / 1000)} 秒后自动重连…`);
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
    });

    socket.addEventListener("error", () => {
      setConnectionState("degraded");
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
      const isDoubaoProvider = provider === "doubao" || health?.provider === "doubao";
      if (isLiveRef.current || isDoubaoProvider || socketRef.current) {
        setStatus(gender === "male" ? "正在切换到男声…" : "正在切换到女声…");
        if (socketRef.current) restartSession();
      } else {
        setStatus(gender === "male" ? "已切换到男声" : "已切换到女声");
      }
    },
    [health?.provider, provider, restartSession]
  );

  const setVoicePersonality = useCallback(
    (personality: VoicePersonality) => {
      voicePersonalityRef.current = personality;
      setVoicePersonalityState(personality);
      setStatus(`已切换语气：${PERSONALITY_LABELS[personality]}`);
      if (socketRef.current) restartSession();
    },
    [restartSession]
  );

  const setRideMode = useCallback(
    (mode: RideMode) => {
      rideModeRef.current = mode;
      const hazardLevel = combineHazardLevels(
        mode === "emergency" ? "critical" : mode === "navigation" ? "caution" : "normal",
        SCENARIO_HAZARDS[scenarioRef.current]
      );
      setRideContext((context) => ({
        ...context,
        mode,
        modeLabel: RIDE_MODE_LABELS[mode],
        hazardLevel
      }));
      if (socketRef.current) restartSession();
    },
    [restartSession]
  );

  const setScenario = useCallback(
    (scenario: DemoScenario) => {
      scenarioRef.current = scenario;
      const mode = scenarioDefaultMode(scenario);
      rideModeRef.current = mode;
      const hazardLevel = combineHazardLevels(
        mode === "emergency" ? "critical" : mode === "navigation" ? "caution" : "normal",
        SCENARIO_HAZARDS[scenario]
      );
      setRideContext((context) => ({
        ...context,
        scenario,
        scenarioLabel: scenarioLabel(scenario),
        mode,
        modeLabel: RIDE_MODE_LABELS[mode],
        hazardLevel
      }));
      if (socketRef.current) restartSession();
    },
    [restartSession]
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
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: SAMPLE_RATE },
        sampleSize: { ideal: 16 }
      } as MediaTrackConstraints
    });
    const [track] = stream.getAudioTracks();
    if (track) setAudioProcessing(readAudioProcessingSettings(track));
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
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(message.pcm);
          const now = performance.now();
          const result = recordSentFrame(frameWindowRef.current, now);
          frameWindowRef.current = result.window;
          if (result.metric) setPacketStats(result.metric);
        } else {
          const result = recordDroppedFrame(frameWindowRef.current);
          frameWindowRef.current = result.window;
          setPacketStats((stats) => ({ ...stats, droppedFrames: result.metric.droppedFrames }));
        }
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
    setAudioProcessing(DEFAULT_AUDIO_PROCESSING);
  }, []);

  // Start the hands-free session: grab geolocation (for live weather), open the
  // relay, and stream the mic continuously — Doubao's VAD handles turn-taking.
  const startMic = useCallback(async () => {
    try {
      if (!locationRef.current) {
        locationRef.current = await getRiderLocation();
        setLocationPermission(locationRef.current ? "granted" : "unknown");
      }
      const socket = await waitForSocket();
      await ensureMic();
      stopAgentSpeech();
      streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = true));
      transmittingRef.current = true;
      setMicPermission("granted");
      frameWindowRef.current = createPacketWindow();
      setPacketStats(DEFAULT_PACKET_STATS);
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
    frameWindowRef.current = createPacketWindow();
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
    setConnectionState("offline");
    setTurnState("idle");
    setStatus("离线");
  }, [releaseMic, stopAgentSpeech, stopMic]);

  useEffect(() => () => disconnect(), [disconnect]);

  return {
    connected,
    listening,
    status,
    provider,
    connectionState,
    health,
    capabilities,
    latencyMs,
    packetStats,
    voiceLevel,
    transcript,
    voiceGender,
    voicePersonality,
    turnState,
    weather,
    rideContext,
    telemetry,
    sessionMemory,
    micPermission,
    locationPermission,
    audioProcessing,
    setVoiceGender,
    setVoicePersonality,
    setRideMode,
    setScenario,
    startMic,
    stopMic
  };
}

function App() {
  const agent = useHelmetAgent();
  const t = UI_TEXT[agent.sessionMemory.language];
  const { listening, startMic, stopMic } = agent;

  useEffect(() => {
    const toggleHandsFree = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
      ) {
        return;
      }

      event.preventDefault();
      if (listening) {
        stopMic();
      } else {
        void startMic();
      }
    };

    window.addEventListener("keydown", toggleHandsFree);
    return () => window.removeEventListener("keydown", toggleHandsFree);
  }, [listening, startMic, stopMic]);

  const agentState = useMemo(() => {
    if (agent.listening) return agent.sessionMemory.language === "en" ? "Hands-free" : "免提中";
    if (agent.connected) return agent.sessionMemory.language === "en" ? "Standby" : "待命";
    return agent.sessionMemory.language === "en" ? "Offline" : "离线";
  }, [agent.connected, agent.listening, agent.sessionMemory.language]);

  const latencyTone = agent.latencyMs < 140 ? "good" : agent.latencyMs < 280 ? "warn" : "alert";
  const lastCommand = [...agent.transcript].reverse().find((item) => item.speaker === "rider")?.text ?? "—";
  const lastReply = [...agent.transcript].reverse().find((item) => item.speaker === "agent")?.text ?? "—";
  const weatherRisk = agent.weather?.riskLevel ?? "normal";
  const fusedHazard = combineHazardLevels(agent.rideContext.hazardLevel, weatherRisk);
  const preflight = [
    { label: t.mic, value: PERMISSION_LABELS[agent.micPermission] },
    { label: t.location, value: PERMISSION_LABELS[agent.locationPermission] },
    { label: t.audio, value: `NS ${audioProcessingLabel(agent.audioProcessing.noiseSuppression)}` },
    { label: t.server, value: agent.health?.ok ? t.ready : "…" },
    { label: t.provider, value: agent.provider.toUpperCase() },
    {
      label: t.voice,
      value: `${agent.voiceGender === "female" ? "女声" : "男声"} · ${PERSONALITY_LABELS[agent.voicePersonality]}`
    }
  ];

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
            <div className="voiceToggle" role="group" aria-label="语气风格">
              {VOICE_PERSONALITIES.map((personality) => (
                <button
                  key={personality}
                  type="button"
                  className={agent.voicePersonality === personality ? "active" : ""}
                  onClick={() => agent.setVoicePersonality(personality)}
                >
                  {PERSONALITY_LABELS[personality]}
                </button>
              ))}
            </div>
            <div className="modeToggle" role="group" aria-label="骑行模式">
              {RIDE_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={agent.rideContext.mode === mode ? "active" : ""}
                  onClick={() => agent.setRideMode(mode)}
                >
                  {RIDE_MODE_LABELS[mode]}
                </button>
              ))}
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
                  ? "免提已开启 — 直接说话即可，按空格或点击按钮可结束。"
                  : "点击按钮或按空格开启免提。需要麦克风与定位权限。"}
              </p>
              <div className="scenarioStrip" aria-label="演示场景">
                {SCENARIOS.map((scenario) => (
                  <button
                    key={scenario}
                    type="button"
                    className={agent.rideContext.scenario === scenario ? "active" : ""}
                    onClick={() => agent.setScenario(scenario)}
                  >
                    {scenarioLabel(scenario)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="hudPanel statusPanel">
            <div className="stateBlock">
              <div className="stateMain">
                <p>{t.assistant}</p>
                <strong>{agentState}</strong>
              </div>
              <SignalBars active={agent.connected} />
            </div>
            <p className="stateDetail">{agent.status}</p>
            <div className={`instrument ridePulse ${fusedHazard}`}>
              <div className="instrumentHead">
                <span>态势摘要</span>
                <b>{HAZARD_LABELS[fusedHazard]}</b>
              </div>
              <strong>{HAZARD_ACTIONS[fusedHazard]}</strong>
              <p>{agent.rideContext.glanceableFocus}</p>
              <div className="pulseGrid">
                <span>
                  <b>{agent.rideContext.modeLabel}</b>
                  模式
                </span>
                <span>
                  <b>{agent.rideContext.scenarioLabel}</b>
                  场景
                </span>
                <span>
                  <b>{NETWORK_LABELS[agent.rideContext.network]}</b>
                  网络
                </span>
                <span>
                  <b>{agent.rideContext.batteryPct}%</b>
                  电量
                </span>
              </div>
            </div>
            <div className="instrument preflight">
              <div className="instrumentHead">
                <span>{t.onboarding}</span>
                <b>{agent.health?.ok ? t.ready : "check"}</b>
              </div>
              <div className="preflightGrid">
                {preflight.map((item) => (
                  <span key={item.label}>
                    <b>{item.label}</b>
                    {item.value}
                  </span>
                ))}
              </div>
            </div>
            <div className={`instrument rideIntel ${agent.rideContext.hazardLevel}`}>
              <div className="instrumentHead">
                <span>骑行情报</span>
                <b>{agent.rideContext.modeLabel}</b>
              </div>
              <div className="rideIntelGrid">
                <strong>{agent.rideContext.speedKmh}</strong>
                <span>km/h</span>
                <p>{agent.rideContext.routePhase}</p>
              </div>
              <div className="rideChips">
                <span>{agent.rideContext.scenarioLabel}</span>
                <span>{agent.rideContext.network}</span>
                <span>{agent.rideContext.batteryPct}%</span>
              </div>
            </div>
            <WeatherReadout weather={agent.weather} />
            <div className={`instrument diagnostics ${agent.connectionState}`}>
              <div className="instrumentHead">
                <span>系统诊断</span>
                <b>{CONNECTION_LABELS[agent.connectionState]}</b>
              </div>
              <div className="diagnosticGrid">
                <span>凭证</span>
                <strong>{agent.health ? CREDENTIAL_LABELS[agent.health.credentials] : "unknown"}</strong>
                <span>VAD</span>
                <strong>{agent.capabilities.serverVad ? "server" : "off"}</strong>
                <span>音频</span>
                <strong>{agent.capabilities.synthesizedAudio ? "PCM" : "TTS"}</strong>
                <span>记忆</span>
                <strong>{agent.capabilities.sessionMemory ? "on" : "off"}</strong>
                <span>降噪</span>
                <strong>{audioProcessingLabel(agent.audioProcessing.noiseSuppression)}</strong>
                <span>回声</span>
                <strong>{audioProcessingLabel(agent.audioProcessing.echoCancellation)}</strong>
                <span>增益</span>
                <strong>{audioProcessingLabel(agent.audioProcessing.autoGainControl)}</strong>
                <span>采样</span>
                <strong>{agent.audioProcessing.sampleRate ?? SAMPLE_RATE}Hz</strong>
              </div>
              <div className="rideChips">
                <span>{agent.sessionMemory.language === "zh" ? "中文" : "English"}</span>
                <span>{RESPONSE_MODE_LABELS[agent.sessionMemory.responseMode]}</span>
                <span>{agent.sessionMemory.lastIntent ?? "待识别"}</span>
                {agent.sessionMemory.destination ? <span>{agent.sessionMemory.destination}</span> : null}
              </div>
            </div>
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
              <div className="telemetryGrid">
                <span>ASR {agent.telemetry.asrMs}ms</span>
                <span>思考 {agent.telemetry.thinkMs}ms</span>
                <span>首音 {agent.telemetry.firstAudioMs}ms</span>
                <span>总计 {agent.telemetry.totalMs}ms</span>
                <span>上行 {agent.packetStats.outgoingFps}fps</span>
                <span>丢帧 {agent.packetStats.droppedFrames}</span>
              </div>
            </div>
          </section>

          <section className="hudPanel transcriptPanel">
            <div className="panelHeader">
              <h2>{t.conversation}</h2>
              <span>{agent.transcript.length ? t.live : t.idle}</span>
            </div>
            <div className="rideHistory">
              <div>
                <span>{t.lastCommand}</span>
                <strong>{lastCommand}</strong>
              </div>
              <div>
                <span>{t.lastReply}</span>
                <strong>{lastReply}</strong>
              </div>
              <div>
                <span>{t.weather}</span>
                <strong>{agent.weather ? `${agent.weather.description} ${agent.weather.temperatureC}°C` : "—"}</strong>
              </div>
              <div>
                <span>{t.connection}</span>
                <strong>{CONNECTION_LABELS[agent.connectionState]}</strong>
              </div>
            </div>
            <div className="transcriptList">
              {(agent.transcript.length
                ? agent.transcript
                : [
                    {
                      id: 1,
                      at: Date.now(),
                      speaker: "agent" as const,
                      final: true,
                      language: "zh" as const,
                      text: "你好，我是 Max，摩托车头盔 AI 助手。开启免提后直接说话，问我天气、路线或摩托车问题。"
                    }
                  ]
              ).map((item) => (
                <article className={`message ${item.speaker}`} key={item.id}>
                  <span>{item.speaker === "rider" ? "骑手" : "Max"}</span>
                  <div className="messageMeta">
                    <b>{formatClockTime(item.at)}</b>
                    <b>{item.language === "zh" ? "中文" : "EN"}</b>
                    <b>{item.final ? "final" : "live"}</b>
                  </div>
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

declare global {
  interface Window {
    __helmetMaxRoot?: Root;
  }
}

const rootElement = document.getElementById("root")!;
const root = window.__helmetMaxRoot ?? createRoot(rootElement);
window.__helmetMaxRoot = root;

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
