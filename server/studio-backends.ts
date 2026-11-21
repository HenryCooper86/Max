import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VoiceProviderKind } from "../shared/agent";
import { resolveVoiceProviderId, VOICE_PROVIDERS, voiceProvider, type VoiceProviderId } from "./providers/catalog";
import { config } from "./runtime-config";

/**
 * Voice backend setup from the Studio.
 *
 * An admin can set up a backend from the app instead of editing `.env` on the
 * server: its API key, its model and voices, which backend is the default, and
 * whether wearers may switch. What is saved here is laid over the process
 * environment, so every backend reads it exactly as it reads `.env`, and a
 * value cleared here falls back to whatever `.env` provided.
 *
 * Secrets are write-only. A key can be set or cleared; it is never sent back,
 * never logged, and reported only as "set", with where it came from.
 * The file is written 0600 beside the Studio's assistant config, outside the
 * app directory so a deploy does not erase it.
 */

type BackendField = {
  /** The environment variable this field sets. */
  env: string;
  label: string;
  /** API keys and tokens: write-only. */
  secret?: boolean;
  kind?: "text" | "url" | "toggle";
  /** What the backend uses when the field is empty. */
  placeholder?: string;
};

const voices = (prefix: string, female: string, male: string): BackendField[] => [
  { env: `${prefix}`, label: "Voice", placeholder: female },
  { env: `${prefix}_MALE`, label: "Voice (male)", placeholder: male }
];

/** Every setting an admin may change, per backend. Anything not listed here
 *  cannot be written through the Studio. */
export const BACKEND_FIELDS: Record<VoiceProviderId, BackendField[]> = {
  mock: [],
  doubao: [
    { env: "DOUBAO_API_KEY", label: "API key", secret: true },
    ...voices("DOUBAO_VOICE", "zh_female_vv_jupiter_bigtts", "zh_male_yunzhou_jupiter_bigtts")
  ],
  openai: [
    { env: "OPENAI_API_KEY", label: "API key", secret: true },
    { env: "OPENAI_REALTIME_MODEL", label: "Realtime model", placeholder: "gpt-realtime" },
    { env: "OPENAI_TRANSCRIBE_MODEL", label: "Transcription model", placeholder: "gpt-4o-mini-transcribe" },
    ...voices("OPENAI_VOICE", "marin", "cedar")
  ],
  grok: [
    { env: "XAI_API_KEY", label: "API key", secret: true },
    { env: "XAI_VOICE_MODEL", label: "Voice model", placeholder: "grok-voice-latest" },
    ...voices("XAI_VOICE", "eve", "rex")
  ],
  gemini: [
    { env: "GEMINI_API_KEY", label: "API key", secret: true },
    { env: "GEMINI_LIVE_MODEL", label: "Live model", placeholder: "gemini-3.8-live" },
    ...voices("GEMINI_VOICE", "Aoede", "Puck")
  ],
  pipeline: [
    { env: "PIPELINE_API_KEY", label: "API key", secret: true },
    { env: "PIPELINE_BASE_URL", label: "Endpoint", kind: "url", placeholder: "https://api.openai.com/v1" },
    { env: "PIPELINE_STT_MODEL", label: "Speech-to-text model", placeholder: "whisper-1" },
    { env: "PIPELINE_LLM_MODEL", label: "Chat model", placeholder: "gpt-4o-mini" },
    { env: "PIPELINE_TTS_MODEL", label: "Text-to-speech model", placeholder: "gpt-4o-mini-tts" },
    ...voices("PIPELINE_TTS_VOICE", "nova", "onyx")
  ],
  local: [
    { env: "LOCAL_VOICE", label: "Use local models", kind: "toggle" },
    { env: "LOCAL_STT_BASE_URL", label: "Speech-to-text server", kind: "url", placeholder: "http://localhost:8000/v1" },
    { env: "LOCAL_STT_MODEL", label: "Speech-to-text model", placeholder: "Systran/faster-whisper-small" },
    { env: "LOCAL_LLM_BASE_URL", label: "Chat model server", kind: "url", placeholder: "http://localhost:11434/v1" },
    { env: "LOCAL_LLM_MODEL", label: "Chat model", placeholder: "qwen3:8b" },
    { env: "LOCAL_TTS_BASE_URL", label: "Text-to-speech server", kind: "url", placeholder: "http://localhost:8880/v1" },
    { env: "LOCAL_TTS_MODEL", label: "Text-to-speech model", placeholder: "kokoro" },
    ...voices("LOCAL_TTS_VOICE", "af_heart", "am_michael")
  ],
  "local-realtime": [
    {
      env: "LOCAL_REALTIME_URL",
      label: "Realtime server",
      kind: "url",
      placeholder: "ws://localhost:8000/v1/realtime"
    },
    { env: "LOCAL_REALTIME_MODEL", label: "Model" },
    ...voices("LOCAL_REALTIME_VOICE", "af_heart", "am_michael")
  ],
  "max-speech": [
    { env: "MAX_SPEECH", label: "Use Max Speech", kind: "toggle" },
    {
      env: "MAX_SPEECH_URL",
      label: "Speech server",
      kind: "url",
      placeholder: "ws://localhost:8790/v1/speech/session"
    },
    { env: "MAX_SPEECH_API_KEY", label: "API key", secret: true },
    { env: "MAX_SPEECH_VOICE", label: "Voice", placeholder: "af_heart" },
    { env: "LOCAL_LLM_BASE_URL", label: "Chat model server", kind: "url", placeholder: "http://localhost:11434/v1" },
    { env: "LOCAL_LLM_MODEL", label: "Chat model", placeholder: "qwen3:8b" }
  ]
};

