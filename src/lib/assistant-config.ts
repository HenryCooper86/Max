// One model of an assistant's configuration, shared by the public
// configurator (/build) and the admin Studio: parse a stored
// assistant.config.json into an editable draft, validate it, and write it
// back in the shape the relay accepts (server/assistant.ts). Fields the
// editor does not touch (persona, wearer, theme, …) ride along untouched.

import type { VoiceEqualizer, VoiceVisualizer } from "../../shared/agent";
import { DEFAULT_DEVICE_ID, DEVICES, findBackend } from "./device-catalog";
import { normalizeBands, normalizeEqualizer } from "./equalizer";
import { localized, type Language } from "./i18n";
import { isVisualizer } from "./visualizer";

export type AssistantDraft = {
  name: string;
  /** A device preset id. */
  device: string;
  languages: string[];
  /** Answer only in the listed languages; null lets the relay decide. */
  strictLanguages: boolean | null;
  developer: string;
  tagline: string;
  /** Extra names that wake the assistant, besides its name. */
  wakeNames: string[];
  /** null follows the device's default. */
  template: string | null;
  templateSwitching: boolean;
  visualizer: VoiceVisualizer | null;
  /** "#RRGGBB", or "" for the template's own accent. */
  accentColor: string;
  /** null follows the device's default preset. */
  equalizer: VoiceEqualizer | null;
  /** The speech voice the assistant speaks with (Max Speech); "" for the default. */
  voiceId: string;
  /** The voice backend (configurator only: it lives in .env, not the config). */
  voiceProvider: string;
  /** Stored keys this editor does not edit, written back as they were. */
  extra: Record<string, unknown>;
};

const LIMITS = { name: 24, wakeName: 24, wakeNames: 8, languages: 8, developer: 80, tagline: 80 } as const;
const VOICE_ID_MAX = 64;
const HEX = /^#[0-9a-f]{6}$/i;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;
const FAMILY_DEFAULT: Record<string, string> = {
  helmet: "motorcycle-helmet",
  glasses: "smart-glasses",
  other: "wearable"
};
// Keys the draft owns; everything else in a stored config is `extra`.
const OWNED = new Set([
  "name",
  "device",
  "languages",
  "strictLanguages",
  "developer",
  "tagline",
  "wake",
  "template",
  "templateSwitching",
  "visualizer",
  "accentColor",
  "voice",
  "equalizer"
]);

