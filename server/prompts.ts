// Operating rules shared by every voice backend. They are written in Chinese
// because the original helmet was tuned in Chinese; every supported model
// follows them regardless of the language it answers in.

import type { PromptAudience } from "../shared/session";

// Small local models with thinking off repeat a scripted refusal whenever they are unsure, so ordinary
// questions came back as "I only support Chinese and English". They get the same limit without the script.
const SCRIPTED_REFUSALS: ReadonlyArray<readonly [string, string]> = [
  ["如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文和 English。", ""],
  ["如果听到中文和英文以外的语言、或骑手要求使用其他语言，只用中文简短拒绝：我只支持中文和 English。", ""],
  ["意图指导：语言规则。只支持中文和 English；其他语言用中文简短拒绝。", "意图指导：一般问题。直接简短回答。"]
];
const ANSWER_LANGUAGE_RULE =
  "\n\n[回答语言] 只用中文或 English 回答。对方说中文就用中文回答；对方说其他任何语言，或要求你改用其他语言，都用 English 回答。";

/** The part of the tool rule that lets a model fill the silence before a tool call. */
export const TOOL_ANNOUNCE_RULE = {
  zh: "调用工具之前可以先简短说一句你要做什么（例如“我查一下”）。",
  en: 'You may say a few words first so the user is not left in silence (for example: "Let me check.").'
} as const;
// A small local model with thinking off takes the invitation literally: it says "Let me check." and
// ends its turn without calling anything. It is told to call first and speak once it has the result.
const TOOL_CALL_FIRST_RULE = {
  zh: "需要工具时直接调用，不要先说“我查一下”之类的话；拿到结果后再回答。",
  en: "When you need a tool, call it straight away without announcing it, and speak once you have its result."
} as const;

/** The instructions for a local model replying without a thinking step. Apart from the tool rule, a
 *  customised assistant, whose persona has no scripted refusal, is left exactly as written. */
export function forFastLocalModel(instructions: string): string {
  const direct = instructions
    .replace(TOOL_ANNOUNCE_RULE.zh, TOOL_CALL_FIRST_RULE.zh)
    .replace(TOOL_ANNOUNCE_RULE.en, TOOL_CALL_FIRST_RULE.en);
  if (!direct.includes("我只支持中文和 English")) return direct;
  const rewritten = SCRIPTED_REFUSALS.reduce((text, [line, next]) => text.replaceAll(line, next), direct);
  return rewritten + ANSWER_LANGUAGE_RULE;
}

export function buildLanguageInteractionPrompt(): string {
  return (
    "[语言与交互规则] 默认先用中文回应；只有当骑手明确使用 English 或要求 English 时才切换英文。" +
    "如果听到中文和英文以外的语言、或骑手要求使用其他语言，只用中文简短拒绝：我只支持中文和 English。" +
    "每次回复优先给下一步可执行动作；骑行中最多问一个必要问题，避免菜单、长列表和需要看屏幕的说明。" +
    "[网络恢复交互] 骑手提到网络、信号或连接中断、断联、重连或恢复时，先直接回应网络连接问题，" +
    "再给简短的安全检查或有限重试建议，不要只给泛泛的导航或车距建议。" +
    "连接状态未经系统确认时，不要声称网络已恢复、重连成功或某项操作已经执行；" +
    "需要手动检查手机时，建议在安全停车后处理。"
  );
}

/** Declares the device actions the system can actually execute, and keeps every
 * other external action explicitly out of reach. The success-only rule is now
 * load-bearing: the relay dispatches real commands and corrects Max out loud
 * when one fails. */
