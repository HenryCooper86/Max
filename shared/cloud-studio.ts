import { characterList, type CharacterId } from "./characters";

/**
 * Max Cloud Studio: what a project can be set up with beyond its name, key
 * and instructions. Shared by the relay (which validates and runs it) and the
 * console (which edits it), so both agree on what is valid.
 */

export type CloudBackend = "openai" | "gemini" | "grok";

export type VoiceOption = { id: string; label: string; note: { zh: string; en: string } };

/** Voices each backend offers. The first is the default. */
export const CLOUD_VOICES: Record<CloudBackend, readonly VoiceOption[]> = {
  openai: [
    { id: "marin", label: "Marin", note: { zh: "女声，自然清晰", en: "Female, natural and clear" } },
    { id: "cedar", label: "Cedar", note: { zh: "男声，沉稳温暖", en: "Male, calm and warm" } },
    { id: "alloy", label: "Alloy", note: { zh: "中性，平和", en: "Neutral, even" } },
    { id: "ash", label: "Ash", note: { zh: "男声，干脆", en: "Male, crisp" } },
    { id: "ballad", label: "Ballad", note: { zh: "男声，柔和", en: "Male, soft" } },
    { id: "coral", label: "Coral", note: { zh: "女声，热情", en: "Female, warm" } },
    { id: "echo", label: "Echo", note: { zh: "男声，明亮", en: "Male, bright" } },
    { id: "sage", label: "Sage", note: { zh: "女声，从容", en: "Female, composed" } },
    { id: "shimmer", label: "Shimmer", note: { zh: "女声，轻快", en: "Female, light" } },
    { id: "verse", label: "Verse", note: { zh: "男声，富有表现力", en: "Male, expressive" } }
  ],
  gemini: [
    { id: "Aoede", label: "Aoede", note: { zh: "女声，轻快", en: "Female, breezy" } },
    { id: "Puck", label: "Puck", note: { zh: "男声，活泼", en: "Male, upbeat" } },
    { id: "Kore", label: "Kore", note: { zh: "女声，坚定", en: "Female, firm" } },
    { id: "Charon", label: "Charon", note: { zh: "男声，信息感强", en: "Male, informative" } },
    { id: "Fenrir", label: "Fenrir", note: { zh: "男声，兴奋", en: "Male, excitable" } },
    { id: "Leda", label: "Leda", note: { zh: "女声，年轻", en: "Female, youthful" } },
    { id: "Orus", label: "Orus", note: { zh: "男声，坚定", en: "Male, firm" } },
    { id: "Zephyr", label: "Zephyr", note: { zh: "女声，明亮", en: "Female, bright" } }
  ],
  grok: [
    { id: "eve", label: "Eve", note: { zh: "女声，有活力", en: "Female, energetic" } },
    { id: "ara", label: "Ara", note: { zh: "女声，温暖友好", en: "Female, warm and friendly" } },
    { id: "rex", label: "Rex", note: { zh: "男声，自信", en: "Male, confident" } },
    { id: "sal", label: "Sal", note: { zh: "中性，平稳", en: "Neutral, smooth" } },
    { id: "leo", label: "Leo", note: { zh: "男声，权威", en: "Male, authoritative" } }
  ]
};

/** Languages a project can be told to speak. "" follows the caller. */
export const CLOUD_LANGUAGES: readonly { code: string; label: { zh: string; en: string } }[] = [
  { code: "", label: { zh: "跟随用户", en: "Follow the user" } },
  { code: "en", label: { zh: "英语", en: "English" } },
  { code: "zh", label: { zh: "中文", en: "Chinese" } },
  { code: "es", label: { zh: "西班牙语", en: "Spanish" } },
  { code: "fr", label: { zh: "法语", en: "French" } },
  { code: "de", label: { zh: "德语", en: "German" } },
  { code: "pt", label: { zh: "葡萄牙语", en: "Portuguese" } },
  { code: "it", label: { zh: "意大利语", en: "Italian" } },
  { code: "ja", label: { zh: "日语", en: "Japanese" } },
  { code: "ko", label: { zh: "韩语", en: "Korean" } },
  { code: "ar", label: { zh: "阿拉伯语", en: "Arabic" } },
  { code: "hi", label: { zh: "印地语", en: "Hindi" } },
  { code: "ru", label: { zh: "俄语", en: "Russian" } }
];

