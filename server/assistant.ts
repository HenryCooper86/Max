import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantDevice, AssistantSummary, VoiceEqualizer, VoiceVisualizer } from "../shared/agent";
import { normalizeEqualizer } from "./audio-eq";
import { devicePreset, type DevicePreset } from "./device-presets";
import { configureWakePhrase, DEFAULT_WAKE_NAMES, type WakeNames } from "../shared/wake";
import type { ServerToolSource } from "./tools/registry";
import { analysisConfigFrom, type AnalysisConfig } from "./conversation-analysis";
import { guardrailsConfigFrom, type GuardrailsConfig } from "./guardrails";
import { variantSpecsFrom } from "./variants";
import { redactionKindsFrom, type RedactionKind } from "./redact";
import { knowledgeConfigFrom } from "./knowledge";

/**
 * Config keys that are wired up by whoever deploys the relay and never typed
 * into the Studio: they name servers, files on disk and where records go.
 */
export const DEPLOYER_KEYS = [
  "conversation",
  "agents",
  "analysis",
  "privacy",
  "guardrails",
  "variants",
  "version",
  "knowledge",
  "mcpServers"
] as const;
import {
  agentStagesFrom,
  conversationSettingsFrom,
  DEFAULT_CONVERSATION_SETTINGS,
  type AgentStage,
  type ConversationSettings
} from "./conversation-config";

/**
 * The assistant's identity: who it is, what it is worn in, what it answers to.
 *
 * This is the one place a deployment makes the kit its own. Everything is
 * optional — with no `assistant.config.json` the relay is exactly the original
 * "Max" motorcycle-helmet assistant, prompt for prompt.
 *
 * Resolution: `ASSISTANT_CONFIG` (a path) → `./assistant.config.json` → the
 * built-in defaults. A file that exists but cannot be parsed is a startup
 * error rather than a silent fallback: a deployment that believes it is
 * running its own persona must not quietly ship someone else's.
 */
export type AssistantProfile = {
  name: string;
  /** Coarse family, for clients that only know helmet / glasses / other. */
  device: AssistantDevice;
  /** The specific embodied device (server/device-presets.ts). */
  preset: DevicePreset;
  /** How the wearable is described in prompts, e.g. "motorcycle helmet". */
  deviceLabel: { zh: string; en: string };
  /** What the person wearing it is called in prompts, e.g. "rider". */
  wearer: { zh: string; en: string };
  /** Who the assistant says built it. Omitted → it does not claim a maker. */
  developer?: string;
  /** Extra identity facts appended to the identity rule (one or two sentences). */
  identityNotes?: string;
  tagline?: string;
  accentColor?: string;
  /** Design template the clients should use; defaults to the device preset's. */
  template: string;
  /** Token overrides on top of the template (validated names and values). */
  theme?: Record<string, string>;
  /** False pins the template so viewers cannot pick their own. */
  templateSwitching: boolean;
  /** How the live voice display is drawn; defaults to the device preset's. */
  visualizer: VoiceVisualizer;
  /** The owner's own logo file, when one is configured and readable. */
  logo?: BrandLogo;
  /** Background behind the logo where a platform needs one (app icons). */
  logoBackground: string;
  /** Default equaliser for the assistant's voice; defaults to the device preset's. */
  equalizer: VoiceEqualizer;
  /** Which voice of the speech server to speak with (`voice.id`); only the max-speech backend uses it. */
  voiceId?: string;
  /** Languages it speaks, most preferred first. */
  languages: string[];
  /** true → refuse languages outside `languages`; false → prefer them but follow the wearer. */
  strictLanguages: boolean;
  wake: WakeNames;
  /** Replaces the generated base persona prompt entirely. */
  persona?: string;
  /** Extra instructions added after the generated persona: knowledge, house
   *  rules, what to do and not do. Kept even when `persona` is set. */
  instructions?: string;
  /** Spoken once when the microphone first opens in a session. */
  greeting?: string;
  /** False → answer every turn without waiting for the assistant's name.
   *  Defaults to off for software assistants (`general` presets), on otherwise.
   *  AGENT_WAKE_WORD=off still turns it off everywhere. */
  wakeWord: boolean;
  /** Where the relay's own tools come from (server/tools/registry.ts). */
  tools: ServerToolSource;
  /** When the relay checks in on a silent user and when it ends a conversation. */
  conversation: ConversationSettings;
  /** Specialist agents the conversation can be handed to. Empty: one agent. */
  agents: AgentStage[];
  /** What to work out about a finished conversation (server/conversation-analysis.ts). */
  analysis?: AnalysisConfig;
  /** Kinds of personal data removed from records that leave the relay (server/redact.ts). */
  redact: RedactionKind[];
  /** What the assistant must not say and users must not do (server/guardrails.ts). */
  guardrails?: GuardrailsConfig;
  /** A label of the owner's for this state of the config, named in every conversation's record. */
  version?: string;
  /** The assistant as each variant of an A/B test has it (server/variants.ts). Empty: no test. */
  variants: AssistantVariant[];
  /** On a variant's own profile: which one it is. */
  variant?: string;
  /** What was wrong with the conversation keys of the config file, for /health and startup. */
  configProblems: string[];
  /** The config keys only whoever deploys the relay sets (see {@link DEPLOYER_KEYS}), as written, so
   *  the Studio can carry them into its own file. Knowledge paths are absolute here. */
  deployerConfig: Record<string, unknown>;
  /** True when nothing overrides the built-in Max profile. */
  isDefault: boolean;
};

