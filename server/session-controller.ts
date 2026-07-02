import type { RawData, WebSocket } from "ws";
import type { Logger } from "./logger";
import type { AgentProvider, ClientEvent } from "./providers/types";

export type ProviderFactory = (client: WebSocket) => AgentProvider;

const MAX_CLIENT_JSON_BYTES = 8 * 1024;
const MAX_CLIENT_AUDIO_BYTES = 32 * 1024;
const VOICE_GENDERS = new Set(["female", "male"]);
const VOICE_PERSONALITIES = new Set(["concise", "friendly", "technical", "rally"]);
const RIDE_MODES = new Set(["ride", "stop", "navigation", "emergency"]);
const DEMO_SCENARIOS = new Set(["commute", "wind", "fuel", "group", "emergency", "adas"]);
const MEMORY_LANGUAGES = new Set(["zh", "en"]);
const RESPONSE_MODES = new Set(["concise", "normal", "emergency"]);
const RIDER_INTENTS = new Set(["navigation", "weather", "emergency", "diagnostics", "group", "casual"]);
const MAX_MEMORY_DESTINATION_BYTES = 256;

export function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function assertOptionalEnum(value: unknown, allowed: Set<string>, field: string) {
  if (value !== undefined && (typeof value !== "string" || !allowed.has(value))) {
    throw new Error(`Invalid ${field}`);
  }
}

function assertOptionalCoordinate(value: unknown, min: number, max: number, field: string) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) {
    throw new Error(`Invalid ${field}`);
  }
}

/** The optional session-memory snapshot echoed back by restarting clients. */
function assertOptionalMemory(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory");
  const memory = value as Record<string, unknown>;
  assertOptionalEnum(memory.language, MEMORY_LANGUAGES, "memory.language");
  assertOptionalEnum(memory.responseMode, RESPONSE_MODES, "memory.responseMode");
  assertOptionalEnum(memory.lastIntent, RIDER_INTENTS, "memory.lastIntent");
  if (
    memory.destination !== undefined &&
    (typeof memory.destination !== "string" || memory.destination.length > MAX_MEMORY_DESTINATION_BYTES)
  ) {
    throw new Error("Invalid memory.destination");
  }
}

export function parseClientEvent(data: RawData): ClientEvent {
  const buffer = normalizeRawData(data);
  if (buffer.byteLength > MAX_CLIENT_JSON_BYTES) throw new Error("Client event is too large");

  const value = JSON.parse(buffer.toString()) as Record<string, unknown>;
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    throw new Error("Client event type is required");
  }

  if (value.type === "audio.start" || value.type === "audio.stop") {
    return { type: value.type };
  }

  if (value.type === "demo.guided") {
    if (typeof value.enabled !== "boolean") throw new Error("Invalid demo.guided enabled flag");
    return { type: "demo.guided", enabled: value.enabled };
  }

  if (value.type !== "session.start") {
    throw new Error(`Unsupported client event ${value.type}`);
  }

  if (value.sampleRate !== 16000) throw new Error("Invalid sampleRate");
  if (value.channels !== 1) throw new Error("Invalid channels");
  assertOptionalEnum(value.voiceGender, VOICE_GENDERS, "voiceGender");
  assertOptionalEnum(value.voicePersonality, VOICE_PERSONALITIES, "voicePersonality");
  assertOptionalEnum(value.rideMode, RIDE_MODES, "rideMode");
  assertOptionalEnum(value.scenario, DEMO_SCENARIOS, "scenario");
  assertOptionalCoordinate(value.lat, -90, 90, "lat");
  assertOptionalCoordinate(value.lon, -180, 180, "lon");
  assertOptionalMemory(value.memory);

  return value as ClientEvent;
}

export class AgentSessionController {
  private readonly provider: AgentProvider;

  constructor(
    private readonly client: WebSocket,
    providerFactory: ProviderFactory,
    private readonly log?: Logger
  ) {
    this.provider = providerFactory(client);
    this.send({ type: "connection", state: "relay", detail: "语音中继 WebSocket 已连接" });
  }

  async handleMessage(data: RawData, isBinary: boolean) {
    try {
      if (isBinary) {
        const chunk = normalizeRawData(data);
        if (chunk.byteLength > MAX_CLIENT_AUDIO_BYTES) throw new Error("Audio frame is too large");
        await this.provider.sendAudio(chunk);
        return;
      }

      const event = parseClientEvent(data);
      if (event.type !== "audio.start" && event.type !== "audio.stop") {
        this.log?.info(
          `client event: ${event.type}`,
          event.type === "session.start"
            ? {
                scenario: event.scenario,
                rideMode: event.rideMode,
                voiceGender: event.voiceGender
              }
            : undefined
        );
      }
      if (event.type === "session.start") await this.provider.start(event);
      if (event.type === "audio.start") await this.provider.startAudio();
      if (event.type === "audio.stop") await this.provider.stopAudio();
      if (event.type === "demo.guided") await this.provider.setGuidedDemo?.(event.enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice relay failed";
      this.log?.warn("client message failed", { message });
      this.send({ type: "error", message });
    }
  }

  async close() {
    await this.provider.close();
  }

  private send(payload: unknown) {
    if (this.client.readyState === this.client.OPEN) {
      this.client.send(JSON.stringify(payload));
    }
  }
}
