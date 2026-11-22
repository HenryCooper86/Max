import { assistant, promptsInChinese, wakeWordActive } from "./assistant";
import { clientToolSpecsFrom } from "./tools/schema";
import { sessionLanguage } from "./prompts";
import { localizeOutgoing } from "./relay-speech";
import { normalizeEqualizer } from "./audio-eq";
import type { RawData, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  IDLE_CLOSE_CODE,
  MAX_IMAGE_BASE64_CHARS,
  PROTOCOL_VERSION,
  type AudioPlan,
  type NavPromptEvent
} from "../shared/agent";
import { SilenceFiller, normalizeDeviceAudio, planAudio } from "./audio-contract";
import { CLIENT_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { TESTING_PLATFORMS as CANONICAL_TESTING_PLATFORMS } from "../shared/testing";
import type { Logger } from "./logger";
import type { AgentProvider, ClientEvent, ProviderSessionContext, ProviderTelemetry } from "./providers/types";
import { handleCrashAlert, handleCrashCancel, selectCrashNotifier } from "./crash-escalation";
import { config } from "./config";
import { createNavHandler, selectRouteProvider } from "./routing";
import { createNavPromptHandler } from "./navigation-prompts";
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
import {
  externalUserMemoryKey,
  recordUserMemoryEvent,
  summarizeUserMemory,
  userConversationMemory,
  userMemoryEnabled
} from "./user-memory";
import { redactText } from "./redact";
import type { HelmetPeer } from "./companion-registry";
import { isResumeId, resumeStore } from "./session-resume";
import type { ToolDefinition } from "./tools";
import { createNoiseSuppressor, type NoiseSuppressor } from "./noise-suppression";
import { interruptsPlayback } from "./transcript-events";

export type ProviderFactory = (client: WebSocket, telemetry: ProviderTelemetry) => AgentProvider;

export type AgentSessionHooks = {
  onDeviceRegistered?(peer: HelmetPeer): () => void;
  onRiderUtterance?(deviceId: string, text: string): void;
  deviceRegistrationAuthorized: boolean;
  /** What the session token this socket opened with says about the session
   *  (server/session-tokens.ts). */
  tokenGrant?: { userId?: string; context?: string };
  /** Every event the provider sends the client (usage metering counts tool calls). */
  onServerEvent?(payload: unknown): void;
  /** Someone else's session (a Max Cloud customer's end user): never recorded
   *  in the relay's own QA evidence. Every QA recorder ignores a session that
   *  was never begun. */
  privateSession?: boolean;
  /** Whose conversations this socket may resume, beyond its user id: a Max
   *  Cloud project must never pick up another project's conversation. */
  resumeScope?: string;
  /** What only this session's channel provides: a phone call has no screen
   *  and brings its own transfer tools. */
  channel?: "web" | "phone";
  sessionTools?: readonly ToolDefinition[];
  /** Facts the channel itself vouches for (the caller's number), added to the
   *  token's trusted context. */
  trustedContext?: string;
  /** Clean the microphone audio before any backend hears it (server/noise-suppression.ts). */
  noiseSuppression?: boolean;
  /** Where the conversation's audio is recorded (server/recording.ts). */
  recording?: SessionRecording;
  /** What plays the recorded conversation's audio: a phone call drops queued speech on fewer events. */
  recordingClient?: "phone";
};

/** What a session tells a recording: the audio each way, and when the client dropped speech unplayed. */
export type SessionRecording = {
  user(pcm16k: Buffer): void;
  agent(pcm24k: Buffer): void;
  agentCleared(): void;
};

/**
 * Lets a recording hear what the backend sends the client: the assistant's
 * audio, and the events on which the client drops what it has not played.
 * A recording must never cost a conversation anything, so nothing it throws
 * gets out.
 */
function recordingTap(client: WebSocket, recording: SessionRecording, playedBy: "app" | "phone"): WebSocket {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "send") return (value as (...args: unknown[]) => unknown).bind(target);
      return (data: unknown, ...rest: unknown[]) => {
        try {
          if (typeof data === "string") {
            if (interruptsPlayback(data, playedBy)) recording.agentCleared();
          } else if (target.readyState === target.OPEN) {
            if (Buffer.isBuffer(data)) recording.agent(data);
            else if (ArrayBuffer.isView(data)) {
              recording.agent(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
            }
          }
        } catch {
          /* the conversation goes on without it */
        }
        return (target.send as (...args: unknown[]) => unknown)(data, ...rest);
      };
    }
  });
}

const MAX_TEXT_INPUT_CHARS = 2_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_MAGIC = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
} as const;

/** Throws unless `image` is base64 of a real JPEG or PNG matching `mimeType`. */
function assertImage(image: unknown, mimeType: unknown): asserts mimeType is keyof typeof IMAGE_MAGIC {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw new Error("Invalid image.input mimeType: use image/jpeg or image/png");
  }
  if (typeof image !== "string" || !image) throw new Error("Invalid image.input image");
  if (image.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error(`image.input image is too large (at most ${MAX_IMAGE_BASE64_CHARS} base64 characters)`);
  }
  if (image.length % 4 !== 0 || !BASE64.test(image)) throw new Error("Invalid image.input image: not base64");
  const magic = IMAGE_MAGIC[mimeType];
  // The first 12 base64 characters are the first 9 bytes, enough for both signatures.
  const head = Buffer.from(image.slice(0, 12), "base64");
  if (!head.subarray(0, magic.length).equals(magic)) {
    throw new Error(`Invalid image.input image: the bytes are not a ${mimeType === "image/png" ? "PNG" : "JPEG"}`);
  }
}

