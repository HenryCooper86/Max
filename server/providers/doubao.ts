import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { AgentProvider, SessionStartEvent, VoiceGender } from "./types";
import { DOUBAO_CAPABILITIES } from "../../shared/agent";
import { fetchRiderWeather } from "../weather";
import {
  buildRideContextSummary,
  describeRideMode,
  rideModeFromScenario,
  scenarioLabel,
  type DemoScenario,
  type RideContext
} from "../../shared/ride";
import {
  buildIntentGuidancePrompt,
  buildPersonalityPrompt,
  buildSafetyPrompt,
  buildSessionMemoryPrompt,
  createSessionMemory,
  updateSessionMemory,
  type SessionMemory
} from "../../shared/session";

// The "Max" persona prompt. Overridable per deployment with DOUBAO_SYSTEM_ROLE;
// keep it consistent with the DOUBAO_SYSTEM_ROLE default in .env.example.
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  "你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认使用中文回答；如果骑手明确使用英文，可以用英文回答。只允许中文和英文两种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文和 English。帮助骑手处理摩托车相关问题、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。骑行中遇到危险或分心请求时，给出更安全的替代方案。声音由当前会话音色决定。";

type DoubaoSessionConfig = {
  sampleRate: number;
  channels: number;
  voiceGender: VoiceGender;
  // Persona prompt, possibly augmented with live weather for this session.
  systemRole: string;
};

// Default realtime-dialogue speakers from the Doubao S2S-Omni 音色列表 (jupiter family).
// Override per deployment with DOUBAO_VOICE / DOUBAO_VOICE_MALE.
const DEFAULT_FEMALE_SPEAKER = "zh_female_vv_jupiter_bigtts";
const DEFAULT_MALE_SPEAKER = "zh_male_yunzhou_jupiter_bigtts";
const UNSUPPORTED_REALTIME_SPEAKER_REPLACEMENTS: Record<string, string> = {
  zh_male_vv_jupiter_bigtts: DEFAULT_MALE_SPEAKER
};

