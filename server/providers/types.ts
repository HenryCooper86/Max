import type { SessionStartEvent } from "../../shared/agent";

export type { ClientEvent, SessionStartEvent, VoiceGender } from "../../shared/agent";

export type AgentProvider = {
  start(event: SessionStartEvent): Promise<void>;
  startAudio(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  stopAudio(): Promise<void>;
  close(): Promise<void>;
};