/** Who the stock Max says built it. Only the stock assistant says this: an
 *  owner's own assistant (a config file, the Studio, a Max Cloud project)
 *  never claims Henry built it. */
const MAX_DEVELOPER = "Henry (cooph2o)";

const LANGUAGE_NAMES: Record<string, { zh: string; en: string }> = {
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
  tg: { zh: "塔吉克语", en: "Tajik" },
  tr: { zh: "土耳其语", en: "Turkish" }
};

/** A logo the relay can serve: where it is, what it is, and a cache-busting tag. */
export type BrandLogo = { path: string; contentType: "image/svg+xml" | "image/png"; version: string };

const MAX_LOGO_BYTES = 512 * 1024;
const DEFAULT_LOGO_BACKGROUND = "#0B0C0E";

/** Resolves a configured logo path (relative to the config file). Anything
 *  that is not a readable, reasonably sized SVG or PNG is ignored with the
 *  reason, so a typo cannot take the relay down or serve an arbitrary file. */
export function brandLogoFrom(value: unknown, baseDir: string): { logo?: BrandLogo; problem?: string } {
  const configured = text(value, 400);
  if (!configured) return {};
  const file = path.resolve(baseDir, configured);
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".svg" && extension !== ".png")
    return { problem: `logo must be an .svg or .png file: ${configured}` };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { problem: `logo is not a file: ${file}` };
    if (stat.size > MAX_LOGO_BYTES) return { problem: `logo is larger than ${MAX_LOGO_BYTES / 1024} KiB: ${file}` };
    return {
      logo: {
        path: file,
        contentType: extension === ".svg" ? "image/svg+xml" : "image/png",
        version: `${stat.size.toString(36)}${Math.round(stat.mtimeMs).toString(36)}`
      }
    };
  } catch {
    return { problem: `logo cannot be read: ${file}` };
  }
}

const deviceLogos = new Map<string, BrandLogo | undefined>();

/** The built-in mark for a device (brand/devices/<id>.svg): a helmet for a
 *  helmet, glasses for glasses, a headset for a headset. */
function deviceLogo(presetId: string): BrandLogo | undefined {
  if (!deviceLogos.has(presetId)) {
    deviceLogos.set(presetId, brandLogoFrom(`brand/devices/${presetId}.svg`, process.cwd()).logo);
  }
  return deviceLogos.get(presetId);
}

/** The logo clients should show: the owner's own, else the device's mark. */
export function assistantLogo(profile: AssistantProfile = assistant()): BrandLogo | undefined {
  if (profile.logo) return profile.logo;
  // Max's own mark is the hummingbird; an assistant of someone else's shows
  // its device until it has a logo of its own.
  return profile.isDefault ? stockLogo() : deviceLogo(profile.preset.id);
}

let stockMark: BrandLogo | undefined | null = null;
function stockLogo(): BrandLogo | undefined {
  if (stockMark === null) stockMark = brandLogoFrom("brand/hummingbird.svg", process.cwd()).logo;
  return stockMark ?? deviceLogo("motorcycle-helmet");
}

