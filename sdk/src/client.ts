/**
 * Framework-free browser client for a voice-agent relay.
 *
 * ```ts
 * const agent = new VoiceAgent({ url: "https://relay.example.com", token: "vst_..." });
 * agent.on("transcript", ({ transcript }) => render(transcript));
 * await agent.start(); // from a click handler
 * ```
 */

import { createBrowserAudio } from "./audio.js";
import type { AudioIO } from "./audio.js";
import { PROTOCOL_VERSION, SDK_VERSION } from "./version.js";
import { DEFAULT_IMAGE_MAX_SIDE, encodeImage } from "./image.js";
import type { ImageEncoder, ImageSource } from "./image.js";
import { WEBRTC_UNAVAILABLE_CODE, createWebRtcSocket, webRtcSupported } from "./webrtc.js";
import type { WebRtcSocket, WebRtcSocketOptions } from "./webrtc.js";
import {
  MAX_TEXT_CHARS,
  MIN_IMAGE_INTERVAL_MS,
  TOOL_NAME_PATTERN,
  buildSessionStart,
  mergeTranscript,
  parseRelayEvent,
  reconnectDelayMs,
  fetchPublicAgentToken,
  relayUrl,
  relayWebRtcUrl,
  shouldReconnect,
  IDLE_CLOSE_CODE,
  USAGE_LIMIT_CLOSE_CODE,
  UNAUTHORIZED_CLOSE_CODE,
  MAX_TOOLS
} from "./protocol.js";
import type {
  AgentCapabilities,
  ClientMessage,
  JsonSchema,
  ToolActivityEvent,
  ToolCallEvent,
  TranscriptItem,
  VoiceGender
} from "./protocol.js";

/** Where the agent is in its lifecycle. */
export type VoiceAgentStatus =
  "idle" | "connecting" | "ready" | "listening" | "hearing" | "thinking" | "speaking" | "error" | "closed";

/** A tool the page implements and the agent may call mid-conversation. */
export interface ClientTool<Args extends Record<string, unknown> = Record<string, unknown>> {
  /** Letters, digits, `_` and `-`; must start with a letter or `_`; at most 64 characters. */
  name: string;
  /** Tells the model when to use the tool. At most 1024 characters. */
  description: string;
  /** JSON Schema object for the arguments. Omit for a tool without arguments. */
  parameters?: JsonSchema;
  /**
   * Runs the tool. The return value (anything JSON-serializable) goes back to
   * the agent; a thrown error or rejected promise is reported as a tool error.
   * Calls that run longer than ~14 s are abandoned with a "timeout" error.
   */
  handler(args: Args): unknown;
}

/** Details of a tool call the agent asked the page to run. */
export type ToolCallInfo = { callId: string; name: string; arguments: Record<string, unknown> };

/** Machine-readable reason attached to a {@link VoiceAgentError}. */
export type VoiceAgentErrorCode =
  | "microphone"
  | "token"
  | "connection"
  | "relay"
  | "audio"
  /** {@link VoiceAgent.sendImage} could not turn the source into a small enough JPEG. */
  | "image"
  /** The relay closed with 4003: this account's voice minutes are used up. Retrying will not help. */
  | "usage_limit"
  /** The relay closed with 1008: it refused the credentials, even after a fresh token where one could be fetched. */
  | "unauthorized";

/** Error delivered through the `error` event and rejected `start()` calls. */
export class VoiceAgentError extends Error {
  readonly code: VoiceAgentErrorCode;
  /** The WebSocket close code behind the error, when the relay closed the connection. */
  readonly closeCode?: number;

  constructor(code: VoiceAgentErrorCode, message: string, options?: { cause?: unknown; closeCode?: number }) {
    super(message, options);
    this.name = "VoiceAgentError";
    this.code = code;
    if (options?.closeCode !== undefined) this.closeCode = options.closeCode;
  }
}

/** Something the developer should know that does not end the session. */
export type VoiceAgentWarning = {
  /**
   * `audio_blocked`: the browser left the audio context suspended, so the agent cannot be heard until {@link VoiceAgent.resumeAudio} runs inside a user gesture.
   * `protocol_mismatch`: the relay speaks a newer protocol than this SDK; the session runs, but update the SDK.
   * `webrtc_unavailable`: `transport: "webrtc"` was asked for and could not be used; the session runs over the WebSocket.
   */
  code: "audio_blocked" | "protocol_mismatch" | "webrtc_unavailable";
  message: string;
};

