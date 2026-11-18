import WebSocket, { type RawData } from "ws";
import type { VoiceGender } from "../../../shared/agent";
import type { Logger } from "../../logger";
import {
  CLIENT_INPUT_RATE,
  CLIENT_OUTPUT_RATE,
  env,
  resamplePcm16,
  type EngineConfig,
  type EngineEvents,
  type EngineResponseMode,
  type VoiceEngine
} from "./engine";

/**
 * Engine for realtime APIs that speak the OpenAI Realtime event protocol:
 * OpenAI itself and xAI's Grok Voice Agent, which is wire-compatible apart
 * from the handful of differences captured in `RealtimeDialect`.
 *
 * Event names are matched generously (the beta and GA names, and xAI's
 * aliases) so a vendor renaming `response.audio.delta` to
 * `response.output_audio.delta` does not silence the assistant.
 */
export type RealtimeDialect = {
  name: string;
  url: string;
  apiKey: string;
  responseMode: EngineResponseMode;
  /** PCM16 rate this upstream wants for microphone audio. */
  inputRate: number;
  voice(gender: VoiceGender): string;
  /** Builds the `session` object for `session.update`. */
  session(config: EngineConfig, voice: string): Record<string, unknown>;
  /** Builds the event that makes the model speak one exact line. */
  say(text: string): Record<string, unknown>[];
  /** Role used for silent context notes. */
  contextRole: "system" | "user";
  /** `session.type` the upstream requires on every session.update, if any. */
  sessionType?: string;
};

const SAY_INSTRUCTION = "Say exactly the following line and nothing else, in the language it is written in: ";

/** The `tools` part of a realtime `session` object. Every OpenAI-compatible
 *  realtime server takes the same flat function shape. */
export function realtimeTools(config: EngineConfig): Record<string, unknown> {
  if (!config.tools.length) return {};
  return {
    tools: config.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })),
    tool_choice: "auto"
  };
}

/** `apiKey` overrides OPENAI_API_KEY (a Max Cloud project brings its own). */
/** `voiceName` overrides the gender-based voice (a Max Cloud project picks one). */
export function openAiDialect(apiKey?: string, voiceName?: string): RealtimeDialect {
  const model = env("OPENAI_REALTIME_MODEL") ?? "gpt-realtime";
  const base = (env("OPENAI_REALTIME_URL") ?? "wss://api.openai.com/v1/realtime").replace(/\/+$/, "");
  return {
    name: "OpenAI Realtime",
    url: `${base}?model=${encodeURIComponent(model)}`,
    apiKey: apiKey ?? env("OPENAI_API_KEY") ?? "",
    responseMode: "manual-capable",
    inputRate: 24_000,
    voice: (gender) =>
      voiceName ??
      (gender === "male"
        ? (env("OPENAI_VOICE_MALE") ?? "cedar")
        : (env("OPENAI_VOICE", "OPENAI_VOICE_FEMALE") ?? "marin")),
    session: (config, voice) => ({
      type: "realtime",
      model,
      output_modalities: ["audio"],
      instructions: config.instructions,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: {
            model: env("OPENAI_TRANSCRIBE_MODEL") ?? "gpt-4o-mini-transcribe",
            ...(config.keyterms.length ? { prompt: config.keyterms.join(", ") } : {})
          },
          turn_detection: {
            type: env("OPENAI_TURN_DETECTION") ?? "server_vad",
            create_response: !config.manualResponse,
            interrupt_response: true
          }
        },
        output: { format: { type: "audio/pcm", rate: CLIENT_OUTPUT_RATE }, voice }
      },
      ...realtimeTools(config)
    }),
    say: (text) => [
      // Out-of-band: the line is the relay's, not part of the model's own
      // conversation, so it must not steer later answers.
      { type: "response.create", response: { conversation: "none", instructions: SAY_INSTRUCTION + text } }
    ],
    contextRole: "system",
    sessionType: "realtime"
  };
}

