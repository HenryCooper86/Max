// UI-facing types for the web HUD. Server protocol types live in shared/.

import type { HazardLevel } from "../shared/agent";
import type { AdasDirection, AdasSeverity, AdasThreat } from "../shared/adas";
import type { SupportedLanguage } from "../shared/language";
import type { DemoScenario, RideMode } from "../shared/ride";

export type VoiceGender = "female" | "male";

export type TranscriptItem = {
  id: number;
  at: number;
  speaker: "rider" | "agent";
  text: string;
  final: boolean;
  language: SupportedLanguage;
  /** Reason the tester flagged this turn as bad (mirrors the relay-side flag). */
  feedback?: string;
};

// Messages posted from public/pcm-worklet.js.
export type WorkletMessage =
  | { type: "frame"; pcm: ArrayBuffer }
  | { type: "level"; value: number; clippingPct?: number; silencePct?: number };

export type RiderLocation = { lat: number; lon: number };

export type RideHudContext = {
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

export type HazardAlertState = {
  threat: AdasThreat;
  direction: AdasDirection;
  severity: AdasSeverity;
  label: string;
  message: string;
  advice: string;
  ttcSeconds: number;
};

export type Telemetry = {
  asrMs: number;
  thinkMs: number;
  firstAudioMs: number;
  totalMs: number;
};

export type SessionMemoryState = {
  language: "zh" | "en";
  destination?: string;
  lastIntent?: string;
  responseMode: "concise" | "normal" | "emergency";
};

export type PacketStats = {
  outgoingFps: number;
  droppedFrames: number;
  jitterMs: number;
  clippingPct: number;
  silencePct: number;
};

export type PermissionStateLabel = "granted" | "prompt" | "denied" | "unknown";

export type AudioProcessingState = {
  echoCancellation: boolean | "unknown";
  noiseSuppression: boolean | "unknown";
  autoGainControl: boolean | "unknown";
  sampleRate?: number;
};
