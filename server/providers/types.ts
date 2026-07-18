import type { SessionStartEvent } from "../../shared/agent";
import type { UserMemoryTurn } from "../user-memory";

export type { ClientEvent, SessionStartEvent, VoiceGender } from "../../shared/agent";

export type ProviderTelemetry = {
  serverEvent(payload: unknown, bytes: number): void;
  serverAudio(bytes: number): void;
  ttsFallback(): void;
};

export type ProviderSessionContext = {
  /** Bounded, server-owned history for the authenticated user. */
  previousConversation?: {
    updatedAt: number;
    turns: UserMemoryTurn[];
  };
};

export type AgentProvider = {
  start(event: SessionStartEvent, context?: ProviderSessionContext): Promise<void>;
  startAudio(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  stopAudio(): Promise<void>;
  close(): Promise<void>;
  /** Toggles the guided demo ride. Providers without a demo tour omit this. */
  setGuidedDemo?(enabled: boolean): Promise<void>;
  /** Mid-ride rider position update. Providers without location context omit this. */
  updateLocation?(lat: number, lon: number): Promise<void>;
};