/** Set when the configured logo was rejected; reported at startup. */
let logoProblem: string | undefined;

export function assistantLogoProblem(): string | undefined {
  return logoProblem;
}

export const DEFAULT_ASSISTANT_PROFILE: AssistantProfile = {
  name: "Max",
  device: "helmet",
  preset: devicePreset("motorcycle-helmet"),
  deviceLabel: devicePreset("motorcycle-helmet").label,
  wearer: devicePreset("motorcycle-helmet").wearer,
  template: "visor",
  templateSwitching: true,
  visualizer: "wave",
  logoBackground: DEFAULT_LOGO_BACKGROUND,
  // The original helmet shipped with the backend's voice untouched.
  equalizer: { preset: "flat" },
  developer: MAX_DEVELOPER,
  languages: ["zh", "en"],
  strictLanguages: true,
  wake: DEFAULT_WAKE_NAMES,
  wakeWord: true,
  tools: {},
  conversation: DEFAULT_CONVERSATION_SETTINGS,
  agents: [],
  redact: [],
  variants: [],
  configProblems: [],
  deployerConfig: {},
  isDefault: true
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => text(item, maxLength)).filter((item): item is string => Boolean(item));
  return items.length ? items.slice(0, maxItems) : undefined;
}

function labelPair(value: unknown, fallback: { zh: string; en: string }): { zh: string; en: string } {
  if (typeof value === "string" && value.trim())
    return { zh: value.trim().slice(0, 40), en: value.trim().slice(0, 40) };
  if (!isRecord(value)) return fallback;
  return { zh: text(value.zh, 40) ?? fallback.zh, en: text(value.en, 40) ?? fallback.en };
}

// Theme overrides reach clients' style sheets, so both sides are an allow-list:
// token-shaped names, and values that can only be a colour, a length or a number.
const THEME_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const THEME_VALUE =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[0-9.]+\s*(,\s*[0-9.]+%?\s*){2,3}\)|-?[0-9]+(\.[0-9]+)?(px|rem|em|ms|%)?)$/i;

function themeFrom(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const theme: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 48)) {
    const cleaned = typeof value === "number" ? String(value) : text(value, 48);
    if (THEME_KEY.test(key) && cleaned && THEME_VALUE.test(cleaned)) theme[key] = cleaned;
  }
  return Object.keys(theme).length ? theme : undefined;
}

/** Config keys that change who the assistant is or how it speaks. */
const PERSONA_KEYS = [
  "name",
  "device",
  "deviceLabel",
  "wearer",
  "developer",
  "identityNotes",
  "languages",
  "strictLanguages",
  "wake",
  "persona"
] as const;

const VISUALIZERS: readonly VoiceVisualizer[] = ["wave", "bars", "mirror", "dots", "ring"];

const HAN = /\p{Script=Han}/u;

/** Splits configured wake names by script: Han names match anywhere in a
 *  Chinese transcript, everything else matches as a whole token. */
function wakeNamesFrom(name: string, raw: unknown): WakeNames {
  const configured = isRecord(raw) ? raw : {};
  const names = [name, ...(textList(configured.names, 24, 24) ?? [])];
  const latin = new Set<string>();
  const cjk = new Set<string>();
  for (const candidate of names) {
    if (HAN.test(candidate)) cjk.add(candidate);
    else latin.add(candidate.toLowerCase());
  }
  return {
    label: text(configured.label, 24) ?? name,
    latin: [...latin],
    cjk: [...cjk],
    falseFriends: textList(configured.falseFriends, 24, 24) ?? []
  };
}

/** A speech-server voice id: short and plain, since it is sent upstream. */
function voiceIdFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

type AssistantVariant = { id: string; weight: number; profile: AssistantProfile };

