import WebSocket, { type RawData } from "ws";
import type { Logger } from "../../logger";
import { geminiRealtimeInput } from "./turn-settings";
import { createTurnTaking, type TurnTaking, type TurnTakingHooks } from "./turn-watcher";
import { CLIENT_INPUT_RATE, env, type EngineConfig, type EngineEvents, type VoiceEngine } from "./engine";

/**
 * Engine for Google's Gemini Live API (BidiGenerateContent over WebSocket).
 *
 * Gemini decides on its own when the wearer has finished and answers
 * immediately, so the relay's wake-word gate withholds unaddressed replies
 * rather than preventing them (`responseMode: "auto"`). It reports no explicit
 * "speech started": the first transcription fragment after a finished turn, or
 * an `interrupted` notice, is what opens a new wearer turn here.
 *
 * With the relay's own turn detector (./turn-watcher.ts) Gemini's detection is
 * switched off for the connection: the relay says where the user's speech
 * begins and ends (`activityStart`, `activityEnd`), and only the audio in
 * between is sent.
 */

const DEFAULT_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Gemini Live documents a frame a second; a timer that fires at 990 ms is still that. */
const MIN_GEMINI_FRAME_GAP_MS = 900;

type ServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string }; text?: string }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
  goAway?: { timeLeft?: string };
  error?: { message?: string };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  toolCallCancellation?: { ids?: string[] };
};

// Gemini's function declarations take the OpenAPI subset of JSON Schema.
// These keywords are rejected there, so they are dropped on the way out.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "unevaluatedProperties",
  "const",
  "examples",
  "default"
]);

/** A JSON Schema reduced to what Gemini function declarations accept. Exported for tests. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    // `properties` maps names to schemas; its keys are not schema keywords.
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, geminiSchema(child)])
      );
    } else output[key] = geminiSchema(value);
  }
  return output;
}

/** What Gemini wants as a function response: an object. */
function functionResponse(output: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { result: parsed };
  } catch {
    return { result: output };
  }
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

/**
 * Strips the API key from text about this engine's connection. The key rides
 * in the WebSocket URL (`?key=`), and a malformed URL, a socket error or a
 * close reason can quote that URL; the text is then logged and shown to the
 * connected client, and in Max Cloud the key is a customer's. Both the raw and
 * URL-encoded forms are removed, and any `key=` parameter whatever its value.
 * Exported for tests.
 */
