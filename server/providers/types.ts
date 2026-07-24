import type { DeviceResultEvent, SessionStartEvent } from "../../shared/agent";
import type { UserMemoryFact, UserMemoryTurn } from "../user-memory";

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
    facts: UserMemoryFact[];
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
  /** Result of a dispatched device command. Providers without a device-action
   *  path omit this. */
  deviceResult?(event: DeviceResultEvent): Promise<void>;
};