/** Client events a private (Max Cloud) session may not send. */
const PRIVATE_SESSION_REFUSED: ReadonlySet<string> = new Set([
  "nav.request",
  "nav.prompt",
  "crash.alert",
  "crash.cancel",
  "location.update",
  "demo.guided"
]);
const MAX_APP_CONTEXT_CHARS = 2_000;
const MAX_TOOL_CALL_ID = 128;
const MAX_TOOL_RESULT_ERROR_CHARS = 1_000;

// 256 KiB: every other client event fits comfortably under a few KB, but
// camera.frame carries a base64 JPEG capped at 200_000 chars below. Without
// headroom here, this gate would reject every real frame before the
// camera.frame-specific check ever ran. This must also stay BELOW
// config.maxPayloadBytes (server/config.ts) — ws enforces that ceiling before
// the "message" event fires and terminates the connection outright on an
// oversized frame, rather than producing a catchable error. If ws's ceiling
// ever sat at or below this constant, ws — not this clean validation error —
// would be what fails first, and it would take the rider's live session down
// with it.
const MAX_CLIENT_JSON_BYTES = 256 * 1024;
const MAX_CLIENT_AUDIO_BYTES = 32 * 1024;
const VOICE_GENDERS = new Set(["female", "male"]);
const VOICE_PERSONALITIES = new Set(["concise", "friendly", "technical", "rally"]);
const RIDE_MODES = new Set(["ride", "stop", "navigation", "emergency"]);
const DEMO_SCENARIOS = new Set(["commute", "wind", "fuel", "group", "emergency", "adas", "crash"]);
const MEMORY_LANGUAGES = new Set(["zh", "en"]);
const RESPONSE_MODES = new Set(["concise", "normal", "emergency"]);
const RIDER_INTENTS = new Set(["navigation", "weather", "emergency", "diagnostics", "group", "casual"]);
// Derived, never re-listed: a local copy of this list silently rejected the
// embedded client after the enum gained "embedded".
const TESTING_PLATFORMS = new Set<string>(CANONICAL_TESTING_PLATFORMS);
const MAX_MEMORY_DESTINATION_BYTES = 256;
const MAX_TESTER_ID_BYTES = 80;
const MAX_TESTER_REGION_BYTES = 96;
const MAX_TESTING_META_BYTES = 160;
const RDK_DEVICE_ID = /^rdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VOICE_PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/i;

export function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function hasDeviceRegistrationClaim(data: RawData): boolean {
  const buffer = normalizeRawData(data);
  if (buffer.byteLength > MAX_CLIENT_JSON_BYTES) return false;
  try {
    const value = JSON.parse(buffer.toString()) as Record<string, unknown>;
    return (
      Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.type === "session.start" &&
      Object.prototype.hasOwnProperty.call(value, "deviceId")
    );
  } catch {
    return false;
  }
}

