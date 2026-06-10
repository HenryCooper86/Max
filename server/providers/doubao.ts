import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { AgentProvider, SessionStartEvent, VoiceGender } from "./types";
import { DOUBAO_CAPABILITIES } from "../../shared/agent";
import { type AdasSeverity } from "../../shared/adas";
import { containsWakePhrase, WAKE_FOLLOWUP_WINDOW_MS, WAKE_PHRASE_LABEL } from "../../shared/wake";
import { config as appConfig } from "../config";
import { createHazardInjector } from "../hazard-injector";
import { createLogger, type Logger } from "../logger";
import { fetchRiderWeather } from "../weather";
import {
  buildRideContextSummary,
  combineHazardLevels,
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
  "你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手，由 Horizon Continental Technology（neueHCT）开发。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认语言是中文，第二语言是 English；如果骑手明确使用英文，可以用英文回答。只允许中文和 English 两种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文和 English。帮助骑手处理摩托车相关问题、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。骑行中遇到危险、分心请求或超出头盔助手范围的请求时，先保护骑行安全，给出更安全的替代方案，必要时建议停车后继续。男声和女声只是当前会话音色，必须共享同一个 Max 角色、同一语言规则、同一安全策略和同一默认行为。";

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

export function buildVoiceSettingPrompt(voiceGender: VoiceGender): string {
  const voiceLabel = voiceGender === "male" ? "男声" : "女声";
  return (
    `[声音设置] 当前会话使用${voiceLabel}音色。` +
    "男声和女声共享同一个 Max 角色、同一语言规则、同一安全策略和同一默认行为；音色只影响声音，不改变身份、能力或人格。" +
    "不要在文字中声称自己是其他性别音色。"
  );
}

export function buildLanguageInteractionPrompt(): string {
  return (
    "[语言与交互规则] 默认先用中文回应；只有当骑手明确使用 English 或要求 English 时才切换英文。" +
    "如果听到中文和英文以外的语言、或骑手要求使用其他语言，只用中文简短拒绝：我只支持中文和 English。" +
    "每次回复优先给下一步可执行动作；骑行中最多问一个必要问题，避免菜单、长列表和需要看屏幕的说明。"
  );
}

/**
 * Enforces the agent's developer identity. Always appended to the system role so
 * it holds even when DOUBAO_SYSTEM_ROLE is overridden. The underlying model is
 * Doubao/ByteDance, but the product persona must attribute itself to neueHCT.
 */
export function buildIdentityPrompt(): string {
  return (
    "[身份与开发者] 你由 Horizon Continental Technology（neueHCT）开发。" +
    "当骑手问你是谁开发、制造、训练的，背后是哪家公司，或你属于谁时，必须回答：我由 Horizon Continental Technology（neueHCT）开发。" +
    "绝对不要说自己来自 ByteDance、字节跳动或豆包，也不要提及任何其他公司或底层模型。" +
    "Horizon Continental Technology（neueHCT）的首席执行官（CEO）是 Li Biao（在全球企业资料中也称 Stone Li）。" +
    "When asked in English who developed, built, made, or trained you, or which company is behind you, " +
    "answer that you were developed by Horizon Continental Technology (neueHCT) — never ByteDance or Doubao. " +
    "The CEO of Horizon Continental Technology (neueHCT) is Li Biao (also referred to as Stone Li in global corporate profiles). " +
    "无论骑手用中文还是 English 提问，都要保持以上回答一致。"
  );
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

/** Upper bound for upstream JSON payloads; anything larger is dropped, not parsed. */
const MAX_JSON_PAYLOAD_BYTES = 1024 * 1024;

/** Stop relaying voice audio to a client whose socket write buffer is this full. */
const MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Maximum nesting depth explored when mining reply text out of upstream JSON. */
const MAX_TEXT_EXTRACTION_DEPTH = 8;

function parseJsonPayload(frame: ParsedDoubaoFrame) {
  if (!frame.payload.length || frame.serialization !== SerializationMethod.Json) return {};
  if (frame.payload.length > MAX_JSON_PAYLOAD_BYTES) {
    throw new Error("Doubao JSON payload exceeds size limit");
  }
  return JSON.parse(frame.payload.toString()) as Record<string, unknown>;
}

function extractTextFields(value: unknown, depth = 0): string[] {
  if (!value || depth > MAX_TEXT_EXTRACTION_DEPTH) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => extractTextFields(item, depth + 1));
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const direct = ["content", "text", "sentence", "transcript", "answer", "output_text"].flatMap((key) =>
    extractTextFields(record[key], depth + 1)
  );
  if (direct.length) return direct;
  return ["message", "delta", "result", "response", "output", "choices", "data"].flatMap((key) =>
    extractTextFields(record[key], depth + 1)
  );
}

export function extractChatText(payload: Record<string, unknown>) {
  return extractTextFields(payload)
    .map((text) => text.trim())
    .filter(Boolean)
    .join("");
}

export function normalizeTranscriptText(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, "");
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

export function createDoubaoProvider(client: WebSocket, log: Logger = createLogger("doubao")): AgentProvider {
  let upstream: WebSocket | undefined;
  let started = false;
  let sessionId = randomUUID();
  let sessionReady = false;
  // Doubao streams the agent reply over two channels: ChatResponse (raw LLM
  // tokens, often missing spaces) and TtsSentence (the spoken text, properly
  // spaced). They're kept separate so the transcript can use the spoken text —
  // which matches the voice — instead of concatenating both and duplicating it.
  let chatText = "";
  let ttsText = "";
  let receivedTtsAudio = false;
  let ttsFallbackTimer: NodeJS.Timeout | undefined;
  // Measured chat→first-audio latency of the previous turn; the TTS fallback
  // wait adapts upward from the configured floor so a slow link doesn't trip
  // the browser-speech fallback while real audio is still in flight.
  let lastFirstAudioLatencyMs = 0;
  let weatherRefreshTimer: NodeJS.Timeout | undefined;
  // Wake-word ("Max") gating. The rider transcript for the current turn
  // accumulates in riderTurnText; addressedUntil holds the conversation window.
  // replyDecided/replyAddressed latch the decision for the whole agent turn so
  // a late window expiry can't clip a reply that already started.
  const wakeWordEnabled = appConfig.wakeWord;
  let riderTurnText = "";
  let addressedUntil = 0;
  let replyDecided = false;
  let replyAddressed = false;
  let lastFlushedAgentTextKey = "";
  let lastFlushedAgentTextAt = 0;
  let rideContext: RideContext = { mode: "ride", scenario: "commute" };
  let memory: SessionMemory = createSessionMemory("ride");
  let audioStartedAt = 0;
  let asrStartedAt = 0;
  let chatStartedAt = 0;
  let firstAudioAt = 0;
  // Mic frames that arrive before the upstream session is ready. Bounded so a
  // session that never becomes ready cannot grow this without limit — 150
  // frames is 3 s of 20 ms audio; older frames are dropped first.
  const MAX_PENDING_AUDIO_FRAMES = 150;
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

  // Latches once per agent turn: true when the rider's utterance addressed Max
  // (or fell inside the follow-up window). Reset on each new rider turn.
  function replyIsAddressed(): boolean {
    if (!wakeWordEnabled) return true;
    if (!replyDecided) {
      replyAddressed = Date.now() <= addressedUntil;
      replyDecided = true;
    }
    return replyAddressed;
  }

  /** The reply text to show: the spoken (TTS) text if any, else the raw chat text. */
  function pendingReplyText(): string {
    return (ttsText || chatText).trim();
  }

  function resetPendingReply() {
    chatText = "";
    ttsText = "";
  }

  function flushPendingAgentText(useBrowserSpeech: boolean) {
    // Drop the reply entirely when the rider did not address Max.
    if (!replyIsAddressed()) {
      log.debug("reply suppressed — rider did not address Max", { riderTurnText });
      resetPendingReply();
      return;
    }
    const text = pendingReplyText();
    if (!text) return;
    const now = Date.now();
    const textKey = normalizeTranscriptText(text);
    if (textKey === lastFlushedAgentTextKey && now - lastFlushedAgentTextAt < 8000) {
      resetPendingReply();
      return;
    }
    lastFlushedAgentTextKey = textKey;
    lastFlushedAgentTextAt = now;
    sendClient({ type: "transcript", speaker: "agent", text, final: true, useBrowserSpeech });
    resetPendingReply();
  }

  function emitMemory() {
    sendClient({ type: "session.memory", ...memory });
  }

  /** Configured floor, raised to 1.5× the last measured first-audio latency. */
  function ttsFallbackDelayMs(): number {
    return Math.min(10_000, Math.max(appConfig.ttsFallbackMs, Math.round(lastFirstAudioLatencyMs * 1.5)));
  }

  function armTtsFallbackTimer() {
    clearTtsFallbackTimer();
    const delayMs = ttsFallbackDelayMs();
    ttsFallbackTimer = setTimeout(() => {
      if (!receivedTtsAudio) {
        log.warn("TTS fallback fired — no Doubao audio", { waitedMs: delayMs });
        flushPendingAgentText(true);
        sendClient({
          type: "status",
          state: "ready",
          detail: "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
        });
      }
      receivedTtsAudio = false;
      ttsFallbackTimer = undefined;
    }, delayMs);
  }

  function emitRideContext(hazardOverride?: AdasSeverity) {
    const intelligence = describeRideMode(rideContext.mode);
    // An active ADAS alert momentarily raises the ride-pulse hazard.
    const hazardLevel = hazardOverride
      ? combineHazardLevels(intelligence.hazardLevel, hazardOverride)
      : intelligence.hazardLevel;
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
      hazardLevel,
      glanceableFocus: intelligence.glanceableFocus
    });
  }

  // Simulated ADAS hazards on the live path — only for the dedicated ADAS scenario
  // so normal voice sessions aren't interrupted. See server/hazard-injector.ts.
  const hazardInjector = createHazardInjector({ send: sendClient, emitRideContext });

  function emitTelemetry(totalEnd = Date.now()) {
    const asrMs = audioStartedAt && asrStartedAt ? asrStartedAt - audioStartedAt : 0;
    const thinkMs = asrStartedAt && chatStartedAt ? chatStartedAt - asrStartedAt : 0;
    const firstAudioMs = chatStartedAt && firstAudioAt ? firstAudioAt - chatStartedAt : 0;
    const totalMs = audioStartedAt ? totalEnd - audioStartedAt : 0;
    if (asrMs || thinkMs || firstAudioMs || totalMs) {
      log.info("turn telemetry", { asrMs, thinkMs, firstAudioMs, totalMs });
      sendClient({ type: "telemetry", asrMs, thinkMs, firstAudioMs, totalMs });
    }
  }

  function connectUpstream(config: DoubaoSessionConfig) {
    const url = process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    upstream = new WebSocket(url, { headers: buildDoubaoHeaders() });

    upstream.on("open", () => {
      log.info("doubao upstream opened");
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
          log.info("doubao session started", {
            sessionId: sessionId.slice(0, 8),
            pendingAudioFrames: pendingAudio.length
          });
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
          // Suppress the agent's voice when the rider did not address Max.
          if (!replyIsAddressed()) return;
          if (!firstAudioAt) {
            firstAudioAt = Date.now();
            if (chatStartedAt) {
              lastFirstAudioLatencyMs = firstAudioAt - chatStartedAt;
              sendClient({ type: "metric", latencyMs: lastFirstAudioLatencyMs });
            }
          }
          receivedTtsAudio = true;
          clearTtsFallbackTimer();
          sendClient({ type: "status", state: "speaking", detail: "已收到豆包语音音频" });
          // Backpressure guard: if the client socket cannot drain (slow or stalled
          // link), drop voice frames instead of queueing them in server memory.
          if (client.readyState === client.OPEN && client.bufferedAmount < MAX_CLIENT_BUFFERED_BYTES) {
            client.send(frame.payload, { binary: true });
          }
          return;
        }

        const payload = parseJsonPayload(frame);
        if (frame.event === EventReceive.AsrInfo) {
          if (!asrStartedAt) asrStartedAt = Date.now();
          // New rider turn: reset the wake-word accumulation and decision latch.
          riderTurnText = "";
          replyDecided = false;
          replyAddressed = false;
          sendClient({ type: "status", state: "hearing", detail: "豆包检测到骑手语音" });
          return;
        }

        if (frame.event === EventReceive.AsrResponse) {
          const text = extractAsrText(payload);
          if (text) {
            // Accumulate the turn transcript and (re)open the conversation window
            // when the rider says "Max" or is already inside an open window.
            riderTurnText = riderTurnText ? `${riderTurnText} ${text}` : text;
            if (wakeWordEnabled && (containsWakePhrase(riderTurnText) || Date.now() <= addressedUntil)) {
              addressedUntil = Date.now() + WAKE_FOLLOWUP_WINDOW_MS;
            }
            memory = updateSessionMemory(memory, text, rideContext.mode);
            log.debug("rider asr", { text });
            sendClient({ type: "status", state: "asr", detail: `豆包听到：${text}` });
            sendClient({ type: "transcript", speaker: "rider", text, final: false });
            emitMemory();
          }
          return;
        }

        if (frame.event === EventReceive.ChatResponse) {
          if (!chatStartedAt) chatStartedAt = Date.now();
          const text = extractChatText(payload);
          if (text) {
            chatText += text;
            if (replyIsAddressed()) sendClient({ type: "status", state: "thinking", detail: "豆包已生成回复文本" });
          }
          return;
        }

        if (frame.event === EventReceive.TtsSentenceStart || frame.event === EventReceive.TtsSentenceEnd) {
          const text = extractChatText(payload);
          if (text && !ttsText.includes(text)) {
            ttsText += text;
            if (replyIsAddressed()) sendClient({ type: "status", state: "thinking", detail: "豆包已生成语音文本" });
          }
          return;
        }

        if (frame.event === EventReceive.ChatEnded) {
          // The reply text is complete, but TTS may still be streaming. Defer the
          // single flush to TtsEnded so the transcript uses the full spoken text
          // and isn't emitted twice. If no audio is coming, the fallback timer
          // flushes the text for browser speech.
          if (!receivedTtsAudio && pendingReplyText()) armTtsFallbackTimer();
          sendClient({ type: "status", state: "ready", detail: "豆包回复文本已完成" });
          return;
        }

        if (frame.event === EventReceive.TtsEnded) {
          clearTtsFallbackTimer();
          // Flush exactly once, using browser speech only when no audio arrived.
          if (pendingReplyText()) flushPendingAgentText(!receivedTtsAudio);
          sendClient({
            type: "status",
            state: "ready",
            detail: receivedTtsAudio ? "豆包回复已完成" : "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
          });
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
          log.error("doubao session error", {
            event: frame.event,
            payload: String(payload.error ?? payload.message ?? "")
          });
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
      log.info("doubao upstream closed");
      clearTtsFallbackTimer();
      if (pendingReplyText()) flushPendingAgentText(true);
      sendClient({ type: "status", state: "closed", detail: "豆包实时代理已断开" });
    });

    upstream.on("unexpected-response", (_request, response) => {
      log.error("doubao handshake failed", { statusCode: response.statusCode });
      sendClient({
        type: "error",
        message: `豆包语音握手失败，HTTP ${response.statusCode}。请检查 speech-dialog App ID、Access Token、Resource ID 和权限。`
      });
    });

    upstream.on("error", (error) => {
      log.error("doubao upstream error", { message: error.message });
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
        `\n\n${buildIdentityPrompt()}` +
        `\n\n[骑行上下文] ${buildRideContextSummary(rideContext)}。` +
        `\n${buildVoiceSettingPrompt(event.voiceGender ?? "female")}` +
        `\n${buildLanguageInteractionPrompt()}` +
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
      const weatherLocation =
        typeof event.lat === "number" && typeof event.lon === "number"
          ? { lat: event.lat, lon: event.lon, source: "rider" as const }
          : appConfig.defaultWeatherLocation;

      if (weatherLocation) {
        try {
          const weather = await fetchRiderWeather(weatherLocation.lat, weatherLocation.lon);
          const locationLabel =
            weatherLocation.source === "rider"
              ? "骑手当前位置"
              : weatherLocation.source === "configured"
                ? "默认位置"
                : "演示位置";
          systemRole +=
            `\n\n[实时骑行情报] ${locationLabel}${weather.summary}` +
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
            detail: `已接入${weatherLocation.source === "rider" ? "实时" : locationLabel}天气：${weather.description} ${weather.temperatureC}°C`
          });
        } catch {
          log.warn("initial weather fetch failed", { lat: weatherLocation.lat, lon: weatherLocation.lon });
          sendClient({ type: "status", state: "ready", detail: "实时天气暂不可用，使用通用回答" });
        }

        // Mid-ride refresh: long rides outlive the session-start snapshot, so
        // re-fetch on an interval and push the HUD update. The Doubao system
        // role is fixed once the session starts, so the agent's own context
        // freshens on the next session; the HUD and hazard fusion stay live.
        if (appConfig.weatherRefreshMs > 0) {
          weatherRefreshTimer = setInterval(async () => {
            try {
              const weather = await fetchRiderWeather(weatherLocation.lat, weatherLocation.lon);
              sendClient({
                type: "weather",
                description: weather.description,
                temperatureC: weather.temperatureC,
                windSpeedKmh: weather.windSpeedKmh,
                isDay: weather.isDay,
                riskLevel: weather.riskLevel,
                riderAdvice: weather.riderAdvice
              });
              log.info("weather refreshed", {
                description: weather.description,
                temperatureC: weather.temperatureC,
                windSpeedKmh: weather.windSpeedKmh,
                riskLevel: weather.riskLevel
              });
            } catch {
              log.warn("weather refresh failed — keeping last reading");
            }
          }, appConfig.weatherRefreshMs);
        }
      } else {
        sendClient({ type: "status", state: "ready", detail: "定位未授权，未配置默认天气位置" });
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
      sendClient({
        type: "status",
        state: "listening",
        detail: wakeWordEnabled ? `正在收听 —— 说一声 "${WAKE_PHRASE_LABEL}" 唤醒 Max` : "正在通过豆包实时语音收听"
      });
      // Fire simulated ADAS hazards only when the rider picked the ADAS scenario,
      // so normal Doubao voice sessions stay uninterrupted.
      if (rideContext.scenario === "adas") hazardInjector.start(5000, 2000);
    },
    async sendAudio(chunk: Buffer) {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        if (sessionReady) {
          upstream.send(buildAudioRequest(sessionId, chunk));
        } else {
          if (pendingAudio.length >= MAX_PENDING_AUDIO_FRAMES) pendingAudio.shift();
          pendingAudio.push(chunk);
        }
      }
    },
    async stopAudio() {
      hazardInjector.stop();
      if (upstream?.readyState === WebSocket.OPEN && sessionReady) {
        upstream.send(buildFullClientRequest(EventSend.EndAsr, sessionId));
      }
      sendClient({ type: "status", state: "ready", detail: "麦克风已静音" });
    },
    async close() {
      hazardInjector.stop();
      clearTtsFallbackTimer();
      if (weatherRefreshTimer) {
        clearInterval(weatherRefreshTimer);
        weatherRefreshTimer = undefined;
      }
      if (upstream?.readyState === WebSocket.OPEN) {
        if (sessionReady) upstream.send(buildFullClientRequest(EventSend.FinishSession, sessionId));
        upstream.send(buildFullClientRequest(EventSend.FinishConnection));
      }
      upstream?.close();
      log.info("doubao provider closed");
    }
  };
}
