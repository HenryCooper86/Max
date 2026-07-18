import type { RawData, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger";
import type { AgentProvider, ClientEvent, ProviderSessionContext, ProviderTelemetry } from "./providers/types";
import {
  beginTesterSession,
  endTesterSession,
  metrics,
  recordTesterClientAudio,
  recordTesterAudioQuality,
  recordTesterServerAudio,
  recordTesterServerEvent,
  recordTesterTtsFallback,
  recordTesterTurnFeedback
} from "./metrics";
import { recordUserMemoryEvent, userConversationMemory, userMemoryEnabled } from "./user-memory";

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
const TESTING_PLATFORMS = new Set(["web", "ios", "android", "unknown"]);
const MAX_MEMORY_DESTINATION_BYTES = 256;
const MAX_TESTER_ID_BYTES = 80;
const MAX_TESTER_REGION_BYTES = 96;
const MAX_TESTING_META_BYTES = 160;

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

function assertOptionalMetadataString(value: unknown, field: string, maxBytes = MAX_TESTING_META_BYTES) {
  if (value === undefined) return;
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes || hasControlCharacter(value)) {
    throw new Error(`Invalid ${field}`);
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
    (typeof memory.destination !== "string" || Buffer.byteLength(memory.destination) > MAX_MEMORY_DESTINATION_BYTES)
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

  if (value.type === "turn.feedback") {
    if (value.speaker !== "rider" && value.speaker !== "agent") throw new Error("Invalid turn.feedback speaker");
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 2_000) {
      throw new Error("Invalid turn.feedback text");
    }
    if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 120) {
      throw new Error("Invalid turn.feedback reason");
    }
    return { type: "turn.feedback", speaker: value.speaker, text: value.text, reason: value.reason };
  }

  if (value.type === "testing.metric") {
    const metric = (field: string, max: number) => {
      const candidate = value[field];
      if (candidate === undefined) return undefined;
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > max) {
        throw new Error(`Invalid testing.metric ${field}`);
      }
      return candidate;
    };
    return {
      type: "testing.metric",
      droppedFrames: metric("droppedFrames", 10_000_000),
      outgoingFps: metric("outgoingFps", 1_000),
      jitterMs: metric("jitterMs", 60_000),
      clippingPct: metric("clippingPct", 100),
      silencePct: metric("silencePct", 100)
    };
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
  assertOptionalMetadataString(value.testingCampaignId, "testingCampaignId", 80);
  assertOptionalMetadataString(value.testingTestCaseId, "testingTestCaseId", 80);
  assertOptionalMetadataString(value.testingRunId, "testingRunId", 80);
  assertOptionalMetadataString(value.testingAssignmentId, "testingAssignmentId", 80);
  assertOptionalMetadataString(value.appVersion, "appVersion", 40);
  assertOptionalMetadataString(value.gitCommit, "gitCommit", 80);
  assertOptionalMetadataString(value.deviceLabel, "deviceLabel", 120);
  assertOptionalMetadataString(value.browserLanguage, "browserLanguage", 40);
  assertOptionalMetadataString(value.networkType, "networkType", 40);
  assertOptionalEnum(value.platform, TESTING_PLATFORMS, "platform");
  assertOptionalCoordinate(value.lat, -90, 90, "lat");
  assertOptionalCoordinate(value.lon, -180, 180, "lon");
  assertOptionalMemory(value.memory);

  return value as ClientEvent;
}