/** Builds a profile from parsed config JSON. Exported for tests. */
export function assistantProfileFrom(raw: unknown, baseDir = process.cwd()): AssistantProfile {
  if (!isRecord(raw)) throw new Error("assistant config must be a JSON object");
  const base = baseProfileFrom(raw, baseDir);
  const specs = variantSpecsFrom(raw.variants);
  if (specs.problem) base.configProblems.push(specs.problem);
  const problems: string[] = [];
  for (const spec of specs.variants) {
    // The whole config with the variant's keys in place of its own.
    const profile = baseProfileFrom({ ...raw, ...spec.overrides }, baseDir);
    profile.variant = spec.id;
    // Whether users are remembered is decided before a conversation has its
    // variant: it is the config's own for all of them. Worth a word only when
    // the variant asks for something else.
    const asked = isRecord(spec.overrides.conversation) ? spec.overrides.conversation.rememberUsers : undefined;
    if (profile.conversation.rememberUsers !== base.conversation.rememberUsers) {
      profile.conversation = { ...profile.conversation, rememberUsers: base.conversation.rememberUsers };
      if (asked !== undefined) {
        problems.push(
          `variants: ${spec.id}: conversation.rememberUsers is the same for every variant; the config's own value is used`
        );
      }
    }
    // What is wrong with the config whatever the variant sets is said once, for
    // the config. What is wrong because of the variant's own keys is said for it.
    const overridden = Object.keys(spec.overrides);
    if (profile.configProblems.length > 0 && overridden.length > 0) {
      const without = Object.fromEntries(Object.entries(raw).filter(([key]) => !overridden.includes(key)));
      const others = [...baseProfileFrom(without, baseDir).configProblems];
      for (const problem of profile.configProblems) {
        const index = others.indexOf(problem);
        if (index >= 0) others.splice(index, 1);
        else problems.push(`variants: ${spec.id}: ${problem}`);
      }
    }
    base.variants.push({ id: spec.id, weight: spec.weight, profile });
  }
  base.configProblems.push(...problems);
  return base;
}

