import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { AgentProvider, SessionStartEvent } from "./types";

type DoubaoSessionConfig = {
  sampleRate: number;
  channels: number;
};

const enum MessageType {
  FullClientRequest = 0b0001,
  AudioOnlyRequest = 0b0010,
  FullServerResponse = 0b1001,
  AudioOnlyResponse = 0b1011,
  ErrorInformation = 0b1111
}

const enum SerializationMethod {
  Raw = 0b0000,
  Json = 0b0001
}

const enum EventSend {
  StartConnection = 1,
  FinishConnection = 2,
  StartSession = 100,
  FinishSession = 102,
  TaskRequest = 200
}

const enum EventReceive {
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  SessionStarted = 150,
  SessionFinished = 152,
  SessionFailed = 153,
  Usage = 154,
  TtsSentenceStart = 350,
  TtsSentenceEnd = 351,
  TtsResponse = 352,
  TtsEnded = 359,
  AsrInfo = 450,
  AsrResponse = 451,
  AsrEnded = 459,
  ChatResponse = 550,
  ChatEnded = 559,
  DialogCommonError = 599
}

type ParsedDoubaoFrame = {
  event: number;
  sessionId: string;
  serialization: number;
  payload: Buffer;
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when VOICE_PROVIDER=doubao`);
  return value;
}

function buildDoubaoHeaders() {
  const appId = requireEnv("DOUBAO_APP_ID");
  const accessKey = requireEnv("DOUBAO_ACCESS_KEY");
  const resourceId = process.env.DOUBAO_RESOURCE_ID ?? "volc.speech.dialog";

  return {
    "X-Api-App-ID": appId,
    "X-Api-App-Key": "PlgvMymc7f3tQnJ6",
    "X-Api-Access-Key": accessKey,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Connect-Id": randomUUID()
  };
}

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function buildHeader(messageType: MessageType, serialization: SerializationMethod) {
  return Buffer.from([
    0x11,
    (messageType << 4) | 0b0100,
    serialization << 4,
    0x00
  ]);
}

function buildFullClientRequest(event: EventSend, sessionId?: string, metadata: unknown = {}) {
  const meta = Buffer.from(JSON.stringify(metadata));
  const parts = [buildHeader(MessageType.FullClientRequest, SerializationMethod.Json), uint32(event)];

  if (sessionId) {
    const session = Buffer.from(sessionId);
    parts.push(uint32(session.length), session);
  }

  parts.push(uint32(meta.length), meta);
  return Buffer.concat(parts);
}

function buildAudioRequest(sessionId: string, audio: Buffer) {
  const session = Buffer.from(sessionId);
  return Buffer.concat([
    buildHeader(MessageType.AudioOnlyRequest, SerializationMethod.Raw),
    uint32(EventSend.TaskRequest),
    uint32(session.length),
    session,
    uint32(audio.length),
    audio
  ]);
}

function buildDoubaoSessionConfig(config: DoubaoSessionConfig) {
  return {
    dialog: {
      bot_name: process.env.DOUBAO_BOT_NAME ?? "Horizon Helmet",
      system_role:
        process.env.DOUBAO_SYSTEM_ROLE ??
        "You are a motorcycle helmet voice assistant. Keep replies short, hands-free, and safety-first.",
      extra: {
        input_mod: "keep_alive",
        model: process.env.DOUBAO_REALTIME_MODEL ?? "1.2.1.1"
      }
    },
    asr: {
      audio_info: {
        format: "pcm",
        sample_rate: config.sampleRate,
        channel: config.channels
      }
    },
    tts: {
      speaker: process.env.DOUBAO_VOICE ?? "zh_female_vv_jupiter_bigtts",
      audio_config: {
        channel: 1,
        format: "pcm_s16le",
        sample_rate: 24000
      }
    }
  };
}

function parseDoubaoFrame(raw: RawData): ParsedDoubaoFrame {
  const data = Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.from(raw);
  if (data.length < 12) throw new Error("Doubao frame is too short");

  const messageType = (data[1] >> 4) & 0b1111;
  if (![MessageType.FullServerResponse, MessageType.AudioOnlyResponse, MessageType.ErrorInformation].includes(messageType)) {
    throw new Error(`Unsupported Doubao message type ${messageType}`);
  }

  const serialization = (data[2] >> 4) & 0b1111;
  const event = data.readUInt32BE(4);
  const sessionLength = data.readUInt32BE(8);
  const sessionStart = 12;
  const sessionEnd = sessionStart + sessionLength;
  const payloadLengthStart = sessionEnd;
  const payloadStart = payloadLengthStart + 4;
  if (data.length < payloadStart) throw new Error("Doubao frame payload is incomplete");

  return {
    event,
    sessionId: data.subarray(sessionStart, sessionEnd).toString(),
    serialization,
    payload: data.subarray(payloadStart)
  };
}

function parseJsonPayload(frame: ParsedDoubaoFrame) {
  if (!frame.payload.length || frame.serialization !== SerializationMethod.Json) return {};
  return JSON.parse(frame.payload.toString()) as Record<string, unknown>;
}

function extractAsrText(payload: Record<string, unknown>) {
  const results = payload.results;
  if (!Array.isArray(results)) return "";
  return results
    .map((result) => {
      if (!result || typeof result !== "object") return "";
      return String((result as Record<string, unknown>).text ?? "");
    })
    .join(" ")
    .trim();
}

export function createDoubaoProvider(client: WebSocket): AgentProvider {
  let upstream: WebSocket | undefined;
  let started = false;
  let sessionId = randomUUID();
  let sessionReady = false;
  const pendingAudio: Buffer[] = [];

  function sendClient(payload: unknown) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  function connectUpstream(config: DoubaoSessionConfig) {
    const url = process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    upstream = new WebSocket(url, { headers: buildDoubaoHeaders() });

    upstream.on("open", () => {
      upstream?.send(buildFullClientRequest(EventSend.StartConnection));
      sendClient({ type: "status", state: "connecting", detail: "Doubao voice connection opened" });
    });

    upstream.on("message", (message) => {
      try {
        const frame = parseDoubaoFrame(message);

        if (frame.event === EventReceive.ConnectionStarted) {
          sessionId = randomUUID();
          upstream?.send(buildFullClientRequest(EventSend.StartSession, sessionId, buildDoubaoSessionConfig(config)));
          return;
        }

        if (frame.event === EventReceive.SessionStarted) {
          sessionReady = true;
          sendClient({ type: "session.started", provider: "doubao", mode: "live" });
          sendClient({ type: "status", state: "ready", detail: "Doubao realtime voice connected" });
          while (pendingAudio.length) {
            upstream?.send(buildAudioRequest(sessionId, pendingAudio.shift()!));
          }
          return;
        }

        if (frame.event === EventReceive.TtsResponse) {
          if (client.readyState === client.OPEN) client.send(frame.payload, { binary: true });
          return;
        }

        const payload = parseJsonPayload(frame);
        if (frame.event === EventReceive.AsrResponse) {
          const text = extractAsrText(payload);
          if (text) sendClient({ type: "transcript", speaker: "rider", text, final: false });
          return;
        }

        if (frame.event === EventReceive.ChatResponse) {
          const text = String(payload.content ?? "");
          if (text) sendClient({ type: "transcript", speaker: "agent", text, final: false });
          return;
        }

        if (frame.event === EventReceive.ChatEnded || frame.event === EventReceive.TtsEnded) {
          sendClient({ type: "status", state: "ready", detail: "Doubao reply complete" });
          return;
        }

        if (
          frame.event === EventReceive.ConnectionFailed ||
          frame.event === EventReceive.SessionFailed ||
          frame.event === EventReceive.DialogCommonError
        ) {
          sendClient({ type: "error", message: String(payload.error ?? payload.message ?? "Doubao voice session failed") });
          return;
        }

        if (frame.event === EventReceive.Usage) {
          sendClient({ type: "status", state: "usage", detail: "Doubao usage event received" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Received invalid Doubao payload";
        sendClient({ type: "status", state: "doubao", detail: message });
      }
    });

    upstream.on("close", () => {
      sessionReady = false;
      sendClient({ type: "status", state: "closed", detail: "Doubao live agent disconnected" });
    });

    upstream.on("unexpected-response", (_request, response) => {
      sendClient({
        type: "error",
        message: `Doubao voice handshake failed with HTTP ${response.statusCode}. Check speech-dialog App ID, Access Token, Resource ID, and entitlement.`
      });
    });

    upstream.on("error", (error) => {
      sendClient({ type: "error", message: error.message });
    });
  }

  return {
    async start(event: SessionStartEvent) {
      if (!started) {
        started = true;
        connectUpstream({ sampleRate: event.sampleRate, channels: event.channels });
      }
    },
    async startAudio() {
      sendClient({ type: "status", state: "listening", detail: "Listening through Doubao realtime voice" });
    },
    async sendAudio(chunk: Buffer) {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        if (sessionReady) upstream.send(buildAudioRequest(sessionId, chunk));
        else pendingAudio.push(chunk);
      }
    },
    async stopAudio() {
      sendClient({ type: "status", state: "ready", detail: "Mic muted" });
    },
    async close() {
      if (upstream?.readyState === WebSocket.OPEN) {
        if (sessionReady) upstream.send(buildFullClientRequest(EventSend.FinishSession, sessionId));
        upstream.send(buildFullClientRequest(EventSend.FinishConnection));
      }
      upstream?.close();
    }
  };
}
