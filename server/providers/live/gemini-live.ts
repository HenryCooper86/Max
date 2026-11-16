import WebSocket, { type RawData } from "ws";
import type { Logger } from "../../logger";
import { CLIENT_INPUT_RATE, env, type EngineConfig, type EngineEvents, type VoiceEngine } from "./engine";

/**
 * Engine for Google's Gemini Live API (BidiGenerateContent over WebSocket).
 *
 * Gemini decides on its own when the wearer has finished and answers
 * immediately, so the relay's wake-word gate withholds unaddressed replies
 * rather than preventing them (`responseMode: "auto"`). It reports no explicit
 * "speech started": the first transcription fragment after a finished turn, or
 * an `interrupted` notice, is what opens a new wearer turn here.
 */

const DEFAULT_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

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
};

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

export function geminiConfigured(): boolean {
  return Boolean(env("GEMINI_API_KEY", "GOOGLE_API_KEY"));
}

export function createGeminiLiveEngine(
  log: Logger,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)
): VoiceEngine {
  let socket: WebSocket | undefined;
  let events: EngineEvents | undefined;
  let closedByRelay = false;
  let ready = false;
  let replying = false;
  let riderText = "";
  let riderOpen = false;

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

  function handle(message: ServerMessage): void {
    if (message.goAway) log.info("gemini live session ending soon", { timeLeft: message.goAway.timeLeft });
    if (message.error?.message) events?.onError(message.error.message);
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      // The wearer spoke over the reply.
      events?.onSpeechStarted();
      riderOpen = true;
      riderText = "";
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
      if (part.inlineData?.data) {
        beginReply();
        events?.onAgentAudio(Buffer.from(part.inlineData.data, "base64"));
      }
    }
    const spoken = content.outputTranscription?.text;
    if (spoken) {
      beginReply();
      events?.onAgentText(spoken);
    }
    if (content.turnComplete && replying) {
      replying = false;
      events?.onResponseDone({ cancelled: false });
    }
  }

  function setup(config: EngineConfig): Record<string, unknown> {
    const model = env("GEMINI_LIVE_MODEL") ?? "gemini-3.8-live";
    const voice =
      config.voiceGender === "male"
        ? (env("GEMINI_VOICE_MALE") ?? "Puck")
        : (env("GEMINI_VOICE", "GEMINI_VOICE_FEMALE") ?? "Aoede");
    return {
      setup: {
        model: model.startsWith("models/") ? model : `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        },
        systemInstruction: { parts: [{ text: config.instructions }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
  }

  return {
    responseMode: "auto",
    connect(config, engineEvents) {
      events = engineEvents;
      const apiKey = env("GEMINI_API_KEY", "GOOGLE_API_KEY");
      if (!apiKey) return Promise.reject(new Error("Gemini Live: API key is not configured on the relay"));
      const base = env("GEMINI_LIVE_URL") ?? DEFAULT_URL;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };
        const upstream = createSocket(`${base}?key=${encodeURIComponent(apiKey)}`);
        socket = upstream;
        upstream.on("open", () => sendMessage(setup(config)));
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
          log.warn("gemini live socket error", { message: error.message });
          fail(new Error(`Gemini Live: ${error.message}`));
        });
        upstream.on("close", (code, reason) => {
          // A rejected setup (bad model, bad key) arrives as a close with the reason.
          const detail = `closed (${code}${reason.length ? ` ${reason.toString("utf8").slice(0, 160)}` : ""})`;
          fail(new Error(`Gemini Live: ${detail}`));
          if (!closedByRelay && ready) events?.onClosed(detail);
        });
      });
    },
    sendAudio(pcm) {
      if (!ready) return;
      sendMessage({
        realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: `audio/pcm;rate=${CLIENT_INPUT_RATE}` } }
      });
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