export const STUDIO_LIMITS = {
  knowledge: 20_000,
  tools: 10,
  toolDescription: 600,
  parameters: 10,
  parameterDescription: 200,
  enumValues: 12,
  origins: 10,
  label: 40,
  url: 500
} as const;

type StudioParameterType = "string" | "number" | "boolean";

export type StudioParameter = {
  name: string;
  type: StudioParameterType;
  description: string;
  required: boolean;
  /** Allowed values (string parameters only). Empty means any. */
  options: string[];
};

/** A no-code webhook tool: Max POSTs the call to `url`, signed with the project's secret. */
export type StudioTool = {
  name: string;
  description: string;
  url: string;
  parameters: StudioParameter[];
};

export type WidgetPosition = "bottom-right" | "bottom-left";

export type ProjectStudio = {
  /** The template the project started from, for reference only. */
  template: string;
  /** Voice id from CLOUD_VOICES; "" is the backend's default. */
  voice: string;
  /** Language code from CLOUD_LANGUAGES; "" follows the user. */
  language: string;
  /** Facts the agent answers from: opening hours, prices, policies, FAQs. */
  knowledge: string;
  tools: StudioTool[];
  /** Embed without a backend: sessions start from these websites only. */
  publicEmbed: { enabled: boolean; origins: string[] };
  /** `characters` fly beside the widget's button (none when empty). */
  widget: { label: string; accent: string; position: WidgetPosition; characters: CharacterId[] };
  /** Keep transcripts of conversations for 30 days. Off unless the customer turns it on
   *  (new projects made in the console start with it on, and say so). */
  keepConversations: boolean;
};

export const DEFAULT_STUDIO: ProjectStudio = {
  template: "",
  voice: "",
  language: "",
  knowledge: "",
  tools: [],
  publicEmbed: { enabled: false, origins: [] },
  widget: { label: "", accent: "", position: "bottom-right", characters: [] },
  keepConversations: false
};

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const PARAMETER_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const ACCENT = /^#[0-9a-fA-F]{6}$/;
/** Names the SDK or relay use for their own purposes. */
const RESERVED_TOOL_NAMES = new Set(["end_session", "transfer", "hang_up"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasControl(value: string, allowNewlines: boolean): boolean {
  for (const character of value) {
    if (allowNewlines && (character === "\n" || character === "\r" || character === "\t")) continue;
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code < 160)) return true;
  }
  return false;
}

type Outcome<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function text(value: unknown, field: string, max: number, multiline = false): Outcome<string> {
  if (value === undefined) return { value: "" };
  if (typeof value !== "string") return { error: `${field} must be text.` };
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: `${field} must be at most ${max.toLocaleString("en")} characters.` };
  if (hasControl(trimmed, multiline)) return { error: `${field} contains characters it cannot have.` };
  return { value: trimmed };
}

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp|metadata\.google\.internal)$/i;

/** True for IP literals in loopback, private, link-local, CGNAT, multicast or reserved ranges. */
export function privateAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (bare.includes(":")) {
    if (bare === "::" || bare === "::1") return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
    if (mapped) return privateAddress(mapped[1]!);
    if (/^::ffff:/.test(bare)) return true;
    // IPv4-compatible (::a.b.c.d, ::7f00:1), 6to4, Teredo, unique-local, link- and site-local, multicast,
    // NAT64 and documentation ranges: none is a public tool server.
    if (bare.startsWith("::")) return true;
    return (
      /^(fc|fd|fe[89a-f]|ff)/.test(bare) ||
      /^2002:/.test(bare) ||
      /^2001:0*:/.test(bare) ||
      bare.startsWith("64:ff9b:") ||
      bare.startsWith("2001:db8")
    );
  }
  return false;
}

