import { detectLanguage, type SupportedLanguage } from "./language";
import type { VoicePersonality } from "./agent";
import type { RideContext, RideMode } from "./ride";

export type ResponseMode = "concise" | "normal" | "emergency";
export type RiderIntent = "navigation" | "weather" | "emergency" | "diagnostics" | "group" | "casual";

export type SessionMemory = {
  language: SupportedLanguage;
  destination?: string;
  lastIntent?: RiderIntent;
  responseMode: ResponseMode;
};

// Latin keywords are whole-word (\b): without boundaries "rain" fired inside
// "train", "tire" inside "tired", "eta" inside "details". Chinese keywords have
// no word boundaries; single characters that collide inside common words get a
// targeted lookbehind instead (风 in 麦克风 "microphone").
const EMERGENCY_PATTERN =
  /事故|车祸|摔车|摔倒|摔了|撞|救命|急救|报警|受伤|受了伤|\b(?:help|crash(?:ed)?|emergency|ambulance|fell|hurt|injured|accident)\b/i;
// 风 alone also appears in non-weather words: 麦克风 (microphone), 中风
// (stroke), 风格 (style) — exclude those specific collisions.
const WEATHER_PATTERN = /天气|下雨|(?<!麦克|中)风(?!格)|温度|\b(?:weather|rain(?:y|ing)?|wind(?:y)?)\b/i;
const NAVIGATION_PATTERN = /导航|路线|回家|出口|左转|右转|\b(?:route|navigate|home|turn)\b/i;
const DIAGNOSTIC_PATTERN = /异响|故障|轮胎|刹车|发动机|油量|\b(?:diagnostics?|engine|brake|tires?|tyres?|fuel)\b/i;
const GROUP_PATTERN = /小队|队友|发送|\b(?:eta|group|team|share)\b/i;

const PERSONALITY_PROMPTS: Record<VoicePersonality, string> = {
  concise: "人格风格：极简。回答冷静、直接、少寒暄。",
  friendly: "人格风格：友好。保持温和鼓励，但不要啰嗦。",
  technical: "人格风格：技术型。可以给出关键机械或骑行依据，但骑行中仍保持短句。",
  rally: "人格风格：拉力领航员。像可靠领航员一样提示距离、动作和风险，语气果断。"
};

export function inferIntent(text: string): RiderIntent {
  if (EMERGENCY_PATTERN.test(text)) return "emergency";
  // Navigation outranks weather: a mixed ask ("navigate home, will it rain?")
  // needs the next-action guidance more than the forecast framing.
  if (NAVIGATION_PATTERN.test(text)) return "navigation";
  if (WEATHER_PATTERN.test(text)) return "weather";
  if (DIAGNOSTIC_PATTERN.test(text)) return "diagnostics";
  if (GROUP_PATTERN.test(text)) return "group";
  return "casual";
}

export function responseModeForRide(mode: RideMode, intent: RiderIntent): ResponseMode {
  if (mode === "emergency" || intent === "emergency") return "emergency";
  if (mode === "ride" || mode === "navigation") return "concise";
  return "normal";
}

export function updateSessionMemory(memory: SessionMemory, text: string, rideMode: RideMode): SessionMemory {
  const intent = inferIntent(text);
  // Only navigation-shaped turns can set a destination. 到/回 are everyday verb
  // complements (听到 "heard", 迟到 "late"), so an unrestricted capture turned
  // phrases like 我听到异响 into destination 异响 — which then stuck in memory
  // and was injected into the prompt as 目的地 for the rest of the ride.
  const destination = (intent === "navigation" ? inferDestination(text) : undefined) ?? memory.destination;
  return {
    language: preferredLanguage(text, memory.language),
    destination,
    lastIntent: intent,
    responseMode: responseModeForRide(rideMode, intent)
  };
}

/**
 * Session-level language preference. detectLanguage is per-utterance
 * best-effort; adopting it wholesale made one Latin token ("OK", "yes", a road
 * name) flip a Chinese session to English TTS/prompting until the next Han
 * turn. Switch to English only on distinctly English speech; any Han character
 * still switches to Chinese immediately.
 */
function preferredLanguage(text: string, previous: SupportedLanguage): SupportedLanguage {
  if (detectLanguage(text) === "zh") return "zh";
  const latinWords = text.match(/[a-z]+/gi) ?? [];
  // Only a multi-word Latin utterance is "distinctly English." A lone token —
  // however long — stays on the previous language: a single proper noun like a
  // road name ("Gangnam") must not flip a Chinese session's prompt + TTS voice.
  return latinWords.length >= 2 ? "en" : previous;
}

export function createSessionMemory(mode: RideMode): SessionMemory {
  return {
    language: "zh",
    responseMode: mode === "stop" ? "normal" : mode === "emergency" ? "emergency" : "concise"
  };
}

const RIDER_INTENT_VALUES: ReadonlySet<string> = new Set([
  "navigation",
  "weather",
  "emergency",
  "diagnostics",
  "group",
  "casual"
]);

/** Longest destination a restart snapshot may carry back into the prompt. */
export const MAX_MEMORY_DESTINATION_CHARS = 64;

/**
 * Rebuilds session memory from a client-echoed snapshot (see
 * SessionMemorySnapshot in shared/agent.ts). Untrusted input: every field is
 * revalidated, and responseMode is re-derived from the CURRENT ride mode
 * rather than restored, so a stale snapshot can't pin the wrong verbosity.
 */
