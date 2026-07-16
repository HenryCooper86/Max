import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { AgentProvider, ProviderTelemetry, SessionStartEvent, VoiceGender } from "./types";
import { DOUBAO_CAPABILITIES } from "../../shared/agent";
import { type AdasSeverity } from "../../shared/adas";
import {
  containsWakePhrase,
  WAKE_FOLLOWUP_MAX_CHAIN_MS,
  WAKE_FOLLOWUP_WINDOW_MS,
  WAKE_PHRASE_LABEL
} from "../../shared/wake";
import { config as appConfig } from "../config";
import { createHazardInjector } from "../hazard-injector";
import { createLogger, type Logger } from "../logger";
import { metrics } from "../metrics";
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
  // The relay requests no compression; a compressed payload would otherwise
  // fail JSON.parse on every frame with a misleading per-frame error.
  const compression = data[2] & 0b1111;
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
const MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;

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

/** In-place upstream reconnect attempts before giving up and bouncing the client. */
const MAX_UPSTREAM_RETRIES = 3;

export function createDoubaoProvider(
  client: WebSocket,
  log: Logger = createLogger("doubao"),
  telemetry?: ProviderTelemetry
): AgentProvider {
  let upstream: WebSocket | undefined;
  let started = false;
  let sessionId = randomUUID();
  let sessionReady = false;
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
  let receivedTtsAudio = false;
  let ttsFallbackTimer: NodeJS.Timeout | undefined;
  // Measured chat→first-audio latency of the previous turn; the TTS fallback
  // wait adapts upward from the configured floor so a slow link doesn't trip
  // the browser-speech fallback while real audio is still in flight.
  let lastFirstAudioLatencyMs = 0;
  let weatherRefreshTimer: NodeJS.Timeout | undefined;
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
  let lastFlushedAgentTextKey = "";
  let lastFlushedAgentTextAt = 0;
  let rideContext: RideContext = { mode: "ride", scenario: "commute" };
  let memory: SessionMemory = createSessionMemory("ride");
  // Per-turn latency anchors. Reset at each rider turn (AsrInfo) so telemetry
  // and the adaptive TTS-fallback delay reflect the current turn, not just the
  // first turn of the session.
  let asrStartedAt = 0;
  let asrFirstTextAt = 0;
  let chatStartedAt = 0;
  let firstAudioAt = 0;
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

  function sendClient(payload: unknown) {
    if (client.readyState === client.OPEN) {
      const encoded = JSON.stringify(payload);
      telemetry?.serverEvent(payload, Buffer.byteLength(encoded));
      client.send(encoded);
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
      replyAddressed = riderTurnAddressed;
      replyDecided = true;
      if (!replyAddressed) log.debug("reply suppressed — rider did not address Max", { riderTurnText });
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
    lastTtsSentence = "";
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
        metrics.ttsFallback();
        telemetry?.ttsFallback();
        flushPendingAgentText(true);
        // Browser speech now owns this reply; suppress any late Doubao audio.
        fallbackSpoke = true;
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

  // Simulated ADAS hazards on the live path — only for the dedicated ADAS scenario
  // so normal voice sessions aren't interrupted. See server/hazard-injector.ts.
  const hazardInjector = createHazardInjector({ send: sendClient, emitRideContext });

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
    } catch {
      log.warn("weather refresh failed — keeping last reading", { trigger });
    }
  }

  function emitTelemetry(totalEnd = Date.now()) {
    const asrMs = asrStartedAt && asrFirstTextAt ? asrFirstTextAt - asrStartedAt : 0;
    const thinkMs = asrFirstTextAt && chatStartedAt ? chatStartedAt - asrFirstTextAt : 0;
    const firstAudioMs = chatStartedAt && firstAudioAt ? firstAudioAt - chatStartedAt : 0;
    const totalMs = asrStartedAt ? totalEnd - asrStartedAt : 0;
    if (asrMs || thinkMs || firstAudioMs || totalMs) {
      log.info("turn telemetry", { asrMs, thinkMs, firstAudioMs, totalMs });
      sendClient({ type: "telemetry", asrMs, thinkMs, firstAudioMs, totalMs });
    }
  }

  function connectUpstream(config: ConnectConfig) {
    const url = process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    upstream = new WebSocket(url, { headers: buildDoubaoHeaders() });

    upstream.on("open", () => {
      log.info("doubao upstream opened");
      upstream?.send(buildFullClientRequest(EventSend.StartConnection));
      sendClient({ type: "status", state: "connecting", detail: "豆包语音连接已打开" });
    });

    // Handlers that suspend (awaiting the weather promise) must verify they
    // still belong to the CURRENT upstream: after an in-place reconnect the
    // shared `upstream` variable points at the replacement socket, and a stale
    // continuation would double-send StartSession on it.
    const socket = upstream;

    upstream.on("message", async (message) => {
      try {
        const frame = parseDoubaoFrame(message);

        if (frame.errorCode !== undefined) {
          const detail = frame.payload.toString().slice(0, 300);
          metrics.upstreamFailure();
          log.error("doubao error frame", { code: frame.errorCode, detail });
          sendClient({ type: "status", state: "degraded", detail: "豆包连接异常，已保留浏览器 TTS 备用通道" });
          sendClient({ type: "error", message: `豆包错误 ${frame.errorCode}：${detail || "未知错误"}` });
          return;
        }

        // Once this turn is decided unaddressed, the reply stream is dead
        // weight — Doubao synthesizes the full reply regardless — so drop the
        // per-token/per-chunk frames before any JSON parsing. End-of-turn
        // events (ChatEnded/TtsEnded) still run their bookkeeping.
        if (
          wakeWordEnabled &&
          (frame.event === EventReceive.TtsResponse ||
            frame.event === EventReceive.ChatResponse ||
            frame.event === EventReceive.TtsSentenceStart ||
            frame.event === EventReceive.TtsSentenceEnd) &&
          !replyIsAddressed()
        ) {
          return;
        }

        if (frame.event === EventReceive.ConnectionStarted) {
          sessionId = randomUUID();
          // Fold in the concurrently-fetched weather (bounded; "" if unavailable),
          // then start the session. Doubao sends nothing until StartSession, so
          // awaiting here only defers our own next send.
          const weatherRole = await config.weatherRolePromise;
          let systemRole = config.baseSystemRole + weatherRole;
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
              buildDoubaoSessionConfig({
                sampleRate: config.sampleRate,
                channels: config.channels,
                voiceGender: config.voiceGender,
                systemRole
              })
            )
          );
          return;
        }

        if (frame.event === EventReceive.SessionStarted) {
          sessionReady = true;
          upstreamRetries = 0;
          log.info(resumedSession ? "doubao session resumed after reconnect" : "doubao session started", {
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
          // If the fallback already spoke this reply via browser speech, drop the
          // late Doubao audio so the rider doesn't hear it twice.
          if (fallbackSpoke) return;
          if (!firstAudioAt) {
            firstAudioAt = Date.now();
            if (chatStartedAt) {
              lastFirstAudioLatencyMs = firstAudioAt - chatStartedAt;
              sendClient({ type: "metric", latencyMs: lastFirstAudioLatencyMs });
            }
            // Once per turn, on the transition into speaking — not per audio
            // chunk, which repeated the same status dozens of times a reply.
            sendClient({ type: "status", state: "speaking", detail: "已收到豆包语音音频" });
          }
          // Backpressure guard: if the client socket cannot drain (slow or stalled
          // link), drop voice frames instead of queueing them in server memory.
          // Only mark the turn as having delivered audio (and cancel the
          // browser-speech fallback) when a frame is actually forwarded —
          // otherwise a fully-saturated link would report "spoke" while the rider
          // heard nothing and got no fallback.
          if (client.readyState === client.OPEN && client.bufferedAmount < MAX_CLIENT_BUFFERED_BYTES) {
            receivedTtsAudio = true;
            clearTtsFallbackTimer();
            telemetry?.serverAudio(frame.payload.byteLength);
            client.send(frame.payload, { binary: true });
          }
          return;
        }

        const payload = parseJsonPayload(frame);
        if (frame.event === EventReceive.AsrInfo) {
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
          receivedTtsAudio = false;
          // Anchor the per-turn latency timers and reset the wake-word
          // accumulation, decision latch, and double-speak guard.
          asrStartedAt = Date.now();
          asrFirstTextAt = 0;
          chatStartedAt = 0;
          firstAudioAt = 0;
          sentThinkingStatus = false;
          fallbackSpoke = false;
          riderTurnText = "";
          riderTurnFinalized = false;
          riderTurnAddressed = false;
          replyDecided = false;
          replyAddressed = false;
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
            if (!sentThinkingStatus && replyIsAddressed()) {
              sentThinkingStatus = true;
              sendClient({ type: "status", state: "thinking", detail: "豆包已生成回复文本" });
            }
          }
          return;
        }

        if (frame.event === EventReceive.TtsSentenceStart || frame.event === EventReceive.TtsSentenceEnd) {
          const text = extractChatText(payload);
          if (text && text !== lastTtsSentence) {
            ttsText += text;
            lastTtsSentence = text;
            if (!sentThinkingStatus && replyIsAddressed()) {
              sentThinkingStatus = true;
              sendClient({ type: "status", state: "thinking", detail: "豆包已生成语音文本" });
            }
            // Live caption: stream the accumulated spoken text as a non-final
            // agent transcript. Clients merge non-final items in place and the
            // TtsEnded flush finalizes the entry, so nothing is duplicated.
            // No useBrowserSpeech on partials — final !== false gates client TTS.
            if (replyIsAddressed() && !fallbackSpoke && ttsText.trim()) {
              sendClient({ type: "transcript", speaker: "agent", text: ttsText.trim(), final: false });
            }
          }
          return;
        }

        if (frame.event === EventReceive.ChatEnded) {
          // The reply text is complete, but TTS may still be streaming. Defer the
          // single flush to TtsEnded so the transcript uses the full spoken text
          // and isn't emitted twice. If no audio is coming, the fallback timer
          // flushes the text for browser speech.
          if (!receivedTtsAudio && pendingReplyText()) armTtsFallbackTimer();
          if (replyIsAddressed()) sendClient({ type: "status", state: "ready", detail: "豆包回复文本已完成" });
          return;
        }

        if (frame.event === EventReceive.TtsEnded) {
          clearTtsFallbackTimer();
          if (!replyIsAddressed()) {
            // Suppressed turn: no audio was forwarded on purpose — reporting
            // "TTS 未返回音频，浏览器备用" here would read as a fault. Just go
            // back to listening, and don't pollute latency telemetry either.
            receivedTtsAudio = false;
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
            state: "ready",
            detail: receivedTtsAudio ? "豆包回复已完成" : "豆包 TTS 未返回音频，正在使用浏览器语音备用模式"
          });
          receivedTtsAudio = false;
          emitTelemetry();
          return;
        }

        if (frame.event === EventReceive.AsrEnded) {
          // Close the rider turn with a final transcript carrying the full
          // accumulated utterance. Without it, rider turns stayed non-final
          // forever and two separate utterances (e.g. around a suppressed
          // wake-word reply) merged into one, destroying the earlier text in
          // the tester chat-history drilldown.
          if (!riderTurnFinalized && riderTurnText.trim()) {
            riderTurnFinalized = true;
            sendClient({ type: "transcript", speaker: "rider", text: riderTurnText.trim(), final: true });
          }
          sendClient({ type: "status", state: "ready", detail: "豆包语音识别完成" });
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

      // Torn down by the relay itself (client disconnected / provider closed):
      // nothing to revive.
      if (closedByProvider) return;

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

    upstream.on("unexpected-response", (request, response) => {
      metrics.upstreamFailure();
      log.error("doubao handshake failed", { statusCode: response.statusCode });
      sendClient({
        type: "error",
        message: `豆包语音握手失败，HTTP ${response.statusCode}。请检查 speech-dialog App ID、Access Token、Resource ID 和权限。`
      });
      // With an unexpected-response listener attached, ws does NOT abort the
      // handshake itself — without this the socket would sit in CONNECTING
      // forever and the close/retry path above would never run.
      request.destroy();
    });

    upstream.on("error", (error) => {
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
      // A restarting client (voice/personality/mode switch) echoes back its last
      // session.memory snapshot so the agent keeps its short-term memory.
      memory = restoreSessionMemory(event.memory, rideContext.mode);
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
      // Always resolved: a rider location wins, otherwise the configured or demo
      // fallback (see config.resolveDefaultWeatherLocation), so there is no
      // "no weather location" branch to handle here.
      weatherLocation =
        typeof event.lat === "number" && typeof event.lon === "number"
          ? { lat: event.lat, lon: event.lon, source: "rider" as const }
          : appConfig.defaultWeatherLocation;
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
          return (
            `\n\n[实时骑行情报] ${locationLabel}${weather.summary}` +
            `${weather.riderAdvice}当骑手询问天气、风力或路况时，请基于这条真实数据简短回答。`
          );
        } catch {
          log.warn("initial weather fetch failed", { lat: initialLocation.lat, lon: initialLocation.lon });
          sendClient({ type: "status", state: "ready", detail: "实时天气暂不可用，使用通用回答" });
          return "";
        }
      })();

      // Mid-ride refresh: long rides outlive the session-start snapshot, so
      // re-fetch on an interval — always against the CURRENT rider location
      // (kept fresh by location.update events). The Doubao system role is
      // fixed once the session starts, so the agent's own context freshens on
      // the next session; the HUD and hazard fusion stay live.
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
        weatherRolePromise
      };
      connectUpstream(connectConfig);
    },
    async startAudio() {
      // Per-turn latency timers are anchored at each AsrInfo, so there's nothing
      // session-level to seed here.
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
      if (sessionReady && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(buildAudioRequest(sessionId, chunk));
        return;
      }
      // Buffer frames that arrive before the upstream session is ready —
      // including during start()'s weather fetch, before `upstream` even exists —
      // so the rider's first words aren't lost. Bounded; oldest frames drop first.
      if (pendingAudio.length >= MAX_PENDING_AUDIO_FRAMES) pendingAudio.shift();
      pendingAudio.push(chunk);
    },
    async updateLocation(lat: number, lon: number) {
      const previous = weatherLocation;
      weatherLocation = { lat, lon, source: "rider" };
      // Refetch right away when the rider has moved far enough for the weather
      // to plausibly differ; otherwise the periodic refresh picks up the new
      // coordinates on its own. 20 km ≈ a fresh forecast cell.
      if (!previous || previous.source !== "rider" || approxDistanceKm(previous, { lat, lon }) >= 20) {
        await refreshWeather("location");
      }
    },
    async stopAudio() {
      hazardInjector.stop();
      // Frames still waiting for the session to become ready belong to a mic
      // stream the rider just ended — flushing them later would replay stale
      // audio into a fresh turn.
      pendingAudio.length = 0;
      if (upstream?.readyState === WebSocket.OPEN && sessionReady) {
        upstream.send(buildFullClientRequest(EventSend.EndAsr, sessionId));
      }
      sendClient({ type: "status", state: "ready", detail: "麦克风已静音" });
    },
    async close() {
      closedByProvider = true;
      hazardInjector.stop();
      clearTtsFallbackTimer();
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
    }
  };
}