/** A tool URL Max may call: https, a public host name or address, no credentials. */
export function toolUrlProblem(raw: string): string | undefined {
  if (raw.includes("${")) return "cannot contain ${…} variables.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a full https:// address.";
  }
  if (url.protocol !== "https:") return "must start with https://.";
  if (url.username || url.password) return "cannot contain a user name or password.";
  if (url.port && url.port !== "443") return "must use the standard https port.";
  const host = url.hostname;
  if (!host.includes(".") && !host.includes(":")) return "must be a public address.";
  if (PRIVATE_HOST.test(host) || privateAddress(host)) return "must be a public address, not a private one.";
  return undefined;
}

/** "https://shop.example.com" from what a person typed ("shop.example.com/", "https://shop.example.com/path"). */
export function normalizeOrigin(raw: string): string | undefined {
  const typed = raw.trim();
  if (!typed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  if (!local && !url.hostname.includes(".")) return undefined;
  return url.origin;
}

function parameter(raw: unknown, tool: string, index: number): Outcome<StudioParameter> {
  const where = `Tool ${tool}, parameter ${index + 1}`;
  if (!isRecord(raw)) return { error: `${where} is not valid.` };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!PARAMETER_NAME.test(name)) return { error: `${where}: the name must be letters, digits or _ (like orderId).` };
  const type = raw.type ?? "string";
  if (type !== "string" && type !== "number" && type !== "boolean") {
    return { error: `${where}: the type must be text, number or yes/no.` };
  }
  const description = text(raw.description, `${where} description`, STUDIO_LIMITS.parameterDescription);
  if (description.error !== undefined) return { error: description.error };
  const options: string[] = [];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return { error: `${where}: the options must be a list.` };
    for (const option of raw.options) {
      if (typeof option !== "string") return { error: `${where}: each option must be text.` };
      const trimmed = option.trim();
      if (!trimmed) continue;
      if (trimmed.length > 40 || hasControl(trimmed, false)) return { error: `${where}: an option is not valid.` };
      if (!options.includes(trimmed)) options.push(trimmed);
    }
    if (options.length > STUDIO_LIMITS.enumValues) {
      return { error: `${where}: at most ${STUDIO_LIMITS.enumValues} options.` };
    }
  }
  return {
    value: {
      name,
      type,
      description: description.value,
      required: raw.required === true,
      options: type === "string" ? options : []
    }
  };
}

function tool(raw: unknown, index: number): Outcome<StudioTool> {
  if (!isRecord(raw)) return { error: `Tool ${index + 1} is not valid.` };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!TOOL_NAME.test(name)) {
    return { error: `Tool ${index + 1}: the name must start with a letter and use a-z, 0-9 or _ (like check_order).` };
  }
  if (RESERVED_TOOL_NAMES.has(name)) return { error: `Tool name ${name} is reserved.` };
  const description = text(raw.description, `Tool ${name} description`, STUDIO_LIMITS.toolDescription, true);
  if (description.error !== undefined) return { error: description.error };
  if (!description.value)
    return { error: `Tool ${name} needs a description: the agent reads it to decide when to use it.` };
  const url = text(raw.url, `Tool ${name} address`, STUDIO_LIMITS.url);
  if (url.error !== undefined) return { error: url.error };
  const urlProblem = toolUrlProblem(url.value);
  if (urlProblem) return { error: `Tool ${name} address ${urlProblem}` };
  const rawParameters = raw.parameters ?? [];
  if (!Array.isArray(rawParameters)) return { error: `Tool ${name}: parameters must be a list.` };
  if (rawParameters.length > STUDIO_LIMITS.parameters) {
    return { error: `Tool ${name}: at most ${STUDIO_LIMITS.parameters} parameters.` };
  }
  const parameters: StudioParameter[] = [];
  for (const [position, entry] of rawParameters.entries()) {
    const parsed = parameter(entry, name, position);
    if (parsed.error !== undefined) return { error: parsed.error };
    if (parameters.some((existing) => existing.name === parsed.value.name)) {
      return { error: `Tool ${name} has two parameters named ${parsed.value.name}.` };
    }
    parameters.push(parsed.value);
  }
  return { value: { name, description: description.value, url: url.value, parameters } };
}

/**
 * Validates a whole Studio object (what the console sends, or what is
 * stored). Missing fields take their defaults; anything present must be valid.
 */
