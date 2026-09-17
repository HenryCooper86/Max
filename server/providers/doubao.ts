import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import { RiderLocationContext, asksCurrentLocation } from "../rider-location";
import { synthesizeMaxSpeech } from "../max-speech";
import type { AgentProvider, ProviderSessionContext, ProviderTelemetry, SessionStartEvent, VoiceGender } from "./types";
import { DOUBAO_CAPABILITIES } from "../../shared/agent";
import { type AdasSeverity } from "../../shared/adas";
import {
  containsWakePhrase,
  WAKE_FOLLOWUP_MAX_CHAIN_MS,
  WAKE_FOLLOWUP_WINDOW_MS,
  WAKE_PHRASE_LABEL
} from "../../shared/wake";
import { config as appConfig } from "../config";
import {
  DEVICE_ACTION_TIERS,
  DeviceActivityContext,
  PendingDeviceCommands,
  deviceSuccessSpeech,
  reconcileDeviceResult,
  type DeviceActionName,
  type DeviceActionStatus
} from "../device-actions";
import { createHazardInjector } from "../hazard-injector";
import { createLogger, type Logger } from "../logger";
import { metrics } from "../metrics";
import { createSpeaker, createSynthesizer, type SpeakOptions } from "../speech";
import { createTranscriptDelivery, transcriptEvent, type TranscriptDelivery } from "../transcript-events";
import { buildChatCompletionsEndpoint, selectVisionProvider } from "../vision";
import { createFrameAssembler } from "../vision-frames";
import { createVisionGovernor } from "../vision-governor";
import { fetchRiderWeather } from "../weather";
import {
  approxDistanceKm,
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
  restoreSessionMemory,
  updateSessionMemory,
  type SessionMemory
} from "../../shared/session";
import { buildPreviousConversationPrompt } from "../user-memory";
import { navFabricationGuard } from "../nav-fabrication-guard";
import { NAV_FABRICATION_CLEAR_DETAIL } from "../../shared/nav-fabrication";

// The "Max" persona prompt. Overridable per deployment with DOUBAO_SYSTEM_ROLE;
// keep it consistent with the DOUBAO_SYSTEM_ROLE default in .env.example.
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  "你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手，由 Horizon Continental Technology（neueHCT）开发。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认语言是中文，第二语言是 English；如果骑手明确使用英文，可以用英文回答。只允许中文和 English 两种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文和 English。帮助骑手理解摩托车、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。拍照、录像、导航、开关手电筒、调整音量、播放音乐、拨号、发短信等都是语音免手操作，本来就是为骑行中使用而设计的，属于安全的免手功能；骑手在骑行中要求这些操作时要直接执行，不要当作分心请求拒绝，也不要让骑手停车再做。只有当请求真正危险、需要骑手用手长时间盯着屏幕操作、或超出头盔助手范围时，才先保护骑行安全并给出更安全的替代方案。男声和女声只是当前会话音色，必须共享同一个 Max 角色、同一语言规则、同一安全策略和同一默认行为。";

type DoubaoSessionConfig = {
  sampleRate: number;
  channels: number;
  voiceGender: VoiceGender;
  // Persona prompt, possibly augmented with live weather for this session.
  systemRole: string;
  speakingStyle: string;
  dialogId?: string;
  dialogContext?: DoubaoDialogContextItem[];
  location?: { latitude: number; longitude: number };
};

type DoubaoDialogContextItem = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