/** Resolves the Doubao realtime speaker ID for the requested gender. */
export function doubaoSpeaker(voiceGender: VoiceGender): string {
  const configuredSpeaker =
    voiceGender === "male" ? process.env.DOUBAO_VOICE_MALE?.trim() : process.env.DOUBAO_VOICE?.trim();
  const speaker = configuredSpeaker || (voiceGender === "male" ? DEFAULT_MALE_SPEAKER : DEFAULT_FEMALE_SPEAKER);
  return UNSUPPORTED_REALTIME_SPEAKER_REPLACEMENTS[speaker] ?? speaker;
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

export const enum EventSend {
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

export function buildFullClientRequest(event: EventSend, sessionId?: string, metadata: unknown = {}) {
  const meta = Buffer.from(JSON.stringify(metadata));
  const parts = [buildHeader(MessageType.FullClientRequest, SerializationMethod.Json), uint32(event)];

  if (sessionId) {
    const session = Buffer.from(sessionId);
    parts.push(uint32(session.length), session);
  }

  parts.push(uint32(meta.length), meta);
  return Buffer.concat(parts);
}

export function buildAudioRequest(sessionId: string, audio: Buffer) {
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
      system_role: config.systemRole,
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
  if (data.length < payloadLengthStart + 4) throw new Error("Doubao frame payload length is missing");
  const payloadLength = data.readUInt32BE(payloadLengthStart);
  const payloadStart = payloadLengthStart + 4;
  const payloadEnd = payloadStart + payloadLength;
  if (data.length < payloadEnd) throw new Error("Doubao frame payload is incomplete");

  return {
    event,
    sessionId: data.subarray(sessionStart, sessionEnd).toString(),
    serialization,
    payload: data.subarray(payloadStart, payloadEnd)
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
  let rideContext: RideContext = { mode: "ride", scenario: "commute" };
  let memory: SessionMemory = createSessionMemory("ride");
  let audioStartedAt = 0;
  let asrStartedAt = 0;
  let chatStartedAt = 0;
  let firstAudioAt = 0;
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

  function emitMemory() {
    sendClient({ type: "session.memory", ...memory });
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

  function emitRideContext() {
    const intelligence = describeRideMode(rideContext.mode);
    sendClient({
      type: "ride.context",
      mode: rideContext.mode,
      modeLabel: intelligence.modeLabel,
      scenario: rideContext.scenario,
      scenarioLabel: scenarioLabel(rideContext.scenario),
      speedKmh: rideContext.speedKmh,
      routePhase: rideContext.routePhase,
      network: rideContext.network,
      batteryPct: rideContext.batteryPct,
      hazardLevel: intelligence.hazardLevel,
      glanceableFocus: intelligence.glanceableFocus
    });
  }

  function emitTelemetry(totalEnd = Date.now()) {
    const asrMs = audioStartedAt && asrStartedAt ? asrStartedAt - audioStartedAt : 0;
    const thinkMs = asrStartedAt && chatStartedAt ? chatStartedAt - asrStartedAt : 0;
    const firstAudioMs = chatStartedAt && firstAudioAt ? firstAudioAt - chatStartedAt : 0;
    const totalMs = audioStartedAt ? totalEnd - audioStartedAt : 0;
    if (asrMs || thinkMs || firstAudioMs || totalMs) {
      sendClient({ type: "telemetry", asrMs, thinkMs, firstAudioMs, totalMs });
    }
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
          sendClient({ type: "session.started", provider: "doubao", mode: "live", capabilities: DOUBAO_CAPABILITIES });
          emitRideContext();
          emitMemory();
          sendClient({ type: "status", state: "ready", detail: "豆包实时语音已连接" });
          while (pendingAudio.length) {
            upstream?.send(buildAudioRequest(sessionId, pendingAudio.shift()!));
          }
          return;
        }

        if (frame.event === EventReceive.TtsResponse) {
          if (!firstAudioAt) {
            firstAudioAt = Date.now();
            if (chatStartedAt) sendClient({ type: "metric", latencyMs: firstAudioAt - chatStartedAt });
          }
          receivedTtsAudio = true;
          clearTtsFallbackTimer();
          sendClient({ type: "status", state: "speaking", detail: "已收到豆包语音音频" });
          if (client.readyState === client.OPEN) client.send(frame.payload, { binary: true });
          return;
        }

        const payload = parseJsonPayload(frame);
        if (frame.event === EventReceive.AsrInfo) {
          if (!asrStartedAt) asrStartedAt = Date.now();
          sendClient({ type: "status", state: "hearing", detail: "豆包检测到骑手语音" });
          return;
        }

        if (frame.event === EventReceive.AsrResponse) {
          const text = extractAsrText(payload);
          if (text) {
            memory = updateSessionMemory(memory, text, rideContext.mode);
            sendClient({ type: "status", state: "asr", detail: `豆包听到：${text}` });
            sendClient({ type: "transcript", speaker: "rider", text, final: false });
            emitMemory();
          }
          return;
        }

        if (frame.event === EventReceive.ChatResponse) {
          if (!chatStartedAt) chatStartedAt = Date.now();
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
          emitTelemetry();
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
          sendClient({
            type: "status",
            state: "degraded",
            detail: "豆包连接异常，已保留浏览器 TTS 备用通道"
          });
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
      if (pendingAgentText) flushPendingAgentText(true);
      sendClient({ type: "status", state: "closed", detail: "豆包实时代理已断开" });
    });

    upstream.on("unexpected-response", (_request, response) => {
      sendClient({
        type: "error",
        message: `豆包语音握手失败，HTTP ${response.statusCode}。请检查 speech-dialog App ID、Access Token、Resource ID 和权限。`
      });
    });

    upstream.on("error", (error) => {
      sendClient({ type: "status", state: "degraded", detail: "豆包音频不可用，浏览器 TTS 备用通道待命" });
      sendClient({ type: "error", message: error.message });
    });
  }

  return {
    async start(event: SessionStartEvent) {
      if (started) return;
      started = true;

      let systemRole = process.env.DOUBAO_SYSTEM_ROLE ?? DEFAULT_AGENT_SYSTEM_PROMPT;
      const scenario: DemoScenario = event.scenario ?? "commute";
      rideContext = {
        mode: rideModeFromScenario(event.rideMode, scenario),
        scenario,
        network: "online"
      };
      memory = createSessionMemory(rideContext.mode);
      systemRole +=
        `\n\n[骑行上下文] ${buildRideContextSummary(rideContext)}。` +
        `\n[声音设置] 当前会话使用${event.voiceGender === "male" ? "男声" : "女声"}音色。不要在文字中声称自己是其他性别音色。` +
        `你必须根据模式调整回答长度和安全策略；紧急模式优先生命安全，导航模式只给下一步。\n${buildSafetyPrompt(
          rideContext,
          memory
        )}\n${buildIntentGuidancePrompt(memory.lastIntent)}\n${buildPersonalityPrompt(
          event.voicePersonality ?? "concise"
        )}\n[短期记忆] ${buildSessionMemoryPrompt(memory)}。`;
      emitRideContext();
      emitMemory();

      // Best-effort: fold live weather for the rider's location into the agent
      // context so weather questions are answered with real data. A failure
      // here never blocks the session — the agent just answers generically.
      if (typeof event.lat === "number" && typeof event.lon === "number") {
        try {
          const weather = await fetchRiderWeather(event.lat, event.lon);
          systemRole +=
            `\n\n[实时骑行情报] 骑手当前位置${weather.summary}` +
            `${weather.riderAdvice}当骑手询问天气、风力或路况时，请基于这条真实数据简短回答。`;
          sendClient({
            type: "weather",
            description: weather.description,
            temperatureC: weather.temperatureC,
            windSpeedKmh: weather.windSpeedKmh,
            isDay: weather.isDay,
            riskLevel: weather.riskLevel,
            riderAdvice: weather.riderAdvice
          });
          sendClient({
            type: "status",
            state: "ready",
            detail: `已接入实时天气：${weather.description} ${weather.temperatureC}°C`
          });
        } catch {
          sendClient({ type: "status", state: "ready", detail: "实时天气暂不可用，使用通用回答" });
        }
      }

      connectUpstream({
        sampleRate: event.sampleRate,
        channels: event.channels,
        voiceGender: event.voiceGender ?? "female",
        systemRole
      });
    },
    async startAudio() {
      audioStartedAt = Date.now();
      asrStartedAt = 0;
      chatStartedAt = 0;
      firstAudioAt = 0;
      emitRideContext();
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