export function redactGeminiSecrets(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)]))
      redacted = redacted.split(form).join("[redacted]");
  }
  return redacted.replace(/([?&]key=)[^&\s"'#]+/gi, "$1[redacted]");
}

export function geminiConfigured(): boolean {
  return Boolean(env("GEMINI_API_KEY", "GOOGLE_API_KEY"));
}

export function createGeminiLiveEngine(
  log: Logger,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  /** Overrides GEMINI_API_KEY (a Max Cloud project brings its own). */
  apiKeyOverride?: string,
  /** Overrides the gender-based voice (a Max Cloud project picks one). */
  voiceOverride?: string,
  /** The relay's own turn detector, when one is set up. Replaced in tests. */
  turnTaking: (log: Logger, hooks: TurnTakingHooks) => TurnTaking = createTurnTaking
): VoiceEngine {
  let socket: WebSocket | undefined;
  let events: EngineEvents | undefined;
  let closedByRelay = false;
  let ready = false;
  let lastVideoAt = 0;
  let replying = false;
  let riderText = "";
  let riderOpen = false;
  /** The relay cut a reply off for the user, and Gemini has not yet said that it stopped:
   *  what still arrives of that reply is not the start of a new one. */
  let staleReply = false;
  /** Tool calls awaiting a result: id → function name (the response needs both). */
  const pendingCalls = new Map<string, string>();

  function sendMessage(message: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function closeRiderTurn(): void {
    if (!riderOpen) return;
    riderOpen = false;
    events?.onRiderTranscript(riderText, true);
    riderText = "";
  }

  function beginReply(): void {
    if (replying) return;
    // The model answering is the only signal that the wearer's turn is over.
    closeRiderTurn();
    replying = true;
    events?.onResponseStarted();
  }

  let secrets: string[] = [];
  const redact = (text: string) => redactGeminiSecrets(text, secrets);

  function sendMicrophone(pcm: Buffer): void {
    sendMessage({
      realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: `audio/pcm;rate=${CLIENT_INPUT_RATE}` } }
    });
  }

  const turns = turnTaking(log, {
    forward: sendMicrophone,
    onStart() {
      if (!ready) return;
      sendMessage({ realtimeInput: { activityStart: {} } });
      // What Gemini's own `interrupted` does when it detects the speech itself.
      events?.onSpeechStarted();
      riderOpen = true;
      riderText = "";
      if (replying) {
        replying = false;
        staleReply = true;
        events?.onResponseDone({ cancelled: true });
      }
    },
    onEnd() {
      if (!ready) return;
      sendMessage({ realtimeInput: { activityEnd: {} } });
      // Whatever comes now answers this turn.
      staleReply = false;
    },
    onAbandon() {
      if (!ready) return;
      // Gemini cannot be told to forget what it was sent: the activity is ended, and what
      // it makes of a noise is its own. For the session, the turn is over with nothing said.
      sendMessage({ realtimeInput: { activityEnd: {} } });
      staleReply = false;
      closeRiderTurn();
    },
    onLost(reason) {
      // Gemini was told at setup to detect nothing itself, and that cannot be changed on a
      // connection: a new one is made, with whichever detector is there then.
      if (closedByRelay || !ready) return;
      ready = false;
      closedByRelay = true;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = undefined;
      events?.onClosed(`the turn detector went away (${reason})`);
    }
  });

  function handle(message: ServerMessage): void {
    if (message.goAway) log.info("gemini live session ending soon", { timeLeft: message.goAway.timeLeft });
    if (message.error?.message) events?.onError(redact(message.error.message));
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (!call.id || !call.name) continue;
      // The model asking for a tool is it answering: the wearer's turn is
      // over, and the reply starts here. Gemini can send a tool call before
      // any content, and the session only runs tools inside a reply it has
      // already judged (wake word, barge-in).
      beginReply();
      pendingCalls.set(call.id, call.name);
      if (events?.onToolCall) events.onToolCall({ callId: call.id, name: call.name, arguments: call.args ?? {} });
      else sendToolResponse(call.id, JSON.stringify({ error: "tools are not available" }));
    }
    for (const id of message.toolCallCancellation?.ids ?? []) pendingCalls.delete(id);
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      // The relay's detector already opened this turn and ended the reply: Gemini confirms it.
      if (turns.on) staleReply = false;
      else {
        // The wearer spoke over the reply.
        events?.onSpeechStarted();
        riderOpen = true;
        riderText = "";
      }
      if (replying) {
        replying = false;
        events?.onResponseDone({ cancelled: true });
      }
    }
    const heard = content.inputTranscription?.text;
    if (heard) {
      if (!riderOpen) {
        riderOpen = true;
        riderText = "";
        if (!replying) events?.onSpeechStarted();
      }
      riderText += heard;
      events?.onRiderTranscript(riderText, false);
    }
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && !staleReply) {
        beginReply();
        events?.onAgentAudio(Buffer.from(part.inlineData.data, "base64"));
      }
    }
    const spoken = content.outputTranscription?.text;
    if (spoken && !staleReply) {
      beginReply();
      events?.onAgentText(spoken);
    }
    if (content.turnComplete) staleReply = false;
    if (content.turnComplete && replying) {
      replying = false;
      events?.onResponseDone({ cancelled: false });
    }
  }

  function sendToolResponse(callId: string, output: string): void {
    const name = pendingCalls.get(callId);
    if (!name) return;
    pendingCalls.delete(callId);
    sendMessage({ toolResponse: { functionResponses: [{ id: callId, name, response: functionResponse(output) }] } });
  }

  function setup(config: EngineConfig, relayTakesTurns: boolean): Record<string, unknown> {
    const model = env("GEMINI_LIVE_MODEL") ?? "gemini-3.8-live";
    const voice =
      voiceOverride ??
      (config.voiceGender === "male"
        ? (env("GEMINI_VOICE_MALE") ?? "Puck")
        : (env("GEMINI_VOICE", "GEMINI_VOICE_FEMALE") ?? "Aoede"));
    // The relay's detector in charge: Gemini detects nothing, and its settings for that do not apply.
    const realtimeInput = relayTakesTurns
      ? { automaticActivityDetection: { disabled: true } }
      : geminiRealtimeInput().config;
    return {
      setup: {
        model: model.startsWith("models/") ? model : `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        },
        systemInstruction: { parts: [{ text: config.instructions }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(realtimeInput ? { realtimeInputConfig: realtimeInput } : {}),
        ...(config.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: config.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: geminiSchema(tool.parameters)
                  }))
                }
              ]
            }
          : {})
      }
    };
  }

  function openUpstream(config: EngineConfig, apiKey: string, base: string, relayTakesTurns: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      let upstream: WebSocket;
      try {
        upstream = createSocket(`${base}?key=${encodeURIComponent(apiKey)}`);
      } catch (error) {
        // ws rejects a malformed URL by quoting it, key included.
        fail(new Error(`Gemini Live: ${redact(error instanceof Error ? error.message : String(error))}`));
        return;
      }
      socket = upstream;
      upstream.on("open", () => sendMessage(setup(config, relayTakesTurns)));
      // Gemini sends JSON in binary frames as well as text frames.
      upstream.on("message", (raw) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(rawToString(raw)) as ServerMessage;
        } catch {
          return;
        }
        if (message.setupComplete !== undefined && !settled) {
          ready = true;
          settled = true;
          resolve();
          return;
        }
        handle(message);
      });
      upstream.on("unexpected-response", (_request, response) => {
        const hint = response.statusCode === 401 || response.statusCode === 403 ? " — check the API key" : "";
        fail(new Error(`Gemini Live: HTTP ${response.statusCode}${hint}`));
      });
      upstream.on("error", (error) => {
        const message = redact(error.message);
        log.warn("gemini live socket error", { message });
        fail(new Error(`Gemini Live: ${message}`));
      });
      upstream.on("close", (code, reason) => {
        // A rejected setup (bad model, bad key) arrives as a close with the reason.
        // Redacted before trimming, so a cut cannot leave part of the key behind.
        const text = reason.length ? ` ${redact(reason.toString("utf8")).slice(0, 160)}` : "";
        const detail = `closed (${code}${text})`;
        fail(new Error(`Gemini Live: ${detail}`));
        if (!closedByRelay && ready) events?.onClosed(detail);
      });
    });
  }

  return {
    responseMode: "auto",
    connect(config, engineEvents) {
      events = engineEvents;
      const apiKey = apiKeyOverride ?? env("GEMINI_API_KEY", "GOOGLE_API_KEY");
      if (!apiKey) return Promise.reject(new Error("Gemini Live: API key is not configured on the relay"));
      secrets = [apiKey];
      const base = env("GEMINI_LIVE_URL") ?? DEFAULT_URL;
      if (!turns.wanted) return openUpstream(config, apiKey, base, false);
      // The detector first: what Gemini is told at setup depends on whether it is there.
      return turns.connect(config.languages).then((relayTakesTurns) => {
        if (closedByRelay) throw new Error("Gemini Live: closed before it connected");
        return openUpstream(config, apiKey, base, relayTakesTurns);
      });
    },
    sendAudio(pcm) {
      if (ready) turns.audio(pcm);
    },
    endInput() {
      if (ready) turns.endInput();
    },
    respond() {
      /* Gemini answers on its own. */
    },
    cancel() {
      /* No cancel message exists; the relay stops forwarding the reply instead. */
    },
    say(text) {
      if (!ready) return;
      sendMessage({
        realtimeInput: {
          text: `Say exactly the following line and nothing else, in the language it is written in: ${text}`
        }
      });
    },
    sendToolResult(callId, output) {
      if (ready) sendToolResponse(callId, output);
    },
    sendText(text) {
      if (!ready) return;
      // The session already settled any spoken fragment before this typed
      // turn; reporting it again would make it a second, new turn.
      riderOpen = false;
      riderText = "";
      sendMessage({ realtimeInput: { text } });
    },
    sendVideoFrame(image) {
      // Gemini Live takes video itself, a frame a second: it sees each one as it comes. A client's
      // "every second" is a few milliseconds early as often as late, and those frames are not too many.
      const at = Date.now();
      if (!ready || !image || at - lastVideoAt < MIN_GEMINI_FRAME_GAP_MS) return;
      lastVideoAt = at;
      sendMessage({ realtimeInput: { video: { data: image.data, mimeType: image.mimeType } } });
    },
    sendImage(image, text) {
      if (!ready) return;
      // Gemini Live takes pictures as video frames, at most one a second.
      sendMessage({ realtimeInput: { video: { data: image.data, mimeType: image.mimeType } } });
      if (!text) return;
      riderOpen = false;
      riderText = "";
      sendMessage({ realtimeInput: { text } });
    },
    close() {
      closedByRelay = true;
      ready = false;
      turns.close();
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = undefined;
    }
  };
}