/** `apiKey` overrides XAI_API_KEY (a Max Cloud project brings its own). */
export function grokDialect(apiKey?: string, voiceName?: string): RealtimeDialect {
  const model = env("XAI_VOICE_MODEL", "GROK_VOICE_MODEL") ?? "grok-voice-latest";
  const base = (env("XAI_REALTIME_URL") ?? "wss://api.x.ai/v1/realtime").replace(/\/+$/, "");
  return {
    name: "Grok Voice",
    url: `${base}?model=${encodeURIComponent(model)}`,
    apiKey: apiKey ?? env("XAI_API_KEY", "GROK_API_KEY") ?? "",
    // xAI documents server VAD without a way to defer the reply, so the relay
    // withholds unaddressed replies instead of preventing them.
    responseMode: "auto",
    inputRate: CLIENT_INPUT_RATE,
    voice: (gender) =>
      voiceName ??
      (gender === "male" ? (env("XAI_VOICE_MALE") ?? "rex") : (env("XAI_VOICE", "XAI_VOICE_FEMALE") ?? "eve")),
    session: (config, voice) => ({
      voice,
      instructions: config.instructions,
      turn_detection: { type: "server_vad" },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: CLIENT_INPUT_RATE },
          transcription: {
            model: "grok-transcribe",
            ...(config.languages[0] && !["es", "pt"].includes(config.languages[0])
              ? { language_hint: config.languages[0] }
              : {}),
            ...(config.keyterms.length ? { keyterms: config.keyterms.slice(0, 100) } : {})
          }
        },
        output: { format: { type: "audio/pcm", rate: CLIENT_OUTPUT_RATE } }
      },
      ...realtimeTools(config)
    }),
    say: (text) => [
      {
        type: "conversation.item.create",
        item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text }] }
      }
    ],
    contextRole: "user"
  };
}

/**
 * Any self-hosted server that implements the OpenAI Realtime protocol in
 * front of open-weight models (Speaches, LocalAI and similar). These grew up
 * against the original, flat `session` shape, so that is what is sent; the
 * event names in both generations are already understood on the way back.
 */
export function localRealtimeDialect(): RealtimeDialect {
  const model = env("LOCAL_REALTIME_MODEL") ?? "";
  const base = (env("LOCAL_REALTIME_URL") ?? "ws://localhost:8000/v1/realtime").replace(/\/+$/, "");
  return {
    name: "Local realtime",
    url: model ? `${base}?model=${encodeURIComponent(model)}` : base,
    // Local servers rarely check the key, but the header must not be empty.
    apiKey: env("LOCAL_REALTIME_API_KEY", "LOCAL_API_KEY") ?? "local",
    responseMode: "manual-capable",
    inputRate: 24_000,
    voice: (gender) =>
      gender === "male"
        ? (env("LOCAL_REALTIME_VOICE_MALE") ?? "am_michael")
        : (env("LOCAL_REALTIME_VOICE", "LOCAL_REALTIME_VOICE_FEMALE") ?? "af_heart"),
    session: (config, voice) => ({
      modalities: ["audio", "text"],
      instructions: config.instructions,
      voice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: {
        model: env("LOCAL_REALTIME_TRANSCRIBE_MODEL") ?? "Systran/faster-whisper-small",
        ...(config.languages.length === 1 ? { language: config.languages[0] } : {})
      },
      turn_detection: { type: "server_vad", create_response: !config.manualResponse },
      ...realtimeTools(config)
    }),
    say: (text) => [{ type: "response.create", response: { instructions: SAY_INSTRUCTION + text } }],
    contextRole: "system"
  };
}

/** Offered once the owner points at a local realtime server. */
export function localRealtimeEnabled(): boolean {
  return Boolean(env("LOCAL_REALTIME_URL"));
}

type FunctionCallItem = { type?: string; call_id?: string; name?: string; arguments?: string };

type UpstreamEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  error?: { message?: string; code?: string };
  response?: { status?: string; output?: FunctionCallItem[] };
  item?: FunctionCallItem;
  call_id?: string;
  name?: string;
  arguments?: string;
};

const AUDIO_DELTA = new Set(["response.output_audio.delta", "response.audio.delta"]);
const TEXT_DELTA = new Set([
  "response.output_audio_transcript.delta",
  "response.audio_transcript.delta",
  "response.output_text.delta",
  "response.text.delta"
]);
const TRANSCRIPTION = "conversation.item.input_audio_transcription.";

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

