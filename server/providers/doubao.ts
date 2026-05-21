import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { AgentProvider, SessionStartEvent, VoiceGender } from "./types";

// The "Max" persona prompt. Overridable per deployment with DOUBAO_SYSTEM_ROLE;
// keep it consistent with the DOUBAO_SYSTEM_ROLE default in .env.example.
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  "你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认使用中文回答；如果骑手明确使用英文，可以用英文回答；如果骑手明确使用日文，可以用日文回答。只允许中文、英文、日文三种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文、English、日本語。帮助骑手处理摩托车相关问题、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。骑行中遇到危险或分心请求时，给出更安全的替代方案。声音设定为中文女声。";

type DoubaoSessionConfig = {
  sampleRate: number;
  channels: number;
  voiceGender: VoiceGender;
};

// Default realtime-dialogue speakers from the Doubao 音色列表 (jupiter family).
// Override per deployment with DOUBAO_VOICE / DOUBAO_VOICE_MALE.
const DEFAULT_FEMALE_SPEAKER = "zh_female_vv_jupiter_bigtts";
const DEFAULT_MALE_SPEAKER = "zh_male_yunzhou_jupiter_bigtts";

/** Resolves the Doubao realtime speaker ID for the requested gender. */
export function doubaoSpeaker(voiceGender: VoiceGender): string {
  if (voiceGender === "male") {
    return process.env.DOUBAO_VOICE_MALE?.trim() || DEFAULT_MALE_SPEAKER;
  }
  return process.env.DOUBAO_VOICE?.trim() || DEFAULT_FEMALE_SPEAKER;
}

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
  TaskRequest = 200,
  EndAsr = 400
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

export type ParsedDoubaoFrame = {
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
  const apiKey = process.env.DOUBAO_API_KEY;
  const resourceId = process.env.DOUBAO_RESOURCE_ID ?? "volc.speech.dialog";

  if (apiKey) {
    return {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Connect-Id": randomUUID()
    };
  }

  const appId = requireEnv("DOUBAO_APP_ID");
  const appKey = requireEnv("DOUBAO_APP_KEY");
  const accessKey = requireEnv("DOUBAO_ACCESS_KEY");

  return {
    "X-Api-App-ID": appId,
    "X-Api-App-Key": appKey,
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
  return Buffer.from([0x11, (messageType << 4) | 0b0100, serialization << 4, 0x00]);
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
      bot_name: process.env.DOUBAO_BOT_NAME ?? "Max",
      system_role: process.env.DOUBAO_SYSTEM_ROLE ?? DEFAULT_AGENT_SYSTEM_PROMPT,
      extra: {
        input_mod: process.env.DOUBAO_INPUT_MODE ?? "keep_alive",
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
      speaker: doubaoSpeaker(config.voiceGender),
      audio_config: {
        channel: 1,
        format: "pcm_s16le",
        sample_rate: 24000
      }
    }
  };
}