const FIELD_BY_ENV = new Map<string, BackendField>(
  Object.values(BACKEND_FIELDS).flatMap((fields) => fields.map((field) => [field.env, field] as const))
);

type Stored = { values: Record<string, string>; defaultProvider?: string; switching?: boolean };

type BackendFieldState = {
  env: string;
  label: string;
  kind: "text" | "url" | "toggle" | "secret";
  /** True when the backend will see a value for this field. */
  set: boolean;
  /** Where that value comes from. */
  source: "studio" | "env" | "unset";
  /** The value itself — never present for secrets. */
  value?: string;
  placeholder?: string;
};

type BackendState = {
  id: string;
  label: string;
  kind: VoiceProviderKind;
  description: string;
  local: boolean;
  configured: boolean;
  requires: string;
  fields: BackendFieldState[];
};

export type StudioBackendsState = {
  ok: true;
  defaultProvider: string;
  switching: boolean;
  backends: BackendState[];
};

function storePath(): string {
  const directory = process.env.STUDIO_DIR?.trim() || path.join(os.homedir(), ".max-relay");
  return path.join(directory, "voice-backends.json");
}

function readStored(): Stored {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<Stored>;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.values ?? {})) {
      if (FIELD_BY_ENV.has(key) && typeof value === "string" && value) values[key] = value;
    }
    return {
      values,
      ...(typeof parsed.defaultProvider === "string" ? { defaultProvider: parsed.defaultProvider } : {}),
      ...(typeof parsed.switching === "boolean" ? { switching: parsed.switching } : {})
    };
  } catch {
    return { values: {} };
  }
}

function writeStored(stored: Stored): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

/** What `.env` and the shell provided, before the Studio laid anything over
 *  it — the value a field returns to when it is cleared in the Studio. */
const baseline = new Map<string, string | undefined>();
let baselineProvider: VoiceProviderId | undefined;
let baselineSwitching: boolean | undefined;

function captureBaseline(): void {
  if (baselineProvider !== undefined) return;
  for (const env of FIELD_BY_ENV.keys()) baseline.set(env, process.env[env]);
  baselineProvider = config.voiceProvider;
  baselineSwitching = config.voiceProviderSwitching;
}

/** Lays the stored settings over the environment and the live config. */
function apply(stored: Stored): void {
  captureBaseline();
  for (const env of FIELD_BY_ENV.keys()) {
    const value = stored.values[env] ?? baseline.get(env);
    if (value === undefined) delete process.env[env];
    else process.env[env] = value;
  }
  const chosen = resolveVoiceProviderId(stored.defaultProvider);
  // A default that has since lost its credentials would break every session.
  config.voiceProvider = chosen && voiceProvider(chosen).configured() ? chosen : baselineProvider!;
  config.voiceProviderSwitching = stored.switching ?? baselineSwitching!;
}

/** Called once at startup, before the relay accepts sessions. */
export function loadStudioBackends(): void {
  apply(readStored());
}