function baseProfileFrom(raw: Record<string, unknown>, baseDir: string): AssistantProfile {
  const brand = brandLogoFrom(raw.logo, baseDir);
  logoProblem = brand.problem;
  const logoBackground = text(raw.logoBackground, 7);
  const name = text(raw.name, 24) ?? DEFAULT_ASSISTANT_PROFILE.name;
  const preset = devicePreset(raw.device);
  const device: AssistantDevice = preset.family;
  const voice = isRecord(raw.voice) ? raw.voice : {};
  const accent = text(raw.accentColor, 7);
  const renamed = name !== DEFAULT_ASSISTANT_PROFILE.name;
  // Changing only the look, the logo or the sound leaves the assistant who it was.
  const stock = !PERSONA_KEYS.some((key) => raw[key] !== undefined && raw[key] !== null);
  const deployerConfig: Record<string, unknown> = {};
  for (const key of DEPLOYER_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null) deployerConfig[key] = raw[key];
  }
  // Relative knowledge paths belong to this file's directory: pin them, so
  // they still resolve when the Studio writes its own file somewhere else.
  const knowledge = knowledgeConfigFrom(raw.knowledge, baseDir).config;
  if (knowledge) {
    deployerConfig.knowledge = {
      files: knowledge.paths,
      ...(knowledge.text ? { text: knowledge.text } : {}),
      maxResults: knowledge.maxResults,
      chunkChars: knowledge.chunkChars
    };
  }
  const conversation = conversationSettingsFrom(raw.conversation);
  const agents = agentStagesFrom(raw.agents);
  const analysis = analysisConfigFrom(raw.analysis);
  const guardrails = guardrailsConfigFrom(raw.guardrails);
  const privacy = raw.privacy;
  const redact = redactionKindsFrom(
    privacy && typeof privacy === "object" && !Array.isArray(privacy)
      ? (privacy as { redact?: unknown }).redact
      : undefined
  );
  return {
    name,
    device,
    preset,
    deviceLabel: labelPair(raw.deviceLabel, preset.label),
    wearer: labelPair(raw.wearer, preset.wearer),
    template: text(raw.template, 32)?.toLowerCase() ?? preset.template,
    theme: themeFrom(raw.theme),
    templateSwitching: raw.templateSwitching !== false,
    visualizer: VISUALIZERS.includes(raw.visualizer as VoiceVisualizer)
      ? (raw.visualizer as VoiceVisualizer)
      : preset.visualizer,
    ...(brand.logo ? { logo: brand.logo } : {}),
    logoBackground:
      logoBackground && /^#[0-9a-f]{6}$/i.test(logoBackground) ? logoBackground.toUpperCase() : DEFAULT_LOGO_BACKGROUND,
    equalizer: normalizeEqualizer(raw.equalizer ?? voice.equalizer) ?? { preset: preset.equalizer },
    ...(voiceIdFrom(voice.id) ? { voiceId: voiceIdFrom(voice.id) } : {}),
    // Who built it is the owner's to say; without a `developer` it names no company.
    // A config that only changes the look keeps the stock Max, maker included.
    developer: raw.developer === null ? undefined : (text(raw.developer, 80) ?? (stock ? MAX_DEVELOPER : undefined)),
    identityNotes: text(raw.identityNotes, 400),
    tagline: text(raw.tagline, 80),
    accentColor: accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toUpperCase() : undefined,
    // A software assistant starts in English; the wearables keep the
    // original Chinese-first default they were tuned with.
    languages:
      textList(raw.languages, 8, 12)?.map((language) => language.toLowerCase()) ??
      (preset.general ? ["en"] : ["zh", "en"]),
    strictLanguages: typeof raw.strictLanguages === "boolean" ? raw.strictLanguages : !renamed && device === "helmet",
    wake: !renamed && raw.wake === undefined ? DEFAULT_WAKE_NAMES : wakeNamesFrom(name, raw.wake),
    persona: text(raw.persona, 6000),
    instructions: text(raw.instructions, 8000),
    greeting: text(raw.greeting, 300),
    wakeWord: typeof raw.wakeWord === "boolean" ? raw.wakeWord : !preset.general,
    tools: {
      ...(raw.tools !== undefined ? { tools: raw.tools } : {}),
      ...(text(raw.toolsModule, 400) ? { modulePath: path.resolve(baseDir, text(raw.toolsModule, 400)!) } : {}),
      ...(raw.mcpServers !== undefined ? { mcpServers: raw.mcpServers } : {}),
      ...(raw.knowledge !== undefined && raw.knowledge !== null ? { knowledge: raw.knowledge, baseDir } : {})
    },
    conversation: conversation.settings,
    agents: agents.agents,
    ...(analysis.config ? { analysis: analysis.config } : {}),
    redact: redact.kinds,
    ...(guardrails.config ? { guardrails: guardrails.config } : {}),
    ...(text(raw.version, 64) ? { version: text(raw.version, 64) } : {}),
    variants: [],
    deployerConfig,
    configProblems: [
      ...conversation.problems,
      ...agents.problems,
      ...(analysis.problem ? [analysis.problem] : []),
      ...(redact.problem ? [redact.problem] : []),
      ...(guardrails.problem ? [guardrails.problem] : [])
    ],
    // Changing only the look, the logo or the sound leaves the assistant who
    // it was: it keeps the original Max prompts word for word.
    isDefault: stock
  };
}

/** The persona of a Max Cloud project: a software assistant with the
 *  project's name, instructions and greeting, and no wake word. Leaves the
 *  relay's own assistant (and its logo diagnostics) untouched. */
export function projectAssistantProfile(input: {
  name: string;
  instructions?: string;
  greeting?: string;
  /** Language code the agent speaks first; empty follows the user. */
  language?: string;
  /** Reference facts the agent answers from (up to 20,000 characters). */
  knowledge?: string;
}): AssistantProfile {
  const savedProblem = logoProblem;
  try {
    const profile = assistantProfileFrom({
      name: input.name,
      device: "app",
      wakeWord: false,
      ...(input.language ? { languages: [input.language], strictLanguages: false } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.greeting ? { greeting: input.greeting } : {})
    });
    const knowledge = input.knowledge?.trim();
    if (!knowledge) return profile;
    // Added after the loader, whose 8,000-character cap is for instructions alone.
    const reference =
      "Reference information for answering questions. Answer from it when it covers the question; " +
      "when it does not, say you do not know rather than guessing, and offer what you can do instead.\n" +
      `<reference>\n${knowledge}\n</reference>`;
    return { ...profile, instructions: profile.instructions ? `${profile.instructions}\n\n${reference}` : reference };
  } finally {
    logoProblem = savedProblem;
  }
}

