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
};

export type ClientEvent = SessionStartEvent | { type: "audio.start" } | { type: "audio.stop" };

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
  | { type: "error"; message: string };

export type AgentHealth = {
  ok: boolean;
  provider: string;
  uptimeSec: number;
  credentials: "configured" | "missing" | "not-required";
  weather: "available";
  capabilities: ProviderCapabilities;
};

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
