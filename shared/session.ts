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

const EMERGENCY_PATTERN = /事故|摔车|撞|救命|急救|报警|受伤|help|crash|crashed|emergency|ambulance/i;
const WEATHER_PATTERN = /天气|下雨|风|温度|weather|rain|wind/i;
const NAVIGATION_PATTERN = /导航|路线|回家|出口|左转|右转|route|navigate|home|turn/i;
const DIAGNOSTIC_PATTERN = /异响|故障|轮胎|刹车|发动机|油量|diagnostic|engine|brake|tire|tyre|fuel/i;
const GROUP_PATTERN = /小队|队友|发送|ETA|group|team|share/i;

const PERSONALITY_PROMPTS: Record<VoicePersonality, string> = {
  concise: "人格风格：极简。回答冷静、直接、少寒暄。",
  friendly: "人格风格：友好。保持温和鼓励，但不要啰嗦。",
  technical: "人格风格：技术型。可以给出关键机械或骑行依据，但骑行中仍保持短句。",
  rally: "人格风格：拉力领航员。像可靠领航员一样提示距离、动作和风险，语气果断。"
};

export function inferIntent(text: string): RiderIntent {
  if (EMERGENCY_PATTERN.test(text)) return "emergency";
  if (WEATHER_PATTERN.test(text)) return "weather";
  if (NAVIGATION_PATTERN.test(text)) return "navigation";
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
  const destination = inferDestination(text) ?? memory.destination;
  return {
    language: detectLanguage(text),
    destination,
    lastIntent: intent,
    responseMode: responseModeForRide(rideMode, intent)
  };
}

export function createSessionMemory(mode: RideMode): SessionMemory {
  return {
    language: "zh",
    responseMode: mode === "stop" ? "normal" : mode === "emergency" ? "emergency" : "concise"
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
        ? "骑行模式：每次最多两句，只给下一步动作、距离、风险或确认。把长任务推迟到停车后。"
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
      return "意图指导：闲聊。保持简短，不把注意力从骑行上拉走。";
    default:
      return "意图指导：语言规则。只支持中文和 English；其他语言用中文简短拒绝。";
  }
}

export function buildPersonalityPrompt(personality: VoicePersonality): string {
  return PERSONALITY_PROMPTS[personality];
}

function inferDestination(text: string): string | undefined {
  const zhMatch = text.match(/(?:去|到|回)([^，。,.!?]{1,12})/);
  if (zhMatch?.[1]) return zhMatch[1].trim();
  const enMatch = text.match(/\b(?:to|home to|navigate to|route to)\s+([a-z0-9\s-]{3,28})/i);
  if (enMatch?.[1]) return enMatch[1].trim();
  return undefined;
}
