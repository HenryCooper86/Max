/**
 * Wire types and pure helpers for the voice-agent relay.
 *
 * The SDK ships standalone, so these types are a deliberate local copy of the
 * subset of the relay protocol the browser client speaks. Everything in this
 * file is free of browser APIs and safe to unit-test in Node.
 */

import { PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

/** Sample rate of the microphone stream the relay expects (PCM16 mono). */
const UPLINK_SAMPLE_RATE = 16000;
/** Sample rate of the agent voice the relay sends back (PCM16 mono). */
export const DOWNLINK_SAMPLE_RATE = 24000;
/** Samples per uplink frame: 20 ms at 16 kHz. */
export const FRAME_SAMPLES = 320;
/** The relay closes idle sessions with this code; clients must not auto-reconnect. */
export const IDLE_CLOSE_CODE = 4001;
/** The relay closes with this when the user has used up their voice minutes. */
export const USAGE_LIMIT_CLOSE_CODE = 4003;
/** Policy close: the relay refused the credentials (signed out, expired, deleted). */
export const UNAUTHORIZED_CLOSE_CODE = 1008;
/** Longest context string the relay accepts. */
const MAX_CONTEXT_CHARS = 2000;
/** Longest typed message the relay accepts. */
export const MAX_TEXT_CHARS = 2000;
/** Most client tools a session may declare. */
export const MAX_TOOLS = 32;
/** Reconnect attempts before the client gives up. */
const MAX_RECONNECT_ATTEMPTS = 6;

/** The user's choice of agent voice. */
export type VoiceGender = "female" | "male";

/** JSON Schema describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

/** A tool declaration as sent to the relay (no handler). */
export type ClientToolSpec = {
  name: string;
  description: string;
  parameters?: JsonSchema;
};

/** What the relay reports it can do, from `session.started`. */
export type AgentCapabilities = {
  serverVad?: boolean;
  synthesizedAudio?: boolean;
  transcriptEvents?: boolean;
  bargeIn?: boolean;
  voiceSelection?: boolean;
  /** The relay will call client tools. */
  tools?: boolean;
  /** The relay accepts typed input via `text.input`. */
  textInput?: boolean;
};

/** Who said a transcript line, as the relay names it. */
type WireSpeaker = "rider" | "agent";

/** Who said a transcript line, as the SDK exposes it. */
type TranscriptRole = "user" | "agent";

/** One line of conversation. Updated in place while it is still being spoken. */
export type TranscriptItem = {
  /** Stable for the life of the turn; partials and the final share it. */
  id: string;
  role: TranscriptRole;
  text: string;
  /** False while the text may still change. */
  final: boolean;
  /** Epoch milliseconds of the latest update. */
  at: number;
};

/** Client to relay: the first message on a connection. */
export type SessionStartMessage = {
  type: "session.start";
  sampleRate: number;
  channels: number;
  platform: "web";
  /** The wire protocol this SDK speaks, so the relay can tell when it is behind. */
  protocol: number;
  /** `max-voice-agent@<version>`, for the relay's logs and QA records. */
  appVersion: string;
  language?: string;
  voiceGender?: VoiceGender;
  voiceProvider?: string;
  tools?: ClientToolSpec[];
  context?: string;
  /** The `resume` id of the session this one continues after a dropped connection. */
  resume?: string;
};

/** Client to relay messages. */
export type ClientMessage =
  | SessionStartMessage
  | { type: "audio.start" }
  | { type: "audio.stop" }
  | { type: "text.input"; text: string }
  | { type: "tool.result"; callId: string; output?: unknown; error?: string };

/** Relay to client: a transcript line or partial. */
export type TranscriptEvent = {
  type: "transcript";
  turnId: string;
  deliveryId: string;
  speaker: WireSpeaker;
  text: string;
  final?: boolean;
  useBrowserSpeech?: boolean;
};

/** Relay to client: the agent wants the page to run a tool. */
export type ToolCallEvent = {
  type: "tool.call";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

/** Progress of any tool call, server or client side. */
export type ToolActivityEvent = {
  type: "tool.activity";
  callId: string;
  name: string;
  where: "server" | "client";
  state: "started" | "succeeded" | "failed";
  durationMs?: number;
  error?: string;
};

/** Relay to client messages the SDK understands. Anything else is ignored. */
export type RelayEvent =
  | {
      type: "session.started";
      provider: string;
      mode?: string;
      capabilities?: AgentCapabilities;
      /** The relay's wire protocol; absent from relays older than the version handshake. */
      protocol?: number;
      /** Sent back on reconnect so the conversation carries on; absent from older relays. */
      resume?: string;
    }
  | { type: "session.ended"; reason: string }
  | { type: "agent.changed"; agent: string }
  | { type: "status"; state: string; detail?: string }
  | { type: "connection"; state: string; detail?: string }
  | TranscriptEvent
  | ToolCallEvent
  | ToolActivityEvent
  | { type: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a relay text frame. Returns `undefined` for malformed JSON, unknown
 * event types, and events missing required fields, so a skewed relay cannot
 * inject `undefined` into the UI.
 */
export function parseRelayEvent(raw: string): RelayEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "session.started":
      return typeof value.provider === "string" ? (value as RelayEvent) : undefined;
    case "status":
    case "connection":
      return typeof value.state === "string" ? (value as RelayEvent) : undefined;
    case "transcript":
      return typeof value.text === "string" && (value.speaker === "rider" || value.speaker === "agent")
        ? (value as RelayEvent)
        : undefined;
    case "tool.call":
      return typeof value.callId === "string" && typeof value.name === "string"
        ? {
            type: "tool.call",
            callId: value.callId,
            name: value.name,
            arguments: isRecord(value.arguments) ? value.arguments : {}
          }
        : undefined;
    case "tool.activity":
      return typeof value.callId === "string" && typeof value.name === "string" && typeof value.state === "string"
        ? (value as RelayEvent)
        : undefined;
    case "error":
      return typeof value.message === "string" ? (value as RelayEvent) : undefined;
    case "session.ended":
      return { type: "session.ended", reason: typeof value.reason === "string" ? value.reason : "ended" };
    case "agent.changed":
      return typeof value.agent === "string" && value.agent ? { type: "agent.changed", agent: value.agent } : undefined;
    default:
      return undefined;
  }
}

/**
 * Builds the relay's WebSocket URL from a base.
 *
 * Accepts `http(s)://`, `ws(s)://`, a relative path (resolved against the page),
 * or a full `/agent` URL. HTTP schemes become WS schemes, `/agent` is appended
 * unless already present, and a token, when given, becomes the `token` query
 * parameter (replacing any existing one).
 *
 * @throws {TypeError} when `base` cannot be resolved to an absolute URL.
 */
export function relayUrl(base: string, token?: string): string {
  const origin = (globalThis as { location?: { href?: string } }).location?.href;
  let url: URL;
  try {
    url = new URL(base, origin);
  } catch {
    throw new TypeError(`Invalid relay URL: ${base}`);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new TypeError(`Unsupported relay URL scheme: ${url.protocol}`);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/agent") ? path : `${path}/agent`;
  url.hash = "";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/** The relay's HTTP base (`https://relay.example.com`) for any relay URL form, including `wss://…/agent`. */
function relayHttpBase(base: string): string {
  const origin = (globalThis as { location?: { href?: string } }).location?.href;
  const url = new URL(base, origin);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/agent$/, "");
  return `${url.origin}${path}`;
}

/** Where the WebRTC transport sends its offer: `https://relay.example.com/agent/webrtc`. */
export function relayWebRtcUrl(base: string): string {
  return `${relayHttpBase(base)}/agent/webrtc`;
}

/**
 * A session token for a Max Cloud agent embedded without a backend. Works only
 * on a website the agent's owner listed in the console.
 */
export async function fetchPublicAgentToken(relay: string, project: string): Promise<string> {
  const response = await fetch(`${relayHttpBase(relay)}/v1/public-session-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ project }),
    credentials: "omit"
  });
  const body = (await response.json().catch(() => ({}))) as { token?: unknown; error?: unknown };
  if (!response.ok || typeof body.token !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : `The relay answered ${response.status}`);
  }
  return body.token;
}

/** Tool names the relay accepts. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/** Strips handlers (and anything else not on the wire) from tool definitions. */
export function serializeTools(
  tools: ReadonlyArray<{ name: string; description: string; parameters?: JsonSchema }>
): ClientToolSpec[] {
  return tools.slice(0, MAX_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.parameters ? { parameters: tool.parameters } : {})
  }));
}

/** Inputs to {@link buildSessionStart}. */
export type SessionStartInput = {
  language?: string;
  voice?: VoiceGender;
  backend?: string;
  context?: string;
  tools?: ReadonlyArray<{ name: string; description: string; parameters?: JsonSchema }>;
  /** The previous session's resume id, when reconnecting. */
  resume?: string;
};

/** Builds the `session.start` message. Empty optional fields are omitted. */
export function buildSessionStart(input: SessionStartInput): SessionStartMessage {
  const context = input.context?.trim().slice(0, MAX_CONTEXT_CHARS);
  const tools = input.tools?.length ? serializeTools(input.tools) : undefined;
  return {
    type: "session.start",
    sampleRate: UPLINK_SAMPLE_RATE,
    channels: 1,
    platform: "web",
    protocol: PROTOCOL_VERSION,
    appVersion: `max-voice-agent@${SDK_VERSION}`,
    ...(input.language ? { language: input.language } : {}),
    ...(input.voice ? { voiceGender: input.voice } : {}),
    ...(input.backend ? { voiceProvider: input.backend } : {}),
    ...(tools ? { tools } : {}),
    ...(context ? { context } : {}),
    ...(input.resume ? { resume: input.resume } : {})
  };
}

/** Delay before reconnect attempt `attempt` (1-based): 1 s doubling, capped at 8 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Whether to reconnect after a close. Idle closes (4001), used-up voice
 *  minutes (4003) and refused credentials (1008) are final: reconnecting with
 *  the same inputs would only be refused again. (The client makes one extra
 *  attempt after 1008 when it can fetch a fresh token.) */
export function shouldReconnect(code: number, attempt: number, enabled = true): boolean {
  return (
    enabled &&
    code !== IDLE_CLOSE_CODE &&
    code !== USAGE_LIMIT_CLOSE_CODE &&
    code !== UNAUTHORIZED_CLOSE_CODE &&
    attempt <= MAX_RECONNECT_ATTEMPTS
  );
}

/**
 * Applies a transcript event to a list, returning a new list and the changed
 * item. Turns update in place by `turnId`; a new turn finalizes any dangling
 * partial before it. Returns the same list and no item when nothing changed
 * (empty text, or an identical repeat).
 */
export function mergeTranscript(
  list: readonly TranscriptItem[],
  event: Pick<TranscriptEvent, "turnId" | "speaker" | "text" | "final">,
  now: number = Date.now()
): { list: readonly TranscriptItem[]; item?: TranscriptItem } {
  const text = event.text.trim();
  if (!text) return { list };
  const final = event.final !== false;
  const role: TranscriptRole = event.speaker === "rider" ? "user" : "agent";
  const id = event.turnId || `${role}-${list.length + 1}`;

  const index = list.findIndex((item) => item.id === id);
  if (index >= 0) {
    const existing = list[index]!;
    if (existing.text === text && existing.final === final) return { list };
    const item: TranscriptItem = { ...existing, text, final, at: now };
    return { list: list.map((entry, i) => (i === index ? item : entry)), item };
  }
  const last = list.at(-1);
  const settled = last && !last.final ? [...list.slice(0, -1), { ...last, final: true }] : list;
  const item: TranscriptItem = { id, role, text, final, at: now };
  return { list: [...settled, item], item };
}

/** Converts float samples in [-1, 1] to little-endian PCM16, clamping overshoot. */
export function float32ToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

/** Converts PCM16 samples to floats in [-1, 1). */
export function pcm16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = (input[i] ?? 0) / 0x8000;
  return out;
}

/**
 * Downsamples by box-averaging, so every input sample contributes to exactly
 * one output sample with fractional weights at the edges (44.1 kHz and 48 kHz
 * both resample cleanly). Not streaming: use {@link PcmFramer} across chunks.
 *
 * @throws {RangeError} when `outRate` exceeds `inRate`.
 */
export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate > inRate) throw new RangeError("downsample cannot upsample");
  if (outRate === inRate) return input.slice();
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = i * ratio;
    const end = start + ratio;
    let sum = 0;
    let weight = 0;
    for (let j = Math.floor(start); j < Math.min(input.length, Math.ceil(end)); j += 1) {
      const w = Math.min(j + 1, end) - Math.max(j, start);
      sum += (input[j] ?? 0) * w;
      weight += w;
    }
    out[i] = weight > 0 ? sum / weight : 0;
  }
  return out;
}

/**
 * Streaming resampler and framer: feed it mic blocks at any rate, get back
 * 20 ms PCM16 frames at 16 kHz. Used by the ScriptProcessor fallback; the
 * AudioWorklet runs the same algorithm on the audio thread.
 */
export class PcmFramer {
  private readonly ratio: number;
  private windowRemaining: number;
  private sum = 0;
  private weight = 0;
  private frame = new Int16Array(FRAME_SAMPLES);
  private fill = 0;

  constructor(inputRate: number) {
    this.ratio = inputRate / UPLINK_SAMPLE_RATE;
    this.windowRemaining = this.ratio;
  }

  /** Consumes a block and returns any completed frames. */
  push(block: Float32Array): Int16Array[] {
    const frames: Int16Array[] = [];
    for (let index = 0; index < block.length; index += 1) {
      let inputRemaining = 1;
      while (inputRemaining > 0) {
        const w = Math.min(inputRemaining, this.windowRemaining);
        this.sum += (block[index] ?? 0) * w;
        this.weight += w;
        inputRemaining -= w;
        this.windowRemaining -= w;
        if (this.windowRemaining <= 1e-9) {
          const averaged = this.weight > 0 ? this.sum / this.weight : 0;
          this.frame[this.fill] = float32ToPcm16(Float32Array.of(averaged))[0] ?? 0;
          this.fill += 1;
          this.windowRemaining = this.ratio;
          this.sum = 0;
          this.weight = 0;
          if (this.fill === FRAME_SAMPLES) {
            frames.push(this.frame);
            this.frame = new Int16Array(FRAME_SAMPLES);
            this.fill = 0;
          }
        }
      }
    }
    return frames;
  }
}

/** Root-mean-square of a block, in [0, 1] for normalized audio. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Scales a raw RMS to a 0..1 meter value that moves visibly at speech volume. */
export function meterLevel(rawRms: number): number {
  return Math.min(1, rawRms * 6);
}
