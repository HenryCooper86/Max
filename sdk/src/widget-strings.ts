/**
 * Built-in text of the `<voice-agent>` widget, in English and Simplified
 * Chinese, and the rules for picking and overriding it.
 */

import type { VoiceAgentStatus } from "./client.js";

export type WidgetLocale = "en" | "zh";

/** Every error code the widget has a message for. */
type WidgetErrorKey = "microphone" | "token" | "connection" | "relay" | "audio" | "usage_limit" | "unauthorized";

/** All visible and screen-reader text of the widget. */
export interface WidgetStrings {
  /** Accessible name of the round button. The `label` attribute wins over this. */
  label: string;
  /** Accessible name of the conversation panel. */
  conversation: string;
  mute: string;
  unmute: string;
  close: string;
  typeMessage: string;
  send: string;
  /** Button shown when the browser blocks audio. */
  enableSound: string;
  /** Button for showing the assistant a picture (the `image-input` attribute). */
  picture: string;
  /** Text alternative of a picture in the transcript. */
  pictureSent: string;
  /** A picture was not sent: no session ready for one, or one went out a moment ago. */
  pictureNotSent: string;
  /** A picture could not be read or made small enough. */
  pictureUnusable: string;
  status: Record<VoiceAgentStatus, string>;
  errors: Record<WidgetErrorKey, string>;
}

/** What the `strings` property accepts: any subset of {@link WidgetStrings}. */
export type WidgetStringOverrides = Partial<Omit<WidgetStrings, "status" | "errors">> & {
  status?: Partial<WidgetStrings["status"]>;
  /** Keyed by error code; codes the widget does not know are accepted too. */
  errors?: Record<string, string | undefined>;
};

const en: WidgetStrings = {
  label: "Talk to the assistant",
  conversation: "Conversation",
  mute: "Mute",
  unmute: "Unmute",
  close: "Close",
  typeMessage: "Type a message",
  send: "Send",
  enableSound: "Tap to enable sound",
  picture: "Show a picture",
  pictureSent: "A picture you sent",
  pictureNotSent: "The picture was not sent. Wait a moment and try again.",
  pictureUnusable: "This picture could not be used. Choose a JPEG or PNG photo or screenshot.",
  status: {
    idle: "Idle",
    connecting: "Connecting",
    ready: "Ready",
    listening: "Listening",
    hearing: "Hearing you",
    thinking: "Thinking",
    speaking: "Speaking",
    error: "Something went wrong",
    closed: "Session ended"
  },
  errors: {
    microphone: "Microphone access was blocked. Allow it in your browser and try again.",
    token: "Could not start a session. Please try again later.",
    connection: "Could not reach the assistant. Please try again.",
    relay: "The assistant reported a problem.",
    audio: "Audio playback failed.",
    usage_limit: "This month's voice minutes are used up.",
    unauthorized: "The assistant did not accept this session. Sign in again and retry."
  }
};

const zh: WidgetStrings = {
  label: "与助手对话",
  conversation: "对话",
  mute: "静音",
  unmute: "取消静音",
  close: "关闭",
  typeMessage: "输入消息",
  send: "发送",
  enableSound: "点按以开启声音",
  picture: "发送图片",
  pictureSent: "你发送的图片",
  pictureNotSent: "图片没有发出去，请稍等片刻再试。",
  pictureUnusable: "这张图片无法使用，请选择 JPEG 或 PNG 格式的照片或截图。",
  status: {
    idle: "空闲",
    connecting: "正在连接",
    ready: "就绪",
    listening: "正在聆听",
    hearing: "正在听你说话",
    thinking: "正在思考",
    speaking: "正在说话",
    error: "出了点问题",
    closed: "会话已结束"
  },
  errors: {
    microphone: "麦克风被阻止。请在浏览器中允许使用麦克风后重试。",
    token: "无法开始会话，请稍后再试。",
    connection: "无法连接到助手，请重试。",
    relay: "助手报告了一个问题。",
    audio: "音频播放失败。",
    usage_limit: "本月的语音时长已用完。",
    unauthorized: "助手没有接受此会话，请重新登录后再试。"
  }
};

const BUILT_IN: Record<WidgetLocale, WidgetStrings> = { en, zh };

/** `zh`, `zh-CN`, `zh_Hans` and the like pick Chinese; anything else, or nothing, picks English. */
export function resolveLocale(...candidates: Array<string | null | undefined>): WidgetLocale {
  const found = candidates.find((value) => value?.trim());
  return found && /^zh(?:[-_]|$)/i.test(found.trim()) ? "zh" : "en";
}

/** The built-in strings for a locale with the caller's overrides laid over them. */
export function resolveStrings(locale: WidgetLocale, overrides: WidgetStringOverrides = {}): WidgetStrings {
  const base = BUILT_IN[locale];
  const { status, errors, ...flat } = overrides;
  const text: Partial<WidgetStrings> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === "string" && key in base) (text as Record<string, string>)[key] = value;
  }
  return {
    ...base,
    ...text,
    status: { ...base.status, ...definedOnly(status) },
    errors: { ...base.errors, ...definedOnly(errors) }
  };
}

function definedOnly<T extends string>(
  map: Partial<Record<T, string | undefined>> | undefined
): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  for (const [key, value] of Object.entries(map ?? {}) as Array<[T, string | undefined]>) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