export function emptyDraft(language: Language = "en-US"): AssistantDraft {
  return {
    name: "",
    device: DEFAULT_DEVICE_ID,
    languages: language === "zh-CN" ? ["zh", "en"] : ["en"],
    strictLanguages: null,
    developer: "",
    tagline: "",
    wakeNames: [],
    template: null,
    templateSwitching: true,
    visualizer: null,
    accentColor: "",
    equalizer: null,
    voiceId: "",
    voiceProvider: "mock",
    extra: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const textList = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

/** A device preset id from a stored `device` (an id or a coarse family). */
function deviceIdFrom(value: unknown): string {
  const key = text(value).toLowerCase();
  if (DEVICES.some((device) => device.id === key)) return key;
  return FAMILY_DEFAULT[key] ?? DEFAULT_DEVICE_ID;
}

/** Parse a stored config (or {} for the relay's defaults) into a draft. */
export function draftFromConfig(config: unknown, language: Language = "en-US"): AssistantDraft {
  const base = emptyDraft(language);
  if (!isRecord(config)) return base;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) if (!OWNED.has(key)) extra[key] = value;
  const wake = isRecord(config.wake) ? config.wake : {};
  const wakeRest = Object.fromEntries(Object.entries(wake).filter(([key]) => key !== "names"));
  if (Object.keys(wakeRest).length) extra.wake = wakeRest;
  const voice = isRecord(config.voice) ? config.voice : {};
  const voiceEqualizer = voice.equalizer;
  const voiceRest = Object.fromEntries(Object.entries(voice).filter(([key]) => key !== "equalizer" && key !== "id"));
  if (Object.keys(voiceRest).length) extra.voice = voiceRest;
  const name = text(config.name);
  const languages = textList(config.languages).map((code) => code.trim().toLowerCase());
  return {
    ...base,
    name,
    device: config.device === undefined ? base.device : deviceIdFrom(config.device),
    languages: languages.length ? languages : config.languages === undefined ? base.languages : [],
    strictLanguages: typeof config.strictLanguages === "boolean" ? config.strictLanguages : null,
    developer: text(config.developer),
    tagline: text(config.tagline),
    wakeNames: textList(wake.names)
      .map((item) => item.trim())
      .filter((item) => item.toLowerCase() !== name.toLowerCase()),
    template: text(config.template).toLowerCase() || null,
    templateSwitching: config.templateSwitching !== false,
    visualizer: isVisualizer(config.visualizer) ? config.visualizer : null,
    accentColor: HEX.test(text(config.accentColor)) ? text(config.accentColor).toUpperCase() : "",
    equalizer: normalizeEqualizer(voiceEqualizer ?? config.equalizer),
    voiceId: text(voice.id).slice(0, VOICE_ID_MAX),
    extra
  };
}

/** The config the relay reads, in a stable key order, leaving out anything
 *  that only restates a default so the file stays short and readable. */
export function configFromDraft(draft: AssistantDraft): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const { wake: extraWake, voice: extraVoice, theme, ...rest } = draft.extra;
  if (draft.name.trim()) config.name = draft.name.trim();
  config.device = draft.device;
  config.languages = draft.languages;
  if (draft.strictLanguages !== null) config.strictLanguages = draft.strictLanguages;
  if (draft.developer.trim()) config.developer = draft.developer.trim();
  if (draft.tagline.trim()) config.tagline = draft.tagline.trim();
  const wakeNames = draft.wakeNames.map((item) => item.trim()).filter(Boolean);
  if (wakeNames.length || isRecord(extraWake)) {
    config.wake = { ...(isRecord(extraWake) ? extraWake : {}), ...(wakeNames.length ? { names: wakeNames } : {}) };
  }
  if (draft.template) config.template = draft.template;
  if (!draft.templateSwitching) config.templateSwitching = false;
  if (draft.visualizer) config.visualizer = draft.visualizer;
  if (draft.accentColor) config.accentColor = draft.accentColor.toUpperCase();
  if (theme !== undefined) config.theme = theme;
  const equalizer = draft.equalizer ? normalizeEqualizer(draft.equalizer) : null;
  const voiceId = draft.voiceId.trim();
  if (equalizer || voiceId || isRecord(extraVoice)) {
    config.voice = {
      ...(isRecord(extraVoice) ? extraVoice : {}),
      ...(voiceId ? { id: voiceId } : {}),
      ...(equalizer ? { equalizer } : {})
    };
  }
  return { ...config, ...rest };
}

export type DraftField =
  "name" | "wakeNames" | "languages" | "developer" | "tagline" | "accentColor" | "equalizer" | "device";
export type DraftErrors = Partial<Record<DraftField, string>>;

