import type { SessionStartEvent } from "../../shared/agent";

export type { ClientEvent, SessionStartEvent, VoiceGender } from "../../shared/agent";

export type AgentProvider = {
  start(event: SessionStartEvent): Promise<void>;
  startAudio(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  stopAudio(): Promise<void>;
  close(): Promise<void>;
  /** Toggles the guided demo ride. Providers without a demo tour omit this. */
  setGuidedDemo?(enabled: boolean): Promise<void>;
  /** Mid-ride rider position update. Providers without location context omit this. */
  updateLocation?(lat: number, lon: number): Promise<void>;
};