export function parseStudio(raw: unknown, backend: CloudBackend): Outcome<ProjectStudio> {
  if (raw === undefined || raw === null) return { value: structuredClone(DEFAULT_STUDIO) };
  if (!isRecord(raw)) return { error: "Studio settings are not valid." };
  const template = text(raw.template, "Template", 40);
  if (template.error !== undefined) return { error: template.error };
  const voice = text(raw.voice, "Voice", 40);
  if (voice.error !== undefined) return { error: voice.error };
  if (voice.value && !CLOUD_VOICES[backend].some((option) => option.id === voice.value)) {
    return { error: `Voice ${voice.value} is not one of this backend's voices.` };
  }
  const language = text(raw.language, "Language", 8);
  if (language.error !== undefined) return { error: language.error };
  if (!CLOUD_LANGUAGES.some((option) => option.code === language.value)) {
    return { error: "Choose a language from the list." };
  }
  const knowledge = text(raw.knowledge, "Knowledge", STUDIO_LIMITS.knowledge, true);
  if (knowledge.error !== undefined) return { error: knowledge.error };

  const rawTools = raw.tools ?? [];
  if (!Array.isArray(rawTools)) return { error: "Tools must be a list." };
  if (rawTools.length > STUDIO_LIMITS.tools) return { error: `At most ${STUDIO_LIMITS.tools} tools.` };
  const tools: StudioTool[] = [];
  for (const [index, entry] of rawTools.entries()) {
    const parsed = tool(entry, index);
    if (parsed.error !== undefined) return { error: parsed.error };
    if (tools.some((existing) => existing.name === parsed.value.name)) {
      return { error: `Two tools are named ${parsed.value.name}.` };
    }
    tools.push(parsed.value);
  }

  const rawEmbed = raw.publicEmbed ?? {};
  if (!isRecord(rawEmbed)) return { error: "Public embed settings are not valid." };
  const rawOrigins = rawEmbed.origins ?? [];
  if (!Array.isArray(rawOrigins)) return { error: "Websites must be a list." };
  const origins: string[] = [];
  for (const entry of rawOrigins) {
    if (typeof entry !== "string") return { error: "Each website must be text." };
    if (!entry.trim()) continue;
    const origin = normalizeOrigin(entry);
    if (!origin) return { error: `${entry.trim().slice(0, 80)} is not a website address (like https://example.com).` };
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length > STUDIO_LIMITS.origins) return { error: `At most ${STUDIO_LIMITS.origins} websites.` };
  const enabled = rawEmbed.enabled === true;
  if (enabled && !origins.length) return { error: "Add the website the agent will be on before turning on the embed." };

  const rawWidget = raw.widget ?? {};
  if (!isRecord(rawWidget)) return { error: "Widget settings are not valid." };
  const label = text(rawWidget.label, "Button label", STUDIO_LIMITS.label);
  if (label.error !== undefined) return { error: label.error };
  const accent = text(rawWidget.accent, "Accent color", 7);
  if (accent.error !== undefined) return { error: accent.error };
  if (accent.value && !ACCENT.test(accent.value)) return { error: "Accent color must look like #2fd08a." };
  const position = rawWidget.position ?? "bottom-right";
  if (position !== "bottom-right" && position !== "bottom-left") {
    return { error: "Position must be bottom-right or bottom-left." };
  }

  return {
    value: {
      template: template.value,
      voice: voice.value,
      language: language.value,
      knowledge: knowledge.value,
      tools,
      publicEmbed: { enabled, origins },
      widget: {
        label: label.value,
        accent: accent.value.toLowerCase(),
        position,
        characters: characterList(rawWidget.characters) ?? []
      },
      keepConversations: raw.keepConversations === true
    }
  };
}

/** The JSON Schema a model is given for a Studio tool's arguments. */
export function studioToolParameters(tool: StudioTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const parameter of tool.parameters) {
    properties[parameter.name] = {
      type: parameter.type,
      ...(parameter.description ? { description: parameter.description } : {}),
      ...(parameter.options.length ? { enum: parameter.options } : {})
    };
  }
  const required = tool.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}