export class AgentSessionController {
  private readonly relaySessionId = randomUUID();
  private readonly provider: AgentProvider;
  private sessionStartReceived = false;
  private providerStarted = false;
  private closed = false;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: WebSocket,
    providerFactory: ProviderFactory,
    private readonly log?: Logger,
    private readonly clientIp = "unknown-ip",
    private readonly requestRegion?: string,
    private readonly authenticatedUser?: { username: string }
  ) {
    this.provider = providerFactory(client, {
      serverEvent: (payload, bytes) => {
        metrics.serverEvent(bytes);
        recordTesterServerEvent(this.relaySessionId, payload, bytes);
        if (this.authenticatedUser) recordUserMemoryEvent(this.authenticatedUser.username, payload);
      },
      serverAudio: (bytes) => {
        metrics.serverAudio(bytes);
        recordTesterServerAudio(this.relaySessionId, bytes);
      },
      ttsFallback: () => recordTesterTtsFallback(this.relaySessionId)
    });
    this.send({ type: "connection", state: "relay", detail: "语音中继 WebSocket 已连接" });
  }

  /**
   * WebSocket EventEmitter callbacks do not await async listeners. Serialize
   * messages here so session.start, audio.start, and PCM frames reach every
   * provider in wire order instead of racing one another.
   */
  handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    const task = this.messageQueue.then(() => this.processMessage(data, isBinary));
    // Keep the queue usable even if an unexpected error escapes processMessage.
    this.messageQueue = task.catch(() => undefined);
    return task;
  }

  private async processMessage(data: RawData, isBinary: boolean) {
    try {
      if (isBinary) {
        if (!this.providerStarted) throw new Error("session.start must complete before audio");
        const chunk = normalizeRawData(data);
        if (chunk.byteLength > MAX_CLIENT_AUDIO_BYTES) throw new Error("Audio frame is too large");
        metrics.clientAudio(chunk.byteLength);
        recordTesterClientAudio(this.relaySessionId, chunk.byteLength);
        await this.provider.sendAudio(chunk);
        return;
      }

      const event = parseClientEvent(data);
      if (event.type === "session.start") {
        if (this.sessionStartReceived) throw new Error("session.start has already been received");
        this.sessionStartReceived = true;
      } else if (!this.sessionStartReceived) {
        throw new Error("session.start is required before control events");
      } else if (!this.providerStarted) {
        throw new Error("session.start did not complete");
      }
      if (event.type !== "audio.start" && event.type !== "audio.stop") {
        this.log?.info(
          `client event: ${event.type}`,
          event.type === "session.start"
            ? {
                testerId: event.testerId,
                testerRegion: event.testerRegion,
                testingCampaignId: event.testingCampaignId,
                testingTestCaseId: event.testingTestCaseId,
                testingRunId: event.testingRunId,
                testingAssignmentId: event.testingAssignmentId,
                clientIp: this.clientIp,
                scenario: event.scenario,
                rideMode: event.rideMode,
                voiceGender: event.voiceGender
              }
            : undefined
        );
      }
      if (event.type === "session.start") {
        const durableMemory = this.authenticatedUser ? userConversationMemory(this.authenticatedUser.username) : null;
        // Once durable memory is enabled, the server is authoritative for a
        // login identity. A newly logged-in user must never inherit the
        // previous user's device-local snapshot merely because their own
        // server record does not exist yet. When the feature is explicitly
        // disabled, retain the original client-echoed restart behaviour.
        const providerEvent =
          this.authenticatedUser && userMemoryEnabled() ? { ...event, memory: durableMemory?.session } : event;
        const providerContext: ProviderSessionContext | undefined = durableMemory?.turns.length
          ? {
              previousConversation: {
                updatedAt: durableMemory.updatedAt,
                turns: durableMemory.turns
              }
            }
          : undefined;
        beginTesterSession(this.relaySessionId, {
          // Logged-in users cannot claim another tester's evidence row. The
          // operator relay-token path has no account identity and keeps the
          // explicit testerId for automation rigs.
          testerId: this.authenticatedUser?.username ?? event.testerId,
          ipAddress: this.clientIp,
          region: event.testerRegion ?? this.requestRegion,
          testingCampaignId: event.testingCampaignId,
          testingTestCaseId: event.testingTestCaseId,
          testingRunId: event.testingRunId,
          testingAssignmentId: event.testingAssignmentId,
          appVersion: event.appVersion,
          gitCommit: event.gitCommit,
          deviceLabel: event.deviceLabel,
          browserLanguage: event.browserLanguage,
          networkType: event.networkType,
          platform: event.platform
        });
        await this.provider.start(providerEvent, providerContext);
        this.providerStarted = true;
      }
      if (event.type === "audio.start") await this.provider.startAudio();
      if (event.type === "audio.stop") await this.provider.stopAudio();
      if (event.type === "demo.guided") await this.provider.setGuidedDemo?.(event.enabled);
      if (event.type === "location.update") await this.provider.updateLocation?.(event.lat, event.lon);
      if (event.type === "turn.feedback") recordTesterTurnFeedback(this.relaySessionId, event);
      if (event.type === "testing.metric") recordTesterAudioQuality(this.relaySessionId, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice relay failed";
      this.log?.warn("client message failed", { message });
      this.send({ type: "error", message });
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.messageQueue;
      await this.provider.close();
    } finally {
      // Always settle the tester stats — a provider close failure must not
      // leave a phantom active session (and an untrimmable tester) behind.
      endTesterSession(this.relaySessionId);
    }
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