function isFinalRiderTranscript(payload: unknown): payload is { text: string } {
  if (!payload || typeof payload !== "object") return false;
  const event = payload as { type?: unknown; speaker?: unknown; final?: unknown; text?: unknown };
  return (
    event.type === "transcript" && event.speaker === "rider" && event.final === true && typeof event.text === "string"
  );
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

function assertCrashIncidentId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 120 || hasControlCharacter(value)) {
    throw new Error("Invalid crash incidentId");
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
  if (!(CLIENT_EVENT_TYPES as readonly string[]).includes(value.type)) {
    throw new Error(`Unsupported client event ${value.type}`);
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
    if (value.speedKmh !== undefined) assertCoordinate(value.speedKmh, 0, 400, "speedKmh");
    return {
      type: "location.update",
      lat: value.lat as number,
      lon: value.lon as number,
      ...(value.speedKmh === undefined ? {} : { speedKmh: value.speedKmh as number })
    };
  }

  if (value.type === "turn.feedback") {
    if (typeof value.turnId !== "string" || !value.turnId.trim() || value.turnId.length > 120) {
      throw new Error("Invalid turn.feedback turnId");
    }
    if (value.speaker !== "rider" && value.speaker !== "agent") throw new Error("Invalid turn.feedback speaker");
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 2_000) {
      throw new Error("Invalid turn.feedback text");
    }
    if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 120) {
      throw new Error("Invalid turn.feedback reason");
    }
    return {
      type: "turn.feedback",
      turnId: value.turnId,
      speaker: value.speaker,
      text: value.text,
      reason: value.reason
    };
  }

  if (value.type === "device.result") {
    if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
      throw new Error("Invalid device.result commandId");
    }
    if (
      value.status !== "ok" &&
      value.status !== "failed" &&
      value.status !== "denied" &&
      value.status !== "unsupported"
    ) {
      throw new Error("Invalid device.result status");
    }
    if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 120)) {
      throw new Error("Invalid device.result reason");
    }
    if (value.detail !== undefined && (typeof value.detail !== "string" || value.detail.length > 500)) {
      throw new Error("Invalid device.result detail");
    }
    return {
      type: "device.result",
      commandId: value.commandId,
      status: value.status,
      reason: value.reason as string | undefined,
      detail: value.detail as string | undefined
    };
  }

  if (value.type === "hazard.report") {
    // Flows upward only. The board has already played the audio, so the relay
    // must never echo this back as hazard.alert — Max would speak the warning a
    // second time, seconds late, over a rider who is already braking.
    if (typeof value.threat !== "string" || !value.threat.trim() || value.threat.length > 120) {
      throw new Error("Invalid hazard.report threat");
    }
    if (typeof value.direction !== "string" || !value.direction.trim() || value.direction.length > 40) {
      throw new Error("Invalid hazard.report direction");
    }
    if (value.severity !== "caution" && value.severity !== "critical") {
      throw new Error("Invalid hazard.report severity");
    }
    for (const field of ["label", "message", "advice"] as const) {
      const text = value[field];
      if (typeof text !== "string" || !text.trim() || text.length > 500) {
        throw new Error(`Invalid hazard.report ${field}`);
      }
    }
    if (
      value.ttcSeconds !== undefined &&
      (typeof value.ttcSeconds !== "number" || !Number.isFinite(value.ttcSeconds))
    ) {
      throw new Error("Invalid hazard.report ttcSeconds");
    }
    if (
      value.handoverMs !== undefined &&
      (typeof value.handoverMs !== "number" || !Number.isFinite(value.handoverMs))
    ) {
      throw new Error("Invalid hazard.report handoverMs");
    }
    return {
      type: "hazard.report",
      threat: value.threat,
      direction: value.direction,
      severity: value.severity,
      label: value.label as string,
      message: value.message as string,
      advice: value.advice as string,
      ttcSeconds: value.ttcSeconds as number | undefined,
      handoverMs: value.handoverMs as number | undefined
    };
  }

  if (value.type === "crash.alert") {
    assertCrashIncidentId(value.incidentId);
    if (typeof value.contactOptIn !== "boolean") throw new Error("Invalid crash.alert contactOptIn");
    assertOptionalCoordinate(value.lat, -90, 90, "crash.alert lat");
    assertOptionalCoordinate(value.lon, -180, 180, "crash.alert lon");
    if (
      value.speedKmhRecent !== undefined &&
      (typeof value.speedKmhRecent !== "number" || !Number.isFinite(value.speedKmhRecent) || value.speedKmhRecent < 0)
    )
      throw new Error("Invalid crash.alert speedKmhRecent");
    if (
      value.contactNumber !== undefined &&
      (typeof value.contactNumber !== "string" ||
        Buffer.byteLength(value.contactNumber) > 128 ||
        hasControlCharacter(value.contactNumber))
    )
      throw new Error("Invalid crash.alert contactNumber");
    if (
      value.detectedAt !== undefined &&
      (typeof value.detectedAt !== "number" ||
        !Number.isFinite(value.detectedAt) ||
        value.detectedAt < 0 ||
        value.detectedAt > 8.64e15)
    )
      throw new Error("Invalid crash.alert detectedAt");
    return {
      type: "crash.alert",
      incidentId: value.incidentId,
      contactOptIn: value.contactOptIn,
      lat: value.lat as number | undefined,
      lon: value.lon as number | undefined,
      speedKmhRecent: value.speedKmhRecent as number | undefined,
      contactNumber: value.contactNumber as string | undefined,
      detectedAt: value.detectedAt as number | undefined
    };
  }

  if (value.type === "crash.cancel") {
    assertCrashIncidentId(value.incidentId);
    return {
      type: "crash.cancel",
      incidentId: value.incidentId
    };
  }

  if (value.type === "camera.frame") {
    if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
      throw new Error("Invalid camera.frame commandId");
    }
    // ~55 KB for a 640px frame. The cap is a control-plane guard, not a quality
    // setting: without it a client can push megabytes through this path.
    if (typeof value.image !== "string" || !value.image || value.image.length > 200_000) {
      throw new Error("Invalid camera.frame image");
    }
    return { type: "camera.frame", commandId: value.commandId, image: value.image };
  }

  if (value.type === "vision.frames") {
    if (value.reason !== "gallery" && value.reason !== "watch") throw new Error("Invalid vision.frames reason");

    // Image cap is shared by both reasons — a control-plane guard against a
    // bulk media channel, not a quality setting.
    const checkImage = () => {
      if (typeof value.image !== "string" || !value.image || value.image.length > 200_000) {
        throw new Error("Invalid vision.frames image");
      }
    };

    if (value.reason === "watch") {
      // Watch frames are unsolicited: no commandId to answer, no question to
      // carry, and always exactly one frame.
      if (value.commandId !== undefined) throw new Error("Invalid vision.frames commandId for watch");
      if (value.question !== undefined) throw new Error("Invalid vision.frames question for watch");
      if (value.total !== 1) throw new Error("Invalid vision.frames total for watch");
      if (value.index !== 0) throw new Error("Invalid vision.frames index for watch");
      checkImage();
      return { type: "vision.frames", reason: "watch", index: 0, total: 1, image: value.image as string };
    }

    // Gallery validation unchanged from before V-C.
    if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
      throw new Error("Invalid vision.frames commandId");
    }
    if (typeof value.total !== "number" || !Number.isInteger(value.total) || value.total < 1 || value.total > 8) {
      throw new Error("Invalid vision.frames total");
    }
    if (
      typeof value.index !== "number" ||
      !Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index >= value.total
    ) {
      throw new Error("Invalid vision.frames index");
    }
    checkImage();
    if (
      value.question !== undefined &&
      (typeof value.question !== "string" || Buffer.byteLength(value.question) > 500)
    ) {
      throw new Error("Invalid vision.frames question");
    }
    return {
      type: "vision.frames",
      commandId: value.commandId,
      reason: "gallery",
      index: value.index,
      total: value.total,
      image: value.image as string,
      question: value.question as string | undefined
    };
  }

  if (value.type === "nav.prompt") {
    const invalid = () => {
      throw new Error("Invalid nav.prompt fields");
    };
    if (
      typeof value.promptId !== "string" ||
      !value.promptId.trim() ||
      Buffer.byteLength(value.promptId) > 120 ||
      typeof value.routeCommandId !== "string" ||
      !value.routeCommandId.trim() ||
      Buffer.byteLength(value.routeCommandId) > 120
    ) {
      invalid();
    }
    if (value.kind === "maneuver") {
      if (
        !Number.isInteger(value.maneuverIndex) ||
        (value.maneuverIndex as number) < 0 ||
        (value.threshold !== "far" && value.threshold !== "near" && value.threshold !== "now") ||
        typeof value.distanceMeters !== "number" ||
        !Number.isFinite(value.distanceMeters) ||
        value.distanceMeters < 0 ||
        Object.keys(value).some(
          (field) =>
            !["type", "promptId", "routeCommandId", "kind", "maneuverIndex", "threshold", "distanceMeters"].includes(
              field
            )
        )
      ) {
        invalid();
      }
      return {
        type: "nav.prompt",
        promptId: value.promptId as string,
        routeCommandId: value.routeCommandId as string,
        kind: "maneuver",
        maneuverIndex: value.maneuverIndex as number,
        threshold: value.threshold as "far" | "near" | "now",
        distanceMeters: value.distanceMeters as number
      };
    }
    if (
      (value.kind !== "confirm" &&
        value.kind !== "offRoute" &&
        value.kind !== "rerouteFailed" &&
        value.kind !== "arrived" &&
        value.kind !== "locationLost") ||
      Object.keys(value).some((field) => !["type", "promptId", "routeCommandId", "kind"].includes(field))
    ) {
      invalid();
    }
    return {
      type: "nav.prompt",
      promptId: value.promptId as string,
      routeCommandId: value.routeCommandId as string,
      kind: value.kind as "confirm" | "offRoute" | "rerouteFailed" | "arrived" | "locationLost"
    };
  }

  if (value.type === "nav.request") {
    if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
      throw new Error("Invalid nav.request commandId");
    }
    if (value.reason !== "start" && value.reason !== "reroute") throw new Error("Invalid nav.request reason");
    const origin = value.origin as Record<string, unknown> | undefined;
    if (!origin || typeof origin !== "object") throw new Error("Invalid nav.request origin");
    assertCoordinate(origin.lat, -90, 90, "lat");
    assertCoordinate(origin.lon, -180, 180, "lon");
    if (value.reason === "start") {
      if (typeof value.query !== "string" || !value.query.trim() || Buffer.byteLength(value.query) > 256) {
        throw new Error("Invalid nav.request query");
      }
      return {
        type: "nav.request",
        commandId: value.commandId,
        reason: "start",
        origin: { lat: origin.lat as number, lon: origin.lon as number },
        query: value.query
      };
    }
    const destination = value.destination as Record<string, unknown> | undefined;
    if (!destination || typeof destination !== "object") throw new Error("Invalid nav.request destination");
    assertCoordinate(destination.lat, -90, 90, "lat");
    assertCoordinate(destination.lon, -180, 180, "lon");
    if (
      typeof value.destinationName !== "string" ||
      !value.destinationName.trim() ||
      Buffer.byteLength(value.destinationName) > 256
    ) {
      throw new Error("Invalid nav.request destinationName");
    }
    return {
      type: "nav.request",
      commandId: value.commandId,
      reason: "reroute",
      origin: { lat: origin.lat as number, lon: origin.lon as number },
      destination: { lat: destination.lat as number, lon: destination.lon as number },
      destinationName: value.destinationName
    };
  }

  if (value.type === "text.input") {
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > MAX_TEXT_INPUT_CHARS) {
      throw new Error("Invalid text.input text");
    }
    return { type: "text.input", text: value.text.trim() };
  }

  if (value.type === "image.input") {
    assertImage(value.image, value.mimeType);
    if (value.text !== undefined && typeof value.text !== "string") throw new Error("Invalid image.input text");
    if (value.text !== undefined && value.text.length > MAX_TEXT_INPUT_CHARS)
      throw new Error("Invalid image.input text");
    const text = value.text?.trim();
    return {
      type: "image.input",
      image: value.image as string,
      mimeType: value.mimeType as "image/jpeg" | "image/png",
      ...(text ? { text } : {})
    };
  }

  if (value.type === "tool.result") {
    if (typeof value.callId !== "string" || !value.callId || value.callId.length > MAX_TOOL_CALL_ID) {
      throw new Error("Invalid tool.result callId");
    }
    if (value.error !== undefined && typeof value.error !== "string") throw new Error("Invalid tool.result error");
    return {
      type: "tool.result",
      callId: value.callId,
      ...(value.output !== undefined ? { output: value.output } : {}),
      ...(typeof value.error === "string" && value.error.trim()
        ? { error: value.error.trim().slice(0, MAX_TOOL_RESULT_ERROR_CHARS) }
        : {})
    };
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

  if (value.type !== "session.start") throw new Error(`Unsupported client event ${value.type}`);

  if (value.sampleRate !== 16000) throw new Error("Invalid sampleRate");
  if (value.channels !== 1) throw new Error("Invalid channels");
  if (value.deviceId !== undefined && (typeof value.deviceId !== "string" || !RDK_DEVICE_ID.test(value.deviceId))) {
    throw new Error("Invalid deviceId");
  }
  assertOptionalEnum(value.voiceGender, VOICE_GENDERS, "voiceGender");
  assertOptionalEnum(value.voicePersonality, VOICE_PERSONALITIES, "voicePersonality");
  if (
    value.voiceProvider !== undefined &&
    (typeof value.voiceProvider !== "string" || !VOICE_PROVIDER_ID.test(value.voiceProvider))
  ) {
    throw new Error("Invalid voiceProvider");
  }
  if (value.language !== undefined && (typeof value.language !== "string" || !LANGUAGE_TAG.test(value.language))) {
    throw new Error("Invalid language");
  }
  if (value.equalizer !== undefined) {
    // Sanitised rather than rejected: out-of-range bands clamp, junk drops.
    const equalizer = normalizeEqualizer(value.equalizer);
    if (equalizer) value.equalizer = equalizer;
    else delete value.equalizer;
  }
  if (value.audio !== undefined) {
    // Sanitised rather than rejected, so a device built against a newer
    // contract still connects.
    const audio = normalizeDeviceAudio(value.audio);
    if (audio) value.audio = audio;
    else delete value.audio;
  }
  assertOptionalEnum(value.rideMode, RIDE_MODES, "rideMode");
  assertOptionalEnum(value.scenario, DEMO_SCENARIOS, "scenario");
  assertOptionalTesterId(value.testerId);
  assertOptionalTesterRegion(value.testerRegion);
  assertOptionalMetadataString(value.testingCampaignId, "testingCampaignId", 80);
  assertOptionalMetadataString(value.testingTestCaseId, "testingTestCaseId", 80);
  assertOptionalMetadataString(value.testingRunId, "testingRunId", 80);
  assertOptionalMetadataString(value.testingAssignmentId, "testingAssignmentId", 80);
  if (value.protocol !== undefined && !(Number.isInteger(value.protocol) && (value.protocol as number) >= 1)) {
    throw new Error("protocol must be a positive integer");
  }
  assertOptionalMetadataString(value.appVersion, "appVersion", 40);
  assertOptionalMetadataString(value.gitCommit, "gitCommit", 80);
  assertOptionalMetadataString(value.deviceLabel, "deviceLabel", 120);
  assertOptionalMetadataString(value.browserLanguage, "browserLanguage", 40);
  assertOptionalMetadataString(value.networkType, "networkType", 40);
  assertOptionalEnum(value.platform, TESTING_PLATFORMS, "platform");
  assertOptionalCoordinate(value.lat, -90, 90, "lat");
  assertOptionalCoordinate(value.lon, -180, 180, "lon");
  assertOptionalMemory(value.memory);
  if (value.tools !== undefined) value.tools = clientToolSpecsFrom(value.tools);
  if (value.context !== undefined) {
    if (typeof value.context !== "string" || value.context.length > MAX_APP_CONTEXT_CHARS) {
      throw new Error("Invalid context");
    }
    if (value.context.trim()) value.context = value.context.trim();
    else delete value.context;
  }
  // Dropped rather than rejected: a stale or mangled id only means the
  // conversation starts fresh.
  if (value.resume !== undefined && !isResumeId(value.resume)) delete value.resume;

  return value as ClientEvent;
}

