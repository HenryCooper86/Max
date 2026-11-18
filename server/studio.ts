import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantSummary, VoiceEqualizerOptions, VoiceProviderSummary } from "../shared/agent";
import {
  assistant,
  assistantProfileFrom,
  assistantSummary,
  installAssistantProfile,
  wakeWordActive,
  type AssistantProfile
} from "./assistant";
import { equalizerOptions } from "./audio-eq";
import { DEVICE_PRESETS } from "./device-presets";
import { voiceProviderSummaries } from "./providers/catalog";
import { config } from "./runtime-config";

/**
 * The Studio: an admin edits the running relay's assistant from the app
 * instead of from a text editor on the server.
 *
 * What it writes is the same `assistant.config.json` the setup wizard writes,
 * validated by the same loader, so there is one definition of a valid
 * assistant. A save takes effect at once for new sessions; a session already
 * in progress keeps the persona it started with.
 *
 * The Studio never touches `.env`. API keys stay on the server's disk and
 * reach the app only as "set" or "not set".
 */

/** Where the Studio keeps its config and uploaded logo. Outside the app
 *  directory on purpose: a deploy replaces that directory wholesale. */
function studioDirectory(): string {
  return process.env.STUDIO_DIR?.trim() || path.join(os.homedir(), ".max-relay");
}

/** The config file the Studio reads and writes: ASSISTANT_CONFIG when the
 *  deployment names one, else the Studio's own file. */
export function studioConfigPath(): string {
  const configured = process.env.ASSISTANT_CONFIG?.trim();
  if (configured && configured.toLowerCase() !== "off") return path.resolve(configured);
  return path.join(studioDirectory(), "assistant.config.json");
}

/** Keys an admin may set from the app. `logo` is managed by the upload
 *  endpoints, never typed in: it is a path on the server's disk. */
const EDITABLE_KEYS = [
  "name",
  "device",
  "deviceLabel",
  "wearer",
  "tagline",
  "developer",
  "identityNotes",
  "languages",
  "strictLanguages",
  "wake",
  "persona",
  "instructions",
  "greeting",
  "wakeWord",
  "template",
  "theme",
  "templateSwitching",
  "visualizer",
  "accentColor",
  "logoBackground",
  "voice"
] as const;

const MAX_CONFIG_BYTES = 24 * 1024;
const MAX_LOGO_BYTES = 512 * 1024;

type StudioDevice = {
  id: string;
  family: string;
  label: { zh: string; en: string };
  template: string;
  visualizer: string;
  equalizer: string;
};

export type StudioState = {
  ok: true;
  /** The stored config, or {} when the relay runs on its built-in defaults. */
  config: Record<string, unknown>;
  /** What clients currently see on /health. */
  assistant: AssistantSummary;
  /** True when a custom logo has been uploaded. */
  customLogo: boolean;
  devices: StudioDevice[];
  equalizer: VoiceEqualizerOptions;
  providers: VoiceProviderSummary[];
  defaultProvider: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStored(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStored(stored: Record<string, unknown>): void {
  const file = studioConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write beside the target and rename, so a crash never leaves half a file.
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function apply(stored: Record<string, unknown>): AssistantProfile {
  const profile = assistantProfileFrom(stored, path.dirname(studioConfigPath()));
  installAssistantProfile(profile);
  return profile;
}

export function studioState(): StudioState {
  const stored = readStored();
  const { logo, ...visible } = stored;
  return {
    ok: true,
    config: visible,
    assistant: assistantSummary(wakeWordActive(config.wakeWord)),
    customLogo: typeof logo === "string" && logo.length > 0,
    devices: DEVICE_PRESETS.map((preset) => ({
      id: preset.id,
      family: preset.family,
      label: preset.label,
      template: preset.template,
      visualizer: preset.visualizer,
      equalizer: preset.equalizer
    })),
    equalizer: equalizerOptions(undefined, config.voiceEqualizerAdjustable),
    providers: voiceProviderSummaries(),
    defaultProvider: config.voiceProvider
  };
}

/** Validates and saves an edited config, then makes it the live assistant.
 *  Throws with a message fit to show the admin when the config is not valid. */
export function saveStudioConfig(raw: unknown): StudioState {
  if (!isRecord(raw)) throw new Error("The assistant config must be an object.");
  const next: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") next[key] = raw[key];
  }
  if (typeof next.name === "string" && !next.name.trim()) delete next.name;
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_CONFIG_BYTES) {
    throw new Error("The assistant config is too large.");
  }
  // The uploaded logo survives edits to everything else, and so do the
  // tools: they are wired up by whoever deploys the relay (a module path is
  // code on the server's disk), never typed into the app.
  const previous = readStored();
  if (typeof previous.logo === "string") next.logo = previous.logo;
  // The Studio's file is often not where the tools were declared: before the
  // first save the relay runs ./assistant.config.json, and once a Studio file
  // exists it wins. Carry the running assistant's tools over, so a save can
  // never silently drop them at the next restart. The module path is absolute
  // here, so it still resolves from the Studio's directory.
  const running = assistant().tools;
  if (previous.tools !== undefined) next.tools = previous.tools;
  else if (running.tools !== undefined) next.tools = running.tools;
  if (typeof previous.toolsModule === "string") next.toolsModule = previous.toolsModule;
  else if (running.modulePath) next.toolsModule = running.modulePath;

  const before = readStored();
  writeStored(next);
  try {
    apply(next);
  } catch (error) {
    writeStored(before);
    throw error;
  }
  return studioState();
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The logo is served on the relay's own origin. It goes out under a sandbox
// policy that already stops script, but an upload is still held to a plain
// drawing: nothing that scripts, embeds a document or fetches from elsewhere.
const UNSAFE_SVG =
  /<\s*script|<\s*foreignObject|<\s*iframe|<\s*embed|<\s*object|<!ENTITY|<!DOCTYPE[^>]*\[|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg);base64,)/i;

/** Returns the file extension for an acceptable logo, or throws. Exported for tests. */
export function checkLogoUpload(body: Buffer): "svg" | "png" {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error("The logo file is empty.");
  if (body.length > MAX_LOGO_BYTES) throw new Error("The logo must be 512 KB or smaller.");
  if (body.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  const text = body.toString("utf8");
  if (!/<svg[\s>]/i.test(text.slice(0, 2048))) throw new Error("The logo must be an SVG or PNG image.");
  if (UNSAFE_SVG.test(text)) {
    throw new Error("This SVG contains scripts, embedded documents or external links. Export it as a plain drawing.");
  }
  return "svg";
}

function removeLogoFiles(): void {
  for (const extension of ["svg", "png"]) {
    fs.rmSync(path.join(studioDirectory(), `brand-logo.${extension}`), { force: true });
  }
}

/** Stores an uploaded logo and makes it the assistant's. */
export function saveStudioLogo(body: Buffer): StudioState {
  const extension = checkLogoUpload(body);
  const directory = studioDirectory();
  fs.mkdirSync(directory, { recursive: true });
  removeLogoFiles();
  const file = path.join(directory, `brand-logo.${extension}`);
  fs.writeFileSync(file, body, { mode: 0o644 });
  const stored = { ...readStored(), logo: file };
  writeStored(stored);
  apply(stored);
  return studioState();
}

/** Goes back to the device's built-in mark. */
export function removeStudioLogo(): StudioState {
  const stored = readStored();
  delete stored.logo;
  removeLogoFiles();
  writeStored(stored);
  apply(stored);
  return studioState();
}