function loadAssistantProfile(): AssistantProfile {
  const configured = process.env.ASSISTANT_CONFIG?.trim();
  if (configured?.toLowerCase() === "off") return DEFAULT_ASSISTANT_PROFILE;
  // ASSISTANT_CONFIG names the file outright. Otherwise the config an admin
  // saved from the Studio (kept outside the app directory, which a deploy
  // replaces) wins over a file checked out beside the code.
  const studioFile = path.join(
    process.env.STUDIO_DIR?.trim() || path.join(os.homedir(), ".max-relay"),
    "assistant.config.json"
  );
  const candidates = configured ? [path.resolve(configured)] : [studioFile, path.resolve("assistant.config.json")];
  let file = candidates[0]!;
  let contents: string | undefined;
  for (const candidate of candidates) {
    try {
      contents = fs.readFileSync(candidate, "utf8");
      file = candidate;
      break;
    } catch {
      /* try the next place */
    }
  }
  if (contents === undefined) {
    if (configured) throw new Error(`ASSISTANT_CONFIG points at ${file}, which cannot be read`);
    return DEFAULT_ASSISTANT_PROFILE;
  }
  try {
    const raw: unknown = JSON.parse(contents);
    const profile = assistantProfileFrom(raw, path.dirname(file));
    if (isRecord(raw)) loadedConfig = { file, raw };
    return profile;
  } catch (error) {
    throw new Error(`Invalid assistant config ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

/** The config file the relay started from, as it was written. Nothing when it runs on its defaults. */
let loadedConfig: { file: string; raw: Record<string, unknown> } | undefined;

let active: AssistantProfile =
  process.env.NODE_ENV === "test" && !process.env.ASSISTANT_CONFIG ? DEFAULT_ASSISTANT_PROFILE : loadAssistantProfile();
configureWakePhrase(active.wake);

/** The config file the relay loaded at startup, and what it held. */
export function loadedAssistantConfig(): { file: string; raw: Record<string, unknown> } | undefined {
  return loadedConfig;
}

/** The configured assistant. Read at call time so tests can swap it. */
export function assistant(): AssistantProfile {
  return active;
}

/** Makes `profile` the live assistant: new sessions get its persona and wake
 *  phrase, and /health reports it. Used by the Studio after a save. */
export function installAssistantProfile(profile: AssistantProfile): void {
  active = profile;
  configureWakePhrase(profile.wake);
}

/** Test seam: install a profile (or restore the default with no argument). */
export function setAssistantProfileForTests(profile: AssistantProfile = DEFAULT_ASSISTANT_PROFILE): void {
  active = profile;
  configureWakePhrase(profile.wake);
}

export function assistantSummary(wakeWordEnabled: boolean): AssistantSummary {
  const profile = assistant();
  const logo = assistantLogo(profile);
  return {
    name: profile.name,
    device: profile.device,
    wakePhrase: profile.wake.label,
    wakeWordEnabled,
    ...(profile.tagline ? { tagline: profile.tagline } : {}),
    ...(profile.developer ? { developer: profile.developer } : {}),
    ...(profile.accentColor ? { accentColor: profile.accentColor } : {}),
    languages: [...profile.languages],
    ...(profile.voiceId ? { voiceId: profile.voiceId } : {}),
    deviceProfile: profile.preset.id,
    deviceLabel: promptsInChinese(profile) ? profile.deviceLabel.zh : profile.deviceLabel.en,
    template: profile.template,
    ...(profile.theme ? { theme: { ...profile.theme } } : {}),
    templateSwitching: profile.templateSwitching,
    visualizer: profile.visualizer,
    ...(logo ? { logoUrl: `/brand/logo?v=${logo.version}` } : {})
  };
}

/** Whether sessions wait for the assistant's name before answering: the
 *  relay-wide switch (AGENT_WAKE_WORD) and the assistant's own setting. */
export function wakeWordActive(relayWide: boolean, profile: AssistantProfile = assistant()): boolean {
  return relayWide && profile.wakeWord;
}

/** True when the assistant's first language is Chinese — prompts are then
 *  written in Chinese, otherwise in English. */
export function promptsInChinese(profile: AssistantProfile = assistant()): boolean {
  return (profile.languages[0] ?? "zh").startsWith("zh");
}

function languageName(code: string, inChinese: boolean): string {
  const known = LANGUAGE_NAMES[code.split("-")[0] ?? code];
  return known ? (inChinese ? known.zh : known.en) : code;
}

function languageList(profile: AssistantProfile, inChinese: boolean): string {
  const names = profile.languages.map((code) => languageName(code, inChinese));
  if (names.length <= 1) return names[0] ?? (inChinese ? "中文" : "English");
  return inChinese ? names.join("、") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The original "Max" persona prompt, kept verbatim: the default profile must
// produce exactly the prompt the helmet has been tuned and tested against.
const LEGACY_MAX_PERSONA =
  "你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认语言是中文，第二语言是 English；如果骑手明确使用英文，可以用英文回答。只允许中文和 English 两种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文和 English。帮助骑手理解摩托车、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。拍照、录像、导航、开关手电筒、调整音量、播放音乐、拨号、发短信等都是语音免手操作，本来就是为骑行中使用而设计的，属于安全的免手功能；骑手在骑行中要求这些操作时要直接执行，不要当作分心请求拒绝，也不要让骑手停车再做。只有当请求真正危险、或需要骑手用手长时间盯着屏幕操作时，才先保护骑行安全并给出更安全的替代方案；闲聊、笑话、短故事和常识问题用一两句话直接回答，不要拒绝。男声和女声只是当前会话音色，必须共享同一个 Max 角色、同一语言规则、同一安全策略和同一默认行为。";

/** The base persona: who the assistant is and how it behaves. */
export function basePersonaPrompt(profile: AssistantProfile = assistant()): string {
  if (profile.persona) return profile.persona;
  if (profile.isDefault) return LEGACY_MAX_PERSONA;
  if (profile.preset.general) return generalPersonaPrompt(profile);

  const inChinese = promptsInChinese(profile);
  const languages = languageList(profile, inChinese);
  if (inChinese) {
    const maker = profile.developer ? `，由 ${profile.developer} 开发` : "";
    const languageRule = profile.strictLanguages
      ? `只使用这些语言：${languages}，默认使用第一种；${profile.wearer.zh}使用其他语言时，简短说明你只支持${languages}。`
      : `优先使用${languages}，默认使用第一种；${profile.wearer.zh}换用其他语言时跟随对方。`;
    const scope = profile.preset.scope.zh + profile.preset.conduct.zh;
    return (
      `你是 ${profile.name}，一位友好、冷静、以安全为先的${profile.deviceLabel.zh}语音助手${maker}。你的名字保持 ${profile.name}。` +
      languageRule +
      scope +
      "回答要简短、清晰、适合免手操作，一次只说最重要的一件事。" +
      `拍照、录像、导航、开关手电筒、调整音量、播放音乐、拨号、发短信都是语音免手操作，${profile.wearer.zh}提出时直接执行，不要因为对方正在移动而拒绝。` +
      "只有请求真正危险、需要长时间看屏幕或超出你的能力范围时，才先保护安全并给出更安全的替代方案。" +
      `男声和女声只是音色，共享同一个 ${profile.name} 角色和同样的规则。`
    );
  }

  const maker = profile.developer ? `, built by ${profile.developer}` : "";
  const languageRule = profile.strictLanguages
    ? `Speak only ${languages}, defaulting to the first; if the ${profile.wearer.en} uses another language, briefly say you only support ${languages}. `
    : `Prefer ${languages}, defaulting to the first; if the ${profile.wearer.en} switches language, follow them. `;
  const scope = profile.preset.scope.en + profile.preset.conduct.en;
  return (
    `You are ${profile.name}, a friendly, calm, safety-first voice assistant living in a ${profile.deviceLabel.en}${maker}. Your name stays ${profile.name}. ` +
    languageRule +
    scope +
    "Keep answers short, clear and hands-free: one thing at a time, the most important first. " +
    `Taking photos, recording video, navigation, the torch, volume, music, calls and text messages are hands-free voice actions; when the ${profile.wearer.en} asks for one, just do it — never refuse because they are on the move. ` +
    "Only when a request is genuinely dangerous, needs long looks at a screen, or is beyond what you can do, protect safety first and offer a safer alternative. " +
    `The male and female voices are only a timbre; both are the same ${profile.name} with the same rules.`
  );
}

/** The persona of a software assistant: a voice for a product, not a wearable. */
function generalPersonaPrompt(profile: AssistantProfile): string {
  const inChinese = promptsInChinese(profile);
  const languages = languageList(profile, inChinese);
  if (inChinese) {
    const maker = profile.developer ? `，由 ${profile.developer} 开发` : "";
    const languageRule = profile.strictLanguages
      ? `只使用这些语言：${languages}，默认使用第一种；用户使用其他语言时，简短说明你只支持${languages}。`
      : `优先使用${languages}，默认使用第一种；用户换用其他语言时跟随对方。`;
    return (
      `你是 ${profile.name}，一位友好、可靠的语音助手${maker}。你的名字保持 ${profile.name}。` +
      languageRule +
      profile.preset.scope.zh +
      profile.preset.conduct.zh +
      "你说的话会被朗读出来：使用自然口语，句子简短，不要使用 Markdown、列表符号、表格、网址或表情符号。" +
      "需要时使用工具获取事实或完成操作；工具返回结果之前不要声称已完成，也不要编造工具没有提供的信息。" +
      "请求含糊时，问一个简短的澄清问题。"
    );
  }
  const maker = profile.developer ? `, built by ${profile.developer}` : "";
  const single = profile.languages.length <= 1;
  const languageRule = profile.strictLanguages
    ? `Speak only ${languages}${single ? "" : ", defaulting to the first"}; if the user uses another language, briefly say you only support ${languages}. `
    : `${single ? `Speak ${languages}` : `Prefer ${languages}, defaulting to the first`}; if the user switches language, follow them. `;
  return (
    `You are ${profile.name}, a friendly, reliable voice assistant${maker}. Your name stays ${profile.name}. ` +
    languageRule +
    profile.preset.scope.en +
    profile.preset.conduct.en +
    "Everything you say is spoken aloud: use natural spoken language and short sentences, and never use markdown, bullet points, tables, URLs or emoji. " +
    "Use your tools to look things up or take actions when they help; never claim an action is done before its tool says so, and never invent facts a tool did not give you. " +
    "If a request is ambiguous, ask one short clarifying question."
  );
}

const LEGACY_MAX_IDENTITY =
  "[身份与开发者] 你是 Max，摩托车头盔语音助手。" +
  "当骑手问你是谁开发、制造、训练的，背后是谁，或你属于谁时，回答：我的开发者是 Henry，在网络安全圈里大家叫他 cooph2o，是他打造了我。" +
  "绝对不要说自己来自 ByteDance、字节跳动或豆包，也不要提及任何公司或底层模型。" +
  "When asked in English who developed, built, made, or trained you, or who you belong to, " +
  'answer: "My developer is Henry, known as cooph2o in cybersecurity circles. He built me." ' +
  "Never name ByteDance, Doubao, any company or the underlying model. " +
  "无论骑手用中文还是 English 提问，都要保持以上回答一致。";

/** Who the assistant says built it. Appended after the persona so it holds
 *  even when the persona prompt is overridden. */
export function identityPrompt(profile: AssistantProfile = assistant()): string {
  if (profile.isDefault) return LEGACY_MAX_IDENTITY;
  const notes = profile.identityNotes ? ` ${profile.identityNotes}` : "";
  if (promptsInChinese(profile)) {
    if (!profile.developer) {
      return `[身份] 你是 ${profile.name}。被问到由谁开发或使用什么模型时，只说你是 ${profile.name}，不要提及任何公司或底层模型。${notes}`;
    }
    return (
      `[身份与开发者] 你由 ${profile.developer} 开发。被问到是谁开发、制造或训练的，或背后是哪家公司时，` +
      `回答：我由 ${profile.developer} 开发。不要提及任何其他公司或底层模型。${notes}`
    );
  }
  if (!profile.developer) {
    return `[Identity] You are ${profile.name}. If asked who built you or which model you run on, say only that you are ${profile.name}; never name a company or an underlying model.${notes}`;
  }
  return (
    `[Identity] You were built by ${profile.developer}. If asked who developed, made or trained you, or which company is behind you, ` +
    `answer that you were built by ${profile.developer}. Never name any other company or the underlying model.${notes}`
  );
}

/** The line a status event shows while the assistant waits to be addressed. */
export function wakeHint(profile: AssistantProfile = assistant()): string {
  return `正在收听 —— 说一声 "${profile.wake.label}" 唤醒 ${profile.name}`;
}