export function parseDoubaoFrame(raw: RawData): ParsedDoubaoFrame {
  const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
  if (data.length < 12) throw new Error("Doubao frame is too short");

  const messageType = (data[1] >> 4) & 0b1111;
  if (
    ![MessageType.FullServerResponse, MessageType.AudioOnlyResponse, MessageType.ErrorInformation].includes(messageType)
  ) {
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

export function extractAsrText(payload: Record<string, unknown>) {
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
  let pendingAgentText = "";
  let receivedTtsAudio = false;
  let ttsFallbackTimer: NodeJS.Timeout | undefined;
  const pendingAudio: Buffer[] = [];

  function sendClient(payload: unknown) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  function clearTtsFallbackTimer() {
    if (ttsFallbackTimer) clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = undefined;
  }

  function flushPendingAgentText(useBrowserSpeech: boolean) {
    const text = pendingAgentText.trim();
    if (!text) return;
    sendClient({ type: "transcript", speaker: "agent", text, final: useBrowserSpeech });
    pendingAgentText = "";
  }

  function armTtsFallbackTimer() {
    clearTtsFallbackTimer();
    ttsFallbackTimer = setTimeout(() => {
      if (!receivedTtsAudio) {
        flushPendingAgentText(true);
        sendClient({
          type: "status",
          state: "ready",
          detail: "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
        });
      }
      receivedTtsAudio = false;
      ttsFallbackTimer = undefined;
    }, 1800);
  }

  function connectUpstream(config: DoubaoSessionConfig) {
    const url = process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    upstream = new WebSocket(url, { headers: buildDoubaoHeaders() });

    upstream.on("open", () => {
      upstream?.send(buildFullClientRequest(EventSend.StartConnection));
      sendClient({ type: "status", state: "connecting", detail: "豆包语音连接已打开" });
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
          sendClient({ type: "status", state: "ready", detail: "豆包实时语音已连接" });
          while (pendingAudio.length) {
            upstream?.send(buildAudioRequest(sessionId, pendingAudio.shift()!));
          }
          return;
        }

        if (frame.event === EventReceive.TtsResponse) {
          receivedTtsAudio = true;
          clearTtsFallbackTimer();
          sendClient({ type: "status", state: "speaking", detail: "已收到豆包语音音频" });
          if (client.readyState === client.OPEN) client.send(frame.payload, { binary: true });
          return;
        }

        const payload = parseJsonPayload(frame);
        if (frame.event === EventReceive.AsrInfo) {
          sendClient({ type: "status", state: "hearing", detail: "豆包检测到骑手语音" });
          return;
        }

        if (frame.event === EventReceive.AsrResponse) {
          const text = extractAsrText(payload);
          if (text) {
            sendClient({ type: "status", state: "asr", detail: `豆包听到：${text}` });
            sendClient({ type: "transcript", speaker: "rider", text, final: false });
          }
          return;
        }

        if (frame.event === EventReceive.ChatResponse) {
          const text = String(payload.content ?? "");
          if (text) {
            pendingAgentText += text;
            sendClient({ type: "status", state: "thinking", detail: "豆包已生成回复文本" });
          }
          return;
        }

        if (frame.event === EventReceive.ChatEnded) {
          if (pendingAgentText && receivedTtsAudio) {
            flushPendingAgentText(false);
          } else if (pendingAgentText) {
            armTtsFallbackTimer();
          }
          sendClient({ type: "status", state: "ready", detail: "豆包回复文本已完成" });
          return;
        }

        if (frame.event === EventReceive.TtsEnded) {
          clearTtsFallbackTimer();
          if (pendingAgentText && !receivedTtsAudio) {
            flushPendingAgentText(true);
            sendClient({
              type: "status",
              state: "ready",
              detail: "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
            });
          } else {
            sendClient({ type: "status", state: "ready", detail: "豆包回复已完成" });
          }
          receivedTtsAudio = false;
          return;
        }

        if (frame.event === EventReceive.AsrEnded) {
          sendClient({ type: "status", state: "ready", detail: "豆包回复已完成" });
          return;
        }

        if (
          frame.event === EventReceive.ConnectionFailed ||
          frame.event === EventReceive.SessionFailed ||
          frame.event === EventReceive.DialogCommonError
        ) {
          sendClient({ type: "error", message: String(payload.error ?? payload.message ?? "豆包语音会话失败") });
          return;
        }

        if (frame.event === EventReceive.Usage) {
          sendClient({ type: "status", state: "usage", detail: "已收到豆包用量事件" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "收到无效豆包载荷";
        sendClient({ type: "status", state: "doubao", detail: message });
      }
    });

    upstream.on("close", () => {
      sessionReady = false;
      clearTtsFallbackTimer();
      sendClient({ type: "status", state: "closed", detail: "豆包实时代理已断开" });
    });

    upstream.on("unexpected-response", (_request, response) => {
      sendClient({
        type: "error",
        message: `豆包语音握手失败，HTTP ${response.statusCode}。请检查 speech-dialog App ID、Access Token、Resource ID 和权限。`
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
        connectUpstream({
          sampleRate: event.sampleRate,
          channels: event.channels,
          voiceGender: event.voiceGender ?? "female"
        });
      }
    },
    async startAudio() {
      sendClient({ type: "status", state: "listening", detail: "正在通过豆包实时语音收听" });
    },
    async sendAudio(chunk: Buffer) {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        if (sessionReady) upstream.send(buildAudioRequest(sessionId, chunk));
        else pendingAudio.push(chunk);
      }
    },
    async stopAudio() {
      if (upstream?.readyState === WebSocket.OPEN && sessionReady) {
        upstream.send(buildFullClientRequest(EventSend.EndAsr, sessionId));
      }
      sendClient({ type: "status", state: "ready", detail: "麦克风已静音" });
    },
    async close() {
      clearTtsFallbackTimer();
      if (upstream?.readyState === WebSocket.OPEN) {
        if (sessionReady) upstream.send(buildFullClientRequest(EventSend.FinishSession, sessionId));
        upstream.send(buildFullClientRequest(EventSend.FinishConnection));
      }
      upstream?.close();
    }
  };
}