function fieldState(field: BackendField, stored: Stored): BackendFieldState {
  const fromStudio = stored.values[field.env] !== undefined;
  const current = process.env[field.env]?.trim() ?? "";
  return {
    env: field.env,
    label: field.label,
    kind: field.secret ? "secret" : (field.kind ?? "text"),
    set: Boolean(current),
    source: fromStudio ? "studio" : current ? "env" : "unset",
    ...(field.secret || !current ? {} : { value: current }),
    ...(field.placeholder ? { placeholder: field.placeholder } : {})
  };
}

export function studioBackendsState(): StudioBackendsState {
  captureBaseline();
  const stored = readStored();
  return {
    ok: true,
    defaultProvider: config.voiceProvider,
    switching: config.voiceProviderSwitching,
    backends: VOICE_PROVIDERS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      description: entry.description,
      local: Boolean(entry.local),
      configured: entry.configured(),
      requires: entry.requires,
      fields: BACKEND_FIELDS[entry.id].map((field) => fieldState(field, stored))
    }))
  };
}

const MAX_VALUE_LENGTH = 400;

function cleanValue(field: BackendField, raw: unknown): string {
  if (typeof raw !== "string") throw new Error(`${field.label}: expected text.`);
  const value = raw.trim();
  // A value with a line break would let one field write another variable.
  if (value.length > MAX_VALUE_LENGTH || /[\r\n\0]/.test(value)) throw new Error(`${field.label}: not a valid value.`);
  if (field.kind === "toggle") {
    if (value !== "on" && value !== "off") throw new Error(`${field.label}: must be on or off.`);
    return value;
  }
  if (field.kind === "url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${field.label}: enter a full address, such as http://localhost:11434/v1.`);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${field.label}: use an http, https, ws or wss address without a password in it.`);
    }
  }
  return value;
}

/**
 * Saves a change from the Studio.
 * - `values`: `{ ENV_NAME: "new value" }` sets a field; `null` or `""` clears
 *   it back to what `.env` provides. Unknown names are rejected.
 * - `defaultProvider`: must be a backend that is set up once the values apply.
 * - `switching`: whether wearers may pick their own backend.
 * Returns the new state and the names (never the values) of what changed.
 */
export function saveStudioBackends(raw: unknown): { state: StudioBackendsState; changed: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid request.");
  const input = raw as { values?: unknown; defaultProvider?: unknown; switching?: unknown };
  captureBaseline();
  const previous = readStored();
  const next: Stored = { ...previous, values: { ...previous.values } };
  const changed: string[] = [];

  if (input.values !== undefined) {
    if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
      throw new Error("Invalid settings.");
    }
    for (const [env, value] of Object.entries(input.values as Record<string, unknown>)) {
      const field = FIELD_BY_ENV.get(env);
      if (!field) throw new Error(`"${env}" is not a setting the Studio can change.`);
      if (value === null || value === "") {
        if (next.values[env] !== undefined) changed.push(env);
        delete next.values[env];
      } else {
        const cleaned = cleanValue(field, value);
        if (next.values[env] !== cleaned) changed.push(env);
        next.values[env] = cleaned;
      }
    }
  }
  if (input.switching !== undefined) {
    if (typeof input.switching !== "boolean") throw new Error("Invalid switching setting.");
    if (next.switching !== input.switching) changed.push("switching");
    next.switching = input.switching;
  }

  // Apply first, so "is it set up?" is judged against the values just entered.
  apply(next);
  if (input.defaultProvider !== undefined) {
    const id = resolveVoiceProviderId(typeof input.defaultProvider === "string" ? input.defaultProvider : undefined);
    if (!id) {
      apply(previous);
      throw new Error("Unknown voice backend.");
    }
    if (!voiceProvider(id).configured()) {
      apply(previous);
      throw new Error(`${voiceProvider(id).label} is not set up yet: it needs ${voiceProvider(id).requires}.`);
    }
    if (next.defaultProvider !== id) changed.push("defaultProvider");
    next.defaultProvider = id;
    apply(next);
  }
  writeStored(next);
  return { state: studioBackendsState(), changed };
}

/** Test seam: forget what was captured from the environment. */
export function resetStudioBackendsForTests(): void {
  if (baselineProvider !== undefined) {
    for (const [env, value] of baseline) {
      if (value === undefined) delete process.env[env];
      else process.env[env] = value;
    }
    config.voiceProvider = baselineProvider;
    config.voiceProviderSwitching = baselineSwitching!;
  }
  baseline.clear();
  baselineProvider = undefined;
  baselineSwitching = undefined;
}
