// The hands-free session brain: relay WebSocket lifecycle (connect, reconnect,
// event fan-out), session settings, and the start/stop hands-free flow. Audio
// I/O lives in useAudioPlayback / useMicCapture.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnState } from "../components/HelmetVisual";
import type { Weather } from "../components/Instruments";
import type {
  AgentEvent,
  AgentHealth,
  ConnectionState,
  ProviderCapabilities,
  VoicePersonality
} from "../../shared/agent";
import { detectLanguage } from "../../shared/language";
import {
  combineHazardLevels,
  scenarioDefaultMode,
  scenarioLabel,
  type DemoScenario,
  type RideMode
} from "../../shared/ride";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_MEMORY,
  DEFAULT_PACKET_STATS,
  DEFAULT_RIDE_CONTEXT,
  MAX_RECONNECT_ATTEMPTS,
  PERSONALITY_LABELS,
  RIDE_MODE_LABELS,
  SAMPLE_RATE,
  SCENARIO_HAZARDS
} from "../lib/constants";
import {
  clearStoredTranscript,
  loadStoredSettings,
  loadStoredTranscript,
  saveStoredSettings,
  saveStoredTranscript
} from "../lib/persistence";
import {
  createAgentSocket,
  fetchAgentHealth,
  getRiderLocation,
  mapTurnState,
  normalizeTranscriptText
} from "../lib/utils";
import type {
  HazardAlertState,
  PermissionStateLabel,
  RideHudContext,
  RiderLocation,
  SessionMemoryState,
  Telemetry,
  TranscriptItem,
  VoiceGender
} from "../types";
import { useAudioPlayback } from "./useAudioPlayback";
import { useMicCapture } from "./useMicCapture";

const storedSettings = loadStoredSettings();

