// The hands-free session brain: relay WebSocket lifecycle (connect, reconnect,
// event fan-out), session settings, and the start/stop hands-free flow. Audio
// I/O lives in useAudioPlayback / useMicCapture.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnState } from "../components/HelmetVisual";
import type { Weather } from "../components/Instruments";
import {
  IDLE_CLOSE_CODE,
  type AgentHealth,
  type ConnectionState,
  type ProviderCapabilities,
  type VoicePersonality
} from "../../shared/agent";
import { validateAgentEvent } from "../../shared/events";
import { detectLanguage } from "../../shared/language";
import {
  defaultTestCaseForCampaign,
  findTestingCampaign,
  findTestingTestCase,
  type TestingTestCase
} from "../../shared/testing";
import {
  approxDistanceKm,
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
const initialTesterId = storedSettings.testerId ?? `tester-${Math.random().toString(36).slice(2, 8)}`;
const LOCATION_START_GRACE_MS = 900;
const HEALTH_POLL_MS = 5000;
// Mid-ride location updates: send at most one per interval, and only after
// real movement — the relay only refetches weather past ~20 km anyway.
const LOCATION_UPDATE_MIN_INTERVAL_MS = 60_000;
const LOCATION_UPDATE_MIN_MOVE_KM = 0.25;
const clientEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function stripControlChars(value: string) {
  return value
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
}

function testerRegionLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || navigator.language || "browser";
  } catch {
    return "browser";
  }
}

function deviceLabel(): string {
  const userAgent = navigator.userAgent || "browser";
  if (/iPhone/i.test(userAgent)) return "iPhone Safari";
  if (/iPad/i.test(userAgent)) return "iPad Safari";
  if (/Android/i.test(userAgent)) return "Android browser";
  if (/Macintosh/i.test(userAgent)) return "macOS browser";
  if (/Windows/i.test(userAgent)) return "Windows browser";
  return userAgent.slice(0, 120);
}

