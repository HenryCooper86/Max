import type { AdasDirection, AdasSeverity, AdasThreat } from "./adas";
import type { DemoScenario, RideIntelligence, RideMode } from "./ride";

export type VoiceGender = "female" | "male";
export type VoicePersonality = "concise" | "friendly" | "technical" | "rally";
export type ConnectionState = "offline" | "connecting" | "relay" | "provider" | "ready" | "degraded";
export type ProviderMode = "mock" | "live";
export type NetworkState = "online" | "degraded" | "offline";
export type HazardLevel = RideIntelligence["hazardLevel"];

export type ProviderCapabilities = {
  serverVad: boolean;
  synthesizedAudio: boolean;
  transcriptEvents: boolean;
  bargeIn: boolean;
  voiceSelection: boolean;
  weatherContext: boolean;
  sessionMemory: boolean;
  emergencyMode: boolean;
};

/**
 * Session-memory snapshot a client may echo back in `session.start` — the
 * fields of the last `session.memory` event it received. Settings changes
 * (voice, personality, mode) restart the relay session; without this the
 * agent's short-term memory (destination, intent, language preference) would
 * reset with every toggle.
 */
export type SessionMemorySnapshot = {
  language?: "zh" | "en";
  destination?: string;
  lastIntent?: string;
  responseMode?: "concise" | "normal" | "emergency";
};

export type SessionStartEvent = {
  type: "session.start";
  sampleRate: number;
  channels: number;
  voiceGender?: VoiceGender;
  voicePersonality?: VoicePersonality;
  rideMode?: RideMode;
  scenario?: DemoScenario;
  lat?: number;
  lon?: number;
  memory?: SessionMemorySnapshot;
};

export type ClientEvent =
  | SessionStartEvent
  | { type: "audio.start" }
  | { type: "audio.stop" }
  // Guided demo ride: the mock provider auto-advances through the scenario
  // catalog so a hands-off demo shows every capability. Live provider ignores it.
  | { type: "demo.guided"; enabled: boolean }
  // Mid-ride rider position update. The session-start coordinates go stale
  // fast on a moving motorcycle; this keeps the live weather (and any future
  // location-aware context) tracking the rider. Clients throttle sends.
  | { type: "location.update"; lat: number; lon: number };

export type AgentEvent =
  | {
      type: "session.started";
      provider: string;
      mode: ProviderMode;
      capabilities: ProviderCapabilities;
    }
  | { type: "connection"; state: ConnectionState; detail: string }
  | { type: "status"; state: string; detail: string }
  | { type: "transcript"; speaker: "rider" | "agent"; text: string; final?: boolean; useBrowserSpeech?: boolean }
  | { type: "metric"; latencyMs: number; droppedFrames?: number; outgoingFps?: number }
  | {
      type: "weather";
      description: string;
      temperatureC: number;
      windSpeedKmh: number;
      isDay: boolean;
      riskLevel?: HazardLevel;
      riderAdvice?: string;
    }
  | {
      type: "ride.context";
      mode: RideMode;
      modeLabel: string;
      scenario: DemoScenario;
      scenarioLabel: string;
      speedKmh?: number;
      routePhase?: string;
      network?: NetworkState;
      batteryPct?: number;
      hazardLevel: HazardLevel;
      glanceableFocus: string;
    }
  | {
      type: "session.memory";
      language: "zh" | "en";
      destination?: string;
      lastIntent?: string;
      responseMode: "concise" | "normal" | "emergency";
    }
  | {
      type: "telemetry";
      asrMs: number;
      thinkMs: number;
      firstAudioMs: number;
      totalMs: number;
    }
  | {
      // A proactive ADAS safety alert. `interrupt` tells the client to cut any
      // in-progress agent speech so the warning is heard immediately.
      type: "hazard.alert";
      threat: AdasThreat;
      direction: AdasDirection;
      severity: AdasSeverity;
      label: string;
      message: string;
      advice: string;
      ttcSeconds: number;
      interrupt: boolean;
    }
  | { type: "error"; message: string };

export type AgentHealth = {
  ok: boolean;
  provider: string;
  uptimeSec: number;
  credentials: "configured" | "missing" | "not-required";
  weather: "available";
  capabilities: ProviderCapabilities;
  /** Relay counters since startup (see server/metrics.ts); absent on old relays. */
  metrics?: Record<string, number>;
  /** Counter deltas over the trailing window (server/metrics.ts metricsWindow). */
  metricsWindow?: Record<string, number>;
};

/**
 * WebSocket close code the relay uses when it closes an idle session (see
 * server/watchdog.ts). Clients must treat it as an intentional close and NOT
 * auto-reconnect — reconnecting would immediately re-open the upstream session
 * the idle timeout just freed. Mirrored by the iOS/Android clients.
 */
export const IDLE_CLOSE_CODE = 4001;

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  serverVad: true,
  synthesizedAudio: false,
  transcriptEvents: true,
  bargeIn: true,
  voiceSelection: true,
  weatherContext: true,
  sessionMemory: true,
  emergencyMode: true
};

export const DOUBAO_CAPABILITIES: ProviderCapabilities = {
  serverVad: true,
  synthesizedAudio: true,
  transcriptEvents: true,
  bargeIn: true,
  voiceSelection: true,
  weatherContext: true,
  sessionMemory: true,
  emergencyMode: true
};

export function providerCapabilities(provider: string): ProviderCapabilities {
  return provider === "doubao" ? DOUBAO_CAPABILITIES : MOCK_CAPABILITIES;
}