export function restoreSessionMemory(
  snapshot: { language?: string; destination?: string; lastIntent?: string } | undefined,
  mode: RideMode
): SessionMemory {
  const base = createSessionMemory(mode);
  if (!snapshot) return base;

  const lastIntent =
    typeof snapshot.lastIntent === "string" && RIDER_INTENT_VALUES.has(snapshot.lastIntent)
      ? (snapshot.lastIntent as RiderIntent)
      : undefined;
  const destination =
    typeof snapshot.destination === "string" && snapshot.destination.trim()
      ? // Slice by code point — a UTF-16 slice can bisect a surrogate pair and
        // embed a lone surrogate in the prompt.
        [...snapshot.destination.trim()].slice(0, MAX_MEMORY_DESTINATION_CHARS).join("")
      : undefined;

  return {
    language: snapshot.language === "en" ? "en" : base.language,
    destination,
    lastIntent,
    // Re-derive verbosity from the CURRENT mode. A restored emergency intent
    // must not pin emergency verbosity on its own (responseModeForRide would):
    // the intent may be hours stale, while a genuinely ongoing emergency is
    // reflected in the current ride mode, which base already accounts for.
    responseMode: lastIntent && lastIntent !== "emergency" ? responseModeForRide(mode, lastIntent) : base.responseMode
  };
}

export function buildSessionMemoryPrompt(memory: SessionMemory): string {
  const parts = [
    `语言偏好：${memory.language === "zh" ? "中文" : "English"}`,
    `回答模式：${memory.responseMode}`,
    `最近意图：${memory.lastIntent ?? "未知"}`
  ];
  if (memory.destination) parts.push(`目的地：${memory.destination}`);
  return parts.join("；");
}

export function buildSafetyPrompt(context: RideContext, memory: SessionMemory): string {
  const mode = memory.responseMode;
  const isFast = typeof context.speedKmh === "number" && context.speedKmh >= 60;
  const limits =
    mode === "emergency"
      ? "紧急模式：用命令式短句。先让骑手减速、靠边、打开警示并寻求帮助。不要展开复杂排障。"
      : mode === "concise"
        ? "骑行模式：每次最多两句。导航和安全问题只给下一步动作、距离、风险或确认；闲聊、笑话、短故事和常识问题用一两句话直接回答。把需要看屏幕或多步操作的长任务推迟到停车后。"
        : "停车模式：可以稍微完整，但仍保持清晰简短。";
  const speedPolicy = isFast ? "高速/较快移动：每次只问一个必要问题，不提供复杂菜单或长列表。" : "";

  const telemetry = [
    typeof context.speedKmh === "number" ? `速度约 ${context.speedKmh} km/h` : "",
    context.routePhase ? `路线阶段：${context.routePhase}` : "",
    context.network ? `网络：${context.network}` : "",
    typeof context.batteryPct === "number" ? `电量：${context.batteryPct}%` : ""
  ]
    .filter(Boolean)
    .join("；");

  return `[安全策略] ${limits}${speedPolicy ? ` ${speedPolicy}` : ""}${telemetry ? ` 当前骑行情报：${telemetry}。` : ""}`;
}

export function buildIntentGuidancePrompt(intent: RiderIntent | undefined): string {
  switch (intent) {
    case "navigation":
      return "意图指导：导航/帮助。只给下一步动作、距离、车道或风险。";
    case "weather":
      return "意图指导：天气。优先回答温度、风、雨和骑行风险。";
    case "emergency":
      return "意图指导：紧急。先确认骑手是否安全，再给靠边、警示、求助的下一步。";
    case "diagnostics":
      return "意图指导：摩托车诊断。骑行中只给安全停靠建议，停车后再排查。";
    case "group":
      return "意图指导：小队。准备消息但避免骑行中发送需要确认的内容。";
    case "casual":
      return "意图指导：闲聊。用一两句话直接给出对方要的内容（笑话、短故事、常识、建议都可以），不要拒绝，不要转移话题，也不要让对方停车后再问。";
    default:
      return "意图指导：语言规则。只支持中文和 English；其他语言用中文简短拒绝。";
  }
}

export function buildPersonalityPrompt(personality: VoicePersonality): string {
  return PERSONALITY_PROMPTS[personality];
}

function inferDestination(text: string): string | undefined {
  // Stop at any punctuation — including the fullwidth ？！、 that Chinese ASR
  // emits — so 带我回家！ captures 家, not 家！.
  const zhMatch = text.match(/(?:去|到|回)([^，。,.!?？！、；：\s]{1,12})/);
  if (zhMatch?.[1]) {
    const raw = zhMatch[1].trim();
    // Punctuation-free Chinese ASR over-captures the following action clause
    // (到公司门口接我 → 公司门口接我). Trim a trailing verb+object clause so the
    // stored 目的地 is place-like. The object is REQUIRED, so place names that
    // merely start with such a verb (小吃街, 接待中心, 纽约) are left intact.
    const trimmed = raw.replace(
      /(?:接|送|找|见|等|叫|陪|带)(?:我|你|他|她|我们|你们|一下|一趟).*$|吃(?:个|顿)?(?:饭|东西|夜宵|早饭|午饭|晚饭).*$/,
      ""
    );
    return (trimmed || raw).trim();
  }
  // Require a destination-bearing phrase. A bare "to" would over-match ordinary
  // infinitives ("I want to ride") and capture them as a destination. Cap the
  // place at four words so a trailing clause ("… right now please") isn't
  // captured and hard-cut mid-word at a character limit.
  const enMatch = text.match(
    /\b(?:home to|navigate to|route to|head(?:ing|ed)? to|drive to|going to|take me to)\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,3})/i
  );
  if (enMatch?.[1]) {
    return enMatch[1].replace(/(?:\s+(?:please|now|asap|right))+$/i, "").trim();
  }
  return undefined;
}