const SESSION_STARTED_PREFIX = '{"type":"session.started"';

/**
 * The socket a voice backend writes to. Each backend announces the session
 * itself. The protocol version and the audio plan are the relay's own facts,
 * so they are added to that one announcement here, once, for every backend.
 */
function announcingRelayFacts(
  client: WebSocket,
  plan: () => AudioPlan | undefined,
  resume: () => string | undefined
): WebSocket {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "send") return (value as (...args: unknown[]) => unknown).bind(target);
      return (data: unknown, ...rest: unknown[]) => {
        if (typeof data === "string" && data.startsWith(SESSION_STARTED_PREFIX)) {
          const audio = plan();
          const resumeId = resume();
          try {
            data = JSON.stringify({
              ...(JSON.parse(data) as object),
              protocol: PROTOCOL_VERSION,
              ...(audio ? { audio } : {}),
              ...(resumeId ? { resume: resumeId } : {})
            });
          } catch {
            /* send it as the backend wrote it */
          }
        }
        return (target.send as (...args: unknown[]) => unknown)(data, ...rest);
      };
    }
  });
}

/** A final transcript as durable memory may keep it: without the kinds of
 *  personal data the assistant's owner asked never to store. */
function withoutPersonalData(payload: unknown): unknown {
  const kinds = assistant().redact;
  if (kinds.length === 0 || typeof payload !== "object" || payload === null) return payload;
  const event = payload as { type?: unknown; text?: unknown };
  if (event.type !== "transcript" || typeof event.text !== "string") return payload;
  return { ...event, text: redactText(event.text, kinds) };
}

