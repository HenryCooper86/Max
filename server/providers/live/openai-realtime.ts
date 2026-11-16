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
};

const SAY_INSTRUCTION = "Say exactly the following line and nothing else, in the language it is written in: ";

export function openAiDialect(): RealtimeDialect {
  const model = env("OPENAI_REALTIME_MODEL") ?? "gpt-realtime";
  const base = (env("OPENAI_REALTIME_URL") ?? "wss://api.openai.com/v1/realtime").replace(/\/+$/, "");
  return {
    name: "OpenAI Realtime",
    url: `${base}?model=${encodeURIComponent(model)}`,
    apiKey: env("OPENAI_API_KEY") ?? "",
    responseMode: "manual-capable",
    inputRate: 24_000,
    voice: (gender) =>
      gender === "male"
        ? (env("OPENAI_VOICE_MALE") ?? "cedar")
        : (env("OPENAI_VOICE", "OPENAI_VOICE_FEMALE") ?? "marin"),
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
      }
    }),
    say: (text) => [
      // Out-of-band: the line is the relay's, not part of the model's own
      // conversation, so it must not steer later answers.
      { type: "response.create", response: { conversation: "none", instructions: SAY_INSTRUCTION + text } }
    ],
    contextRole: "system"
  };
}

export function grokDialect(): RealtimeDialect {
  const model = env("XAI_VOICE_MODEL", "GROK_VOICE_MODEL") ?? "grok-voice-latest";
  const base = (env("XAI_REALTIME_URL") ?? "wss://api.x.ai/v1/realtime").replace(/\/+$/, "");
  return {
    name: "Grok Voice",
    url: `${base}?model=${encodeURIComponent(model)}`,
    apiKey: env("XAI_API_KEY", "GROK_API_KEY") ?? "",
    // xAI documents server VAD without a way to defer the reply, so the relay
    // withholds unaddressed replies instead of preventing them.
    responseMode: "auto",
    inputRate: CLIENT_INPUT_RATE,
    voice: (gender) =>
      gender === "male" ? (env("XAI_VOICE_MALE") ?? "rex") : (env("XAI_VOICE", "XAI_VOICE_FEMALE") ?? "eve"),
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
      }
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

type UpstreamEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  error?: { message?: string; code?: string };
  response?: { status?: string };
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

  function sendEvent(event: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
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
    if (type === "response.done") {
      responseActive = false;
      events?.onResponseDone({ cancelled: event.response?.status === "cancelled" });
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
      if (ready) sendEvent({ type: "response.create" });
    },
    cancel() {
      if (ready && responseActive) sendEvent({ type: "response.cancel" });
    },
    say(text) {
      if (!ready) return;
      for (const event of dialect.say(text)) sendEvent(event);
    },
    updateInstructions(instructions) {
      if (!ready) return;
      sendEvent({
        type: "session.update",
        session: { ...(dialect.contextRole === "system" ? { type: "realtime" } : {}), instructions }
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
