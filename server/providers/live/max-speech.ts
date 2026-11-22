import WebSocket, { type RawData } from "ws";
import type { Logger } from "../../logger";
import { createChatLoop, type ChatStage } from "./chat-loop";
import { env, type EngineConfig, type EngineEvents, type EngineImage, type VoiceEngine } from "./engine";
import { localPipelineSettings } from "./pipeline";

/**
 * The relay's side of Max Speech (speech-server/): one WebSocket that carries
 * the wearer's microphone up and the spoken reply down. The server does voice
 * detection, turn-taking, streaming transcription and synthesis; the relay
 * keeps what only it can do, the chat model and its tools, through the same
 * chat loop the Whisper pipeline uses.
 *
 * Unlike the pipeline, turn-taking is the server's: a `speech.started` message
 * is the barge-in signal and `transcript.final` closes the turn.
 */

const PROTOCOL = "max-speech.session.v1";
const DEFAULT_URL = "ws://localhost:8790/v1/speech/session";
const SESSION_PATH = "/v1/speech/session";
const READY_TIMEOUT_MS = 10_000;

type MaxSpeechSettings = { url: string; apiKey: string; voice: string | undefined };

/** Accepts the socket URL itself or just the server's http(s) address. */
export function maxSpeechUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MAX_SPEECH_URL "${raw}" is not a valid URL (try http://host:8790)`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (["", "/", "/v1", "/v1/"].includes(url.pathname)) url.pathname = SESSION_PATH;
  }
  return url.toString();
}

function maxSpeechSettings(): MaxSpeechSettings {
  return {
    url: maxSpeechUrl(env("MAX_SPEECH_URL")),
    apiKey: env("MAX_SPEECH_API_KEY") ?? "",
    voice: env("MAX_SPEECH_VOICE")
  };
}

/** Offered once the owner says a speech server is there; the default address
 *  alone is not a claim that one is running on this machine. */
export function maxSpeechEnabled(): boolean {
  return Boolean(env("MAX_SPEECH_URL")) || env("MAX_SPEECH")?.toLowerCase() === "on";
}

type ServerMessage = {
  type?: string;
  id?: string;
  text?: string;
  code?: string;
  message?: string;
  ms?: unknown;
  protocol?: string;
  /** `ready`: whether the live recognizer can bias towards keyterms (absent on older servers). */
  keyterms?: boolean;
};

type Reply = {
  id: string;
  sentFinal: boolean;
  /** Whether any text has been sent for this reply. */
  sentText: boolean;
  cancelled: boolean;
  done: boolean;
  current(): boolean;
  settle(): void;
};