export function createRealtimeEngine(
  dialect: RealtimeDialect,
  log: Logger,
  createSocket: (url: string, headers: Record<string, string>) => WebSocket = (url, headers) =>
    new WebSocket(url, { headers })
): VoiceEngine {
  let socket: WebSocket | undefined;
  let events: EngineEvents | undefined;
  let closedByRelay = false;
  let ready = false;
  let responseActive = false;
  // Transcript of the wearer's turn in progress, by upstream item.
  let riderItem: string | undefined;
  let riderText = "";
  let riderPending = false;
  // Tool calls of the current reply. The model continues only once every one
  // has its output and the reply that asked for them has finished.
  const announcedCalls = new Set<string>();
  const awaitingCalls = new Set<string>();
  let continueAfterTools = false;
  /** A `response.create` that must wait for the active reply to finish. */
  let respondWhenIdle = false;
  /** A `response.create` was sent and the upstream has not answered it yet:
   *  `responseActive` only turns true on `response.created`, a round trip later. */
  let createPending = false;

  function sendEvent(event: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  /** Asks for a reply now, or as soon as the current one has finished:
   *  realtime APIs reject a second concurrent response. */
  function createResponse(): void {
    createPending = true;
    sendEvent({ type: "response.create" });
  }

  function requestResponse(): void {
    if (responseActive || createPending) respondWhenIdle = true;
    else createResponse();
  }

  function functionCall(call: { call_id?: string; name?: string; arguments?: string }): void {
    if (!call.call_id || !call.name || announcedCalls.has(call.call_id)) return;
    announcedCalls.add(call.call_id);
    awaitingCalls.add(call.call_id);
    continueAfterTools = true;
    if (events?.onToolCall) {
      events.onToolCall({ callId: call.call_id, name: call.name, arguments: call.arguments ?? "" });
    } else {
      awaitingCalls.delete(call.call_id);
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: "tools are not available" })
        }
      });
    }
  }

  function afterReply(): void {
    if (responseActive || createPending) return;
    if (continueAfterTools && awaitingCalls.size === 0) {
      continueAfterTools = false;
      respondWhenIdle = false;
      createResponse();
      return;
    }
    if (respondWhenIdle && !continueAfterTools) {
      respondWhenIdle = false;
      createResponse();
    }
  }

  function riderTranscript(event: UpstreamEvent, kind: string): void {
    if (event.item_id && event.item_id !== riderItem) {
      riderItem = event.item_id;
      riderText = "";
    }
    if (kind === "delta") riderText += event.delta ?? "";
    // "updated" (xAI) and "completed" both carry the whole transcript so far.
    else riderText = event.transcript ?? riderText;
    const final = kind === "completed";
    riderPending = !final;
    events?.onRiderTranscript(riderText, final);
    if (final) riderText = "";
  }

  function handle(event: UpstreamEvent, settle: { resolve(): void; reject(error: Error): void }): void {
    const type = event.type ?? "";
    if (type === "session.updated" || (type === "session.created" && ready)) {
      ready = true;
      settle.resolve();
      return;
    }
    if (type === "error") {
      const message = event.error?.message ?? "upstream error";
      // Cancelling a reply that already finished is routine, not a fault.
      if (event.error?.code === "response_cancel_not_active" || /no active response/i.test(message)) return;
      if (!ready) settle.reject(new Error(`${dialect.name}: ${message}`));
      else events?.onError(message);
      // A refused response.create will never be answered with response.created.
      if (createPending) {
        createPending = false;
        afterReply();
      }
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      riderPending = false;
      riderText = "";
      riderItem = undefined;
      events?.onSpeechStarted();
      return;
    }
    if (type.startsWith(TRANSCRIPTION)) {
      const kind = type.slice(TRANSCRIPTION.length);
      if (kind === "delta" || kind === "updated" || kind === "completed") riderTranscript(event, kind);
      return;
    }
    if (type === "response.created") {
      responseActive = true;
      createPending = false;
      // Upstreams that never send a "completed" transcript (cumulative
      // "updated" only) mark the end of the wearer's turn by answering it.
      if (riderPending && dialect.responseMode === "auto" && riderText.trim()) {
        riderPending = false;
        events?.onRiderTranscript(riderText, true);
        riderText = "";
      }
      events?.onResponseStarted();
      return;
    }
    if (AUDIO_DELTA.has(type)) {
      if (event.delta) events?.onAgentAudio(Buffer.from(event.delta, "base64"));
      return;
    }
    if (TEXT_DELTA.has(type)) {
      if (event.delta) events?.onAgentText(event.delta);
      return;
    }
    if (type === "response.output_item.done" && event.item?.type === "function_call") {
      functionCall(event.item);
      return;
    }
    if (type === "response.function_call_arguments.done") {
      functionCall(event);
      return;
    }
    if (type === "response.done") {
      // Some servers only list function calls in the finished response.
      for (const item of event.response?.output ?? []) if (item.type === "function_call") functionCall(item);
      responseActive = false;
      events?.onResponseDone({ cancelled: event.response?.status === "cancelled" });
      afterReply();
    }
  }

  return {
    responseMode: dialect.responseMode,
    connect(config, engineEvents) {
      events = engineEvents;
      if (!dialect.apiKey) return Promise.reject(new Error(`${dialect.name}: API key is not configured on the relay`));
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = {
          resolve: () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          reject: (error: Error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          }
        };
        const upstream = createSocket(dialect.url, { Authorization: `Bearer ${dialect.apiKey}` });
        socket = upstream;
        upstream.on("open", () => {
          sendEvent({ type: "session.update", session: dialect.session(config, dialect.voice(config.voiceGender)) });
        });
        upstream.on("message", (raw, isBinary) => {
          if (isBinary) return;
          let event: UpstreamEvent;
          try {
            event = JSON.parse(rawToString(raw)) as UpstreamEvent;
          } catch {
            return;
          }
          handle(event, settle);
        });
        upstream.on("unexpected-response", (_request, response) => {
          const hint = response.statusCode === 401 || response.statusCode === 403 ? " — check the API key" : "";
          settle.reject(new Error(`${dialect.name}: HTTP ${response.statusCode}${hint}`));
        });
        upstream.on("error", (error) => {
          log.warn("realtime socket error", { backend: dialect.name, message: error.message });
          settle.reject(new Error(`${dialect.name}: ${error.message}`));
        });
        upstream.on("close", (code, reason) => {
          const detail = `closed (${code}${reason.length ? ` ${reason.toString("utf8").slice(0, 120)}` : ""})`;
          settle.reject(new Error(`${dialect.name}: ${detail}`));
          if (!closedByRelay && ready) events?.onClosed(detail);
        });
      });
    },
    sendAudio(pcm) {
      if (!ready) return;
      const audio = resamplePcm16(pcm, CLIENT_INPUT_RATE, dialect.inputRate);
      sendEvent({ type: "input_audio_buffer.append", audio: audio.toString("base64") });
    },
    respond() {
      if (ready) requestResponse();
    },
    cancel() {
      // Tool calls in flight belong to the reply being cancelled: their
      // results must not make the model resume it.
      continueAfterTools = false;
      awaitingCalls.clear();
      respondWhenIdle = false;
      if (ready && responseActive) sendEvent({ type: "response.cancel" });
    },
    sendToolResult(callId, output) {
      if (!ready || !announcedCalls.has(callId)) return;
      sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
      if (!awaitingCalls.delete(callId)) return;
      if (!responseActive) afterReply();
    },
    sendText(text) {
      if (!ready) return;
      continueAfterTools = false;
      awaitingCalls.clear();
      sendEvent({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
      });
      requestResponse();
    },
    say(text) {
      if (!ready) return;
      for (const event of dialect.say(text)) sendEvent(event);
    },
    updateInstructions(instructions) {
      if (!ready) return;
      sendEvent({
        type: "session.update",
        session: { ...(dialect.sessionType ? { type: dialect.sessionType } : {}), instructions }
      });
    },
    addContext(text) {
      if (!ready) return;
      sendEvent({
        type: "conversation.item.create",
        item: { type: "message", role: dialect.contextRole, content: [{ type: "input_text", text }] }
      });
    },
    close() {
      closedByRelay = true;
      ready = false;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = undefined;
    }
  };
}
