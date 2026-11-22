import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantSummary, VoiceEqualizerOptions, VoiceProviderSummary } from "../shared/agent";
import {
  assistant,
  assistantProfileFrom,
  assistantSummary,
  DEPLOYER_KEYS,
  installAssistantProfile,
  loadedAssistantConfig,
  wakeWordActive,
  type AssistantProfile
} from "./assistant";
import {
  listConfigVersions,
  readConfigVersion,
  recordConfigVersion,
  removeConfigVersion,
  rewriteConfigVersions,
  stableJson,
  type ConfigVersionSummary
} from "./config-history";
import { checkFlow, flowFrom, type FlowStep } from "./flow";
import { createLogger } from "./logger";
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

const log = createLogger("studio");

/** The assistant the relay started with: some of a config is read once, at startup. */
const atStart = assistant();

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

// ---- the configs that have been live ----------------------------------------------

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function historyDirectory(): string {
  return path.join(studioDirectory(), "config-history");
}

/** Keeps a config that has just gone live. A history that cannot be written never fails the save itself. */
function remember(stored: Record<string, unknown>, by: string, restoredFrom?: string): void {
  try {
    recordConfigVersion(historyDirectory(), stored, by, restoredFrom ? { restoredFrom } : {});
  } catch (error) {
    log.warn("the config history could not be written", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Before the first config is saved on a relay that runs its built-in
 * assistant: keeps that as the first entry, so there is a way back to it.
 */
function rememberDefaults(): void {
  if (!assistant().isDefault || fs.existsSync(studioConfigPath())) return;
  try {
    if (listConfigVersions(historyDirectory()).length === 0) recordConfigVersion(historyDirectory(), {}, "defaults");
  } catch {
    /* the save itself goes on without a history */
  }
}

/**
 * Keeps the config the relay started with, when it is not the newest one
 * kept already: a file edited by hand is part of the history too.
 *
 * A restore writes the Studio's own file. When the relay started from a file
 * somewhere else (./assistant.config.json, before the first save), the paths
 * in it are made absolute, so they still lead to the same files from there.
 */
export function recordStartupConfig(loaded = loadedAssistantConfig()): void {
  const config = startupConfig(loaded);
  if (config) remember(config, "file");
}

/** The config the relay started from, written so that it means the same in the Studio's own file. */
function startupConfig(loaded = loadedAssistantConfig()): Record<string, unknown> | undefined {
  if (!loaded) return undefined;
  const config: Record<string, unknown> = { ...loaded.raw };
  if (path.resolve(loaded.file) !== studioConfigPath()) {
    const directory = path.dirname(loaded.file);
    for (const key of ["toolsModule", "logo"]) {
      if (typeof config[key] === "string" && config[key]) config[key] = path.resolve(directory, config[key]);
    }
    // The knowledge base's paths, as the loader resolved them.
    const knowledge = assistant().deployerConfig.knowledge;
    if (knowledge !== undefined) config.knowledge = knowledge;
  }
  return config;
}

// ---- the flow: the assistant's agents as steps and arrows --------------------------

export type StudioFlow = {
  ok: true;
  /** The steps of the running assistant, the starting step first. */
  steps: FlowStep[];
  /** What the relay skipped in the stored `agents` key, if anything. */
  problems: string[];
};

export function studioFlow(): StudioFlow {
  return { ok: true, ...flowFrom(assistant().deployerConfig.agents) };
}

/** A flow that cannot be saved as drawn. `problems` says why, one sentence each. */
export class FlowError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}

/**
 * Saves a flow drawn in the Studio as the config's `agents` key and makes it
 * live for new conversations. Everything else in the config stays as it is.
 */
export function saveStudioFlow(raw: unknown, by: string, loaded = loadedAssistantConfig()): StudioFlow {
  const checked = checkFlow(raw);
  if ("problems" in checked) throw new FlowError(checked.problems);
  const file = studioConfigPath();
  let previous: string | undefined;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch {
    /* there was no file */
  }
  // Without a file of the Studio's own, the relay runs the config it started from: that is what the flow goes into.
  const next: Record<string, unknown> = { ...(previous !== undefined ? readStored() : (startupConfig(loaded) ?? {})) };
  if (checked.agents) next.agents = checked.agents;
  else delete next.agents;
  rememberDefaults();
  try {
    writeStored(next);
  } catch (error) {
    throw new ConfigFileError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  try {
    apply(next);
  } catch (error) {
    if (previous !== undefined) fs.writeFileSync(file, previous, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
    throw error;
  }
  remember(next, by);
  return studioFlow();
}

export type StudioHistory = { ok: true; versions: ConfigVersionSummary[] };

/** The configs kept, newest first. `current` marks the newest one that says what the config file says now. */
export function studioHistory(): StudioHistory {
  return { ok: true, versions: listConfigVersions(historyDirectory(), readStored()) };
}

/** One kept config in full, or nothing when there is none of that id. The logo's path stays on the server. */
export function studioVersion(
  id: string
): { ok: true; id: string; savedAt: number; by: string; config: unknown } | undefined {
  const version = readConfigVersion(historyDirectory(), id);
  if (!version) return undefined;
  return {
    ok: true,
    id: version.id,
    savedAt: version.savedAt,
    by: version.by,
    config: without(version.config, "logo")
  };
}

/** Removes one kept config: for one that held a secret, say. Returns whether there was one. */
export function deleteStudioVersion(id: string): boolean {
  return removeConfigVersion(historyDirectory(), id);
}

/** The config file could not be written. Nothing about the assistant changed. */
export class ConfigFileError extends Error {}

/** A logo path is worth keeping when the file is there. */
function logoReadable(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return fs.statSync(path.resolve(path.dirname(studioConfigPath()), value)).isFile();
  } catch {
    return false;
  }
}

/** What the relay reads of a profile only when it starts, in a form that compares. */
function readAtStartup(profile: AssistantProfile): Record<string, string> {
  return {
    // The knowledge base as the loader resolved it: the same files written another way are the same.
    tools: stableJson({
      tools: profile.tools.tools,
      module: profile.tools.modulePath,
      mcpServers: profile.tools.mcpServers,
      knowledge: profile.deployerConfig.knowledge
    }),
    analysis: stableJson(profile.analysis),
    privacy: stableJson([...profile.redact].sort()),
    variants: String(profile.variants.length > 0)
  };
}

/**
 * Makes a kept config the live one again: the whole file as it was, the keys
 * the Studio does not edit included. Returns nothing when there is no such
 * version, and throws when the config is no longer valid or the file cannot
 * be written. `restartFor` names what the running relay read only once, at
 * startup, and so still has from the config it started with.
 *
 * The history keeps the logo's path, not the picture. A version whose logo
 * file is gone gets the logo there is now.
 */
export function restoreStudioConfig(
  id: string,
  by: string,
  /** The assistant the relay started with. Given in tests. */
  startedWith: AssistantProfile = atStart
): (StudioState & { restartFor: string[] }) | undefined {
  const version = readConfigVersion(historyDirectory(), id);
  if (!version) return undefined;
  const file = studioConfigPath();
  let previous: string | undefined;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch {
    /* there was no file */
  }
  const config = { ...version.config };
  if (config.logo !== undefined && !logoReadable(config.logo)) {
    const current = readStored().logo;
    if (logoReadable(current)) config.logo = current;
    else delete config.logo;
  }
  try {
    writeStored(config);
  } catch (error) {
    throw new ConfigFileError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  let profile: AssistantProfile;
  try {
    profile = apply(config);
  } catch (error) {
    // Back to the file exactly as it was, readable or not.
    if (previous !== undefined) fs.writeFileSync(file, previous, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
    throw error;
  }
  remember(config, by, id);
  const now = readAtStartup(profile);
  const then = readAtStartup(startedWith);
  return { ...studioState(), restartFor: Object.keys(now).filter((key) => now[key] !== then[key]) };
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
export function saveStudioConfig(raw: unknown, by = "studio"): StudioState {
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
  // The same goes for everything else a deployer wires up: agents, MCP
  // servers, the knowledge base, conversation rules and records.
  const deployed = assistant().deployerConfig;
  for (const key of DEPLOYER_KEYS) {
    if (previous[key] !== undefined) next[key] = previous[key];
    else if (deployed[key] !== undefined) next[key] = deployed[key];
  }

  const before = readStored();
  rememberDefaults();
  writeStored(next);
  try {
    apply(next);
  } catch (error) {
    writeStored(before);
    throw error;
  }
  remember(next, by);
  return studioState();
}

/** Clears the assistant's saved voice id when it is `id`, through the same
 *  validated save the Studio uses. Returns whether it changed anything. */
export function clearStudioVoice(id: string): boolean {
  // The voice is gone for good: no kept config may bring its id back.
  try {
    rewriteConfigVersions(historyDirectory(), (config) => {
      if (!isRecord(config.voice) || config.voice.id !== id) return undefined;
      const rest = without(config.voice, "id");
      return Object.keys(rest).length > 0 ? { ...config, voice: rest } : without(config, "voice");
    });
  } catch (error) {
    log.warn("a deleted voice could not be taken out of the config history", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const stored = readStored();
  const voice = stored.voice;
  if (!isRecord(voice) || voice.id !== id) return false;
  const rest = Object.fromEntries(Object.entries(voice).filter(([key]) => key !== "id"));
  const next = { ...stored };
  if (Object.keys(rest).length) next.voice = rest;
  else delete next.voice;
  saveStudioConfig(next);
  return true;
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
  rememberDefaults();
  fs.writeFileSync(file, body, { mode: 0o644 });
  const stored = { ...readStored(), logo: file };
  writeStored(stored);
  apply(stored);
  remember(stored, "studio");
  return studioState();
}

/** Goes back to the device's built-in mark. */
export function removeStudioLogo(): StudioState {
  const stored = readStored();
  delete stored.logo;
  removeLogoFiles();
  writeStored(stored);
  apply(stored);
  remember(stored, "studio");
  return studioState();
}