export function buildToolGroundingPrompt(audience: PromptAudience = "rider"): string {
  if (audience === "wearer") return WEARER_TOOL_GROUNDING;
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

// The same boundary for a wearable that is not a helmet: the device actions and
// honesty rules are identical, but nothing assumes the wearer is riding, and
// the assistant's own tools are not ruled out.
const WEARER_TOOL_GROUNDING =
  "[真实能力边界] 你可以请求系统执行这些设备动作：开关手电筒、调整你自己的说话音量、" +
  "请求音乐播放控制（默认 QQ 音乐，也可手动选择 Apple Music 或本机音乐）、准备短信、拨打电话、语音导航（实时路线指引，仅汽车路线）、拍照和录像（录像无声音）、关机（10秒倒计时后干净地关闭设备，期间说取消关机可以撤销）。" +
  "这些都是语音免手操作。用户要求其中任何一项时直接执行，不要以分心或不安全为由拒绝，也不要让用户稍后再做。" +
  "天气信息由系统注入，可以当作实时事实。" +
  "QQ 音乐在 Android 上可通过用户授权的媒体会话控制已有队列；iOS 和网页目前仅提供官网入口，不能控制 QQ 音乐播放。打开官网不代表播放成功。不支持搜索或点播指定 QQ 歌曲。必须等待设备结果再回答。" +
  "除了这些设备动作和系统提供给你的工具之外，你没有其他能力：没有实时交通、附近地点搜索、其他第三方音乐应用。" +
  "拨号和短信必须由用户在手机上确认，你只说正在准备，不要说已经拨通或已经发送。" +
  "任何动作只有在系统明确返回成功之后才可以说已完成；系统没有回应之前，不要描述结果。" +
  "导航路线、路名、转弯方向和距离只能来自系统导航提示，不要自己编造。用户当前位置可来自系统的手机实时定位，无需启动导航；没有最新定位时如实说明，不得把默认或演示天气地点当作用户位置。" +
  "用户在录像或导航后说‘取消’、‘停一下’或 cancel it 时，系统会根据当前动作处理；你必须等待系统结果，不能自行声称已经停止。";

/** The wording a device's rules use: a helmet's wearer is riding, nobody else is. */
export function promptAudience(profile: { preset: { family: string } }): PromptAudience {
  return profile.preset.family === "helmet" ? "rider" : "wearer";
}

/** Live weather for a wearer who is not riding: the facts, without the riding advice. */
export function buildWearerWeatherPrompt(location: "rider" | "configured" | "demo", summary: string): string {
  const label = location === "rider" ? "用户当前位置" : location === "configured" ? "默认位置" : "演示位置";
  return `\n\n[实时天气] ${label}${summary}当对方询问天气或风力时，只基于这条真实数据简短回答。`;
}

const SESSION_LANGUAGE_NAMES: Record<string, { zh: string; en: string }> = {
  zh: { zh: "中文", en: "Chinese" },
  en: { zh: "English", en: "English" },
  ja: { zh: "日语", en: "Japanese" },
  ko: { zh: "韩语", en: "Korean" },
  es: { zh: "西班牙语", en: "Spanish" },
  fr: { zh: "法语", en: "French" },
  de: { zh: "德语", en: "German" },
  pt: { zh: "葡萄牙语", en: "Portuguese" },
  ru: { zh: "俄语", en: "Russian" },
  ar: { zh: "阿拉伯语", en: "Arabic" },
  hi: { zh: "印地语", en: "Hindi" },
  it: { zh: "意大利语", en: "Italian" },
  tr: { zh: "土耳其语", en: "Turkish" }
};

/** The base language of a tag: "en-US" → "en". Empty when it is not a tag. */
export function baseLanguage(tag: unknown): string {
  if (typeof tag !== "string") return "";
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/i.exec(tag.trim());
  return match ? match[1]!.toLowerCase() : "";
}

/**
 * The language the assistant should answer in for one session, given the
 * language the wearer's app is set to. It applies only when the assistant
 * actually speaks that language and it is not already its first one: an app
 * in English makes a Chinese-first assistant answer in English, and an app in
 * a language the assistant does not speak changes nothing. Returns "" when
 * the assistant's own default stands.
 */
export function sessionLanguage(requested: unknown, spoken: readonly string[]): string {
  const base = baseLanguage(requested);
  if (!base) return "";
  const speaks = spoken.map((language) => baseLanguage(language));
  if (!speaks.includes(base) || speaks[0] === base) return "";
  return base;
}

/**
 * Tells the model which language this session runs in. It is appended after
 * the assistant's general language rule and says so, because that rule names
 * a different default. Written in both languages so the instruction is
 * unmistakable whichever one the model weighs more.
 */
export function buildSessionLanguagePrompt(requested: unknown, spoken: readonly string[]): string {
  const language = sessionLanguage(requested, spoken);
  if (!language) return "";
  const name = SESSION_LANGUAGE_NAMES[language] ?? { zh: language, en: language };
  return (
    `[本次会话语言] 对方的应用界面设置为 ${name.zh}。本次会话默认用 ${name.zh} 回答，包括确认、提醒、安全提示和闲聊；` +
    `这一条优先于上面的默认语言规则。只有当对方明确改用其他受支持的语言时才切换。` +
    ` [Session language] The wearer's app is set to ${name.en}. Answer in ${name.en} by default for this whole session — ` +
    `confirmations, reminders, safety prompts and small talk included. This overrides the default-language rule above. ` +
    `Switch only if they clearly start speaking another supported language.`
  );
}