function networkType(): string {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; type?: string } }).connection;
  return connection?.effectiveType || connection?.type || "unknown";
}

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
  const [testerId, setTesterIdState] = useState(initialTesterId);
  const [testingCampaignId, setTestingCampaignIdState] = useState(
    findTestingCampaign(storedSettings.testingCampaignId).id
  );
  const [testingTestCaseId, setTestingTestCaseIdState] = useState(
    findTestingTestCase(storedSettings.testingTestCaseId).id
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

  const [starting, setStarting] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const transmittingRef = useRef(false);
  // Re-entrancy guard + cancellation token for startMic: a second toggle while
  // the (multi-await) start is in flight must not launch a parallel start, and
  // stopMic must be able to cancel a start already past its awaits.
  const startingRef = useRef(false);
  const startAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const isLiveRef = useRef(false);
  const voiceGenderRef = useRef<VoiceGender>(storedSettings.voiceGender ?? "female");
  const voicePersonalityRef = useRef<VoicePersonality>(storedSettings.voicePersonality ?? "concise");
  const testerIdRef = useRef(initialTesterId);
  const testingCampaignIdRef = useRef(findTestingCampaign(storedSettings.testingCampaignId).id);
  const testingTestCaseIdRef = useRef(findTestingTestCase(storedSettings.testingTestCaseId).id);
  const locationRef = useRef<RiderLocation | null>(null);
  const rideModeRef = useRef<RideMode>(DEFAULT_RIDE_CONTEXT.mode);
  const scenarioRef = useRef<DemoScenario>(DEFAULT_RIDE_CONTEXT.scenario);
  const transcriptTurnRef = useRef(0);
  const hazardClearTimerRef = useRef<number | null>(null);
  const guidedDemoRef = useRef(false);
  // Latest server-issued session memory, echoed back in session.start so a
  // settings-change restart keeps the agent's short-term memory.
  const sessionMemoryRef = useRef<SessionMemoryState>(DEFAULT_MEMORY);
  // Last agent text handed to speak(), for duplicate-final suppression.
  const lastSpokenRef = useRef<{ text: string; at: number } | null>(null);

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
  // Debounced: live ASR revises the last item several times a second, and each
  // write is a synchronous JSON.stringify of up to 200 items on the same main
  // thread doing 16 kHz audio work. Restored items are forced final anyway, so
  // trailing-edge writes lose nothing.
  useEffect(() => {
    const timer = window.setTimeout(() => saveStoredTranscript(transcript), 400);
    return () => window.clearTimeout(timer);
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

  // Persist the settings refs in one place. The tester id keeps its last
  // non-empty value: persisting "" (a field cleared mid-edit) would generate a
  // fresh random id on the next load and orphan the tester's server-side stats.
  const lastNonEmptyTesterIdRef = useRef(initialTesterId);
  const persistSettings = useCallback(() => {
    if (testerIdRef.current) lastNonEmptyTesterIdRef.current = testerIdRef.current;
    saveStoredSettings({
      voiceGender: voiceGenderRef.current,
      voicePersonality: voicePersonalityRef.current,
      testerId: lastNonEmptyTesterIdRef.current,
      testingCampaignId: testingCampaignIdRef.current,
      testingTestCaseId: testingTestCaseIdRef.current
    });
  }, []);

  useEffect(() => {
    if (!storedSettings.testerId) persistSettings();
    // Run once on mount to persist the generated id only when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshHealth = async () => {
      const nextHealth = await fetchAgentHealth();
      if (cancelled || !nextHealth) return;
      setHealth(nextHealth);
      setProvider(nextHealth.provider);
      setCapabilities(nextHealth.capabilities);
    };
    // Skip polls while the tab is hidden — a backgrounded HUD refreshing the
    // QA dashboard 12×/min serves nobody. Refresh immediately on return.
    const poll = () => {
      if (!document.hidden) void refreshHealth();
    };
    const onVisibility = () => {
      if (!document.hidden) void refreshHealth();
    };
    void refreshHealth();
    const timer = window.setInterval(poll, HEALTH_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
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
    // The query is async, so guard against the effect being torn down (e.g. a
    // StrictMode remount) before it resolves, and remove every "change" listener
    // on cleanup so they don't accumulate across mounts.
    let active = true;
    const cleanups: Array<() => void> = [];
    const trackPermission = async (name: PermissionName, setter: (state: PermissionStateLabel) => void) => {
      try {
        const status = await navigator.permissions.query({ name });
        if (!active) return;
        const update = () => setter(status.state);
        update();
        status.addEventListener("change", update);
        cleanups.push(() => status.removeEventListener("change", update));
      } catch {
        setter("unknown");
      }
    };
    void trackPermission("microphone" as PermissionName, setMicPermission);
    void trackPermission("geolocation", setLocationPermission);
    return () => {
      active = false;
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  // Stops transmitting but keeps the audio graph alive (the track is disabled,
  // so no real audio is captured) for an instant restart next time. Declared
  // before connect() so the close-handler paths that end hands-free can use it.
  const stopMic = useCallback(() => {
    // Invalidate any in-flight startMic so it can't re-enable transmission
    // after its awaits resolve.
    startAttemptRef.current += 1;
    startingRef.current = false;
    setStarting(false);
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
      // A pending backoff retry is moot once a connection is open.
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setConnected(true);
      setConnectionState("relay");
      setStatus("就绪");
      const location = locationRef.current;
      socket.send(
        JSON.stringify({
          type: "session.start",
          sampleRate: SAMPLE_RATE,
          channels: 1,
          // Mid-edit (field cleared) the last real id keeps stats continuity.
          testerId: testerIdRef.current || lastNonEmptyTesterIdRef.current,
          testerRegion: testerRegionLabel(),
          testingCampaignId: testingCampaignIdRef.current,
          testingTestCaseId: testingTestCaseIdRef.current,
          appVersion: clientEnv.VITE_APP_VERSION ?? "0.1.0",
          gitCommit: clientEnv.VITE_GIT_COMMIT ?? "local",
          deviceLabel: deviceLabel(),
          browserLanguage: navigator.language || "unknown",
          networkType: networkType(),
          voiceGender: voiceGenderRef.current,
          voicePersonality: voicePersonalityRef.current,
          rideMode: rideModeRef.current,
          scenario: scenarioRef.current,
          ...(location ? { lat: location.lat, lon: location.lon } : {}),
          memory: sessionMemoryRef.current
        })
      );
      // The guided tour and audio stream live in the provider instance, so a
      // fresh session must be told about both again.
      if (guidedDemoRef.current) socket.send(JSON.stringify({ type: "demo.guided", enabled: true }));
      if (transmittingRef.current) socket.send(JSON.stringify({ type: "audio.start" }));
    });

    socket.addEventListener("message", (message) => {
      // Ignore a socket already superseded by a newer one (same guard as the
      // close/error handlers): after a settings-change restart, messages
      // queued on the old socket still dispatch and would play stale PCM and
      // mutate the fresh session's transcript/turn state.
      if (socketRef.current !== socket) return;
      if (message.data instanceof ArrayBuffer) {
        // playPcm16 can throw (e.g. AudioContext creation limits); keep it from
        // escaping the WebSocket message handler as an unhandled error.
        try {
          playPcm16(message.data);
        } catch (error) {
          console.error("PCM playback failed", error);
        }
        return;
      }

      try {
        // Validate instead of blind-casting: a malformed event from a skewed
        // relay is dropped here rather than rendering NaN/undefined in the HUD.
        // Unknown event types (newer relay) are ignored silently.
        const event = validateAgentEvent(JSON.parse(String(message.data)));
        if (!event) return;
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
          if (event.speaker === "rider") {
            stopAgentSpeech();
            // The rider spoke: a duplicate agent final replayed after this is
            // a genuine re-delivery, not a double-speak — let it through.
            lastSpokenRef.current = null;
          }
          pushTranscript(event.speaker, event.text, event.final !== false);
          if (event.speaker === "agent" && (event.useBrowserSpeech ?? event.final !== false)) {
            // Mirror pushTranscript's duplicate-final dedupe: speak() starts by
            // cancelling the current utterance, so replaying a duplicate final
            // mid-utterance would audibly restart the reply from the beginning.
            const normalized = normalizeTranscriptText(event.text);
            const lastSpoken = lastSpokenRef.current;
            const now = Date.now();
            if (!(lastSpoken && lastSpoken.text === normalized && now - lastSpoken.at < 8000)) {
              lastSpokenRef.current = { text: normalized, at: now };
              speak(event.text);
            }
          }
        }
        if (event.type === "hazard.alert") {
          // Proactive ADAS warning: cut any in-progress agent speech so the
          // alert is heard immediately, speak it, then surface it and auto-dismiss.
          if (event.interrupt) stopAgentSpeech();
          speak(`${event.message} ${event.advice}`);
          // Only status events (gated on transmittingRef) ever map turnState
          // back, so don't set "speaking" when hands-free is off — it would
          // stick until the next mic toggle.
          if (transmittingRef.current) setTurnState("speaking");
          // A non-numeric TTC would make the auto-dismiss timeout NaN, which
          // fires immediately — flashing the safety banner for one frame.
          const ttcSeconds = Number.isFinite(event.ttcSeconds) ? event.ttcSeconds : 6;
          setHazardAlert({
            threat: event.threat,
            direction: event.direction,
            severity: event.severity,
            label: event.label,
            message: event.message,
            advice: event.advice,
            ttcSeconds
          });
          if (hazardClearTimerRef.current) window.clearTimeout(hazardClearTimerRef.current);
          hazardClearTimerRef.current = window.setTimeout(() => setHazardAlert(null), (ttcSeconds + 2) * 1000);
        }
        if (event.type === "metric") {
          // A frames-only metric arrives with latencyMs 0 — keep the last
          // real reading instead of zeroing the HUD readout.
          if (event.latencyMs > 0) setLatencyMs(event.latencyMs);
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
          // The ride context's hazardLevel is owned by the server's ride.context
          // events (already fused with weather there). Don't fold weather in again
          // here: combineHazardLevels only raises, so a weather event that *lowers*
          // the risk would leave rideContext.hazardLevel stuck high — and the live
          // path can go a whole session between ride.context events. The helmet and
          // ride-pulse tints fuse the current weather at render time (App.tsx), so
          // weather risk is reflected without ratcheting this state.
        }
        if (event.type === "ride.context") {
          setRideContext({
            mode: event.mode,
            modeLabel: event.modeLabel,
            scenario: event.scenario,
            scenarioLabel: event.scenarioLabel,
            speedKmh: event.speedKmh ?? 0,
            // Treat an empty string as missing too, matching the iOS/Android
            // parsers (routePhase.isEmpty / ifEmpty) — all three clients then
            // show the fallback instead of a blank field for a server that
            // ever sends "".
            routePhase: event.routePhase || "等待路线信息",
            network: event.network || "online",
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
          const memory = {
            language: event.language,
            destination: event.destination,
            lastIntent: event.lastIntent,
            responseMode: event.responseMode
          };
          sessionMemoryRef.current = memory;
          setSessionMemory(memory);
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

    socket.addEventListener("close", (event) => {
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
      // The relay closed us for inactivity to free the upstream slot; an
      // auto-reconnect would immediately re-open it, so stay offline until the
      // rider starts hands-free again. stopMic also halts transmission — leaving
      // transmittingRef set would keep the mic hot and burn a dropped-frame
      // state update per 20 ms captured frame.
      if (event.code === IDLE_CLOSE_CODE) {
        stopMic();
        setStatus("会话闲置已断开，开启免提后重新连接");
        return;
      }

      // Unexpected drop: reconnect with exponential backoff.
      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current = 0;
        stopMic();
        setConnectionState("degraded");
        setStatus("语音中继连接失败，请重新开启免提");
        return;
      }
      const delay = Math.min(8000, 1000 * 2 ** (reconnectAttemptsRef.current - 1));
      setStatus(`连接已断开，${Math.round(delay / 1000)} 秒后自动重连…`);
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
    });

    socket.addEventListener("error", () => {
      // Ignore a socket already superseded by a newer one (e.g. a restart);
      // its abort error would otherwise flip the fresh session to "degraded".
      if (socketRef.current !== socket) return;
      setConnectionState("degraded");
      setStatus("连接错误");
    });
  }, [playPcm16, pushTranscript, setPacketStats, speak, stopAgentSpeech, stopMic]);

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
      persistSettings();
      // Only show the progressive "switching…" status when a session restart is
      // actually happening; without a socket nothing ever resolves it, so the
      // switch simply takes effect at the next session start.
      if (socketRef.current) {
        setStatus(gender === "male" ? "正在切换到男声…" : "正在切换到女声…");
        restartSession();
      } else {
        setStatus(gender === "male" ? "已切换到男声" : "已切换到女声");
      }
    },
    [persistSettings, restartSession]
  );

  const setVoicePersonality = useCallback(
    (personality: VoicePersonality) => {
      voicePersonalityRef.current = personality;
      setVoicePersonalityState(personality);
      persistSettings();
      setStatus(`已切换语气：${PERSONALITY_LABELS[personality]}`);
      if (socketRef.current) restartSession();
    },
    [persistSettings, restartSession]
  );

  const setTesterId = useCallback(
    (value: string) => {
      const next = stripControlChars(value.normalize("NFKC")).replace(/\s+/g, " ").trim().slice(0, 80);
      testerIdRef.current = next;
      setTesterIdState(next);
      persistSettings();
    },
    [persistSettings]
  );

  const applyTestingRideContext = useCallback((testCase: TestingTestCase) => {
    scenarioRef.current = testCase.scenario;
    rideModeRef.current = testCase.rideMode;
    const hazardLevel = combineHazardLevels(
      testCase.rideMode === "emergency" ? "critical" : testCase.rideMode === "navigation" ? "caution" : "normal",
      SCENARIO_HAZARDS[testCase.scenario]
    );
    setRideContext((context) => ({
      ...context,
      scenario: testCase.scenario,
      scenarioLabel: scenarioLabel(testCase.scenario),
      mode: testCase.rideMode,
      modeLabel: RIDE_MODE_LABELS[testCase.rideMode],
      hazardLevel
    }));
  }, []);

  const setTestingCampaignId = useCallback(
    (campaignId: string) => {
      const campaign = findTestingCampaign(campaignId);
      const currentCase = findTestingTestCase(testingTestCaseIdRef.current);
      const nextCase: TestingTestCase =
        currentCase.campaignId === campaign.id ? currentCase : defaultTestCaseForCampaign(campaign.id);
      testingCampaignIdRef.current = campaign.id;
      testingTestCaseIdRef.current = nextCase.id;
      setTestingCampaignIdState(campaign.id);
      setTestingTestCaseIdState(nextCase.id);
      persistSettings();
      applyTestingRideContext(nextCase);
      setStatus(`测试活动：${campaign.name}`);
      if (socketRef.current) restartSession();
    },
    [applyTestingRideContext, persistSettings, restartSession]
  );

  const setTestingTestCaseId = useCallback(
    (testCaseId: string) => {
      const testCase = findTestingTestCase(testCaseId);
      const campaign = findTestingCampaign(testCase.campaignId);
      testingCampaignIdRef.current = campaign.id;
      testingTestCaseIdRef.current = testCase.id;
      setTestingCampaignIdState(campaign.id);
      setTestingTestCaseIdState(testCase.id);
      persistSettings();
      applyTestingRideContext(testCase);
      setStatus(`测试用例：${testCase.name}`);
      if (socketRef.current) restartSession();
    },
    [applyTestingRideContext, persistSettings, restartSession]
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
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      throw new Error("语音连接已关闭，请重试");
    }

    return new Promise<WebSocket>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("语音连接打开超时"));
      }, 8000);
      const handleOpen = () => {
        cleanup();
        resolve(socket);
      };
      const handleError = () => {
        cleanup();
        reject(new Error("语音连接打开失败"));
      };
      const handleClose = () => {
        cleanup();
        reject(new Error("语音连接已关闭，请重试"));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    });
  }, [connect]);

  // Start the hands-free session: grab geolocation (for live weather), open the
  // relay, and stream the mic continuously — Doubao's VAD handles turn-taking.
  const startMic = useCallback(async () => {
    if (startingRef.current) return; // a start is already in flight
    startingRef.current = true;
    setStarting(true);
    const attempt = ++startAttemptRef.current;
    try {
      // The playback context must be created inside THIS user gesture — after
      // the location grace, socket open, and a possible mic-permission prompt
      // below, transient activation has expired and Safari would keep the
      // context suspended, muting the first agent reply.
      ensurePlaybackContext();
      // Geolocation is best-effort for live weather; fire it in parallel so a slow
      // or pending GPS prompt never blocks opening the relay or the mic. A short
      // grace window lets cached/fast coordinates make the first session.start.
      if (!locationRef.current) {
        const locationLookup = getRiderLocation().then((location) => {
          if (location) {
            locationRef.current = location;
            setLocationPermission("granted");
          }
          // On null (denied/timeout) we leave the label to the navigator.permissions
          // tracker, which reports "denied" accurately — don't clobber it here.
          return location;
        });
        await Promise.race([locationLookup, delay(LOCATION_START_GRACE_MS)]);
      }
      const socket = await waitForSocket();
      await ensureMic();
      // stopMic ran while we were awaiting: honor the rider's stop.
      if (attempt !== startAttemptRef.current) return;
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
      if (attempt !== startAttemptRef.current) return; // superseded, not a failure
      transmittingRef.current = false;
      setListening(false);
      setTurnState("idle");
      setStatus(error instanceof Error ? error.message : "无法访问麦克风");
    } finally {
      startingRef.current = false;
      setStarting(false);
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

  // Track the rider mid-ride so live weather follows the bike instead of the
  // start point: while hands-free is active, watch geolocation and push
  // throttled location.update events to the relay (which refetches weather
  // when the rider has moved far enough). The watch only runs while listening,
  // so a stopped session sends nothing and the relay's idle timeout still works.
  useEffect(() => {
    if (!listening) return;
    if (typeof navigator === "undefined" || !navigator.geolocation?.watchPosition) return;

    let lastSentAt = 0;
    let lastSent: RiderLocation | null = locationRef.current;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const next = { lat: position.coords.latitude, lon: position.coords.longitude };
        // Future session.starts (settings-change restarts) carry fresh coords too.
        locationRef.current = next;
        const now = Date.now();
        if (now - lastSentAt < LOCATION_UPDATE_MIN_INTERVAL_MS) return;
        if (lastSent && approxDistanceKm(lastSent, next) < LOCATION_UPDATE_MIN_MOVE_KM) return;
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "location.update", lat: next.lat, lon: next.lon }));
          lastSentAt = now;
          lastSent = next;
        }
      },
      () => {
        /* denied/unavailable — session-start coordinates (or the server default) stay in effect */
      },
      { enableHighAccuracy: false, maximumAge: 30_000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [listening]);

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
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel = lock;
        // The browser releases the lock on its own when the tab is hidden; drop
        // our handle then, or the visibility handler would see a stale sentinel
        // and never re-acquire.
        lock.addEventListener("release", () => {
          if (sentinel === lock) sentinel = null;
        });
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
    starting,
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
    testerId,
    testingCampaignId,
    testingTestCaseId,
    testerRegion: testerRegionLabel(),
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
    setTesterId,
    setTestingCampaignId,
    setTestingTestCaseId,
    setRideMode,
    setScenario,
    setGuidedDemo,
    clearTranscript,
    startMic,
    stopMic
  };
}