/** Maps a relay close code to the error `start()` or the `error` event reports. */
function closeError(code: number, initial: boolean): VoiceAgentError {
  if (code === USAGE_LIMIT_CLOSE_CODE) {
    return new VoiceAgentError("usage_limit", "Voice minutes used up for this month", { closeCode: code });
  }
  if (code === UNAUTHORIZED_CLOSE_CODE) {
    return new VoiceAgentError("unauthorized", "The relay refused these credentials", { closeCode: code });
  }
  return new VoiceAgentError(
    "connection",
    initial ? `Relay closed the connection (${code})` : "Lost the connection to the relay",
    { closeCode: code }
  );
}

/** Why a connection ended. */
export type CloseInfo = { code: number; reason: string; willReconnect: boolean };

/** Events emitted by {@link VoiceAgent}; the key is the event name. */
export interface VoiceAgentEvents {
  /** The status changed. */
  status: VoiceAgentStatus;
  /** The transcript changed: the whole list, and the line that changed. */
  transcript: { transcript: readonly TranscriptItem[]; item: TranscriptItem };
  /** A turn became final. Fires once per turn. */
  message: TranscriptItem;
  /** The agent asked this page to run a client tool. */
  toolcall: ToolCallInfo;
  /** Progress of any tool call, whether it runs on the relay or in the page. */
  toolactivity: ToolActivityEvent;
  /** Something went wrong. Not every error ends the session. */
  error: VoiceAgentError;
  /** Mic and agent-output loudness, 0..1, at most ~30 times a second while active. */
  level: { mic: number; output: number };
  /** Something is wrong that does not end the session, such as audio blocked by the browser. */
  warning: VoiceAgentWarning;
  /** Audio that was blocked can play now. */
  audioresume: void;
  /** A session is established (fires again after each reconnect). */
  open: void;
  /** The relay ended the conversation: the agent finished it (`agent`), the
   *  user stayed silent (`idle`) or it reached its time limit (`max_duration`).
   *  The last of the agent's speech still plays; `close` follows. */
  ended: { reason: string };
  /** The conversation moved to another of the assistant's agents. */
  agentchange: { agent: string };
  /** A connection ended. */
  close: CloseInfo;
}

/** Options for {@link VoiceAgent.start}. */
export type StartOptions = {
  /** Set false for a text-only session that never asks for the microphone. Default true. */
  microphone?: boolean;
};

/** Constructor options for {@link VoiceAgent}. */
export interface VoiceAgentOptions {
  /** Relay base (`https://relay.example.com`, `wss://...`) or a full `/agent` URL. Relative paths resolve against the page. */
  url: string;
  /**
   * A session token, or a function returning one. The function is called before
   * every connect and reconnect, so short-lived tokens refresh themselves.
   * Omit when the relay needs no token.
   */
  token?: string | (() => Promise<string>);
  /**
   * A Max Cloud public agent id (`pub_…`), for embedding without a backend:
   * the SDK asks the relay for a token itself. Works only on websites the
   * agent's owner listed in the console. Ignored when `token` is set.
   */
  project?: string;
  /** Conversation language, for example `"en"` or `"zh"`. */
  language?: string;
  /** Preferred agent voice. */
  voice?: VoiceGender;
  /** Voice backend id to request. Honoured only if the relay allows switching. */
  backend?: string;
  /** Facts about the host app, for example "The user is on the pricing page". Untrusted by the relay. Max 2000 characters. */
  context?: string;
  /** Tools the agent can call in this page. At most 32. */
  tools?: ClientTool[];
  /**
   * How audio travels. `"websocket"` (the default) works everywhere.
   * `"webrtc"` sends audio over UDP with the browser's own loss concealment
   * and jitter buffer, which holds up better on poor networks; the relay must
   * have it turned on (`WEBRTC=on`). Where it cannot be used (the relay does
   * not offer it, or the network blocks it) the session runs over the
   * WebSocket instead and a `webrtc_unavailable` warning is emitted.
   */
  transport?: "websocket" | "webrtc";
  /** STUN and TURN servers for `transport: "webrtc"`. Needed only on networks that block direct UDP. */
  iceServers?: RTCIceServer[];
  /** Reconnect with exponential backoff after an unexpected drop. Default true. */
  autoReconnect?: boolean;
  /** Speak replies with the browser's `speechSynthesis` when the relay asks for it. Default true. */
  speakFallback?: boolean;
  /** Reuse an existing AudioContext for capture and playback. */
  audioContext?: AudioContext;
  /** @internal Test seams. Not part of the public API. */
  internals?: VoiceAgentInternals;
}

/** @internal */
export interface SocketEventMap {
  open: unknown;
  error: unknown;
  message: { data: unknown };
  close: { code: number; reason: string };
}