export class AgentSessionController {
  private readonly relaySessionId = randomUUID();
  private readonly provider: AgentProvider;
  private readonly crashNotifier = selectCrashNotifier(config.crashNotifier);
  private readonly navHandler: ReturnType<typeof createNavHandler>;
  private readonly navPromptHandler: (event: NavPromptEvent) => void;
  private audioPlan?: AudioPlan;
  private resumeId?: string;
  /** Where this session's turns are remembered, for a user named by a session token. */
  private tokenUserMemoryKey?: string;
  private silenceFiller?: SilenceFiller;
  private noiseSuppressor?: NoiseSuppressor;
  private sessionStartReceived = false;
  private providerStarted = false;
  private audioActive = false;
  private acceptingMessages = true;
  private detachHelmet?: () => void;
  private registeredDeviceId?: string;
  private cleanupPromise?: Promise<void>;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: WebSocket,
    providerFactory: ProviderFactory,
    private readonly log?: Logger,
    private readonly clientIp = "unknown-ip",
    private readonly requestRegion?: string,
    private readonly authenticatedUser?: { id: string; username: string },
    private readonly hooks?: AgentSessionHooks
  ) {
    this.provider = providerFactory(
      announcingRelayFacts(
        hooks?.recording ? recordingTap(client, hooks.recording, hooks.recordingClient ?? "app") : client,
        () => this.audioPlan,
        () => this.resumeId
      ),
      {
        serverEvent: (payload, bytes) => {
          metrics.serverEvent(bytes);
          this.hooks?.onServerEvent?.(payload);
          recordTesterServerEvent(this.relaySessionId, payload, bytes);
          const memoryKey = this.authenticatedUser?.id ?? this.tokenUserMemoryKey;
          if (memoryKey) recordUserMemoryEvent(memoryKey, withoutPersonalData(payload));
          if (this.registeredDeviceId && isFinalRiderTranscript(payload)) {
            this.hooks?.onRiderUtterance?.(this.registeredDeviceId, payload.text);
          }
        },
        relayEvent: (payload) => this.hooks?.onServerEvent?.(payload),
        serverAudio: (bytes) => {
          metrics.serverAudio(bytes);
          recordTesterServerAudio(this.relaySessionId, bytes);
        },
        ttsFallback: () => recordTesterTtsFallback(this.relaySessionId)
      }
    );
    this.navHandler = createNavHandler({
      provider: selectRouteProvider(config.amapApiKey, log),
      send: (payload) => {
        if (this.acceptingMessages) this.send(payload);
      },
      onRouteAnnounced: (speech) => {
        if (this.acceptingMessages) this.provider.attachNavOkSpeech?.(speech);
      },
      onRerouteAnnounced: (speech) => {
        if (this.acceptingMessages) this.provider.speakNavLine?.(speech);
      }
    });
    this.navPromptHandler = createNavPromptHandler({
      activeRoute: this.navHandler.activeRoute,
      speak: (speech) => this.provider.speakNavPrompt?.(speech),
      clearRoute: this.navHandler.clearRoute
    });
    this.send({
      type: "connection",
      state: "relay",
      detail: promptsInChinese() ? "语音中继 WebSocket 已连接" : "Voice relay connected"
    });
  }

  /**
   * WebSocket EventEmitter callbacks do not await async listeners. Serialize
   * messages here so session.start, audio.start, and PCM frames reach every
   * provider in wire order instead of racing one another.
   */
  handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (!this.acceptingMessages) return Promise.resolve();
    const task = this.messageQueue.then(() => {
      if (!this.acceptingMessages) return;
      return this.processMessage(data, isBinary);
    });
    // Keep the queue usable even if an unexpected error escapes processMessage.
    this.messageQueue = task.catch(() => undefined);
    return task;
  }

  private async processMessage(data: RawData, isBinary: boolean) {
    try {
      if (isBinary) {
        if (!this.providerStarted) throw new Error("session.start must complete before audio");
        if (!this.audioActive) throw new Error("audio.start is required before audio frames");
        const chunk = normalizeRawData(data);
        if (chunk.byteLength > MAX_CLIENT_AUDIO_BYTES) throw new Error("Audio frame is too large");
        metrics.clientAudio(chunk.byteLength);
        recordTesterClientAudio(this.relaySessionId, chunk.byteLength);
        // Until the model has loaded, audio passes through as it came.
        if (this.hooks?.noiseSuppression) this.noiseSuppressor ??= createNoiseSuppressor();
        const audio = this.noiseSuppressor ? this.noiseSuppressor.process(chunk) : chunk;
        if (audio.byteLength > 0) {
          // What the backend heard, which is the cleaned audio when the relay cleans it.
          try {
            this.hooks?.recording?.user(audio);
          } catch {
            /* the conversation goes on without it */
          }
          await this.provider.sendAudio(audio);
        }
        this.silenceFiller?.frame();
        return;
      }

      if (!this.hooks?.deviceRegistrationAuthorized && hasDeviceRegistrationClaim(data)) {
        this.terminate(1008, "device registration unauthorized");
        return;
      }
      const event = parseClientEvent(data);
      if (event.type === "session.start") {
        if (this.sessionStartReceived) throw new Error("session.start has already been received");
        this.sessionStartReceived = true;
        if (event.protocol !== undefined && event.protocol > PROTOCOL_VERSION) {
          // The session still runs: newer clients keep to what an older relay
          // understands. The operator should know the relay is behind.
          this.log?.warn("client speaks a newer protocol than this relay", {
            client: event.protocol,
            relay: PROTOCOL_VERSION,
            appVersion: event.appVersion
          });
        }
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
        this.speechLanguage = sessionLanguage(event.language, assistant().languages);
        const grant = this.hooks?.tokenGrant;
        // A user your product names in a session token is remembered only when
        // the assistant's owner asked for that. A Max Cloud project has its own
        // settings and its own users: the relay's config says nothing for it.
        const cloud = (this.hooks?.resumeScope ?? "").startsWith("cloud:");
        this.tokenUserMemoryKey =
          !this.authenticatedUser && grant?.userId && !cloud && assistant().conversation.rememberUsers
            ? externalUserMemoryKey(grant.userId)
            : undefined;
        const memoryKey = this.authenticatedUser?.id ?? this.tokenUserMemoryKey;
        const durableMemory = memoryKey ? userConversationMemory(memoryKey) : null;
        // Once durable memory is enabled, the server is authoritative for a
        // login identity. A newly logged-in user must never inherit the
        // previous user's device-local snapshot merely because their own
        // server record does not exist yet. When the feature is explicitly
        // disabled, retain the original client-echoed restart behaviour.
        const providerEvent =
          this.authenticatedUser && userMemoryEnabled() ? { ...event, memory: durableMemory?.session } : event;
        const userId = this.authenticatedUser?.id ?? grant?.userId;
        // A resume id only opens the conversation of the same user of the same
        // deployment. Anonymous sessions have the id alone, which is unguessable.
        const resumeOwner = `${this.hooks?.resumeScope ?? ""}\n${userId ?? ""}`;
        const resumed = resumeStore.load(event.resume, resumeOwner);
        const resumeId = resumed && event.resume ? event.resume : resumeStore.create(resumeOwner);
        this.resumeId = resumeId;
        if (resumed?.history.length)
          this.log?.info("session resumes a conversation", { turns: resumed.history.length });
        const trusted = [grant?.context, this.hooks?.trustedContext].filter(Boolean).join("\n");
        const providerContext: ProviderSessionContext = {
          sessionId: this.relaySessionId,
          ...(userId ? { userId } : {}),
          ...(trusted ? { trustedContext: trusted } : {}),
          ...(this.hooks?.channel ? { channel: this.hooks.channel } : {}),
          ...(this.hooks?.sessionTools ? { sessionTools: this.hooks.sessionTools } : {}),
          ...(resumed ? { resume: resumed } : {}),
          saveResume: (state) => resumeStore.save(resumeId, state),
          // The provider has told the client why; the close is what frees the session.
          endSession: (reason) => {
            this.log?.info("session ended by the relay", { reason });
            // The idle code: every client already treats it as final and does
            // not reconnect, which a plain 1000 would invite.
            this.terminate(IDLE_CLOSE_CODE, reason.slice(0, 100));
          },
          // Live accessor, not a snapshot — see ProviderSessionContext's doc
          // comment. this.navHandler is already assigned by the time any
          // provider could actually call this (start() runs after the
          // constructor has finished), regardless of the two properties'
          // relative construction order above.
          routeActive: () => this.navHandler.activeRoute() !== undefined,
          captureNavigationStop: () => this.navHandler.captureStop(),
          ...(durableMemory && (durableMemory.turns.length || durableMemory.facts.length || durableMemory.summary)
            ? {
                previousConversation: {
                  updatedAt: durableMemory.updatedAt,
                  // A resumed conversation already carries its own turns.
                  turns: resumed ? [] : durableMemory.turns,
                  facts: durableMemory.facts,
                  ...(durableMemory.summary ? { summary: durableMemory.summary.text } : {})
                }
              }
            : {})
        };
        if (!this.hooks?.privateSession)
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
        this.audioPlan = planAudio(event.audio, wakeWordActive(config.wakeWord));
        if (event.audio) this.log?.info("device audio declared", { ...event.audio, ...this.audioPlan });
        if (this.audioPlan.silenceFill) {
          this.silenceFiller = new SilenceFiller((frame) => {
            if (!this.audioActive) return;
            void this.provider.sendAudio(frame).catch(() => undefined);
          });
        }
        try {
          await this.provider.start(providerEvent, providerContext);
        } catch (error) {
          // A failed start is not recoverable on this socket: the provider may
          // be partially initialized and duplicate session.start is forbidden.
          // Close so clients enter their bounded reconnect path instead of
          // remaining connected in a permanent "start did not complete" loop.
          const message = error instanceof Error ? error.message : "Provider session failed to start";
          this.log?.error("provider session start failed", { message });
          this.send({ type: "error", message: "语音服务暂时不可用，请重新连接。" });
          // Stop messages before asking the socket to close so any traffic the
          // client already pipelined behind session.start (audio.start,
          // location.update) are dropped by handleMessage instead of each
          // throwing "session.start did not complete" until the TCP close lands.
          this.terminate(1011, "provider start failed");
          return;
        }
        this.providerStarted = true;
        if (!this.acceptingMessages) return;
        if (event.deviceId) {
          try {
            this.registeredDeviceId = event.deviceId;
            this.detachHelmet = this.hooks?.onDeviceRegistered?.({
              deviceId: event.deviceId,
              deviceLabel: event.deviceLabel?.trim() || "RDK X5",
              send: (payload) => this.sendEphemeral(payload),
              speak: (text) => {
                if (this.acceptingMessages) this.provider.speakNavLine?.(text);
              }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Device registration failed";
            this.log?.error("device registration failed", { message });
            this.send({ type: "error", message: "设备注册暂时不可用，请重新连接。" });
            this.terminate(1011, "device registration failed");
            return;
          }
        }
      }
      if (event.type === "audio.start" && !this.audioActive) {
        await this.provider.startAudio();
        this.audioActive = true;
      }
      if (event.type === "audio.stop" && this.audioActive) {
        this.silenceFiller?.stop();
        await this.provider.stopAudio();
        this.audioActive = false;
      }
      // Someone else's session (a Max Cloud project) may not use the relay
      // owner's navigation (their Amap key) or write crash alerts into the
      // owner's QA audit log.
      if (this.hooks?.privateSession && PRIVATE_SESSION_REFUSED.has(event.type)) return;
      if (event.type === "demo.guided") await this.provider.setGuidedDemo?.(event.enabled);
      if (event.type === "location.update") {
        await this.provider.updateLocation?.(event.lat, event.lon, event.speedKmh);
      }
      if (event.type === "turn.feedback") recordTesterTurnFeedback(this.relaySessionId, event);
      if (event.type === "testing.metric") recordTesterAudioQuality(this.relaySessionId, event);
      if (event.type === "device.result") await this.provider.deviceResult?.(event);
      if (event.type === "tool.result") await this.provider.toolResult?.(event);
      if (event.type === "text.input") {
        const accepted = this.provider.textInput ? await this.provider.textInput(event.text) : false;
        if (accepted === false) {
          this.send({ type: "error", message: "This voice backend does not accept typed messages." });
        }
      }
      if (event.type === "image.input") {
        const accepted = this.provider.imageInput
          ? await this.provider.imageInput({ data: event.image, mimeType: event.mimeType }, event.text)
          : false;
        if (accepted === false) {
          this.send({ type: "error", message: "This voice backend does not take pictures." });
        }
      }
      // The FIRST consumer of hazard.report (see parseClientEvent's "never
      // echo back" comment above): forwarded so the vision governor can gate
      // watching on a hazard the board already announced, never echoed to
      // any client as hazard.alert.
      if (event.type === "hazard.report") await this.provider.hazardReport?.(event);
      if (event.type === "camera.frame") await this.provider.cameraFrame?.(event);
      if (event.type === "vision.frames") await this.provider.visionFrames?.(event);
      if (event.type === "crash.alert")
        await handleCrashAlert(event, this.crashNotifier, (payload) => this.send(payload));
      if (event.type === "crash.cancel") await handleCrashCancel(event, this.crashNotifier);
      // Detached from the caller, same rationale as camera.frame in
      // server/providers/doubao.ts (~line 1737): this handler runs inside the
      // same strictly serialized messageQueue that also carries the rider's
      // live mic PCM. Awaiting a real-key Amap round trip here (up to two
      // sequential provider calls — resolveDestination then planRoute, see
      // server/routing.ts's DEFAULT_TIMEOUT_MS) would stall ALL client
      // messages behind a slow navigation provider. Out-of-order interleaving
      // is already safe: the handler's destination-matched cache and the
      // client's stale-answer rejection make it benign for nav.route/nav.error
      // to arrive slightly out of wire order relative to other events.
      if (event.type === "nav.request")
        void this.navHandler(event).catch((error) =>
          this.log?.warn("nav.request failed", { message: error instanceof Error ? error.message : String(error) })
        );
      if (event.type === "nav.prompt") this.navPromptHandler(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice relay failed";
      this.log?.warn("client message failed", { message });
      this.send({ type: "error", message });
    }
  }

  close(): Promise<void> {
    this.acceptingMessages = false;
    this.audioActive = false;
    if (!this.cleanupPromise) {
      const pendingMessages = this.messageQueue;
      this.silenceFiller?.stop();
      this.cleanupPromise = (async () => {
        try {
          await pendingMessages;
          await this.provider.close();
        } finally {
          // The conversation is over: what has left the user's window of turns is folded into their summary.
          const memoryKey = this.authenticatedUser?.id ?? this.tokenUserMemoryKey;
          if (memoryKey) void summarizeUserMemory(memoryKey);
          this.noiseSuppressor?.close();
          this.noiseSuppressor = undefined;
          const detachHelmet = this.detachHelmet;
          this.detachHelmet = undefined;
          try {
            detachHelmet?.();
          } finally {
            // Always settle the tester stats — a provider close failure must not
            // leave a phantom active session (and an untrimmable tester) behind.
            endTesterSession(this.relaySessionId);
          }
        }
      })();
    }
    return this.cleanupPromise;
  }

  private terminate(code: number, reason: string): void {
    const cleanup = this.close();
    this.client.close(code, reason);
    void cleanup.catch((error) => {
      this.log?.warn("session cleanup failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private sendEphemeral(payload: unknown) {
    if (this.client.readyState === this.client.OPEN) {
      const encoded = JSON.stringify(payload);
      metrics.serverEvent(Buffer.byteLength(encoded));
      this.client.send(encoded);
    }
  }

  /** "" keeps the relay's wording; set from session.start (see sessionLanguage). */
  private speechLanguage = "";

  private send(original: unknown) {
    const payload = localizeOutgoing(original, this.speechLanguage);
    if (this.client.readyState === this.client.OPEN) {
      const encoded = JSON.stringify(payload);
      metrics.serverEvent(Buffer.byteLength(encoded));
      recordTesterServerEvent(this.relaySessionId, payload, Buffer.byteLength(encoded));
      this.client.send(encoded);
    }
  }
}