/** Problems a person can fix, keyed by field, in the UI language. */
export function validateDraft(draft: AssistantDraft, language: Language = "en-US"): DraftErrors {
  const say = (zh: string, en: string) => localized(language, zh, en);
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = say("给助手起个名字。", "Give the assistant a name.");
  else if (name.length > LIMITS.name)
    errors.name = say(`名字最多 ${LIMITS.name} 个字符。`, `Keep the name to ${LIMITS.name} characters.`);
  if (!DEVICES.some((device) => device.id === draft.device)) errors.device = say("选择一个设备。", "Choose a device.");
  const wake = draft.wakeNames.map((item) => item.trim()).filter(Boolean);
  if (wake.length > LIMITS.wakeNames) {
    errors.wakeNames = say(`最多 ${LIMITS.wakeNames} 个唤醒名。`, `Use at most ${LIMITS.wakeNames} wake names.`);
  } else if (wake.some((item) => item.length > LIMITS.wakeName)) {
    errors.wakeNames = say(
      `每个唤醒名最多 ${LIMITS.wakeName} 个字符。`,
      `Keep each wake name to ${LIMITS.wakeName} characters.`
    );
  }
  if (!draft.languages.length) errors.languages = say("至少选择一种语言。", "Choose at least one language.");
  else if (draft.languages.length > LIMITS.languages) {
    errors.languages = say(`最多 ${LIMITS.languages} 种语言。`, `Choose at most ${LIMITS.languages} languages.`);
  } else if (draft.languages.some((code) => !LANGUAGE_CODE.test(code))) {
    errors.languages = say("语言代码应类似 zh、en 或 pt-br。", "Language codes look like zh, en or pt-br.");
  }
  if (draft.developer.trim().length > LIMITS.developer) {
    errors.developer = say(`最多 ${LIMITS.developer} 个字符。`, `Keep this to ${LIMITS.developer} characters.`);
  }
  if (draft.tagline.trim().length > LIMITS.tagline) {
    errors.tagline = say(`最多 ${LIMITS.tagline} 个字符。`, `Keep this to ${LIMITS.tagline} characters.`);
  }
  if (draft.accentColor && !HEX.test(draft.accentColor)) {
    errors.accentColor = say("颜色应为 #RRGGBB，例如 #C6F432。", "Use a colour like #C6F432.");
  }
  const equalizer = draft.equalizer;
  if (equalizer) {
    const bandsOk =
      equalizer.bands === undefined || normalizeBands(equalizer.bands)?.every((db, i) => db === equalizer.bands![i]);
    const preampOk =
      equalizer.preamp === undefined ||
      (Number.isInteger(equalizer.preamp) && equalizer.preamp >= -12 && equalizer.preamp <= 12);
    if (!bandsOk || !preampOk) {
      errors.equalizer = say(
        "十个频段和前级都应是 -12 到 12 之间的整数。",
        "Each of the ten bands and the preamp must be a whole number from -12 to 12."
      );
    }
  }
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** The config file as the owner saves it. */
export function configFileText(draft: AssistantDraft): string {
  return `${JSON.stringify(configFromDraft(draft), null, 2)}\n`;
}

/** The .env lines for the chosen backend, with every value left blank for
 *  the owner to fill in on their own machine. */
export function envFileText(draft: AssistantDraft): string {
  const backend = findBackend(draft.voiceProvider);
  return [`VOICE_PROVIDER=${backend.id}`, ...backend.env].join("\n") + "\n";
}

export const SETUP_COMMANDS = ["npm install", "npm run setup", "npm run dev"] as const;

/** True when two drafts would save the same config. */
export function sameConfig(a: AssistantDraft, b: AssistantDraft): boolean {
  return JSON.stringify(configFromDraft(a)) === JSON.stringify(configFromDraft(b));
}

// ---- The public configurator's saved draft --------------------------------

const BUILD_DRAFT_KEY = "max.build.draft.v1";

export type BuildProgress = { draft: AssistantDraft; step: number };

/** The configurator's draft from this browser, if there is one. Stored as the
 *  config it would produce, so it goes through the same parser as any file. */
export function loadBuildDraft(language: Language): BuildProgress | null {
  try {
    const raw = window.localStorage.getItem(BUILD_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const draft = draftFromConfig(parsed.config, language);
    if (typeof parsed.name === "string") draft.name = parsed.name.slice(0, 40);
    if (Array.isArray(parsed.wakeNames)) draft.wakeNames = textList(parsed.wakeNames).slice(0, 16);
    draft.voiceProvider = findBackend(typeof parsed.voiceProvider === "string" ? parsed.voiceProvider : "").id;
    const step = typeof parsed.step === "number" && Number.isInteger(parsed.step) ? parsed.step : 0;
    return { draft, step: Math.max(0, Math.min(5, step)) };
  } catch {
    return null;
  }
}

export function saveBuildDraft(progress: BuildProgress): void {
  try {
    window.localStorage.setItem(
      BUILD_DRAFT_KEY,
      JSON.stringify({
        config: configFromDraft(progress.draft),
        // Kept raw so a half-typed name or wake list survives a refresh.
        name: progress.draft.name,
        wakeNames: progress.draft.wakeNames,
        voiceProvider: progress.draft.voiceProvider,
        step: progress.step
      })
    );
  } catch {
    /* storage unavailable: the draft lives for this visit only */
  }
}

export function clearBuildDraft(): void {
  try {
    window.localStorage.removeItem(BUILD_DRAFT_KEY);
  } catch {
    /* best-effort */
  }
}