export function createMaxSpeechEngine(
  log: Logger,
  settings?: MaxSpeechSettings,
  chatStage: () => ChatStage = () => localPipelineSettings().llm,
  request: typeof fetch = fetch
): VoiceEngine {
  let resolvedSettings = settings;
  let events: EngineEvents | undefined;
  let socket: WebSocket | undefined;
  let instructions = "";
  let config: EngineConfig | undefined;
  let ready = false;
  let closed = false;
  let pendingUser: string | undefined;
  let replySeq = 0;
  /** The reply being spoken now; a new one replaces it. */
  let active: Reply | undefined;
  /** Binary frames belong to the reply whose `audio.start` came last. */
  let audioId: string | undefined;
  const replies = new Map<string, Reply>();
  /** `replyId:code` of server errors already shown, so a failing reply reports once. */
  const reportedErrors = new Set<string>();
  /** The last error the server sent, for a connect that fails right after it. */
  let lastError: { code?: string; message?: string } | undefined;
  /** Warning codes already shown to the user this connection: a notice is said once. */
  const shownWarnings = new Set<string>();
  /** Warnings that arrived before `ready`, shown once the connection is up. */
  const earlyWarnings: ServerMessage[] = [];

  function onWarning(message: ServerMessage): void {
    log.warn("max-speech warning", { code: message.code, message: message.message });
    if (closed) return;
    if (!ready) {
      earlyWarnings.push(message);
      return;
    }
    const key = message.code ?? message.message ?? "";
    if (shownWarnings.has(key)) return;
    shownWarnings.add(key);
    events?.onError(message.message ?? "Max Speech sent a warning");
  }

  function sendJson(message: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function cancelReply(reply: Reply): void {
    if (reply.done || reply.cancelled) return;
    reply.cancelled = true;
    sendJson({ type: "cancel", id: reply.id });
  }

  function settleAll(): void {
    for (const reply of [...replies.values()]) reply.settle();
  }

  const chat = createChatLoop({
    log,
    request,
    label: "max-speech",
    stage: chatStage,
    events: () => events,
    tools: () => config?.tools ?? [],
    instructions: () => instructions,
    closed: () => closed,
    newSpeaker({ signal, current }) {
      replySeq += 1;
      const id = `r${replySeq}`;
      let settle!: () => void;
      const finished = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const reply: Reply = {
        id,
        sentFinal: false,
        sentText: false,
        cancelled: false,
        done: false,
        current,
        settle: () => {
          reply.done = true;
          replies.delete(id);
          if (active === reply) active = undefined;
          settle();
        }
      };
      replies.set(id, reply);
      active = reply;
      // A reply stopped by anything but a barge-in (a newer reply, cancel,
      // close) must not keep talking on the server.
      const onAbort = () => {
        cancelReply(reply);
        reply.settle();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return {
        delta(piece) {
          if (!current() || !piece || reply.sentFinal || reply.done) return;
          reply.sentText = true;
          sendJson({ type: "speak", id, text: piece, final: false });
        },
        say(line) {
          if (!current() || reply.sentFinal || reply.done) return;
          reply.sentFinal = true;
          reply.sentText = true;
          sendJson({ type: "speak", id, text: line, final: true });
        },
        async finish() {
          if (current() && !reply.sentFinal && !reply.done) {
            reply.sentFinal = true;
            sendJson({ type: "speak", id, text: "", final: true });
          }
          // Resolves on this reply's `audio.done`, a socket close or an abort.
          await finished;
        },
        // The model failed mid-reply. Finishing what was already sent is kinder
        // than cutting a sentence, and waiting for its audio.done keeps the
        // reply's end after its last audio, so nothing plays after it. With
        // nothing sent there is nothing worth finishing: cancel.
        abandon() {
          if (reply.done) return;
          if (!reply.sentText) {
            cancelReply(reply);
            reply.settle();
            return;
          }
          if (!reply.sentFinal) {
            reply.sentFinal = true;
            sendJson({ type: "speak", id, text: "", final: true });
          }
          return finished;
        }
      };
    }
  });

  /** A picture waits for the next user turn; with words it is that turn. */
  function sendImage(image: EngineImage, text?: string): void {
    if (closed) return;
    chat.addImage(image);
    if (!text) return;
    pendingUser = undefined;
    void chat.reply(text);
  }

  function onSpeechStarted(): void {
    if (closed) return;
    // Barge-in: whatever is being generated or spoken stops now.
    const wasReplying = chat.replying;
    chat.stop();
    if (active) cancelReply(active);
    events?.onSpeechStarted();
    if (wasReplying) chat.endReply(true);
  }

  function handle(message: ServerMessage): void {
    switch (message.type) {
      case "speech.started":
        onSpeechStarted();
        break;
      case "transcript.partial":
        if (!closed) events?.onRiderTranscript(message.text ?? "", false);
        break;
      case "transcript.final": {
        if (closed) break;
        const finalText = (message.text ?? "").trim();
        log.debug("max-speech transcript", { ms: message.ms });
        pendingUser = finalText || undefined;
        // An empty transcript still closes the turn the server opened.
        events?.onRiderTranscript(finalText, true);
        break;
      }
      case "audio.start":
        audioId = message.id;
        break;
      case "audio.done": {
        const reply = message.id ? replies.get(message.id) : undefined;
        reply?.settle();
        if (audioId === message.id) audioId = undefined;
        break;
      }
      case "warning":
        onWarning(message);
        break;
      case "error":
        log.warn("max-speech error", { code: message.code, message: message.message });
        lastError = { code: message.code, message: message.message };
        if (!closed && ready) {
          // One failing reply can draw an error per message; say it once.
          const key = message.id ? `${message.id}:${message.code ?? ""}` : undefined;
          if (key && reportedErrors.has(key)) break;
          if (key) {
            if (reportedErrors.size >= 100) reportedErrors.clear();
            reportedErrors.add(key);
          }
          events?.onError(message.message ?? "Max Speech reported an error");
        }
        break;
      default:
        break;
    }
  }

  function rawToString(raw: RawData): string {
    return Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
  }

  return {
    responseMode: "manual-only",
    connect(engineConfig, engineEvents) {
      events = engineEvents;
      config = engineConfig;
      instructions = engineConfig.instructions;
      return new Promise<void>((resolve, reject) => {
        lastError = undefined;
        try {
          resolvedSettings ??= maxSpeechSettings();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const settings = resolvedSettings;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
          socket?.terminate();
        };
        const timer = setTimeout(
          () => fail(new Error(`Max Speech did not answer at ${settings.url} within 10 seconds`)),
          READY_TIMEOUT_MS
        );
        const upstream = new WebSocket(settings.url, {
          headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}
        });
        socket = upstream;
        let loading = false;
        upstream.on("open", () => {
          // Keyterms are sent after `ready`, and only to a server that can use them.
          sendJson({
            type: "session.update",
            languages: engineConfig.languages,
            gender: engineConfig.voiceGender,
            ...(engineConfig.voiceId || settings.voice ? { voice: engineConfig.voiceId ?? settings.voice } : {})
          });
        });
        upstream.on("message", (raw, isBinary) => {
          if (isBinary) {
            const reply = active;
            if (reply && audioId === reply.id && reply.current() && !closed) events?.onAgentAudio(raw as Buffer);
            return;
          }
          let message: ServerMessage;
          try {
            message = JSON.parse(rawToString(raw)) as ServerMessage;
          } catch {
            return;
          }
          if (message.type === "ready") {
            if (message.protocol !== PROTOCOL) log.warn("max-speech protocol differs", { protocol: message.protocol });
            if (!settled) {
              settled = true;
              ready = true;
              clearTimeout(timer);
              if (engineConfig.keyterms.length > 0 && message.keyterms !== false)
                sendJson({ type: "session.update", keyterms: engineConfig.keyterms });
              resolve();
              for (const warning of earlyWarnings.splice(0)) onWarning(warning);
            }
            return;
          }
          if (message.type === "error" && message.code === "loading") loading = true;
          handle(message);
        });
        upstream.on("unexpected-response", (_request, response) => {
          const hint = response.statusCode === 401 || response.statusCode === 403 ? " (check MAX_SPEECH_API_KEY)" : "";
          fail(new Error(`Max Speech refused the connection at ${settings.url}: HTTP ${response.statusCode}${hint}`));
        });
        upstream.on("error", (error) => {
          log.warn("max-speech socket error", { message: error.message });
          fail(new Error(`Max Speech is not reachable at ${settings.url}: ${error.message}`));
        });
        upstream.on("close", (code, reason) => {
          const detail = `closed (${code}${reason.length ? ` ${reason.toString("utf8").slice(0, 120)}` : ""})`;
          if (!settled) {
            const why = lastError ? `: ${[lastError.code, lastError.message].filter(Boolean).join(": ")}` : "";
            fail(
              new Error(
                lastError?.code === "busy"
                  ? "Max Speech is at its limit of live sessions; try again when another has ended"
                  : lastError?.code === "handshake_timeout"
                    ? `Max Speech gave up waiting for the session to start${why}`
                    : loading || code === 1013
                      ? "Max Speech is still loading its models"
                      : code === 1011
                        ? `Max Speech could not start its models${why}`
                        : code === 1008
                          ? `Max Speech refused the connection at ${settings.url} (check MAX_SPEECH_API_KEY / origin)${why}`
                          : `Max Speech ${detail} before it was ready${why}`
              )
            );
            return;
          }
          const wasReady = ready;
          ready = false;
          settleAll();
          if (!closed && wasReady)
            events?.onClosed(
              lastError?.code === "idle_timeout" ? "Max Speech closed the session after it sat idle" : detail
            );
        });
      });
    },
    sendAudio(pcm) {
      if (ready && !closed && socket?.readyState === WebSocket.OPEN) socket.send(pcm);
    },
    endInput() {
      if (ready && !closed) sendJson({ type: "turn.end" });
    },
    respond() {
      if (closed) return;
      const userText = pendingUser;
      pendingUser = undefined;
      if (userText) void chat.reply(userText);
    },
    cancel() {
      const wasReplying = chat.replying;
      chat.stop();
      if (active) cancelReply(active);
      if (wasReplying) chat.endReply(true);
    },
    say(text) {
      if (!closed) void chat.reply(undefined, text);
    },
    updateInstructions(next) {
      instructions = next;
    },
    updateTools(tools) {
      // Read per chat request, so the next reply already sees the new set.
      if (config) config = { ...config, tools };
    },
    addContext(text) {
      chat.addContext(text);
    },
    sendToolResult(callId, output) {
      chat.sendToolResult(callId, output);
    },
    sayDuringTool(callId, line) {
      chat.sayDuringTool(callId, line);
    },
    // Only when the owner said the chat model sees pictures (LOCAL_LLM_IMAGES).
    ...(chatStage().images
      ? { sendImage, sendVideoFrame: (image: EngineImage | undefined) => chat.setFrame(image) }
      : {}),
    sendText(text) {
      if (closed) return;
      pendingUser = undefined;
      void chat.reply(text);
    },
    close() {
      closed = true;
      chat.stop();
      settleAll();
      socket?.close();
    }
  };
}