// Passed to connectUpstream. The upstream handshake opens immediately while the
// live-weather fetch runs concurrently; StartSession then waits on the weather
// addendum so it still lands in the agent's context, but without serializing the
// two round-trips (which used to push the rider's first words past the buffer).
type ConnectConfig = {
  sampleRate: number;
  channels: number;
  voiceGender: VoiceGender;
  // Persona prompt without weather; the weather addendum is appended once resolved.
  baseSystemRole: string;
  speakingStyle: string;
  dialogContext: DoubaoDialogContextItem[];
  // Resolves to the weather addendum for the system prompt ("" when weather is
  // unavailable). Never rejects — the session must start regardless.
  weatherRolePromise: Promise<string>;
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

/** Declares the device actions the system can actually execute, and keeps every
 * other external action explicitly out of reach. The success-only rule is now
 * load-bearing: the relay dispatches real commands and corrects Max out loud
 * when one fails. */
export function buildToolGroundingPrompt(): string {
  return (
    "[真实能力边界] 你可以请求系统执行这些设备动作：开关手电筒、调整你自己的说话音量、" +
    "请求音乐播放控制（默认 QQ 音乐，也可手动选择 Apple Music 或本机音乐）、准备短信、拨打电话、语音导航（实时路线指引，仅汽车路线）、拍照和录像（录像无声音）、关机（10秒倒计时后干净地关闭头盔系统，期间说取消关机可以撤销）。" +
    "这些都是语音免手操作，本来就是为骑行中使用而设计的，属于安全的免手功能。骑手在骑行中要求拍照、录像、导航、手电筒、音量、音乐等操作时，必须直接执行，不要当作分心请求拒绝，也不要说不安全或让骑手停车再做；即使系统角色或其他指示提到分心或建议停车，这一条优先。" +
    "天气和骑行情报由系统注入，可以当作实时事实。" +
    "QQ 音乐在 Android 上可通过用户授权的媒体会话控制已有队列；iOS 和网页目前仅提供官网入口，不能控制 QQ 音乐播放。打开官网不代表播放成功。不支持搜索或点播指定 QQ 歌曲。必须等待设备结果再回答。" +
    "除此之外没有工具：没有实时交通、附近地点搜索、车辆控制或诊断、小队消息、其他第三方音乐应用。" +
    "拨号和短信必须由骑手在手机上确认，你只说正在准备，不要说已经拨通或已经发送。" +
    "任何动作只有在系统明确返回成功之后才可以说已完成；系统没有回应之前，不要描述结果。" +
    "导航路线、路名、转弯方向和距离只能来自系统导航提示，不要自己编造。骑手当前位置可来自系统的手机实时定位，无需启动导航；没有最新定位时如实说明，不得把默认或演示天气地点当作骑手位置。" +
    "骑手在录像或导航后说‘取消’、‘停一下’或 cancel it 时，系统会根据当前动作处理；你必须等待系统结果，不能自行声称已经停止。"
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
  UpdateConfig = 201,
  TaskRequest = 200,
  EndAsr = 400,
  ConversationTruncate = 513,
  ConversationDelete = 514
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
  /** Set only for ErrorInformation frames, which carry a code instead of an event. */
  errorCode?: number;
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

function envEnabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "off", "no"].includes(value);
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function doubaoInputMode(): "keep_alive" | "push_to_talk" {
  return process.env.DOUBAO_INPUT_MODE?.trim() === "push_to_talk" ? "push_to_talk" : "keep_alive";
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

export function buildDoubaoSessionConfig(config: DoubaoSessionConfig) {
  const inputMode = doubaoInputMode();
  return {
    dialog: {
      bot_name: process.env.DOUBAO_BOT_NAME ?? "Max",
      system_role: config.systemRole,
      speaking_style: config.speakingStyle,
      ...(config.dialogId ? { dialog_id: config.dialogId } : {}),
      ...(config.dialogContext?.length ? { dialog_context: config.dialogContext } : {}),
      ...(config.location ? { location: config.location } : {}),
      extra: {
        strict_audit: true,
        audit_response: process.env.DOUBAO_AUDIT_RESPONSE ?? "这个请求我不能帮助执行。请把注意力放在安全骑行上。",
        input_mod: inputMode,
        enable_loudness_norm: envEnabled("DOUBAO_LOUDNESS_NORMALIZATION", true),
        enable_conversation_truncate: true,
        model: process.env.DOUBAO_REALTIME_MODEL ?? "1.2.1.1"
      }
    },
    asr: {
      extra: {
        end_smooth_window_ms: boundedEnvInt("DOUBAO_VAD_END_MS", 900, 500, 50_000),
        enable_custom_vad: true,
        enable_asr_twopass: envEnabled("DOUBAO_ASR_TWOPASS", true),
        context: {
          hotwords: [{ word: "Max" }, { word: "马克斯" }, { word: "麦克斯" }]
        }
      },
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
        sample_rate: 24000,
        speech_rate: boundedEnvInt("DOUBAO_SPEECH_RATE", 8, -50, 100),
        loudness_rate: boundedEnvInt("DOUBAO_LOUDNESS_RATE", 10, -50, 100)
      }
    }
  };
}

export function parseDoubaoFrame(raw: RawData): ParsedDoubaoFrame {
  const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
  if (data.length < 12) throw new Error("Doubao frame is too short");

  const messageType = (data.readUInt8(1) >> 4) & 0b1111;
  if (
    ![MessageType.FullServerResponse, MessageType.AudioOnlyResponse, MessageType.ErrorInformation].includes(messageType)
  ) {
    throw new Error(`Unsupported Doubao message type ${messageType}`);
  }

  const serialization = (data.readUInt8(2) >> 4) & 0b1111;
  // The relay requests no compression; a compressed payload would otherwise
  // fail JSON.parse on every frame with a misleading per-frame error.
  const compression = data.readUInt8(2) & 0b1111;
  if (compression !== 0) throw new Error(`Unsupported Doubao compression flag ${compression}`);

  // Error frames use a different layout: header + errorCode(4) + payloadSize(4)
  // + payload — no session-id section. Parsing them with the standard layout
  // would misread the payload size as a session length and always throw.
  if (messageType === MessageType.ErrorInformation) {
    const errorCode = data.readUInt32BE(4);
    const payloadLength = data.readUInt32BE(8);
    if (data.length < 12 + payloadLength) throw new Error("Doubao frame payload is incomplete");
    return {
      event: 0,
      sessionId: "",
      serialization,
      payload: data.subarray(12, 12 + payloadLength),
      errorCode
    };
  }

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
const MAX_CLIENT_BUFFERED_BYTES = 512 * 1024;

/** Maximum nesting depth explored when mining reply text out of upstream JSON. */
const MAX_TEXT_EXTRACTION_DEPTH = 8;

function parseJsonPayload(frame: ParsedDoubaoFrame) {
  if (!frame.payload.length || frame.serialization !== SerializationMethod.Json) return {};
  if (frame.payload.length > MAX_JSON_PAYLOAD_BYTES) {
    throw new Error("Doubao JSON payload exceeds size limit");
  }
  // A scalar payload (`null`, a number, a string) is valid JSON but not the
  // record every consumer expects; coerce it to {} so field access (e.g.
  // extractAsrText's payload.results) can't throw on it.
  const parsed = JSON.parse(frame.payload.toString());
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
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

/** Converts server-owned transcript history into the provider's structured QA
 * context. Only complete rider/assistant pairs are included: the API rejects
 * odd-length context and an orphaned turn would give the model a false state. */
export function buildDoubaoDialogContext(
  turns: Array<{ at: number; speaker: "rider" | "agent"; text: string }>
): DoubaoDialogContextItem[] {
  const pairs: Array<[DoubaoDialogContextItem, DoubaoDialogContextItem]> = [];
  let pendingUser: DoubaoDialogContextItem | undefined;
  let lastTimestamp = 0;
  const item = (turn: (typeof turns)[number], role: "user" | "assistant"): DoubaoDialogContextItem | null => {
    const text = turn.text.trim().slice(0, 500);
    if (!text) return null;
    const sourceTimestamp = Number.isFinite(turn.at) ? Math.round(turn.at) : Date.now();
    const timestamp = Math.max(lastTimestamp + 1, Math.min(Date.now(), sourceTimestamp));
    lastTimestamp = timestamp;
    return { role, text, timestamp };
  };

  for (const turn of turns) {
    if (turn.speaker === "rider") {
      pendingUser = item(turn, "user") ?? undefined;
      continue;
    }
    if (!pendingUser) continue;
    const assistant = item(turn, "assistant");
    if (assistant) pairs.push([pendingUser, assistant]);
    pendingUser = undefined;
  }
  return pairs.slice(-20).flat();
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** In-place upstream reconnect attempts before giving up and bouncing the client. */
const MAX_UPSTREAM_RETRIES = 3;

// Module scope, not per-session: createDoubaoProvider runs once per WebSocket
// connection, and a synthesizer (with its cache) built inside it would be
// rebuilt — and its cache emptied — on every new session, so every session's
// first confirmation paid a fresh Doubao TTS round trip even for a phrase a
// previous session had already cached. The confirmation vocabulary is a
// handful of fixed phrases, so one synthesizer for the life of the process
// gives "one synthesis per phrase, ever" instead of "one per phrase per
// session". The speaker built from it is still per-session — see below —
// because it closes over that session's client and platform.
const speechLog = createLogger("doubao");
const synthesizeConfirmation = createSynthesizer({
  appid: process.env.DOUBAO_TTS_APPID,
  token: process.env.DOUBAO_TTS_TOKEN,
  voice: process.env.DOUBAO_TTS_VOICE,
  onFailure: (reason) => speechLog.warn("confirmation speech synthesis failed", { reason })
});

// Same module-scope reasoning as synthesizeConfirmation above, minus the
// cache: the vision provider never caches (a scene is never the same
// twice), so there is nothing here that would go stale across sessions —
// this just avoids reconstructing it on every WebSocket connection.
//
// Credentials are ARK_API_KEY / ARK_BASE_URL / ARK_MODEL (Volcano Ark), not
// DOUBAO_API_KEY — that key authenticates the realtime speech socket, not
// Ark's chat-completions endpoint, and it is deliberately not used as a
// fallback here (see server/vision.ts). Per Task 1's report, ARK_BASE_URL is
// the base URL and the chat-completions path must be appended; when
// ARK_BASE_URL is unset, selectVisionProvider falls back to its own
// hardcoded VISION_ENDPOINT constant (the same value, measured in Task 1).
// Without ARK_API_KEY/ARK_MODEL, selectVisionProvider falls back to the mock
// provider (with a once-per-process warning) instead of failing every call.
const visionLog = createLogger("vision");
const arkBaseUrl = process.env.ARK_BASE_URL?.trim();
const visionProvider = selectVisionProvider(
  {
    apiKey: process.env.ARK_API_KEY,
    model: process.env.ARK_MODEL,
    endpoint: arkBaseUrl ? buildChatCompletionsEndpoint(arkBaseUrl) : undefined,
    onFailure: (reason) => visionLog.warn("scene description failed", { reason })
  },
  visionLog
);

export function createDoubaoProvider(
  client: WebSocket,
  log: Logger = createLogger("doubao"),
  telemetry?: ProviderTelemetry
): AgentProvider {
  let upstream: WebSocket | undefined;
  let started = false;
  let sessionId = randomUUID();
  let sessionReady = false;
  let providerDialogId: string | undefined;
  // Upstream self-healing: when the Doubao socket drops mid-session, the relay
  // reconnects in place (replaying the persona + current session memory) so the
  // dropout is nearly invisible to the rider. Only after MAX_UPSTREAM_RETRIES
  // consecutive failures does it close the client socket, handing recovery to
  // the client's own backoff reconnect.
  let connectConfig: ConnectConfig | undefined;
  let upstreamRetries = 0;
  let resumedSession = false;
  let closedByProvider = false;
  let upstreamReconnectTimer: NodeJS.Timeout | undefined;
  // Doubao streams the agent reply over two channels: ChatResponse (raw LLM
  // tokens, often missing spaces) and TtsSentence (the spoken text, properly
  // spaced). They're kept separate so the transcript can use the spoken text —
  // which matches the voice — instead of concatenating both and duplicating it.
  let chatText = "";
  let ttsText = "";
  // Text of the last TtsSentence event, so the Start/End pair carrying the same
  // sentence is appended once — without dropping later sentences that merely
  // repeat earlier text (a substring check against all of ttsText did that).
  let lastTtsSentence = "";
  // One "thinking" status per agent turn; per-token statuses only re-send the
  // same state and waste the rider's cellular link.
  let sentThinkingStatus = false;
  // True once the fabrication guard has flagged any sentence of the CURRENT
  // reply. Read by pendingReplyText() below so every downstream flush path
  // (final transcript, TTS-fallback browser speech, barge-in salvage, socket
  // close) stops surfacing this reply's text — not just the triggering
  // sentence's own partial caption, which the guard's early return already
  // covers. Reset with sentThinkingStatus at the next rider turn.
  let fabricationSuppressed = false;
  let receivedTtsAudio = false;
  let ttsFallbackTimer: NodeJS.Timeout | undefined;
  // Measured end-of-ASR→first-audio latency of the previous turn; the TTS
  // fallback wait adapts upward from the configured floor so a slow link does
  // not trip the browser-speech fallback while real audio is still in flight.
  let lastFirstAudioLatencyMs = 0;
  let weatherRefreshTimer: NodeJS.Timeout | undefined;
  let currentWeatherRole = "";
  const riderLocation = new RiderLocationContext(appConfig.amapApiKey);
  // Where the rider is, for weather. Seeded at session.start, then kept fresh
  // by mid-ride location.update events so a long ride's weather doesn't stay
  // pinned to the start point.
  let weatherLocation: { lat: number; lon: number; source: "rider" | "configured" | "demo" } | undefined;
  // Wake-word ("Max") gating. The rider transcript for the current turn
  // accumulates in riderTurnText; addressedUntil holds the conversation window.
  // replyDecided/replyAddressed latch the decision for the whole agent turn so
  // a late window expiry can't clip a reply that already started.
  const wakeWordEnabled = appConfig.wakeWord;
  let riderTurnText = "";
  // Whether the current rider turn's transcript was already closed with a
  // final event (AsrEnded can repeat without new speech in between).
  let riderTurnFinalized = false;
  let asrTurnTimer: NodeJS.Timeout | undefined;
  // True from AsrEnded (once a turn is decided addressed) until the reply is
  // fully resolved — TtsEnded's real-completion branch, or the TTS-fallback
  // timer taking over. Closes the gap isSpeechOpen (further below) would
  // otherwise have: riderTurnFinalized flips true right at AsrEnded, before
  // the reply is even composed, and receivedTtsAudio only flips true once
  // Doubao's first TTS byte arrives — the "thinking" span between those two
  // (asrEndedAt → firstAudioAt, tracked as lastFirstAudioLatencyMs, floored
  // at TTS_FALLBACK_MS, default 1800 ms) previously read as speech-CLOSED,
  // letting a watch observation speak right over an incoming reply.
  let awaitingReply = false;
  let addressedUntil = 0;
  // When the rider last said "Max" explicitly — follow-up turns slide the
  // window but never past this + WAKE_FOLLOWUP_MAX_CHAIN_MS.
  let lastExplicitWakeAt = 0;
  // Whether the CURRENT rider turn addressed Max, decided when the turn's ASR is
  // classified (not re-derived from the wall clock when the agent's first frame
  // lands — first-token latency could otherwise push past addressedUntil and
  // silently drop a reply the rider legitimately addressed).
  let riderTurnAddressed = false;
  let replyDecided = false;
  let replyAddressed = false;
  let riderDelivery = createTranscriptDelivery();
  let agentDelivery = createTranscriptDelivery();
  let agentFinalDelivered = false;
  const pendingDeviceCommands = new PendingDeviceCommands();
  const deviceActivity = new DeviceActivityContext();
  // Set from provider.start()'s context, once the caller has provided it.
  // deviceActivity.isActive("navigation") was tried first and rejected: it
  // only reflects navigation.start/stop commands THIS session dispatched by
  // voice, so it reads stale-true after a route is stopped by any other means
  // and resets on every reconnect regardless of whether a route is still
  // running. session-controller.ts's navHandler.activeRoute() (the same
  // signal createNavPromptHandler already trusts to decide whether a relay
  // nav prompt should speak at all) is a better source but NOT an
  // authoritative one: it is cleared by a fresh "start" request and, since
  // this branch, by navigation-prompts.ts on an "arrived"/"rerouteFailed"
  // nav.prompt, but neither covers every way a route actually ends —
  // NavRequestEvent's reason is "start" | "reroute" only (no "stop"), a
  // paused-not-ended route ("locationLost") does not clear it, and a client
  // that goes away without reporting either (app killed, connectivity lost)
  // leaves it stale-true. This can therefore still read "route active" after
  // the rider has, in fact, stopped navigating — the guard's ROUTE_ACTIVE_LINE
  // will then promise a nav prompt that never comes. See routing.ts's
  // `lastRoute` for the fuller staleness accounting. Defaults to "no route"
  // (the safe direction — see NO_ROUTE_LINE/ROUTE_ACTIVE_LINE below) if
  // start() is ever called without it.
  let routeActiveFromContext: (() => boolean) | undefined;
  // Enforces that navigation truth may originate only from the relay's own
  // nav.* speech (speakNavLine/speakNavPrompt — session-controller.ts), never
  // from the model's own TTS stream. Wired into the TtsSentenceStart/End and
  // ChatResponse handlers below; speakFabricationGuardLine and the
  // truncate/clear helpers it calls are declared later in this closure as
  // hoisted function declarations, so referencing them here (before their
  // declarations run) is safe — none of these callbacks execute until a real
  // event arrives, long after this whole function body has finished setting
  // up the session.
  const fabricationGuard = navFabricationGuard({
    routeActive: () => routeActiveFromContext?.() ?? false,
    truncateReply: () => truncateInterruptedReply(),
    clearPendingAudio: () => clearUndecidedTtsAudio(),
    clearClientPlayback: () => clearClientPlaybackForFabrication(),
    speakHonestLine: (text) => {
      if (!asksCurrentLocation(riderTurnText)) speakFabricationGuardLine(text);
    },
    suppressItem: (itemId) => suppressedItemIds.add(itemId)
  });
  let deviceExpiryTimer: NodeJS.Timeout | undefined;
  const ordinarySpeechWaiters = new Set<() => void>();
  let rideContext: RideContext = { mode: "ride", scenario: "commute" };
  let memory: SessionMemory = createSessionMemory("ride");
  // Per-turn latency anchors. Reset at each rider turn (AsrInfo) so telemetry
  // and the adaptive TTS-fallback delay reflect the current turn, not just the
  // first turn of the session.
  let asrStartedAt = 0;
  let asrFirstTextAt = 0;
  let chatStartedAt = 0;
  let firstAudioAt = 0;
  let asrEndedAt = 0;
  let currentQuestionId: string | undefined;
  let currentReplyId: string | undefined;
  // The reply id AsrInfo just superseded (the id currentReplyId held right
  // before this turn's reset), so a frame for it that lands AFTER the reset
  // — Doubao keeps delivering an in-flight reply's queued frames even after
  // the relay has moved on to the next rider turn — can be dropped instead of
  // being read as this NEW turn's own state. Without this, such a frame
  // reassigns currentReplyId back to the stale id and, if its text asserts
  // navigation, calls inspectForFabrication for the wrong reply: fabricationSuppressed
  // then latches true for the turn that is actually in progress, silently
  // muting a legitimate reply that has nothing to do with the fabrication.
  // Never cleared explicitly — each AsrInfo simply overwrites it with the
  // now-previous turn's id, and reply ids are never reused, so comparing
  // against just the most recent one is sufficient.
  let supersededReplyId: string | undefined;
  const suppressedItemIds = new Set<string>();
  let forwardedReplyBytes = 0;
  let firstForwardedReplyAt: number | undefined;
  const pendingUndecidedAudio: Buffer[] = [];
  let pendingUndecidedAudioBytes = 0;
  // True once the TTS fallback has already spoken this turn via browser speech,
  // so late-arriving Doubao audio for the same reply isn't also played.
  let fallbackSpoke = false;
  // Mic frames that arrive before the upstream session is ready. Bounded so a
  // session that never becomes ready cannot grow this without limit. StartSession
  // is deferred until the live-weather fetch resolves (bounded at 4 s, and now run
  // concurrently with the connection handshake), so the buffer must comfortably
  // outlast that window or the rider's opening words are dropped. 250 frames is
  // 5 s of 20 ms audio (~160 KB); older frames are dropped first.
  const MAX_PENDING_AUDIO_FRAMES = 250;
  const pendingAudio: Buffer[] = [];
  let pendingAudioFlushTimer: NodeJS.Timeout | undefined;
  let latencyMetricSent = false;
  // One telemetry event per agent turn. TtsEnded and the TTS-fallback timer can
  // both reach emitTelemetry for the same turn, which double-counted latency on
  // clients that aggregate it. Reset at each rider turn (AsrInfo).
  let telemetrySent = false;
  let downstreamAudioAbandoned = false;
  let audioActive = false;
  let ttsEndedBeforeWakeDecision = false;
  // Wall-clock of the last SessionStarted, used to distinguish a genuinely
  // recovered upstream (dropped after running a while → fresh retry budget) from
  // one that flaps immediately after StartSession (kept counting so it can't
  // reconnect forever). See the close handler's stability check.
  let upstreamOpenedAt = 0;

  const MAX_UNDECIDED_TTS_BYTES = 240_000; // 5 s of 24 kHz PCM16 mono
  const MAX_UPSTREAM_BUFFERED_BYTES = 1024 * 1024;
  const CONNECTION_TIMEOUT_MS = boundedEnvInt("DOUBAO_CONNECTION_TIMEOUT_MS", 8_000, 1_000, 30_000);
  const SESSION_TIMEOUT_MS = boundedEnvInt("DOUBAO_SESSION_TIMEOUT_MS", 10_000, 1_000, 30_000);
  const ASR_TURN_TIMEOUT_MS = boundedEnvInt("DOUBAO_ASR_TURN_TIMEOUT_MS", 30_000, 5_000, 60_000);
  // A session that stayed up at least this long before dropping counts as
  // recovered and earns a fresh in-place reconnect budget.
  const UPSTREAM_STABILITY_RESET_MS = 60_000;

  let maxSpeechAbort = new AbortController();
  let maxSpeechTail = Promise.resolve();
  const maxSpeechDeliveries = new Set<string>();

  function cancelMaxSpeech() {
    maxSpeechAbort.abort();
    maxSpeechAbort = new AbortController();
  }

  function queueMaxSpeech(text: string, expiresAt?: number) {
    const signal = maxSpeechAbort.signal;
    const requestedAt = Date.now();
    let outcome: "Delivered" | "Failed" | "Cancelled" | "Expired" | "Congested" = "Cancelled";
    metrics.maxSpeechRequested();
    maxSpeechTail = maxSpeechTail
      .then(async () => {
        if (signal.aborted || closedByProvider || !connectConfig) return;
        if (expiresAt !== undefined && Date.now() >= expiresAt) {
          outcome = "Expired";
          return;
        }
        const pcm = await synthesizeMaxSpeech({
          text,
          url: process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
          headers: buildDoubaoHeaders(),
          config: buildDoubaoSessionConfig({
            ...connectConfig,
            systemRole: DEFAULT_AGENT_SYSTEM_PROMPT,
            dialogContext: []
          }),
          pack: buildFullClientRequest,
          parse: parseDoubaoFrame,
          signal
        });
        if (signal.aborted || closedByProvider) return;
        if (!pcm) {
          outcome = "Failed";
          sendClient({ type: "status", state: "degraded", detail: "MAX 语音暂不可用，请查看文字提示。" });
          return;
        }
        await waitForOrdinarySpeech();
        if (signal.aborted || closedByProvider || client.readyState !== client.OPEN) return;
        if (expiresAt !== undefined && Date.now() >= expiresAt) {
          outcome = "Expired";
          return;
        }
        // One synchronous delivery through the shared PCM channel: no second
        // browser speech engine, and no interleaving with live reply chunks.
        for (let offset = 0; offset < pcm.length; offset += 960) {
          if (client.bufferedAmount >= MAX_CLIENT_BUFFERED_BYTES) {
            outcome = "Congested";
            return;
          }
          const chunk = pcm.subarray(offset, offset + 960);
          client.send(chunk, { binary: true });
          telemetry?.serverAudio(chunk.byteLength);
        }
        outcome = "Delivered";
      })
      .catch(() => {
        if (!signal.aborted && !closedByProvider) {
          outcome = "Failed";
          sendClient({ type: "status", state: "degraded", detail: "MAX 语音暂不可用，请查看文字提示。" });
        }
      })
      .finally(() => metrics.maxSpeechCompleted(outcome, Date.now() - requestedAt));
  }

  function sendClient(payload: unknown) {
    const event = payload as {
      type?: string;
      speaker?: string;
      useBrowserSpeech?: boolean;
      text?: string;
      deliveryId?: string;
      detail?: string;
    };
    if (
      (sessionPlatform === "web" || sessionPlatform === "ios" || sessionPlatform === "android") &&
      event.type === "status" &&
      event.detail?.includes("浏览器")
    ) {
      payload = { ...event, detail: "MAX 语音暂不可用，文字提示仍可用。" };
    }
    if (
      (sessionPlatform === "web" || sessionPlatform === "ios" || sessionPlatform === "android") &&
      event.type === "transcript" &&
      event.speaker === "agent" &&
      event.useBrowserSpeech &&
      event.text
    ) {
      payload = { ...event, useBrowserSpeech: false };
      if (!event.deliveryId || !maxSpeechDeliveries.has(event.deliveryId)) {
        if (event.deliveryId) maxSpeechDeliveries.add(event.deliveryId);
        if (maxSpeechDeliveries.size > 256) maxSpeechDeliveries.delete(maxSpeechDeliveries.values().next().value!);
        queueMaxSpeech(event.text);
      }
    }
    if (client.readyState === client.OPEN) {
      const encoded = JSON.stringify(payload);
      telemetry?.serverEvent(payload, Buffer.byteLength(encoded));
      client.send(encoded);
    }
  }

  function clearAsrTurnTimer(): void {
    if (asrTurnTimer) clearTimeout(asrTurnTimer);
    asrTurnTimer = undefined;
  }

  function armAsrTurnTimer(socket: WebSocket): void {
    clearAsrTurnTimer();
    asrTurnTimer = setTimeout(() => {
      asrTurnTimer = undefined;
      if (closedByProvider || upstream !== socket || riderTurnFinalized || socket.readyState !== WebSocket.OPEN) return;
      metrics.upstreamFailure();
      log.warn("doubao ASR turn timed out — reconnecting upstream", { timeoutMs: ASR_TURN_TIMEOUT_MS });
      sendClient({ type: "status", state: "connecting", detail: "语音识别停滞，正在自动恢复…" });
      sessionReady = false;
      socket.close(1011, "doubao asr turn timeout");
    }, ASR_TURN_TIMEOUT_MS);
  }

  function sendUpstreamControl(event: EventSend, metadata: unknown = {}): boolean {
    if (!upstream || upstream.readyState !== WebSocket.OPEN || !sessionReady) return false;
    upstream.send(buildFullClientRequest(event, sessionId, metadata));
    return true;
  }

  function currentDoubaoConfig(
    config: ConnectConfig,
    systemRole: string,
    includeHistory: boolean
  ): DoubaoSessionConfig {
    const fix = riderLocation.coordinates();
    const location = fix ? { latitude: fix.lat, longitude: fix.lon } : undefined;
    return {
      sampleRate: config.sampleRate,
      channels: config.channels,
      voiceGender: config.voiceGender,
      systemRole,
      speakingStyle: config.speakingStyle,
      // Undefined on the first StartSession; populated from SessionStarted for
      // later UpdateConfig calls and in-place reconnects.
      dialogId: providerDialogId,
      dialogContext: includeHistory ? config.dialogContext : undefined,
      location
    };
  }

  /** UpdateConfig is a full overwrite for the supplied dialog/TTS sections. */
  function updateProviderConfig(): void {
    const config = connectConfig;
    if (!config || !sessionReady) return;
    const full = buildDoubaoSessionConfig(
      currentDoubaoConfig(config, config.baseSystemRole + currentWeatherRole + riderLocation.role(), false)
    );
    sendUpstreamControl(EventSend.UpdateConfig, { dialog: full.dialog, tts: full.tts });
  }

  function recordFirstAudioLatency(): void {
    if (latencyMetricSent || !firstAudioAt || !asrEndedAt) return;
    lastFirstAudioLatencyMs = Math.max(0, firstAudioAt - asrEndedAt);
    latencyMetricSent = true;
    sendClient({ type: "metric", latencyMs: lastFirstAudioLatencyMs });
  }

  function forwardTtsAudio(chunk: Buffer): void {
    // The fabrication guard runs on TEXT (TtsSentence/ChatResponse), which can
    // arrive before or after the AUDIO bytes for the same stretch of speech —
    // this relay has no way to measure Doubao's own frame ordering. Whichever
    // order applies, this gate stops every audio chunk not already forwarded
    // by the time text confirms fabrication; inspectForFabrication's own
    // client-side "hearing" status handles whatever was already forwarded.
    if (fallbackSpoke || downstreamAudioAbandoned || fabricationSuppressed) return;
    if (client.readyState !== client.OPEN) return;
    if (client.bufferedAmount >= MAX_CLIENT_BUFFERED_BYTES) {
      downstreamAudioAbandoned = true;
      sendClient({ type: "status", state: "degraded", detail: "网络拥塞，本轮剩余语音已停止发送" });
      return;
    }
    if (!firstAudioAt) {
      firstAudioAt = Date.now();
      firstForwardedReplyAt = performance.now();
      recordFirstAudioLatency();
      sendClient({ type: "status", state: "speaking", detail: "已收到豆包语音音频" });
    }
    receivedTtsAudio = true;
    forwardedReplyBytes += chunk.byteLength;
    clearTtsFallbackTimer();
    telemetry?.serverAudio(chunk.byteLength);
    client.send(chunk, { binary: true });
  }

  function bufferUndecidedTtsAudio(chunk: Buffer): void {
    if (pendingUndecidedAudioBytes + chunk.byteLength > MAX_UNDECIDED_TTS_BYTES) return;
    const copy = Buffer.from(chunk);
    pendingUndecidedAudio.push(copy);
    pendingUndecidedAudioBytes += copy.byteLength;
  }

  function flushUndecidedTtsAudio(): void {
    if (!replyIsAddressed()) return;
    for (const chunk of pendingUndecidedAudio) forwardTtsAudio(chunk);
    pendingUndecidedAudio.length = 0;
    pendingUndecidedAudioBytes = 0;
  }

  function clearUndecidedTtsAudio(): void {
    pendingUndecidedAudio.length = 0;
    pendingUndecidedAudioBytes = 0;
  }

  function truncateInterruptedReply(): void {
    if (!currentReplyId || !forwardedReplyBytes || firstForwardedReplyAt === undefined) return;
    const forwardedMs = Math.round(forwardedReplyBytes / 48); // 48 bytes/ms at 24 kHz PCM16 mono
    // Keep a small safety margin for client/network buffering. This is
    // deliberately conservative: exposing less context is safer than claiming
    // the rider heard words that were still queued when barge-in happened.
    const safetyMs = boundedEnvInt("DOUBAO_PLAYBACK_SAFETY_MS", 350, 0, 2_000);
    const elapsedMs = Math.max(0, performance.now() - firstForwardedReplyAt - safetyMs);
    const audioEndMs = Math.min(forwardedMs, elapsedMs);
    if (
      sendUpstreamControl(EventSend.ConversationTruncate, {
        item_id: currentReplyId,
        audio_end_ms: audioEndMs
      })
    ) {
      log.info("doubao conversation truncated", { replyId: currentReplyId.slice(0, 12), audioEndMs });
    }
  }

  /** Extracts a device command from the rider's final utterance and dispatches
   *  it. Doubao is speaking its own confirmation concurrently; the two are
   *  reconciled when the result arrives (or when it times out).
   *
   *  Gated by sessionPlatform (set in start(), read here at call time — see
   *  hazardInjector below for the same "declared later in this closure, read
   *  only after start() has run" shape): only the embedded board implements
   *  camera.look, so DeviceActivityContext.commandFor applies the shared
   *  platform gate and suppresses it for every other client rather than
   *  dispatching a command no one will answer. */
  function dispatchDeviceCommand(text: string): void {
    if (asksCurrentLocation(text)) {
      truncateInterruptedReply();
      clearUndecidedTtsAudio();
      fallbackSpoke = true;
      clearTtsFallbackTimer();
      resetPendingReply();
      awaitingReply = false;
      receivedTtsAudio = false;
      releaseOrdinarySpeechWaiters();
      const answer = riderLocation.answer();
      sendClient({ type: "status", state: "hearing", detail: "MAX 正在播报手机位置" });
      const delivery = createTranscriptDelivery();
      if (sessionPlatform === "embedded") {
        sendClient(transcriptEvent(delivery, "agent", answer, { final: true, useBrowserSpeech: true }));
        void speakEmbedded(answer).catch(() => {});
      } else {
        sendClient(transcriptEvent(delivery, "agent", answer, { final: true, useBrowserSpeech: false }));
        queueMaxSpeech(answer);
      }
      return;
    }
    const command = deviceActivity.commandFor(text, sessionPlatform);
    if (!command) return;
    const activity = deviceActivity.track(command);
    const issued = pendingDeviceCommands.issue(
      command.action,
      deviceSuccessSpeech(command),
      Date.now(),
      command.action === "camera.look" || command.action === "gallery.describe" ? command.args.question : undefined,
      command.action === "vision.watch" ? command.args.on : undefined,
      activity
    );
    sendClient({
      type: "device.command",
      commandId: issued.commandId,
      action: command.action,
      args: command.args,
      tier: DEVICE_ACTION_TIERS[command.action]
    });
    scheduleDeviceExpiry();
  }

  function scheduleDeviceExpiry(): void {
    if (deviceExpiryTimer) clearTimeout(deviceExpiryTimer);
    const nextExpiryAt = pendingDeviceCommands.nextExpiryAt();
    if (nextExpiryAt === undefined) {
      deviceExpiryTimer = undefined;
      return;
    }
    deviceExpiryTimer = setTimeout(
      () => {
        deviceExpiryTimer = undefined;
        applyExpiredDeviceCommands(Date.now());
        scheduleDeviceExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now())
    );
    deviceExpiryTimer.unref?.();
  }

  function applyExpiredDeviceCommands(now: number): void {
    for (const expired of pendingDeviceCommands.expire(now)) {
      deviceActivity.reconcile(expired.activity, { status: "failed", reason: "timeout" });
      // A gallery.describe whose frame set is still assembling under the
      // frame assembler's OWN (longer, 10 s) timeout must not also get the
      // generic 8 s device-result-timeout failure spoken here — that would
      // produce failure-then-answer (or failure-then-"我看不清") double
      // speak for one command. recentGalleryCommands holding an entry for
      // this commandId is exactly "a frame set is in flight"; the
      // assembler's own onComplete/onIncomplete is the single voice for
      // that outcome, so skip the spoken failure and let it run its course.
      if (expired.action === "gallery.describe" && recentGalleryCommands.has(expired.commandId)) continue;
      applyDeviceReconciliation(expired.action, { status: "failed", reason: "timeout" });
    }
  }

  function applyDeviceReconciliation(
    action: DeviceActionName,
    result: { status: DeviceActionStatus; reason?: string; detail?: string },
    okSpeech?: string
  ): void {
    const decision = reconcileDeviceResult(action, result, okSpeech);
    if (!decision.truncate) return;
    truncateInterruptedReply();
    if (sessionPlatform === "web" || sessionPlatform === "ios" || sessionPlatform === "android") {
      fallbackSpoke = true;
      clearTtsFallbackTimer();
      resetPendingReply();
      awaitingReply = false;
      receivedTtsAudio = false;
      sendClient({ type: "status", state: "hearing", detail: "MAX 正在播报操作结果" });
      releaseOrdinarySpeechWaiters();
    }
    if (decision.speech) {
      sendClient(transcriptEvent(agentDelivery, "agent", decision.speech, { final: true, useBrowserSpeech: true }));
      // Deliberately not awaited: the reconciliation is synchronous and must
      // stay that way. truncateInterruptedReply() has already cut the model's
      // audio, so the line does not land on top of it. speak() is documented
      // to never reject, but nothing here registers an `unhandledRejection`
      // handler, so a future regression in that contract would otherwise take
      // the whole process down for every rider on the box — the `.catch` is
      // the backstop for that, not evidence that speak() is expected to fail.
      void speakEmbedded(decision.speech).catch(() => {});
    }
  }

  function deleteSuppressedTurns(): void {
    for (const itemId of suppressedItemIds) {
      if (sendUpstreamControl(EventSend.ConversationDelete, { items: [{ item_id: itemId }] })) {
        suppressedItemIds.delete(itemId);
      }
    }
  }

  // Deleting either side removes the complete QA pair upstream. Prefer the
  // rider item so one suppressed turn never generates two delete requests.
  //
  // Skipped once fabricationSuppressed is set: inspectForFabrication (via the
  // guard's suppressItem dep) has already queued — and, via its own
  // deleteSuppressedTurns() call, already attempted — a delete for this
  // reply's own item the instant fabrication was detected, independent of
  // whether the turn later resolves addressed or not. That already removes
  // the whole QA pair, so adding the question-side item here too would be
  // exactly the second delete request this function's own invariant forbids.
  // Every caller of this function still calls deleteSuppressedTurns()
  // unconditionally right after, so a reply-item delete that failed on its
  // first attempt still gets retried — this only prevents queuing a second,
  // different item that was never needed.
  function markCurrentTurnSuppressed(): void {
    if (fabricationSuppressed) return;
    const itemId = currentQuestionId ?? currentReplyId;
    if (itemId) suppressedItemIds.add(itemId);
  }

  function queuePendingAudio(chunk: Buffer): void {
    if (pendingAudio.length >= MAX_PENDING_AUDIO_FRAMES) pendingAudio.shift();
    pendingAudio.push(Buffer.from(chunk));
  }

  function clearPendingAudioFlush(): void {
    if (pendingAudioFlushTimer) clearInterval(pendingAudioFlushTimer);
    pendingAudioFlushTimer = undefined;
  }

  /** Replay at capture cadence after a reconnect. A tight while-loop creates a
   * several-second upstream burst that can confuse VAD and inflate latency. */
  function startPendingAudioFlush(): void {
    if (pendingAudioFlushTimer || !pendingAudio.length) return;
    pendingAudioFlushTimer = setInterval(() => {
      const socket = upstream;
      if (!audioActive || !sessionReady || !socket || socket.readyState !== WebSocket.OPEN) {
        clearPendingAudioFlush();
        return;
      }
      if (socket.bufferedAmount >= MAX_UPSTREAM_BUFFERED_BYTES) return;
      // Two 20 ms frames per tick lets a reconnect catch up gradually without
      // reproducing the old all-at-once VAD-confusing burst.
      for (let count = 0; count < 2 && pendingAudio.length; count += 1) {
        const frame = pendingAudio.shift();
        if (frame) socket.send(buildAudioRequest(sessionId, frame));
      }
      if (!pendingAudio.length) clearPendingAudioFlush();
    }, 20);
  }

  function clearTtsFallbackTimer() {
    if (ttsFallbackTimer) clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = undefined;
  }

  // Latches once per agent turn: true when the rider's utterance addressed Max
  // (or fell inside the follow-up window). Reset on each new rider turn.
  function replyIsAddressed(): boolean {
    if (!wakeWordEnabled) return true;
    // Doubao can interleave an early ChatResponse with cumulative ASR updates.
    // A later hypothesis may add the wake phrase, so a negative decision is
    // provisional until AsrEnded. A positive wake is safe to latch immediately.
    if (riderTurnAddressed) {
      replyAddressed = true;
      replyDecided = true;
      return true;
    }
    if (!riderTurnFinalized) return false;
    if (!replyDecided) {
      replyAddressed = false;
      replyDecided = true;
      log.debug("reply suppressed — rider did not address Max", { characters: riderTurnText.length });
    }
    return replyAddressed;
  }

  /** The reply text to show: the spoken (TTS) text if any, else the raw chat text.
   *  Empty once the fabrication guard has flagged this reply — every flush call
   *  site below reads through this one function, so gating it here is the single
   *  choke point that keeps a fabricated reply's text (and any legitimate text
   *  that happens to follow it in the same reply) off the transcript and out of
   *  the TTS-fallback browser-speech path, rather than requiring each call site
   *  to remember to check separately. */
  function pendingReplyText(): string {
    if (fabricationSuppressed) return "";
    return (ttsText || chatText).trim();
  }

  function resetPendingReply() {
    chatText = "";
    ttsText = "";
    lastTtsSentence = "";
  }

  function flushPendingAgentText(useBrowserSpeech: boolean) {
    // Drop the reply entirely when the rider did not address Max.
    if (!replyIsAddressed()) {
      log.debug("reply suppressed — rider did not address Max", { characters: riderTurnText.length });
      resetPendingReply();
      return;
    }
    const text = pendingReplyText();
    if (!text) return;
    if (agentFinalDelivered) {
      resetPendingReply();
      return;
    }
    agentFinalDelivered = true;
    sendClient(transcriptEvent(agentDelivery, "agent", text, { final: true, useBrowserSpeech }));
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
        metrics.ttsFallback();
        telemetry?.ttsFallback();
        flushPendingAgentText(true);
        // Browser speech now owns this reply; suppress any late Doubao audio.
        fallbackSpoke = true;
        // The browser-speech fallback has taken over the reply — the
        // thinking window this flag holds open is over, same as a real
        // TtsEnded completion (below, TtsEnded may still arrive later and
        // clear it again — harmless, since it's already false by then).
        awaitingReply = false;
        releaseOrdinarySpeechWaiters();
        sendClient({
          type: "status",
          state: "ready",
          detail: "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
        });
        // TtsEnded may never arrive on this turn, so report telemetry here.
        emitTelemetry();
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

  // Captured at session.start so the hazard injector can suppress simulated
  // alerts on the embedded board, which detects hazards for real.
  let sessionPlatform: string | undefined;

  // The helmet has no way to speak generated text: it drops `useBrowserSpeech`
  // transcripts, and pre-rendered alert WAVs cannot cover arbitrary wording. So
  // the relay synthesises and sends the bytes down the same binary channel
  // Doubao's own voice uses. `synthesizeConfirmation` is the module-scope,
  // process-lifetime synthesizer above; only this speaker wrapper — which
  // closes over this session's client and platform — is per-session.
  const speaker = createSpeaker({
    synthesize: synthesizeConfirmation,
    sendAudio: (pcm) => client.send(pcm, { binary: true }),
    platform: () => (closedByProvider ? undefined : sessionPlatform),
    onError: (error) => log.warn("confirmation speech failed", { error: String(error) })
  });

  // True for the duration of an embedded-relay-synthesised utterance (device
  // confirmations, gallery/watch lines) — the part of "the agent is audibly
  // speaking" that createSpeaker itself does not track. Wraps every
  // speaker.speak() call site below so isSpeechOpen (on visionGovernor,
  // further down) can read it.
  let speakerActive = 0;
  function speakEmbedded(text: string, options?: SpeakOptions): Promise<void> {
    speakerActive += 1;
    return speaker.speak(text, options).finally(() => {
      speakerActive -= 1;
    });
  }

  /** The fabrication guard's honest-correction line: fresh delivery id, forced
   *  client speech, and the embedded relay's own synthesizer — the same shape
   *  as speakNavLine below. Deliberately not routed through speakNavPrompt:
   *  that method's non-interrupt branch waits on waitForOrdinarySpeech before
   *  it will even start, but the correction is replacing speech that was just
   *  truncated and must not wait to begin. It is still serialized against
   *  other embedded speech, just not by anything in this file — speakEmbedded
   *  (below) goes through createSpeaker's own shared `tail` promise chain
   *  (server/speech.ts), which is what actually queues every speak() call on
   *  the embedded audio channel, this one included. */
  function speakFabricationGuardLine(text: string): void {
    if (closedByProvider) return;
    const delivery = createTranscriptDelivery();
    sendClient(transcriptEvent(delivery, "agent", text, { final: true, useBrowserSpeech: true }));
    void speakEmbedded(text).catch(() => {});
  }

  /** The fabrication guard's clearClientPlayback dep — server/nav-fabrication-
   *  guard.ts calls this BEFORE speakFabricationGuardLine, and that ordering is
   *  load-bearing: every real client's speech stack (web speechSynthesis.
   *  cancel(), iOS stopSpeaking(.immediate), Android tts.stop()) aborts
   *  in-flight playback on receipt of this same signal, so sending it after
   *  the honest line had already started speaking would cancel the
   *  correction itself. Audio can also lead text, so bytes for this reply may
   *  already be forwarded and playing (or queued) on the client by the time
   *  text confirms fabrication — forwardTtsAudio's own fabricationSuppressed
   *  gate stops anything NOT yet forwarded, but cannot recall what already
   *  left the wire. Reuses the exact signal AsrInfo's barge-in handling
   *  sends (session-controller.ts's own comment calls it "an immediate,
   *  privacy-safe signal to clear queued playback"), tagged with a distinct
   *  detail string so RDK — whose barge-in path normally waits for mic
   *  corroboration before flushing, which a fabrication event (no rider
   *  speech) can never provide — routes this one to an unconditional flush
   *  instead (see rdk/agent/src/main.ts). */
  function clearClientPlaybackForFabrication(): void {
    sendClient({ type: "status", state: "hearing", detail: NAV_FABRICATION_CLEAR_DETAIL });
  }

  /** Shared by the ChatResponse (raw token) and TtsSentenceStart/End
   *  (properly-spaced spoken) handlers below — either can be the first to
   *  reveal a fabricated reply, since ChatResponse text typically streams
   *  ahead of TTS segmentation, but a reply for which TtsSentence events never
   *  arrive at all (the same gap the TTS-fallback browser-speech path exists
   *  to cover) must still be caught from its raw text. Returns true when this
   *  call suppressed — the caller must stop processing this event and skip
   *  its own caption/status send.
   *
   *  Callers must NOT gate this call on replyIsAddressed(): suppression must
   *  apply even while the wake decision is still undecided (Doubao can answer
   *  before the rider's ASR hypothesis has settled), or fabricated audio
   *  already buffered by the undecided-TTS path (bufferUndecidedTtsAudio)
   *  escapes uncaught the moment the decision later latches addressed and
   *  flushUndecidedTtsAudio() forwards it. Only the AUDIBLE correction is
   *  conditional on being addressed — handled here by calling
   *  fabricationGuard.announceIfDetected() when replyIsAddressed() is
   *  already true, and separately at every point in this file where an
   *  undecided reply's wake decision resolves to addressed (see
   *  flushUndecidedTtsAudio's call sites), since a reply can have no further
   *  TtsSentence/ChatResponse delta after that point for this function to
   *  catch it on. */
  function inspectForFabrication(text: string): boolean {
    if (!fabricationGuard.inspectSentence(text, currentReplyId)) return false;
    fabricationSuppressed = true;
    deleteSuppressedTurns();
    if (replyIsAddressed()) fabricationGuard.announceIfDetected();
    return true;
  }

  function ordinarySpeechOpen(): boolean {
    return awaitingReply || receivedTtsAudio;
  }

  async function waitForOrdinarySpeech(): Promise<void> {
    while (!closedByProvider && ordinarySpeechOpen()) {
      await new Promise<void>((resolve) => ordinarySpeechWaiters.add(resolve));
    }
  }

  function releaseOrdinarySpeechWaiters(force = false): void {
    if (!force && ordinarySpeechOpen()) return;
    for (const resolve of ordinarySpeechWaiters) resolve();
    ordinarySpeechWaiters.clear();
  }

  // Companion to pendingDeviceCommands, scoped to gallery.describe frame sets:
  // vision.frames chunks all arrive before the device.result for the same
  // commandId (wire order), so pendingDeviceCommands.peek() is enough while a
  // set is still assembling — but the frame assembler's 10 s onIncomplete
  // timer can fire well after device.result has already resolved (deleted)
  // the pending entry. This map keeps just enough alive from accept time
  // through completion or timeout, then prunes itself — at most one live
  // entry per in-flight gallery command:
  //   - action: satisfies the same "issued for this action" guard
  //     visionFrames() runs;
  //   - question: authoritative over whatever a chunk's own `question`
  //     field claims;
  //   - delivery: `agentDelivery` captured SYNCHRONOUSLY at accept time (the
  //     first chunk of the set), exactly like cameraFrame's `const delivery =
  //     agentDelivery;` capture — never read live at speak time, which for
  //     onComplete is after an awaited vision-model round trip and for
  //     onIncomplete is up to 10 s later, either of which a new rider turn
  //     can easily fall inside of and reassign the mutable `agentDelivery`
  //     binding in between. Reading it late would tag the gallery line onto
  //     whatever turn happens to be live when it finally speaks instead of
  //     the one that actually asked to look.
  const recentGalleryCommands = new Map<
    string,
    { action: DeviceActionName; question?: string; delivery: TranscriptDelivery }
  >();

  /** Speaks a gallery.describe answer (or its "我看不清。" fallback) exactly
   *  the way cameraFrame speaks a camera.look answer: transcript + speaker,
   *  against the delivery the caller captured at accept time (see
   *  recentGalleryCommands above) — never the live `agentDelivery` binding. */
  function speakGalleryLine(delivery: TranscriptDelivery, line: string): void {
    sendClient(transcriptEvent(delivery, "agent", line, { final: true, useBrowserSpeech: true }));
    void speakEmbedded(line).catch(() => {});
  }

  /** Speaks a watch observation (V-C) the same way speakGalleryLine speaks a
   *  gallery answer — transcript + speaker — except the delivery is
   *  allocated FRESH here, at speak time, rather than captured from the
   *  mutable `agentDelivery` binding: a watch line belongs to no rider turn,
   *  the same "no owning turn" situation hazard-injector.ts's fire() solves
   *  for hazard.alert lines by calling createTranscriptDelivery() inline
   *  instead of reading a turn-scoped delivery. That inline-allocation idiom
   *  is what this reuses. */
  function speakWatchLine(line: string): void {
    const delivery = createTranscriptDelivery();
    sendClient(transcriptEvent(delivery, "agent", line, { final: true, useBrowserSpeech: true }));
    void speakEmbedded(line).catch(() => {});
  }

  // Watch-frame governor (V-C), per session. describe reuses the same
  // module-scope visionProvider as cameraFrame/gallery above. isSpeechOpen
  // composes four existing bindings, each covering a different span of one
  // rider turn's lifecycle:
  //   - riderTurnFinalized: false for the "hearing"/"asr" span BEFORE
  //     AsrEnded — reset at every AsrInfo, the same event that sends the
  //     "hearing" status.
  //   - awaitingReply: true for the "thinking" span from AsrEnded (once a
  //     turn is decided addressed) until the reply resolves — declared
  //     above, alongside riderTurnFinalized, with the full rationale for why
  //     this flag exists (it closes a gap neither of the other three cover).
  //   - receivedTtsAudio: true for the span Doubao's own audio is
  //     streaming — set in forwardTtsAudio, the same place that sends the
  //     "speaking" status, and reset once TtsEnded finishes. (Its true
  //     window sits entirely inside awaitingReply's; kept as its own term
  //     anyway so "the agent is audibly speaking" reads directly at the
  //     call site instead of only implicitly via awaitingReply.)
  //   - speakerActive: the embedded-relay-synthesised speech span defined
  //     above (device confirmations, gallery/watch lines).
  // Any one being true means "the agent is audibly speaking or a rider turn
  // is mid-flight".
  const visionGovernor = createVisionGovernor({
    describe: (frames, question) => visionProvider.describe(frames, question),
    speak: speakWatchLine,
    isSpeechOpen: () => !riderTurnFinalized || awaitingReply || receivedTtsAudio || speakerActive > 0,
    onDrop: (reason) => metrics.watchDrop(reason)
  });

  // Notes every injected hazard.alert (below) into the watch governor, same
  // as provider.hazardReport does for a board-detected hazard — a simulated
  // ADAS scenario must gate watching exactly like a real one would.
  //
  // CURRENTLY structurally unreachable: hazardInjector.start() (below)
  // unconditionally no-ops when platform() === "embedded" ("the embedded
  // board detects hazards for real" — see hazard-injector.ts), and
  // vision.watch is only ever dispatchable on platform "embedded"
  // (device-actions.ts's PLATFORM_RESTRICTED_ACTIONS). So no session that
  // can ever enable the watch governor can also have this injector firing.
  // Kept wired for when that gate changes, rather than left as a silent gap.
  function sendWithHazardNote(payload: unknown): void {
    if (payload && typeof payload === "object" && (payload as { type?: unknown }).type === "hazard.alert") {
      visionGovernor.noteHazard();
    }
    sendClient(payload);
  }

  // Simulated ADAS hazards on the live path — only for the dedicated ADAS scenario
  // so normal voice sessions aren't interrupted. See server/hazard-injector.ts.
  const hazardInjector = createHazardInjector({
    send: sendWithHazardNote,
    emitRideContext,
    platform: () => sessionPlatform
  });

  // Per-session assembler for gallery.describe's multi-frame sets. Mirrors
  // cameraFrame's detached-async shape below: the vision-model round trip
  // must never block the message queue that also carries mic PCM.
  const galleryFrameAssembler = createFrameAssembler({
    onComplete: ({ commandId, frames, question }) => {
      const record = recentGalleryCommands.get(commandId);
      recentGalleryCommands.delete(commandId);
      const finalQuestion = record?.question ?? question;
      // record is always set by visionFrames() before accept() is called
      // (below); the `?? agentDelivery` fallback only guards a state that
      // should be unreachable, so a defensive read here can never silently
      // resurrect the exact staleness bug this design exists to prevent.
      const delivery = record?.delivery ?? agentDelivery;
      void (async () => {
        const description = await visionProvider.describe(frames, finalQuestion);
        speakGalleryLine(delivery, description ?? "我看不清。");
      })().catch((error) => {
        log.warn("gallery frame set description failed unexpectedly", { error: String(error) });
      });
    },
    onIncomplete: (commandId) => {
      const record = recentGalleryCommands.get(commandId);
      recentGalleryCommands.delete(commandId);
      const delivery = record?.delivery ?? agentDelivery;
      speakGalleryLine(delivery, "我看不清。");
    }
  });

  /** Refetches weather for the current location and pushes the HUD update. */
  async function refreshWeather(trigger: "interval" | "location") {
    const location = weatherLocation;
    if (!location) return;
    try {
      const weather = await fetchRiderWeather(location.lat, location.lon);
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
        trigger,
        description: weather.description,
        temperatureC: weather.temperatureC,
        windSpeedKmh: weather.windSpeedKmh,
        riskLevel: weather.riskLevel
      });
      currentWeatherRole =
        `\n\n[实时骑行情报] 骑手当前位置${weather.summary}` +
        `${weather.riderAdvice}当骑手询问天气或风力时，只基于这条实时数据简短回答。`;
      updateProviderConfig();
    } catch {
      log.warn("weather refresh failed — keeping last reading", { trigger });
    }
  }

  function emitTelemetry(totalEnd = Date.now()) {
    recordFirstAudioLatency();
    if (telemetrySent) return;
    const asrMs = asrStartedAt && asrFirstTextAt ? Math.max(0, asrFirstTextAt - asrStartedAt) : 0;
    const thinkMs = asrEndedAt && chatStartedAt ? Math.max(0, chatStartedAt - asrEndedAt) : 0;
    const firstAudioMs = asrEndedAt && firstAudioAt ? Math.max(0, firstAudioAt - asrEndedAt) : 0;
    const totalMs = asrStartedAt ? Math.max(0, totalEnd - asrStartedAt) : 0;
    if (asrMs || thinkMs || firstAudioMs || totalMs) {
      telemetrySent = true;
      log.info("turn telemetry", { asrMs, thinkMs, firstAudioMs, totalMs });
      sendClient({ type: "telemetry", asrMs, thinkMs, firstAudioMs, totalMs });
    }
  }

  function connectUpstream(config: ConnectConfig) {
    const url = process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    upstream = new WebSocket(url, {
      headers: buildDoubaoHeaders(),
      handshakeTimeout: CONNECTION_TIMEOUT_MS
    });
    const socket = upstream;

    let connectionTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      connectionTimer = undefined;
      metrics.upstreamFailure();
      log.error("doubao connection start timed out", { timeoutMs: CONNECTION_TIMEOUT_MS });
      sendClient({ type: "error", message: "豆包语音连接超时，正在重试。" });
      socket.terminate();
    }, CONNECTION_TIMEOUT_MS);
    let sessionTimer: NodeJS.Timeout | undefined;
    const clearStateTimers = () => {
      if (connectionTimer) clearTimeout(connectionTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      connectionTimer = undefined;
      sessionTimer = undefined;
    };

    socket.on("open", () => {
      log.info("doubao upstream opened");
      socket.send(buildFullClientRequest(EventSend.StartConnection));
      sendClient({ type: "status", state: "connecting", detail: "豆包语音连接已打开" });
    });

    // Handlers that suspend (awaiting the weather promise) must verify they
    // still belong to the CURRENT upstream: after an in-place reconnect the
    // shared `upstream` variable points at the replacement socket, and a stale
    // continuation would double-send StartSession on it.
    socket.on("upgrade", (response) => {
      const requestId = response.headers["x-tt-logid"];
      if (requestId) log.info("doubao handshake accepted", { requestId });
    });

    socket.on("message", async (message) => {
      try {
        if (upstream !== socket) return;
        const frame = parseDoubaoFrame(message);

        if (frame.errorCode !== undefined) {
          const detail = frame.payload.toString().slice(0, 300);
          metrics.upstreamFailure();
          log.error("doubao error frame", { code: frame.errorCode, detail });
          sendClient({ type: "status", state: "degraded", detail: "豆包连接异常，已保留浏览器 TTS 备用通道" });
          sendClient({ type: "error", message: `豆包错误 ${frame.errorCode}：${detail || "未知错误"}` });
          // ErrorInformation is terminal for this upstream exchange. Some
          // gateways leave the WebSocket itself open after sending it; waiting
          // for a close in that case strands the client in a permanently
          // degraded session with audio only accumulating in pendingAudio.
          // Close proactively so the existing bounded reconnect path runs.
          sessionReady = false;
          socket.close(1011, "doubao error frame");
          return;
        }

        // Once this turn is decided unaddressed, the reply stream is dead
        // weight — Doubao synthesizes the full reply regardless — so drop the
        // per-token/per-chunk frames before any JSON parsing. End-of-turn
        // events (ChatEnded/TtsEnded) still run their bookkeeping.
        if (wakeWordEnabled && frame.event === EventReceive.TtsResponse && replyDecided && !replyAddressed) {
          return;
        }

        if (frame.event === EventReceive.ConnectionStarted) {
          if (connectionTimer) clearTimeout(connectionTimer);
          connectionTimer = undefined;
          sessionTimer = setTimeout(() => {
            sessionTimer = undefined;
            metrics.upstreamFailure();
            log.error("doubao session start timed out", { timeoutMs: SESSION_TIMEOUT_MS });
            sendClient({ type: "error", message: "豆包语音会话启动超时，正在重试。" });
            socket.terminate();
          }, SESSION_TIMEOUT_MS);
          sessionId = randomUUID();
          // Fold in the concurrently-fetched weather (bounded; "" if unavailable),
          // then start the session. Doubao sends nothing until StartSession, so
          // awaiting here only defers our own next send.
          currentWeatherRole = await config.weatherRolePromise;
          let systemRole = config.baseSystemRole + currentWeatherRole + riderLocation.role();
          if (resumedSession) {
            // Context replay for an in-place upstream reconnect: same ride, same
            // conversation — carry the live session memory forward and stop the
            // agent from greeting the rider like a stranger.
            systemRole +=
              `\n\n[会话恢复] 与骑手的实时连接曾短暂中断，现已恢复。这是同一次骑行中的同一个会话，` +
              `请继续之前的对话，不要重新自我介绍或重新问候。` +
              `\n[恢复的短期记忆] ${buildSessionMemoryPrompt(memory)}。`;
          }
          // The socket may have closed — or been superseded by an in-place
          // reconnect — while the weather fetch was in flight.
          if (upstream !== socket || socket.readyState !== WebSocket.OPEN) return;
          socket.send(
            buildFullClientRequest(
              EventSend.StartSession,
              sessionId,
              buildDoubaoSessionConfig(currentDoubaoConfig(config, systemRole, !resumedSession))
            )
          );
          return;
        }

        if (frame.event === EventReceive.SessionStarted) {
          if (sessionTimer) clearTimeout(sessionTimer);
          sessionTimer = undefined;
          const sessionPayload = parseJsonPayload(frame);
          providerDialogId = stringField(sessionPayload, "dialog_id") ?? providerDialogId;
          sessionReady = true;
          // Defensive: the close handler above already clears this on every
          // drop, but a resumed session must never start believing a reply
          // is still owed to a turn whose socket is gone — a dead socket
          // delivered no reply, and there is nothing left here to await it.
          awaitingReply = false;
          releaseOrdinarySpeechWaiters();
          // NOT reset here: an upstream that reaches SessionStarted then drops a
          // moment later (quota/model error surfacing once the dialogue is live)
          // would otherwise clear its retry count on every flap and reconnect
          // forever. The close handler grants a fresh budget only once the
          // session has actually stayed up (UPSTREAM_STABILITY_RESET_MS).
          upstreamOpenedAt = Date.now();
          log.info(resumedSession ? "doubao session resumed after reconnect" : "doubao session started", {
            sessionId: sessionId.slice(0, 8),
            pendingAudioFrames: pendingAudio.length
          });
          sendClient({ type: "session.started", provider: "doubao", mode: "live", capabilities: DOUBAO_CAPABILITIES });
          emitRideContext();
          emitMemory();
          sendClient({ type: "status", state: "ready", detail: "豆包实时语音已连接" });
          startPendingAudioFlush();
          return;
        }

        if (frame.event === EventReceive.TtsResponse) {
          if (fallbackSpoke) return;
          // ASR and TTS may overlap. Hold a short bounded prefix until the wake
          // decision is final; otherwise background speech can leak audible Max
          // output before the final ASR hypothesis proves it was unaddressed.
          if (wakeWordEnabled && !replyIsAddressed()) {
            if (!replyDecided) bufferUndecidedTtsAudio(frame.payload);
            return;
          }
          flushUndecidedTtsAudio();
          // Reaching here means addressed (or wake gating is off) — if a
          // fabricated sentence was already suppressed earlier this reply
          // while the wake decision was still undecided, the honest line may
          // not have been announced yet. See inspectForFabrication's doc
          // comment; announceIfDetected() is a no-op otherwise.
          fabricationGuard.announceIfDetected();
          forwardTtsAudio(frame.payload);
          return;
        }

        const payload = parseJsonPayload(frame);
        // A per-reply frame that arrived after AsrInfo already superseded the
        // reply it belongs to. This is NOT the replyDecided/!replyAddressed
        // gate just below: right after AsrInfo the new turn is undecided
        // (replyDecided is false), so that gate does not fire yet, and
        // without this check the stale frame would fall through to the
        // ordinary handlers, reassign currentReplyId back to the superseded
        // reply, and — if its text asserts navigation — trip
        // inspectForFabrication for a reply that is not the one actually in
        // progress. See supersededReplyId's own doc comment.
        if (
          supersededReplyId !== undefined &&
          (frame.event === EventReceive.ChatResponse ||
            frame.event === EventReceive.TtsSentenceStart ||
            frame.event === EventReceive.TtsSentenceEnd ||
            frame.event === EventReceive.ChatEnded ||
            frame.event === EventReceive.TtsEnded) &&
          (stringField(payload, "reply_id") ?? stringField(payload, "item_id")) === supersededReplyId
        ) {
          return;
        }
        if (
          wakeWordEnabled &&
          (frame.event === EventReceive.ChatResponse ||
            frame.event === EventReceive.TtsSentenceStart ||
            frame.event === EventReceive.TtsSentenceEnd) &&
          replyDecided &&
          !replyAddressed
        ) {
          currentQuestionId = stringField(payload, "question_id") ?? currentQuestionId;
          currentReplyId = stringField(payload, "reply_id") ?? stringField(payload, "item_id") ?? currentReplyId;
          markCurrentTurnSuppressed();
          deleteSuppressedTurns();
          return;
        }
        if (frame.event === EventReceive.AsrInfo) {
          cancelMaxSpeech();
          // A new rider utterance means the currently playing reply was
          // interrupted. Tell the provider how much was plausibly heard so its
          // next turn does not rely on text that never reached the rider.
          if (fallbackSpoke && currentReplyId) {
            markCurrentTurnSuppressed();
            deleteSuppressedTurns();
          } else {
            truncateInterruptedReply();
          }
          // New rider turn: the previous turn's reply machinery must be torn
          // down first. A still-armed fallback timer would fire mid-turn,
          // speak the stale turn's text via browser speech, and set
          // fallbackSpoke — silently muting all of THIS turn's real audio.
          clearTtsFallbackTimer();
          // If the interrupted reply was partially spoken, record it in the
          // transcript (without re-speaking); otherwise drop it so it can't
          // prepend itself to the next turn's flush.
          if (receivedTtsAudio && pendingReplyText()) flushPendingAgentText(false);
          resetPendingReply();
          clearUndecidedTtsAudio();
          receivedTtsAudio = false;
          // Anchor the per-turn latency timers and reset the wake-word
          // accumulation, decision latch, and double-speak guard.
          asrStartedAt = Date.now();
          asrFirstTextAt = 0;
          chatStartedAt = 0;
          firstAudioAt = 0;
          asrEndedAt = 0;
          currentQuestionId = stringField(payload, "question_id") ?? stringField(payload, "item_id");
          // Stamp whatever reply was in flight as superseded BEFORE clearing
          // currentReplyId below, so a frame that belongs to it and arrives
          // late (after this reset) can be recognized and dropped instead of
          // contaminating the new turn — see supersededReplyId's doc comment.
          supersededReplyId = currentReplyId;
          currentReplyId = undefined;
          forwardedReplyBytes = 0;
          firstForwardedReplyAt = undefined;
          latencyMetricSent = false;
          telemetrySent = false;
          downstreamAudioAbandoned = false;
          ttsEndedBeforeWakeDecision = false;
          sentThinkingStatus = false;
          fabricationSuppressed = false;
          fabricationGuard.beginReply();
          fallbackSpoke = false;
          riderTurnText = "";
          riderTurnFinalized = false;
          armAsrTurnTimer(socket);
          // A new rider turn (barge-in) supersedes whatever the previous
          // turn's reply was doing — truncateInterruptedReply()/the flush
          // above already handled the interrupted reply itself, so the gate
          // this flag holds open for it must not leak into the new turn.
          awaitingReply = false;
          releaseOrdinarySpeechWaiters();
          riderTurnAddressed = false;
          replyDecided = false;
          replyAddressed = false;
          riderDelivery = createTranscriptDelivery();
          agentDelivery = createTranscriptDelivery();
          agentFinalDelivered = false;
          // This contains no transcript content, but gives every client an
          // immediate, privacy-safe signal to clear queued playback on barge-in.
          sendClient({ type: "status", state: "hearing", detail: "豆包检测到骑手语音" });
          return;
        }

        if (frame.event === EventReceive.AsrResponse) {
          const text = extractAsrText(payload);
          if (text) {
            if (!asrFirstTextAt) asrFirstTextAt = Date.now();
            // Doubao ASR partials are CUMULATIVE: each AsrResponse carries the
            // current best hypothesis of the WHOLE utterance ("我", "我也",
            // "我也看到"…), so the newest one replaces the turn text. Appending
            // them concatenated every hypothesis into an unreadable pile that
            // the AsrEnded flush then stamped into the transcript. Clients
            // already treat non-final rider items as replacements, and the
            // wake window below latches once opened, so replace is safe.
            riderTurnText = text;
            // (Re)open the conversation window when the rider says "Max" or is
            // already inside an open window. Follow-ups slide the window but
            // never past the chain cap after the last explicit wake —
            // continuous chatter otherwise kept the agent addressed forever.
            if (wakeWordEnabled) {
              const now = Date.now();
              if (containsWakePhrase(riderTurnText)) {
                lastExplicitWakeAt = now;
                addressedUntil = now + WAKE_FOLLOWUP_WINDOW_MS;
                riderTurnAddressed = true;
              } else if (now <= addressedUntil) {
                addressedUntil = Math.min(
                  now + WAKE_FOLLOWUP_WINDOW_MS,
                  lastExplicitWakeAt + WAKE_FOLLOWUP_MAX_CHAIN_MS
                );
                riderTurnAddressed = true;
              }
            }
            log.debug("rider asr", { characters: text.length, addressed: !wakeWordEnabled || riderTurnAddressed });
            // Never expose or persist background speech while wake gating is
            // enabled. Once the wake phrase (or follow-up window) is proven,
            // the cumulative hypothesis is safe to display as a live caption.
            if (!wakeWordEnabled || riderTurnAddressed) {
              flushUndecidedTtsAudio();
              // The exact point an undecided reply's wake decision can first
              // resolve to addressed — a cumulative ASR hypothesis just added
              // the wake phrase. If a fabricated sentence arrived earlier this
              // reply while still undecided, its suppression already applied
              // (inspectForFabrication is never gated on being addressed) but
              // the honest line may still be waiting on exactly this moment,
              // since no further TtsSentence/ChatResponse delta is guaranteed
              // to arrive after this to trigger it otherwise.
              fabricationGuard.announceIfDetected();
              sendClient({ type: "status", state: "asr", detail: `豆包听到：${text}` });
              sendClient(transcriptEvent(riderDelivery, "rider", text, { final: false }));
            }
          }
          return;
        }

        if (frame.event === EventReceive.ChatResponse) {
          if (fallbackSpoke && asksCurrentLocation(riderTurnText)) return;
          currentQuestionId = stringField(payload, "question_id") ?? currentQuestionId;
          currentReplyId = stringField(payload, "reply_id") ?? stringField(payload, "item_id") ?? currentReplyId;
          if (!chatStartedAt) chatStartedAt = Date.now();
          const text = extractChatText(payload);
          if (text) {
            chatText += text;
            // Backstop for a reply whose TtsSentenceStart/End never arrives at
            // all (the same gap the TTS-fallback browser-speech path exists to
            // cover) — chatText is the only accumulator pendingReplyText()
            // then has left to fall back to, so it must be checked here too.
            // Checked against the full accumulation so far, not just this
            // chunk's own delta: ChatResponse deltas are raw, often
            // sub-sentence LLM tokens with no reliable per-chunk boundary to
            // check individually. NOT gated on replyIsAddressed() — see
            // inspectForFabrication's doc comment for why suppression must
            // not wait on the wake decision, only the honest line's own
            // audibility (handled inside inspectForFabrication) does.
            if (inspectForFabrication(chatText)) return;
            if (!sentThinkingStatus && replyIsAddressed()) {
              sentThinkingStatus = true;
              sendClient({ type: "status", state: "thinking", detail: "豆包已生成回复文本" });
            }
          }
          return;
        }

        if (frame.event === EventReceive.TtsSentenceStart || frame.event === EventReceive.TtsSentenceEnd) {
          if (fallbackSpoke && asksCurrentLocation(riderTurnText)) return;
          currentQuestionId = stringField(payload, "question_id") ?? currentQuestionId;
          currentReplyId = stringField(payload, "reply_id") ?? stringField(payload, "item_id") ?? currentReplyId;
          const text = extractChatText(payload);
          if (text && text !== lastTtsSentence) {
            ttsText += text;
            lastTtsSentence = text;
            // Navigation truth may come only from the relay's own nav.*
            // speech, never from the model's own words — real turn-by-turn
            // never reaches this handler at all (see speakNavLine/
            // speakNavPrompt in session-controller.ts). Every sentence of a
            // fabricated reply is suppressed upstream and locally; returning
            // early here also keeps it off the live caption below, and
            // fabricationSuppressed keeps it off every later flush of this
            // reply (pendingReplyText(), further down this file). NOT gated
            // on replyIsAddressed() — see inspectForFabrication's doc comment
            // for why suppression must not wait on the wake decision, only
            // the honest line's own audibility (handled inside
            // inspectForFabrication) does.
            if (inspectForFabrication(text)) return;
            if (!sentThinkingStatus && replyIsAddressed()) {
              sentThinkingStatus = true;
              sendClient({ type: "status", state: "thinking", detail: "豆包已生成语音文本" });
            }
            // Live caption: stream the accumulated spoken text as a non-final
            // agent transcript. Clients merge non-final items in place and the
            // TtsEnded flush finalizes the entry, so nothing is duplicated.
            // No useBrowserSpeech on partials — final !== false gates client TTS.
            // !fabricationSuppressed also covers a legitimate sentence that
            // follows an earlier fabricated one in the same reply — the guard
            // itself only vetoes sentences that assert navigation, but once
            // any sentence in a reply has been flagged, none of that reply's
            // captions should reach the rider.
            if (replyIsAddressed() && !fallbackSpoke && !fabricationSuppressed && ttsText.trim()) {
              sendClient(transcriptEvent(agentDelivery, "agent", ttsText.trim(), { final: false }));
            }
          }
          return;
        }

        if (frame.event === EventReceive.ChatEnded) {
          currentQuestionId = stringField(payload, "question_id") ?? currentQuestionId;
          currentReplyId = stringField(payload, "reply_id") ?? stringField(payload, "item_id") ?? currentReplyId;
          // The reply text is complete, but TTS may still be streaming. Defer the
          // single flush to TtsEnded so the transcript uses the full spoken text
          // and isn't emitted twice. If no audio is coming, the fallback timer
          // flushes the text for browser speech.
          const addressed = replyIsAddressed();
          if (addressed && !receivedTtsAudio && pendingReplyText()) armTtsFallbackTimer();
          if (addressed) sendClient({ type: "status", state: "ready", detail: "豆包回复文本已完成" });
          return;
        }

        if (frame.event === EventReceive.TtsEnded) {
          clearTtsFallbackTimer();
          if (!replyIsAddressed()) {
            if (!replyDecided) {
              ttsEndedBeforeWakeDecision = true;
              return;
            }
            // Suppressed turn: no audio was forwarded on purpose — reporting
            // "TTS 未返回音频，浏览器备用" here would read as a fault. Just go
            // back to listening, and don't pollute latency telemetry either.
            receivedTtsAudio = false;
            awaitingReply = false;
            releaseOrdinarySpeechWaiters();
            clearUndecidedTtsAudio();
            resetPendingReply();
            markCurrentTurnSuppressed();
            deleteSuppressedTurns();
            sendClient({
              type: "status",
              state: "listening",
              detail: `正在收听 —— 说一声 "${WAKE_PHRASE_LABEL}" 唤醒 Max`
            });
            return;
          }
          // Flush exactly once, using browser speech only when no audio arrived.
          if (pendingReplyText()) flushPendingAgentText(!receivedTtsAudio);
          sendClient({
            type: "status",
            state: downstreamAudioAbandoned ? "degraded" : "ready",
            detail: downstreamAudioAbandoned
              ? "网络拥塞，本轮语音未完整播放"
              : receivedTtsAudio
                ? "豆包回复已完成"
                : "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
          });
          receivedTtsAudio = false;
          // The reply is fully resolved (real audio finished, or there never
          // was any and the flush above — empty or not — is the whole
          // "reply") — the thinking window this flag holds open is over.
          awaitingReply = false;
          releaseOrdinarySpeechWaiters();
          emitTelemetry();
          return;
        }

        if (frame.event === EventReceive.AsrEnded) {
          clearAsrTurnTimer();
          // Only now is an unaddressed classification final. Chat/TTS events
          // may have arrived between cumulative ASR hypotheses, so deciding
          // earlier could suppress a turn whose later hypothesis contains Max.
          if (riderTurnFinalized) return;
          riderTurnFinalized = true;
          asrEndedAt = Date.now();
          recordFirstAudioLatency();
          const addressed = replyIsAddressed();
          updateProviderConfig(); // Re-evaluate location freshness at each rider turn.
          if (addressed) {
            // A reply is now expected — the "thinking" window starts here,
            // before any ChatResponse/TtsSentence has even arrived. Cleared
            // below when TtsEnded already beat us here (ttsEndedBeforeWakeDecision),
            // or otherwise in TtsEnded's main branch / the TTS-fallback timer,
            // whichever resolves the reply first.
            awaitingReply = true;
            const text = riderTurnText.trim();
            if (text) {
              memory = updateSessionMemory(memory, text, rideContext.mode);
              sendClient(transcriptEvent(riderDelivery, "rider", text, { final: true }));
              dispatchDeviceCommand(text);
              emitMemory();
            }
            flushUndecidedTtsAudio();
            // Defensive, same reasoning as the AsrResponse call site above.
            // `addressed` here is only ever true when riderTurnAddressed was
            // already set (the AsrResponse handler is the only place that
            // happens), so in practice that earlier call already announced —
            // this is a no-op safety net, matching this file's existing
            // pattern of calling flushUndecidedTtsAudio() at more than one
            // resolution point rather than relying on exactly one being
            // reachable.
            if (!asksCurrentLocation(riderTurnText)) fabricationGuard.announceIfDetected();
            sendClient({ type: "status", state: "ready", detail: "豆包语音识别完成" });
            if (ttsEndedBeforeWakeDecision) {
              if (pendingReplyText()) flushPendingAgentText(!receivedTtsAudio);
              emitTelemetry();
              ttsEndedBeforeWakeDecision = false;
              awaitingReply = false;
              releaseOrdinarySpeechWaiters();
            }
          } else {
            clearUndecidedTtsAudio();
            resetPendingReply();
            markCurrentTurnSuppressed();
            deleteSuppressedTurns();
            sendClient({
              type: "status",
              state: "listening",
              detail: `正在收听 —— 说一声 "${WAKE_PHRASE_LABEL}" 唤醒 Max`
            });
          }
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
          // ConnectionFailed and SessionFailed are terminal. Doubao may report
          // them as protocol events without closing the transport, so force the
          // close that drives our in-place retry logic. DialogCommonError can be
          // scoped to one turn and remains recoverable on the same session.
          if (frame.event === EventReceive.ConnectionFailed || frame.event === EventReceive.SessionFailed) {
            sessionReady = false;
            socket.close(1011, "doubao session failed");
          }
          return;
        }

        if (frame.event === EventReceive.Usage) {
          log.info("doubao usage", { usage: payload });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "收到无效豆包载荷";
        metrics.upstreamFailure();
        log.error("invalid doubao protocol frame", { message });
        sendClient({ type: "status", state: "degraded", detail: "豆包返回了无效数据，正在重新连接" });
        socket.terminate();
      }
    });

    socket.on("close", () => {
      if (upstream !== socket) return;
      clearStateTimers();
      clearAsrTurnTimer();
      clearPendingAudioFlush();
      sessionReady = false;
      log.info("doubao upstream closed");
      clearTtsFallbackTimer();
      if (pendingReplyText()) flushPendingAgentText(true);
      // A dead socket can deliver no reply — an addressed turn that reached
      // AsrEnded but dropped before TtsEnded would otherwise leave this flag
      // stuck true, silencing watching (isSpeechOpen) until the rider's next
      // utterance, on a socket that may not even reconnect for seconds.
      awaitingReply = false;
      releaseOrdinarySpeechWaiters();

      // Torn down by the relay itself (client disconnected / provider closed):
      // nothing to revive.
      if (closedByProvider) return;

      // A session that stayed up long enough before dropping is a genuine
      // recovery, so refresh the retry budget. A session that drops within the
      // window (e.g. Doubao accepts StartSession then fails on quota/model) keeps
      // its count climbing, so repeated flaps hit MAX_UPSTREAM_RETRIES and hand
      // recovery to the client instead of reconnecting forever.
      if (upstreamOpenedAt && Date.now() - upstreamOpenedAt >= UPSTREAM_STABILITY_RESET_MS) {
        upstreamRetries = 0;
      }
      upstreamOpenedAt = 0;

      // Try to revive the upstream in place first: reconnect with backoff and
      // replay the persona + session memory (see the resumedSession addendum),
      // so a transient Doubao dropout doesn't cost the rider their session.
      if (connectConfig && upstreamRetries < MAX_UPSTREAM_RETRIES && client.readyState === client.OPEN) {
        upstreamRetries += 1;
        resumedSession = true;
        metrics.upstreamReconnect();
        const delayMs = Math.min(4000, 500 * 2 ** (upstreamRetries - 1));
        log.warn("doubao upstream dropped — reconnecting in place", { attempt: upstreamRetries, delayMs });
        sendClient({
          type: "status",
          state: "connecting",
          detail: `豆包连接中断，正在自动恢复（第 ${upstreamRetries} 次）…`
        });
        const config = connectConfig;
        upstreamReconnectTimer = setTimeout(() => {
          upstreamReconnectTimer = undefined;
          if (client.readyState === client.OPEN) connectUpstream(config);
        }, delayMs);
        return;
      }

      // Out of retries: stop the mid-ride weather refresh and close the client
      // socket so its own backoff reconnect builds a fresh relay session —
      // a dead upstream cannot be revived here once retries are exhausted.
      if (weatherRefreshTimer) {
        clearInterval(weatherRefreshTimer);
        weatherRefreshTimer = undefined;
      }
      sendClient({ type: "status", state: "closed", detail: "豆包实时代理已断开" });
      if (client.readyState === client.OPEN) {
        client.close(1011, "doubao upstream closed");
      }
    });

    socket.on("unexpected-response", (request, response) => {
      if (upstream !== socket) return;
      clearStateTimers();
      metrics.upstreamFailure();
      log.error("doubao handshake failed", {
        statusCode: response.statusCode,
        requestId: response.headers["x-tt-logid"]
      });
      sendClient({
        type: "error",
        message: `豆包语音握手失败，HTTP ${response.statusCode}。请检查 speech-dialog App ID、Access Token、Resource ID 和权限。`
      });
      // With an unexpected-response listener attached, ws does NOT abort the
      // handshake itself — without this the socket would sit in CONNECTING
      // forever and the close/retry path above would never run.
      request.destroy();
      socket.terminate();
    });

    socket.on("error", (error) => {
      if (upstream !== socket) return;
      // close() aborting our own still-CONNECTING handshake (rider left early)
      // emits an error too; counting it would make /health's upstream-failure
      // signal look like Doubao flapping.
      if (closedByProvider) return;
      metrics.upstreamFailure();
      log.error("doubao upstream error", { message: error.message });
      sendClient({ type: "status", state: "degraded", detail: "豆包音频不可用，浏览器 TTS 备用通道待命" });
      sendClient({ type: "error", message: error.message });
    });
  }

  return {
    async start(event: SessionStartEvent, context?: ProviderSessionContext) {
      if (started) return;
      sessionPlatform = event.platform;
      started = true;
      routeActiveFromContext = context?.routeActive;

      let systemRole = process.env.DOUBAO_SYSTEM_ROLE ?? DEFAULT_AGENT_SYSTEM_PROMPT;
      const scenario: DemoScenario = event.scenario ?? "commute";
      rideContext = {
        mode: rideModeFromScenario(event.rideMode, scenario),
        scenario,
        network: "online"
      };
      // A restarting client (voice/personality/mode switch) echoes back its last
      // session.memory snapshot so the agent keeps its short-term memory.
      memory = restoreSessionMemory(event.memory, rideContext.mode);
      const previousConversationPrompt = buildPreviousConversationPrompt(
        [],
        context?.previousConversation?.facts ?? []
      );
      const dialogContext = buildDoubaoDialogContext(context?.previousConversation?.turns ?? []);
      const speakingStyle = buildPersonalityPrompt(event.voicePersonality ?? "concise");
      systemRole +=
        `\n\n${buildIdentityPrompt()}` +
        `\n\n${buildToolGroundingPrompt()}` +
        `\n\n[骑行上下文] ${buildRideContextSummary(rideContext)}。` +
        `\n${buildVoiceSettingPrompt(event.voiceGender ?? "female")}` +
        `\n${buildLanguageInteractionPrompt()}` +
        `你必须根据模式调整回答长度和安全策略；紧急模式优先生命安全，导航模式只给下一步。\n${buildSafetyPrompt(
          rideContext,
          memory
        )}\n${buildIntentGuidancePrompt(memory.lastIntent)}\n${speakingStyle}\n[短期记忆] ${buildSessionMemoryPrompt(memory)}。` +
        (previousConversationPrompt ? `\n\n${previousConversationPrompt}` : "");
      emitRideContext();
      emitMemory();

      // Best-effort: fold live weather for the rider's location into the agent
      // context so weather questions are answered with real data. A failure
      // here never blocks the session — the agent just answers generically.
      // Always resolved: a rider location wins, otherwise the configured or demo
      // fallback (see config.resolveDefaultWeatherLocation), so there is no
      // "no weather location" branch to handle here.
      weatherLocation =
        typeof event.lat === "number" && typeof event.lon === "number"
          ? { lat: event.lat, lon: event.lon, source: "rider" as const }
          : appConfig.defaultWeatherLocation;
      if (weatherLocation.source === "rider") {
        void riderLocation.update(weatherLocation.lat, weatherLocation.lon).then(() => updateProviderConfig());
      }
      const initialLocation = weatherLocation;

      // Kick the weather fetch off WITHOUT awaiting it here: it now runs
      // concurrently with the upstream connection handshake and is folded into
      // the system role at StartSession (see connectUpstream). Awaiting here used
      // to serialize the weather round-trip (up to 4 s) ahead of the connect,
      // pushing the rider's opening words past the pending-audio buffer. This
      // promise resolves to the weather system-prompt addendum and never rejects.
      const weatherRolePromise = (async (): Promise<string> => {
        try {
          const weather = await fetchRiderWeather(initialLocation.lat, initialLocation.lon);
          const locationLabel =
            initialLocation.source === "rider"
              ? "骑手当前位置"
              : initialLocation.source === "configured"
                ? "默认位置"
                : "演示位置";
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
            detail: `已接入${initialLocation.source === "rider" ? "实时" : locationLabel}天气：${weather.description} ${weather.temperatureC}°C`
          });
          currentWeatherRole =
            `\n\n[实时骑行情报] ${locationLabel}${weather.summary}` +
            `${weather.riderAdvice}当骑手询问天气或风力时，只基于这条真实数据简短回答。`;
          return currentWeatherRole;
        } catch {
          log.warn("initial weather fetch failed", { lat: initialLocation.lat, lon: initialLocation.lon });
          sendClient({ type: "status", state: "ready", detail: "实时天气暂不可用，使用通用回答" });
          return "";
        }
      })();

      // Mid-ride refresh: long rides outlive the session-start snapshot, so
      // re-fetch on an interval — always against the CURRENT rider location
      // (kept fresh by location.update events). UpdateConfig keeps the model's
      // location and weather context aligned
      // with the HUD during the same live session.
      if (appConfig.weatherRefreshMs > 0) {
        weatherRefreshTimer = setInterval(() => void refreshWeather("interval"), appConfig.weatherRefreshMs);
      }

      // Kept for in-place upstream reconnects; the weather promise is resolved
      // by then, so replays reuse the same (fast) addendum.
      connectConfig = {
        sampleRate: event.sampleRate,
        channels: event.channels,
        voiceGender: event.voiceGender ?? "female",
        baseSystemRole: systemRole,
        speakingStyle,
        dialogContext,
        weatherRolePromise
      };
      connectUpstream(connectConfig);
    },
    async startAudio() {
      // Per-turn latency timers are anchored at each AsrInfo, so there's nothing
      // session-level to seed here.
      audioActive = true;
      emitRideContext();
      if (sessionReady) startPendingAudioFlush();
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
      if (!audioActive) return;
      const socket = upstream;
      if (
        sessionReady &&
        socket?.readyState === WebSocket.OPEN &&
        !pendingAudioFlushTimer &&
        socket.bufferedAmount < MAX_UPSTREAM_BUFFERED_BYTES
      ) {
        socket.send(buildAudioRequest(sessionId, chunk));
        return;
      }
      // Buffer frames that arrive before the upstream session is ready —
      // including during start()'s weather fetch, before `upstream` even exists —
      // so the rider's first words aren't lost. Bounded; oldest frames drop first.
      queuePendingAudio(chunk);
      if (sessionReady && socket?.readyState === WebSocket.OPEN) startPendingAudioFlush();
    },
    async updateLocation(lat: number, lon: number) {
      const locationUpdate = riderLocation.update(lat, lon);
      updateProviderConfig();
      void locationUpdate.then(() => {
        if (!closedByProvider) updateProviderConfig();
      });
      const previous = weatherLocation;
      weatherLocation = { lat, lon, source: "rider" };
      updateProviderConfig();
      // Refetch right away when the rider has moved far enough for the weather
      // to plausibly differ; otherwise the periodic refresh picks up the new
      // coordinates on its own. 20 km ≈ a fresh forecast cell.
      if (!previous || previous.source !== "rider" || approxDistanceKm(previous, { lat, lon }) >= 20) {
        await refreshWeather("location");
      }
    },
    async deviceResult(event) {
      const receivedAt = Date.now();
      const issued = pendingDeviceCommands.resolve(event.commandId, receivedAt);
      applyExpiredDeviceCommands(receivedAt);
      scheduleDeviceExpiry();
      if (!issued) return;
      deviceActivity.reconcile(issued.activity, event);
      if (issued.action === "vision.watch" && event.status === "ok") {
        visionGovernor.setEnabled(issued.watchOn === true);
      }
      applyDeviceReconciliation(issued.action, event, issued.okSpeech);
    },
    async hazardReport() {
      visionGovernor.noteHazard();
    },
    async cameraFrame(event) {
      // Only describe a frame that answers a camera.look this relay actually
      // issued. Peek — never resolve/consume — the pending-command registry:
      // wire order puts camera.frame before the device.result for the same
      // commandId (rdk/agent/src/main.ts's onFrame fires inside dispatch(),
      // before the device.result promise it returns), so the entry is still
      // present here in the ordinary case; deviceResult() is what actually
      // resolves it moments later. An unrecognised or wrong-action commandId
      // (a hand-rolled event from any client, on any platform) is ignored
      // quietly — Max never guesses, and never pays for a call no one asked for.
      const issued = pendingDeviceCommands.peek(event.commandId);
      if (!issued || issued.action !== "camera.look") return;

      // Capture the turn's delivery now, synchronously, rather than reading
      // the (mutable) `agentDelivery` binding once the vision call finally
      // resolves: a new rider turn can start and reassign it during the up to
      // 10 s round trip below, and reading it late would tag the description
      // onto whatever turn happens to be live then instead of the one that
      // actually asked to look.
      const delivery = agentDelivery;

      // Detached from the caller: session-controller.ts's message queue awaits
      // this method, and that queue also carries mic PCM and audio.stop in
      // wire order. Awaiting visionProvider.describe (up to a 10 s timeout)
      // here would stall the rider's live audio behind a vision-model round
      // trip. The work below still happens — visionProvider.describe never
      // throws (see server/vision.ts: it resolves null on every failure
      // path) — but the `.catch` is the backstop should that contract ever
      // regress, so a rejection here can never become an unhandled rejection.
      void (async () => {
        const description = await visionProvider.describe([event.image], issued.question);
        const line = description ?? "我看不清。";
        sendClient(transcriptEvent(delivery, "agent", line, { final: true, useBrowserSpeech: true }));
        void speakEmbedded(line).catch(() => {});
      })().catch((error) => {
        log.warn("camera frame description failed unexpectedly", { error: String(error) });
      });
    },
    async visionFrames(event) {
      // Branch on reason FIRST. Watch frames (V-C) are unsolicited and carry
      // no commandId — handed to the governor fire-and-forget so a stalled
      // (or gated) describe can never stall session-controller.ts's message
      // queue, which also carries mic PCM and audio.stop. The `.catch` is a
      // backstop; handleWatchFrame's own try/finally already keeps every
      // rule branch synchronous-safe (see vision-governor.ts).
      if (event.reason === "watch") {
        void visionGovernor.handleWatchFrame(event.image).catch(() => {});
        return;
      }
      // Gallery path (V-B), unchanged. Narrows event.commandId to string for
      // the rest of this function.
      if (!event.commandId) return;
      // Same guard shape as cameraFrame, plus the recentGalleryCommands
      // fallback declared above: a stray extra chunk can arrive after
      // device.result already resolved (deleted) the pending entry, and this
      // keeps recognising it as long as this provider itself opened the set.
      const issued = pendingDeviceCommands.peek(event.commandId) ?? recentGalleryCommands.get(event.commandId);
      if (!issued || issued.action !== "gallery.describe") return;
      if (!recentGalleryCommands.has(event.commandId)) {
        // Capture agentDelivery HERE, synchronously, on the first chunk —
        // see the recentGalleryCommands declaration above for why this must
        // not be deferred to speak time.
        recentGalleryCommands.set(event.commandId, {
          action: issued.action,
          question: issued.question,
          delivery: agentDelivery
        });
      }
      galleryFrameAssembler.accept(event);
    },
    async stopAudio() {
      audioActive = false;
      hazardInjector.stop();
      // Frames still waiting for the session to become ready belong to a mic
      // stream the rider just ended — flushing them later would replay stale
      // audio into a fresh turn.
      pendingAudio.length = 0;
      clearPendingAudioFlush();
      if (doubaoInputMode() === "push_to_talk" && upstream?.readyState === WebSocket.OPEN && sessionReady) {
        upstream.send(buildFullClientRequest(EventSend.EndAsr, sessionId));
      }
      sendClient({ type: "status", state: "ready", detail: "麦克风已静音" });
    },
    async close() {
      cancelMaxSpeech();
      closedByProvider = true;
      audioActive = false;
      hazardInjector.stop();
      clearTtsFallbackTimer();
      clearAsrTurnTimer();
      clearPendingAudioFlush();
      // A closed session must not fire a reconciliation into a dead socket.
      if (deviceExpiryTimer) {
        clearTimeout(deviceExpiryTimer);
        deviceExpiryTimer = undefined;
      }
      releaseOrdinarySpeechWaiters(true);
      pendingAudio.length = 0;
      clearUndecidedTtsAudio();
      if (upstreamReconnectTimer) {
        clearTimeout(upstreamReconnectTimer);
        upstreamReconnectTimer = undefined;
      }
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
    },
    attachNavOkSpeech(speech: string) {
      pendingDeviceCommands.attachOkSpeech("navigation.start", speech);
    },
    // A reroute confirmation belongs to no rider turn — an off-route rider
    // hasn't spoken, so the mutable `agentDelivery` binding would still carry
    // whatever deliveryId the last device-result reconciliation (or reply)
    // already spoke on. Every client dedupes agent browser-speech BY
    // DELIVERYID, so reusing it would make this line indistinguishable from
    // one already shown and get it silently dropped. Same fix as
    // speakWatchLine above: allocate a FRESH delivery inline, at speak time.
    // The RDK also needs the generated PCM on its binary audio channel.
    speakNavLine(text: string) {
      if (closedByProvider) return;
      const delivery = createTranscriptDelivery();
      sendClient(transcriptEvent(delivery, "agent", text, { final: true, useBrowserSpeech: true }));
      void speakEmbedded(text).catch(() => {});
    },
    speakNavPrompt(speech) {
      if (closedByProvider) return;
      if (sessionPlatform === "web" || sessionPlatform === "ios" || sessionPlatform === "android") {
        if (speech.interrupt) {
          cancelMaxSpeech();
          truncateInterruptedReply();
          fallbackSpoke = true;
          clearTtsFallbackTimer();
          resetPendingReply();
          awaitingReply = false;
          receivedTtsAudio = false;
          sendClient({ type: "status", state: "hearing", detail: "MAX 正在播报转向提示" });
          releaseOrdinarySpeechWaiters();
        }
        const delivery = createTranscriptDelivery();
        sendClient(transcriptEvent(delivery, "agent", speech.text, { final: true, useBrowserSpeech: false }));
        queueMaxSpeech(speech.text, speech.expiresAt);
        return;
      }
      const deliverTranscript = () => {
        const delivery = createTranscriptDelivery();
        sendClient(transcriptEvent(delivery, "agent", speech.text, { final: true, useBrowserSpeech: true }));
      };
      if (speech.interrupt) truncateInterruptedReply();
      void (async () => {
        if (sessionPlatform === "embedded") {
          await speakEmbedded(speech.text, {
            expiresAt: speech.expiresAt,
            beforeStart: speech.interrupt
              ? undefined
              : async () => {
                  await waitForOrdinarySpeech();
                  return !closedByProvider;
                },
            onStart: deliverTranscript
          });
          return;
        }
        if (!speech.interrupt) await waitForOrdinarySpeech();
        if (closedByProvider || (speech.expiresAt !== undefined && Date.now() >= speech.expiresAt)) return;
        deliverTranscript();
      })().catch(() => {});
    }
  };
}
