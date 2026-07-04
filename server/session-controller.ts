import type { RawData, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger";
import type { AgentProvider, ClientEvent, ProviderTelemetry } from "./providers/types";
import {
  beginTesterSession,
  endTesterSession,
  metrics,
  recordTesterClientAudio,
  recordTesterServerAudio,
  recordTesterServerEvent,
  recordTesterTtsFallback
} from "./metrics";

export type ProviderFactory = (client: WebSocket, telemetry: ProviderTelemetry) => AgentProvider;

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
const MAX_TESTER_ID_BYTES = 80;
const MAX_TESTER_REGION_BYTES = 96;

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

function assertOptionalTesterId(value: unknown) {
  if (value === undefined) return;
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_TESTER_ID_BYTES || hasControlCharacter(value)) {
    throw new Error("Invalid testerId");
  }
}

function assertOptionalTesterRegion(value: unknown) {
  if (value === undefined) return;
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_TESTER_REGION_BYTES || hasControlCharacter(value)) {
    throw new Error("Invalid testerRegion");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function assertCoordinate(value: unknown, min: number, max: number, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
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

  if (value.type === "location.update") {
    assertCoordinate(value.lat, -90, 90, "lat");
    assertCoordinate(value.lon, -180, 180, "lon");
    return { type: "location.update", lat: value.lat as number, lon: value.lon as number };
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
  assertOptionalTesterId(value.testerId);
  assertOptionalTesterRegion(value.testerRegion);
  assertOptionalCoordinate(value.lat, -90, 90, "lat");
  assertOptionalCoordinate(value.lon, -180, 180, "lon");
  assertOptionalMemory(value.memory);

  return value as ClientEvent;
}

export class AgentSessionController {
  private readonly relaySessionId = randomUUID();
  private readonly provider: AgentProvider;

  constructor(
    private readonly client: WebSocket,
    providerFactory: ProviderFactory,
    private readonly log?: Logger,
    private readonly clientIp = "unknown-ip",
    private readonly requestRegion?: string
  ) {
    this.provider = providerFactory(client, {
      serverEvent: (payload, bytes) => {
        metrics.serverEvent(bytes);
        recordTesterServerEvent(this.relaySessionId, payload, bytes);
      },
      serverAudio: (bytes) => {
        metrics.serverAudio(bytes);
        recordTesterServerAudio(this.relaySessionId, bytes);
      },
      ttsFallback: () => recordTesterTtsFallback(this.relaySessionId)
    });
    this.send({ type: "connection", state: "relay", detail: "语音中继 WebSocket 已连接" });
  }

  async handleMessage(data: RawData, isBinary: boolean) {
    try {
      if (isBinary) {
        const chunk = normalizeRawData(data);
        if (chunk.byteLength > MAX_CLIENT_AUDIO_BYTES) throw new Error("Audio frame is too large");
        metrics.clientAudio(chunk.byteLength);
        recordTesterClientAudio(this.relaySessionId, chunk.byteLength);
        await this.provider.sendAudio(chunk);
        return;
      }

      const event = parseClientEvent(data);
      if (event.type !== "audio.start" && event.type !== "audio.stop") {
        this.log?.info(
          `client event: ${event.type}`,
          event.type === "session.start"
            ? {
                testerId: event.testerId,
                testerRegion: event.testerRegion,
                clientIp: this.clientIp,
                scenario: event.scenario,
                rideMode: event.rideMode,
                voiceGender: event.voiceGender
              }
            : undefined
        );
      }
      if (event.type === "session.start") {
        beginTesterSession(this.relaySessionId, {
          testerId: event.testerId,
          ipAddress: this.clientIp,
          region: event.testerRegion ?? this.requestRegion
        });
        await this.provider.start(event);
      }
      if (event.type === "audio.start") await this.provider.startAudio();
      if (event.type === "audio.stop") await this.provider.stopAudio();
      if (event.type === "demo.guided") await this.provider.setGuidedDemo?.(event.enabled);
      if (event.type === "location.update") await this.provider.updateLocation?.(event.lat, event.lon);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice relay failed";
      this.log?.warn("client message failed", { message });
      this.send({ type: "error", message });
    }
  }

  async close() {
    await this.provider.close();
    endTesterSession(this.relaySessionId);
  }

  private send(payload: unknown) {
    if (this.client.readyState === this.client.OPEN) {
      const encoded = JSON.stringify(payload);
      metrics.serverEvent(Buffer.byteLength(encoded));
      recordTesterServerEvent(this.relaySessionId, payload, Buffer.byteLength(encoded));
      this.client.send(encoded);
    }
  }
}