/** @internal The slice of `WebSocket` the client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}

/** @internal */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** @internal */
interface VoiceAgentInternals {
  WebSocket?: WebSocketConstructor;
  /** Opens the WebRTC transport; setting it also skips the browser-support check. */
  webrtc?: (options: WebRtcSocketOptions) => WebRtcSocket;
  /** Builds the audio layer; receives the callback to report playback start/stop. */
  audio?: (onPlayingChange: (playing: boolean) => void, onBlockedChange: (blocked: boolean) => void) => AudioIO;
  toolTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Reads and encodes a picture, instead of the browser's canvas. */
  imageEncoder?: ImageEncoder;
}

/**
 * Declares a client tool with typed arguments. Returns the definition unchanged;
 * it exists so handlers get an argument type and typos fail at compile time.
 */
export function defineClientTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  tool: ClientTool<Args>
): ClientTool {
  return tool as ClientTool;
}

type Lifecycle = "idle" | "connecting" | "active" | "error" | "closed";

type Listener<P> = (payload: P) => void;

const SOCKET_OPEN = 1;
const MAX_BUFFERED_BYTES = 256 * 1024;
const LEVEL_INTERVAL_MS = 33;

/** Minimal typed emitter. A throwing listener never breaks the others. */
class Emitter<E extends object> {
  private readonly listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {};

  /** Subscribes to an event. Returns a function that unsubscribes. */
  on<K extends keyof E>(type: K, listener: Listener<E[K]>): () => void {
    (this.listeners[type] ??= new Set()).add(listener);
    return () => this.off(type, listener);
  }

  /** Removes a listener added with {@link on}. */
  off<K extends keyof E>(type: K, listener: Listener<E[K]>): void {
    this.listeners[type]?.delete(listener);
  }

