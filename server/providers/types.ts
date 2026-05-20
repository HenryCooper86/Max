export type SessionStartEvent = {
  type: "session.start";
  sampleRate: number;
  channels: number;
};

export type ClientEvent = SessionStartEvent | { type: "audio.start" } | { type: "audio.stop" };

export type AgentProvider = {
  start(event: SessionStartEvent): Promise<void>;
  startAudio(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  stopAudio(): Promise<void>;
  close(): Promise<void>;
};