export function useHelmetAgent() {
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("离线");
  const [provider, setProvider] = useState("mock");
  const [connectionState, setConnectionState] = useState<ConnectionState>("offline");
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities>(DEFAULT_CAPABILITIES);
  const [latencyMs, setLatencyMs] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>(() => loadStoredTranscript());
  const [voiceGender, setVoiceGenderState] = useState<VoiceGender>(storedSettings.voiceGender ?? "female");
  const [voicePersonality, setVoicePersonalityState] = useState<VoicePersonality>(
    storedSettings.voicePersonality ?? "concise"
  );
  const [turnState, setTurnState] = useState<TurnState>("idle");
  const [weather, setWeather] = useState<Weather | null>(null);
  const [rideContext, setRideContext] = useState<RideHudContext>(DEFAULT_RIDE_CONTEXT);
  const [hazardAlert, setHazardAlert] = useState<HazardAlertState | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry>({ asrMs: 0, thinkMs: 0, firstAudioMs: 0, totalMs: 0 });
  const [sessionMemory, setSessionMemory] = useState<SessionMemoryState>(DEFAULT_MEMORY);
  const [micPermission, setMicPermission] = useState<PermissionStateLabel>("unknown");
  const [locationPermission, setLocationPermission] = useState<PermissionStateLabel>("unknown");
  const [guidedDemo, setGuidedDemoState] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const transmittingRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const isLiveRef = useRef(false);
  const voiceGenderRef = useRef<VoiceGender>(storedSettings.voiceGender ?? "female");
  const voicePersonalityRef = useRef<VoicePersonality>(storedSettings.voicePersonality ?? "concise");
  const locationRef = useRef<RiderLocation | null>(null);
  const rideModeRef = useRef<RideMode>(DEFAULT_RIDE_CONTEXT.mode);
  const scenarioRef = useRef<DemoScenario>(DEFAULT_RIDE_CONTEXT.scenario);
  const transcriptTurnRef = useRef(0);
  const hazardClearTimerRef = useRef<number | null>(null);
  const guidedDemoRef = useRef(false);

  const onInterrupted = useCallback(() => {
    setTurnState("listening");
    setStatus("已打断 Max，继续听你说");
  }, []);

  const { playPcm16, stopAgentSpeech, speak, ensurePlaybackContext, closePlayback } = useAudioPlayback({
    voiceGenderRef,
    transmittingRef,
    onInterrupted
  });

  const {
    voiceLevel,
    packetStats,
    setPacketStats,
    audioProcessing,
    ensureMic,
    releaseMic,
    setTrackEnabled,
    resetFrameWindow
  } = useMicCapture({ socketRef, transmittingRef });

  // Seed the turn counter past any restored transcript so ids never collide.
  useEffect(() => {
    const lastId = transcript.at(-1)?.id ?? 0;
    if (transcriptTurnRef.current < lastId) transcriptTurnRef.current = lastId;
    // Run once on mount; later ids are managed by pushTranscript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the conversation so a refresh or crash doesn't lose the ride log.
  useEffect(() => {
    saveStoredTranscript(transcript);
  }, [transcript]);

  const pushTranscript = useCallback((speaker: "rider" | "agent", text: string, final = true) => {
    const cleanText = text.trim();
    if (!cleanText) return;
    const language = detectLanguage(cleanText);
    const now = Date.now();
    setTranscript((items) => {
      const last = items.at(-1);
      if (
        speaker === "agent" &&
        last?.speaker === "agent" &&
        normalizeTranscriptText(last.text) === normalizeTranscriptText(cleanText) &&
        now - last.at < 8000
      ) {
        return items;
      }
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
      const finalizedItems = last && !last.final ? [...items.slice(0, -1), { ...last, final: true }] : items;
      return [
        ...finalizedItems,
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

  const clearTranscript = useCallback(() => {
    setTranscript([]);
    clearStoredTranscript();
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

  // Warm the speech-synthesis voice list. `getVoices()` is empty until the async
  // `voiceschanged` event fires in Chrome, so the first TTS-fallback reply on a
  // cold load would otherwise miss gender/locale selection. Touching it on mount
  // kicks off the load so voices are ready by the time a reply arrives.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    synth.getVoices();
    const onVoicesChanged = () => synth.getVoices();
    synth.addEventListener("voiceschanged", onVoicesChanged);
    return () => synth.removeEventListener("voiceschanged", onVoicesChanged);
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
      // The guided tour and audio stream live in the provider instance, so a
      // fresh session must be told about both again.
      if (guidedDemoRef.current) socket.send(JSON.stringify({ type: "demo.guided", enabled: true }));
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
          if (event.speaker === "agent" && (event.useBrowserSpeech ?? event.final !== false)) speak(event.text);
        }
        if (event.type === "hazard.alert") {
          // Proactive ADAS warning: cut any in-progress agent speech so the
          // alert is heard immediately, speak it, then surface it and auto-dismiss.
          if (event.interrupt) stopAgentSpeech();
          speak(`${event.message} ${event.advice}`);
          setTurnState("speaking");
          setHazardAlert({
            threat: event.threat,
            direction: event.direction,
            severity: event.severity,
            label: event.label,
            message: event.message,
            advice: event.advice,
            ttcSeconds: event.ttcSeconds
          });
          if (hazardClearTimerRef.current) window.clearTimeout(hazardClearTimerRef.current);
          hazardClearTimerRef.current = window.setTimeout(() => setHazardAlert(null), (event.ttcSeconds + 2) * 1000);
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
          // The guided tour drives scenario/mode server-side; mirror them so the
          // toggles and a later restartSession stay in sync with the tour.
          scenarioRef.current = event.scenario;
          rideModeRef.current = event.mode;
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
  }, [playPcm16, pushTranscript, setPacketStats, speak, stopAgentSpeech]);

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
      saveStoredSettings({ voiceGender: gender, voicePersonality: voicePersonalityRef.current });
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
      saveStoredSettings({ voiceGender: voiceGenderRef.current, voicePersonality: personality });
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

  // Guided demo ride: the mock provider tours the scenario catalog hands-off.
  const setGuidedDemo = useCallback((enabled: boolean) => {
    guidedDemoRef.current = enabled;
    setGuidedDemoState(enabled);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "demo.guided", enabled }));
    } else if (enabled) {
      setStatus("巡游演示已开启，开启免提后自动巡游场景");
    }
  }, []);

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
      ensurePlaybackContext();
      stopAgentSpeech();
      setTrackEnabled(true);
      transmittingRef.current = true;
      setMicPermission("granted");
      resetFrameWindow();
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
  }, [
    ensureMic,
    ensurePlaybackContext,
    resetFrameWindow,
    setPacketStats,
    setTrackEnabled,
    stopAgentSpeech,
    waitForSocket
  ]);

  // Stops transmitting but keeps the audio graph alive (the track is disabled,
  // so no real audio is captured) for an instant restart next time.
  const stopMic = useCallback(() => {
    transmittingRef.current = false;
    setTrackEnabled(false);
    resetFrameWindow();
    setListening(false);
    setTurnState("idle");
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.stop" }));
    }
  }, [resetFrameWindow, setTrackEnabled]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    if (hazardClearTimerRef.current) {
      window.clearTimeout(hazardClearTimerRef.current);
      hazardClearTimerRef.current = null;
    }
    setHazardAlert(null);
    stopMic();
    releaseMic();
    stopAgentSpeech();
    closePlayback();
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
    setConnectionState("offline");
    setTurnState("idle");
    setStatus("离线");
  }, [closePlayback, releaseMic, stopAgentSpeech, stopMic]);

  useEffect(() => () => disconnect(), [disconnect]);

  // Keep the screen awake while a hands-free session is active. Mobile browsers
  // (iOS Safari 16.4+, Android Chrome) dim and then lock the screen on idle,
  // which suspends the audio context and cuts the conversation mid-ride. The
  // Wake Lock is auto-released whenever the tab is hidden, so re-acquire it when
  // the page returns to the foreground. Best-effort: unsupported browsers no-op.
  useEffect(() => {
    if (!listening) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let cancelled = false;
    let sentinel: WakeLockSentinel | null = null;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release();
          sentinel = null;
        }
      } catch {
        /* lost user activation or unsupported — leave the screen on its default */
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !sentinel) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
      sentinel = null;
    };
  }, [listening]);

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
    hazardAlert,
    telemetry,
    sessionMemory,
    micPermission,
    locationPermission,
    audioProcessing,
    guidedDemo,
    setVoiceGender,
    setVoicePersonality,
    setRideMode,
    setScenario,
    setGuidedDemo,
    clearTranscript,
    startMic,
    stopMic
  };
}
