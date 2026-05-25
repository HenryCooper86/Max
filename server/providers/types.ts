import type { DemoScenario, RideMode } from "../../shared/ride";

export type VoiceGender = "female" | "male";

export type SessionStartEvent = {
  type: "session.start";
  sampleRate: number;
  channels: number;
  voiceGender?: VoiceGender;
  rideMode?: RideMode;
  scenario?: DemoScenario;
  // Rider coordinates, when geolocation is granted — used for live weather.
  lat?: number;
  lon?: number;
};

export type ClientEvent = SessionStartEvent | { type: "audio.start" } | { type: "audio.stop" };

export type AgentProvider = {
  start(event: SessionStartEvent): Promise<void>;
  startAudio(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  stopAudio(): Promise<void>;
  close(): Promise<void>;
};