  protected emit<K extends keyof E>(type: K, payload: E[K]): void {
    for (const listener of [...(this.listeners[type] ?? [])]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`voice-agent: "${String(type)}" listener threw`, error);
      }
    }
  }

  protected clearListeners(): void {
    for (const key of Object.keys(this.listeners) as Array<keyof E>) delete this.listeners[key];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A voice conversation with a relay: connects, streams the microphone, plays
 * the agent's voice, keeps a transcript, and runs the page's tools.
 *
 * Construction touches no browser APIs, so it is safe during server rendering.
 * Call {@link start} from a user gesture (a click) so the browser allows audio.
 */
export class VoiceAgent extends Emitter<VoiceAgentEvents> {
  private readonly options: VoiceAgentOptions;
  private readonly tools: ReadonlyMap<string, ClientTool>;
  private readonly SocketCtor: WebSocketConstructor;
  private audio: AudioIO | undefined;

  private lifecycle: Lifecycle = "idle";
  private serverState: "hearing" | "thinking" | undefined;
  private playing = false;
  private lastStatus: VoiceAgentStatus = "idle";

  private socket: WebSocketLike | undefined;
  /** The current socket when it is a peer connection. */
  private rtcSocket: WebRtcSocket | undefined;
  /** WebRTC was asked for and could not be used: the WebSocket serves until the next start(). */
  private rtcUnavailable = false;
  /** Settles when the microphone is open, or could not be opened. */
  private micReady: Promise<void> = Promise.resolve();
  private socketReady = false;
  private generation = 0;
  private sessionSeq = 0;
  private attempts = 0;
  /** A refused (1008) connection gets one retry with a fresh token; reset once a session starts. */
  private authRetried = false;
  private blocked = false;
  private protocolWarned = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the relay gave this conversation to carry it across a reconnect. */
  private resumeId: string | undefined;
  private endedByRelay = false;
  private activeAgent: string | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private lastLevel = { mic: 0, output: 0 };
  private cancelPending: ((error: VoiceAgentError) => void) | undefined;
  private startPromise: Promise<void> | undefined;

  private wantMic = false;
  private isMuted = false;
  private destroyed = false;
  private context: string | undefined;

  private items: readonly TranscriptItem[] = [];
  private readonly finalized = new Set<string>();
  private readonly spoken = new Set<string>();

  private caps: AgentCapabilities | undefined;
  /** A `sendImage` is encoding now. */
  private imageEncoding = false;
  /** When and on which socket the last picture went out, for the relay's one-second gap. */
  private lastImage: { socket: WebSocketLike; at: number } | undefined;
  private provider: string | undefined;

  /**
   * @throws {TypeError} when a tool name is invalid or duplicated, or there are more than 32 tools.
   */
  constructor(options: VoiceAgentOptions) {
    super();
    this.options = options;
    this.context = options.context;
    const tools = new Map<string, ClientTool>();
    for (const tool of options.tools ?? []) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) throw new TypeError(`Invalid tool name: ${tool.name}`);
      if (tools.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
      tools.set(tool.name, tool);
    }
    if (tools.size > MAX_TOOLS) throw new TypeError(`At most ${MAX_TOOLS} tools are allowed`);
    this.tools = tools;
    this.SocketCtor = options.internals?.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
  }

  /** Current status. */
  get status(): VoiceAgentStatus {
    return this.lastStatus;
  }

  /** The conversation so far, oldest first. A new array on every change, so it is safe to use as React state. */
  get transcript(): readonly TranscriptItem[] {
    return this.items;
  }

  /** What the relay said it supports. Undefined until a session starts. */
  get capabilities(): AgentCapabilities | undefined {
    return this.caps;
  }

  /** The voice backend serving the current session. Undefined until a session starts. */
  get backend(): string | undefined {
    return this.provider;
  }

  /** What carries the current session's audio. Undefined when there is no connection. */
  get transport(): "websocket" | "webrtc" | undefined {
    if (!this.socket) return undefined;
    return this.rtcSocket === this.socket ? "webrtc" : "websocket";
  }

  /** The agent the conversation is with, once the assistant has handed it
   *  over; undefined while it is with the one every conversation starts with. */
  get agent(): string | undefined {
    return this.activeAgent;
  }

  /** Whether the microphone is muted. */
  get muted(): boolean {
    return this.isMuted;
  }

  /**
   * Connects and opens the microphone. Resolves once the relay accepts the
   * session. Call it from a user gesture (click or key press).
   *
   * Calling it while already starting or started returns the same promise.
   *
   * @throws {VoiceAgentError} when the microphone is refused or the relay cannot be reached.
   */
  start(options: StartOptions = {}): Promise<void> {
    if (this.destroyed) return Promise.reject(new VoiceAgentError("connection", "VoiceAgent was destroyed"));
    if (this.startPromise && (this.lifecycle === "connecting" || this.lifecycle === "active")) return this.startPromise;

    this.generation += 1;
    const generation = this.generation;
    this.attempts = 0;
    this.authRetried = false;
    this.rtcUnavailable = false;
    this.isMuted = false;
    this.wantMic = options.microphone !== false;
    this.setLifecycle("connecting");

    // Audio setup runs synchronously first: browsers only allow it inside the gesture.
    const audio = this.ensureAudio();
    const prepared = audio.prepare();
    const mic = this.wantMic
      ? audio
          .startMic((pcm) => this.onMicFrame(pcm))
          .catch((error: unknown) => {
            throw error instanceof VoiceAgentError
              ? error
              : new VoiceAgentError("microphone", `Could not open the microphone: ${errorMessage(error)}`, {
                  cause: error
                });
          })
      : Promise.resolve();
    this.micReady = mic.then(
      () => undefined,
      () => undefined
    );
    this.startLevelTimer();

    const pending = new Promise<never>((_, reject) => {
      this.cancelPending = reject;
    });
    const run = Promise.all([prepared, mic, this.connect(generation, true)]).then(() => undefined);
    const promise = Promise.race([run, pending]).catch((error: unknown) => {
      if (generation === this.generation) this.fail(error);
      throw error;
    });
    this.startPromise = promise;
    // The caller owns rejection handling; this keeps an ignored start() from becoming unhandled.
    promise.catch(() => undefined);
    return promise;
  }

  /** True while the browser is keeping audio suspended, so the agent cannot be heard. See {@link resumeAudio}. */
  get audioBlocked(): boolean {
    return this.blocked;
  }

  /**
   * Resumes audio the browser blocked. Call it from a click or key press (the
   * `warning` event with code `audio_blocked` tells you when it is needed).
   *
   * @returns whether audio is running afterwards.
   */
  async resumeAudio(): Promise<boolean> {
    if (!this.audio) return true;
    const running = await this.audio.resume();
    this.setBlocked(!running);
    return running;
  }

  /** Ends the conversation and releases the microphone. The agent can be started again. */
  stop(): void {
    if (this.destroyed) return;
    this.teardown("idle");
  }

  /** Stops sending microphone audio. The session stays open. */
  mute(): void {
    if (this.isMuted) return;
    this.isMuted = true;
    this.audio?.setMicEnabled(false);
    this.sendIfReady({ type: "audio.stop" });
    this.refreshStatus();
  }

  /** Resumes sending microphone audio after {@link mute}. */
  unmute(): void {
    if (!this.isMuted) return;
    this.isMuted = false;
    this.audio?.setMicEnabled(true);
    if (this.wantMic) this.sendIfReady({ type: "audio.start" });
    this.refreshStatus();
  }

  /**
   * Sends a typed turn. It is shown as a final user line and answered aloud.
   * Text is trimmed and capped at 2000 characters.
   *
   * @returns false when there is no live session or the text is empty.
   */
  sendText(text: string): boolean {
    const clean = text.trim().slice(0, MAX_TEXT_CHARS);
    if (!clean) return false;
    return this.sendIfReady({ type: "text.input", text: clean });
  }

  /**
   * Shows the agent a picture. With `text` it is a typed turn with the picture
   * attached and is answered aloud; without, the agent sees the picture with
   * your next turn. The picture is scaled so its longer side is at most
   * `maxSide` (default 1024 pixels) and sent as JPEG; it goes to the model's
   * vendor and the relay does not keep it.
   *
   * @returns false when the session is not ready or the relay does not take
   * pictures (see `capabilities.imageInput`), when another `sendImage` is
   * still encoding or went out less than a second ago, or when the session
   * changed while the picture was being prepared. Nothing is sent then.
   * @throws {VoiceAgentError} with code `image` when the source cannot be read
   * or will not fit the relay's size limit.
   */
  async sendImage(source: ImageSource, options: { text?: string; maxSide?: number } = {}): Promise<boolean> {
    const socket = this.socket;
    const caps = this.caps;
    if (!socket || !this.isReady() || caps?.imageInput !== true) return false;
    // The relay refuses a second picture within a second; do not even encode one.
    if (this.imageEncoding) return false;
    if (this.lastImage?.socket === socket && Date.now() - this.lastImage.at < MIN_IMAGE_INTERVAL_MS) return false;
    this.imageEncoding = true;
    let data: string;
    try {
      data = await encodeImage(source, options.maxSide ?? DEFAULT_IMAGE_MAX_SIDE, this.options.internals?.imageEncoder);
    } catch (error) {
      throw new VoiceAgentError("image", `Could not prepare the picture: ${errorMessage(error)}`, { cause: error });
    } finally {
      this.imageEncoding = false;
    }
    // The session may have been replaced while encoding (a reconnect): the new
    // one may not take pictures, and its limits start over.
    if (this.socket !== socket || this.caps !== caps || caps.imageInput !== true) return false;
    const text = options.text?.trim().slice(0, MAX_TEXT_CHARS);
    const sent = this.sendIfReady({
      type: "image.input",
      image: data,
      mimeType: "image/jpeg",
      ...(text ? { text } : {})
    });
    if (sent) this.lastImage = { socket, at: Date.now() };
    return sent;
  }

  /**
   * Replaces the context string sent with `session.start`. It takes effect at
   * the next session (the next {@link start} or automatic reconnect); a
   * session already running is not changed.
   */
  setContext(text: string): void {
    this.context = text;
  }

  /** Silences the agent immediately, as if the user had talked over it. */
  interrupt(): void {
    this.audio?.clearPlayback();
    // Over WebRTC the relay holds the speech still to come: it drops it.
    if (this.rtcSocket && this.rtcSocket === this.socket && this.socketReady) {
      this.rtcSocket.send(JSON.stringify({ type: "transport.clear" }));
    }
  }

  /** Stops the conversation, removes all listeners, and makes the instance unusable. */
  destroy(): void {
    if (this.destroyed) return;
    this.teardown("closed");
    this.destroyed = true;
    this.audio?.close();
    this.clearListeners();
  }

  // ----- internals -----

  private ensureAudio(): AudioIO {
    const onPlayingChange = (playing: boolean) => {
      this.playing = playing;
      this.refreshStatus();
    };
    const onBlockedChange = (blocked: boolean) => this.setBlocked(blocked);
    if (this.options.internals?.audio) {
      return (this.audio ??= this.options.internals.audio(onPlayingChange, onBlockedChange));
    }
    this.audio ??= createBrowserAudio({
      ...(this.options.audioContext ? { audioContext: this.options.audioContext } : {}),
      ...(this.options.language ? { language: this.options.language } : {}),
      ...(this.options.voice ? { voice: this.options.voice } : {}),
      onPlayingChange,
      onBlockedChange
    });
    return this.audio;
  }

  /** Warns, once per client, when the relay is ahead of this SDK. A relay
   *  that is behind, or too old to say, needs nothing from the page. */
  private checkRelayProtocol(relay: number | undefined): void {
    if (this.protocolWarned || typeof relay !== "number" || relay <= PROTOCOL_VERSION) return;
    this.protocolWarned = true;
    this.emit("warning", {
      code: "protocol_mismatch",
      message: `The relay speaks protocol ${relay}; this SDK (${SDK_VERSION}) speaks ${PROTOCOL_VERSION}. Update max-voice-agent.`
    });
  }

  private setBlocked(blocked: boolean): void {
    if (blocked === this.blocked || this.destroyed) return;
    this.blocked = blocked;
    if (blocked) {
      this.emit("warning", {
        code: "audio_blocked",
        message: "The browser is blocking audio. Call resumeAudio() from a click or key press."
      });
    } else {
      this.emit("audioresume", undefined);
    }
  }

  private get streaming(): boolean {
    return this.wantMic && !this.isMuted && this.socketReady;
  }

  private computeStatus(): VoiceAgentStatus {
    if (this.lifecycle !== "active") return this.lifecycle;
    if (this.playing) return "speaking";
    if (this.serverState === "thinking") return "thinking";
    if (!this.streaming) return "ready";
    return this.serverState === "hearing" ? "hearing" : "listening";
  }

  private refreshStatus(): void {
    const next = this.computeStatus();
    if (next === this.lastStatus) return;
    this.lastStatus = next;
    this.emit("status", next);
  }

  private setLifecycle(lifecycle: Lifecycle): void {
    this.lifecycle = lifecycle;
    this.refreshStatus();
  }

  private reportError(error: VoiceAgentError): void {
    this.emit("error", error);
  }

  private fail(error: unknown): void {
    const wrapped =
      error instanceof VoiceAgentError
        ? error
        : new VoiceAgentError("connection", errorMessage(error), { cause: error });
    this.cancelSocket();
    this.audio?.releaseMic();
    this.audio?.clearPlayback();
    this.stopLevelTimer();
    this.setLifecycle("error");
    this.reportError(wrapped);
  }

  private teardown(final: "idle" | "closed", keepPlayback = false): void {
    this.resumeId = undefined;
    this.endedByRelay = false;
    this.activeAgent = undefined;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const hadSocket = this.socket !== undefined;
    this.cancelSocket();
    this.cancelPending?.(new VoiceAgentError("connection", "Stopped before the session started"));
    this.cancelPending = undefined;
    this.startPromise = undefined;
    this.audio?.releaseMic();
    if (!keepPlayback) this.audio?.clearPlayback();
    this.stopLevelTimer();
    this.wantMic = false;
    this.isMuted = false;
    this.serverState = undefined;
    this.playing = false;
    this.setLifecycle(final);
    if (hadSocket) this.emit("close", { code: 1000, reason: "stopped", willReconnect: false });
  }

  /** Detaches and closes the current socket without triggering reconnect logic. */
  private cancelSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.rtcSocket = undefined;
    this.socketReady = false;
    this.serverState = undefined;
    if (socket && socket.readyState <= SOCKET_OPEN) {
      try {
        socket.close(1000, "client stop");
      } catch {
        /* already closing */
      }
    }
  }

  private startLevelTimer(): void {
    if (this.levelTimer) return;
    this.levelTimer = setInterval(() => {
      const next = this.audio?.levels() ?? { mic: 0, output: 0 };
      const mic = this.isMuted ? 0 : next.mic;
      const last = this.lastLevel;
      if (Math.abs(mic - last.mic) < 0.01 && Math.abs(next.output - last.output) < 0.01) return;
      this.lastLevel = { mic, output: next.output };
      this.emit("level", this.lastLevel);
    }, LEVEL_INTERVAL_MS);
  }

  private stopLevelTimer(): void {
    clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    if (this.lastLevel.mic !== 0 || this.lastLevel.output !== 0) {
      this.lastLevel = { mic: 0, output: 0 };
      this.emit("level", this.lastLevel);
    }
  }

  private onMicFrame(pcm: ArrayBuffer): void {
    const socket = this.socket;
    if (!socket || !this.streaming || socket.readyState !== SOCKET_OPEN) return;
    if (socket.bufferedAmount + pcm.byteLength >= MAX_BUFFERED_BYTES) return;
    socket.send(pcm);
  }

  private isReady(): boolean {
    return Boolean(this.socket && this.socketReady && this.socket.readyState === SOCKET_OPEN);
  }

  private sendIfReady(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || !this.socketReady || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private async resolveToken(): Promise<string | undefined> {
    const { token, project } = this.options;
    if (token === undefined && project) {
      try {
        return await fetchPublicAgentToken(this.options.url, project);
      } catch (error) {
        throw new VoiceAgentError("token", `Could not start the agent: ${errorMessage(error)}`, { cause: error });
      }
    }
    if (typeof token !== "function") return token;
    try {
      return await token();
    } catch (error) {
      throw new VoiceAgentError("token", `Could not get a session token: ${errorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Opens one socket and resolves when its session is ready. For the initial
   * connect, a drop before readiness rejects. For reconnects it resolves, since
   * the close handler has already scheduled the next attempt.
   */
  private async connect(generation: number, initial: boolean): Promise<void> {
    const token = await this.resolveToken();
    if (generation !== this.generation) return;
    const rtc = this.wantsWebRtc() ? this.openWebRtc(token) : undefined;
    const socket = rtc ?? new this.SocketCtor(relayUrl(this.options.url, token));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.rtcSocket = rtc;
    this.socketReady = false;
    this.sessionSeq += 1;
    const session = this.sessionSeq;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: VoiceAgentError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        if (this.socket === socket) settle(new VoiceAgentError("connection", "Timed out connecting to the relay"));
      }, this.options.internals?.connectTimeoutMs ?? 15000);

      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        socket.send(
          JSON.stringify(
            buildSessionStart({
              ...(this.options.language ? { language: this.options.language } : {}),
              ...(this.options.voice ? { voice: this.options.voice } : {}),
              ...(this.options.backend ? { backend: this.options.backend } : {}),
              ...(this.context ? { context: this.context } : {}),
              // Only a reconnect carries the conversation on: start() begins a new one.
              ...(!initial && this.resumeId ? { resume: this.resumeId } : {}),
              tools: [...this.tools.values()]
            })
          )
        );
      });

      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return;
        if (typeof event.data === "string") {
          const parsed = parseRelayEvent(event.data);
          if (parsed) this.onRelayEvent(parsed, socket, session, () => settle());
        } else if (event.data instanceof ArrayBuffer) {
          this.onAudio(event.data);
        }
      });

      socket.addEventListener("error", () => {
        /* A close event always follows; it carries the code. */
      });

      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.rtcSocket = undefined;
        this.socketReady = false;
        this.serverState = undefined;
        if (event.code === WEBRTC_UNAVAILABLE_CODE) {
          // Nothing was lost: no session had started. Carry on over the WebSocket.
          this.rtcUnavailable = true;
          this.emit("warning", {
            code: "webrtc_unavailable",
            message: `WebRTC could not be used (${event.reason || "unavailable"}); using the WebSocket.`
          });
          this.connect(generation, initial).then(
            () => settle(),
            (error: unknown) => settle(error as VoiceAgentError)
          );
          return;
        }
        // A goodbye the relay just sent must be heard out, not cut off.
        if (!this.endedByRelay) this.audio?.clearPlayback();
        const wasReady = this.lifecycle === "active";
        if (initial && !wasReady && event.code !== IDLE_CLOSE_CODE) {
          if (this.takeAuthRetry(event.code)) {
            this.emit("close", { code: event.code, reason: event.reason, willReconnect: true });
            this.connect(generation, true).then(
              () => settle(),
              (error: unknown) => settle(error as VoiceAgentError)
            );
            return;
          }
          this.emit("close", { code: event.code, reason: event.reason, willReconnect: false });
          settle(closeError(event.code, true));
          return;
        }
        this.onSocketClosed(generation, event.code, event.reason);
        settle();
      });
    });
  }

  private wantsWebRtc(): boolean {
    if (this.options.transport !== "webrtc" || this.rtcUnavailable) return false;
    return Boolean(this.options.internals?.webrtc) || webRtcSupported();
  }

  private openWebRtc(token: string | undefined): WebRtcSocket {
    const socket = (this.options.internals?.webrtc ?? createWebRtcSocket)({
      url: relayWebRtcUrl(this.options.url),
      ...(token ? { token } : {}),
      ...(this.options.iceServers ? { iceServers: this.options.iceServers } : {}),
      onStream: (stream) => this.audio?.playStream?.(stream),
      onStreamEnd: (stream) => this.audio?.stopStream?.(stream)
    });
    // The microphone may still be opening; a reconnect finds it open already.
    void this.micReady.then(() => {
      if (this.rtcSocket === socket) socket.setMicrophone(this.audio?.micTrack?.());
    });
    return socket;
  }

  /**
   * A 1008 close means the relay refused the credentials. A static token cannot
   * change, so retrying is pointless; a token function (or a public agent id)
   * gets one retry with a freshly fetched token before giving up.
   */
  private takeAuthRetry(code: number): boolean {
    const { token, project, autoReconnect } = this.options;
    const refreshable = typeof token === "function" || (token === undefined && Boolean(project));
    if (code !== UNAUTHORIZED_CLOSE_CODE || this.authRetried || !refreshable || autoReconnect === false) return false;
    this.authRetried = true;
    return true;
  }

  private onSocketClosed(generation: number, code: number, reason: string): void {
    this.attempts += 1;
    const willReconnect =
      this.takeAuthRetry(code) || shouldReconnect(code, this.attempts, this.options.autoReconnect ?? true);
    if (this.endedByRelay) {
      // The conversation is over by the relay's own decision, whatever the code.
      this.emit("close", { code, reason, willReconnect: false });
      this.teardown("closed", true);
      return;
    }
    this.emit("close", { code, reason, willReconnect });
    if (code === IDLE_CLOSE_CODE) {
      this.teardown("closed");
      return;
    }
    if (!willReconnect) {
      this.fail(closeError(code, false));
      return;
    }
    this.setLifecycle("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (generation !== this.generation) return;
      this.connect(generation, false).catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.reportError(
          error instanceof VoiceAgentError
            ? error
            : new VoiceAgentError("connection", errorMessage(error), { cause: error })
        );
        this.onSocketClosed(generation, 1006, "reconnect failed");
      });
    }, reconnectDelayMs(this.attempts));
  }

  private onAudio(data: ArrayBuffer): void {
    try {
      this.audio?.playPcm16(data);
    } catch (error) {
      this.reportError(new VoiceAgentError("audio", `Playback failed: ${errorMessage(error)}`, { cause: error }));
    }
  }

  private onRelayEvent(
    event: NonNullable<ReturnType<typeof parseRelayEvent>>,
    socket: WebSocketLike,
    session: number,
    ready: () => void
  ): void {
    switch (event.type) {
      case "session.started": {
        this.caps = event.capabilities ?? {};
        this.provider = event.provider;
        this.socketReady = true;
        this.attempts = 0;
        this.authRetried = false;
        this.resumeId = event.resume;
        this.checkRelayProtocol(event.protocol);
        this.setLifecycle("active");
        if (this.streaming) this.sendIfReady({ type: "audio.start" });
        this.emit("open", undefined);
        ready();
        break;
      }
      case "status": {
        if (event.state === "hearing" || event.state === "asr") {
          this.serverState = "hearing";
          this.audio?.clearPlayback();
        } else if (event.state === "thinking") this.serverState = "thinking";
        else this.serverState = undefined;
        this.refreshStatus();
        break;
      }
      case "transcript": {
        if (event.speaker === "rider") this.audio?.clearPlayback();
        const merged = mergeTranscript(this.items, { ...event, turnId: `${session}:${event.turnId}` });
        if (merged.item) {
          this.items = merged.list;
          this.emit("transcript", { transcript: this.items, item: merged.item });
          for (const item of this.items) {
            if (item.final && !this.finalized.has(item.id)) {
              this.finalized.add(item.id);
              this.emit("message", item);
            }
          }
        }
        if (
          event.speaker === "agent" &&
          event.useBrowserSpeech === true &&
          event.final !== false &&
          (this.options.speakFallback ?? true) &&
          !this.spoken.has(event.deliveryId)
        ) {
          this.spoken.add(event.deliveryId);
          if (this.spoken.size > 512) this.spoken.delete(this.spoken.values().next().value as string);
          this.ensureAudio().speak(event.text);
        }
        break;
      }
      case "tool.call":
        void this.runToolCall(event, socket);
        break;
      case "tool.activity":
        this.emit("toolactivity", event);
        break;
      case "error":
        this.reportError(new VoiceAgentError("relay", event.message));
        break;
      case "session.ended":
        this.endedByRelay = true;
        // Nothing more goes up: the microphone is no longer needed.
        this.audio?.releaseMic();
        this.emit("ended", { reason: event.reason });
        break;
      case "agent.changed":
        this.activeAgent = event.agent;
        this.emit("agentchange", { agent: event.agent });
        break;
      case "connection":
        break;
    }
  }

  private async runToolCall(call: ToolCallEvent, socket: WebSocketLike): Promise<void> {
    const reply = (message: { output?: unknown; error?: string }) => {
      // A reply on a replaced socket would answer a call the new session never made.
      if (this.socket !== socket || socket.readyState !== SOCKET_OPEN) return;
      socket.send(JSON.stringify({ type: "tool.result", callId: call.callId, ...message }));
    };
    this.emit("toolcall", { callId: call.callId, name: call.name, arguments: call.arguments });
    const tool = this.tools.get(call.name);
    if (!tool) {
      reply({ error: "unknown tool" });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), this.options.internals?.toolTimeoutMs ?? 14000);
      });
      const output = await Promise.race([Promise.resolve().then(() => tool.handler(call.arguments)), timeout]);
      reply(output === undefined ? {} : { output });
    } catch (error) {
      reply({ error: errorMessage(error) || "tool failed" });
    } finally {
      clearTimeout(timer);
    }
  }
}
