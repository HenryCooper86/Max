import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The assistant configs that have been live, newest first, so that an owner
 * can see what changed and go back to an earlier one.
 *
 * One file for each config, in a directory beside the config itself. A config
 * that is the same as the newest one kept is not kept again, and only the
 * last fifty are.
 */

const MAX_KEPT = 50;
const VERSION_ID = /^\d{13}-[0-9a-f]{8}$/;

export type ConfigVersion = {
  id: string;
  savedAt: number;
  /**
   * Who made it the live config: an admin's name, "studio", "file" for a
   * config found on disk at startup, or "defaults" for the relay's built-in
   * assistant before the first save.
   */
  by: string;
  /** The version this one was restored from, when it was. */
  restoredFrom?: string;
  config: Record<string, unknown>;
};

export type ConfigVersionSummary = Omit<ConfigVersion, "config"> & {
  /** The assistant's name and the config's own `version` label, when it has them. */
  name?: string;
  version?: string;
  /** The top-level keys that differ from the version before it. Empty for the oldest one kept. */
  changed: string[];
  /** True for the newest version that says what the live config says. */
  current: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** JSON with every object's keys in order, so two configs that say the same compare equal. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function ids(directory: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && VERSION_ID.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort()
    .reverse();
}

export function readConfigVersion(directory: string, id: string): ConfigVersion | undefined {
  // The id is part of a file name: nothing but the ids this module makes.
  if (!VERSION_ID.test(id)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.config) || typeof parsed.savedAt !== "number") return undefined;
    return {
      id,
      savedAt: parsed.savedAt,
      by: typeof parsed.by === "string" ? parsed.by : "unknown",
      ...(typeof parsed.restoredFrom === "string" ? { restoredFrom: parsed.restoredFrom } : {}),
      config: parsed.config
    };
  } catch {
    return undefined;
  }
}

/** Every version that can be read, newest first. */
function readAll(directory: string): ConfigVersion[] {
  return ids(directory)
    .map((id) => readConfigVersion(directory, id))
    .filter((version): version is ConfigVersion => version !== undefined);
}

function writeVersion(directory: string, version: ConfigVersion): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${version.id}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  const entry = {
    savedAt: version.savedAt,
    by: version.by,
    ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {}),
    config: version.config
  };
  // The config may name webhooks and servers: readable by the relay's user only, like the config.
  fs.writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Keeps `config` as the newest version, unless the newest one kept says the
 * same. Returns the id it was kept under, or nothing when it was not.
 */
export function recordConfigVersion(
  directory: string,
  config: Record<string, unknown>,
  by: string,
  options: { restoredFrom?: string; now?: number } = {}
): string | undefined {
  const written = stableJson(config);
  const kept = ids(directory);
  // The newest one that can be read: a damaged file is not what the config is compared with.
  let newest: ConfigVersion | undefined;
  for (const id of kept) {
    newest = readConfigVersion(directory, id);
    if (newest) break;
  }
  if (newest && stableJson(newest.config) === written) return undefined;
  // Never an id below the newest file's, readable or not: a clock that went back must not reorder the history.
  const last = Number(kept[0]?.slice(0, 13) ?? 0);
  const savedAt = Math.max(options.now ?? Date.now(), last + 1);
  const id = `${String(savedAt).padStart(13, "0")}-${createHash("sha256").update(written).digest("hex").slice(0, 8)}`;
  writeVersion(directory, {
    id,
    savedAt,
    by: by.slice(0, 80),
    ...(options.restoredFrom ? { restoredFrom: options.restoredFrom } : {}),
    config
  });
  for (const old of kept.slice(MAX_KEPT - 1)) fs.rmSync(path.join(directory, `${old}.json`), { force: true });
  return id;
}

/**
 * The versions kept, newest first, each with what changed since the one
 * before. With `live`, the newest version that says what it says is marked
 * `current`.
 */
export function listConfigVersions(directory: string, live?: Record<string, unknown>): ConfigVersionSummary[] {
  const versions = readAll(directory);
  const written = versions.map((version) => stableJson(version.config));
  const current = live ? written.indexOf(stableJson(live)) : -1;
  return versions.map(({ config, ...rest }, index) => {
    const before = versions[index + 1]?.config;
    const changed = before
      ? [...new Set([...Object.keys(config), ...Object.keys(before)])]
          .filter((key) => stableJson(config[key]) !== stableJson(before[key]))
          .sort()
      : [];
    return {
      ...rest,
      ...(typeof config.name === "string" && config.name.trim() ? { name: config.name.trim().slice(0, 80) } : {}),
      ...(typeof config.version === "string" && config.version.trim()
        ? { version: config.version.trim().slice(0, 64) }
        : {}),
      changed,
      current: index === current
    };
  });
}

/** Removes one version, for a config that held something that must not be kept. Returns whether there was one. */
export function removeConfigVersion(directory: string, id: string): boolean {
  if (!readConfigVersion(directory, id)) return false;
  fs.rmSync(path.join(directory, `${id}.json`), { force: true });
  return true;
}

/**
 * Changes the kept configs in place: `change` returns the config a version
 * should hold instead, or nothing to leave it. For what no longer exists
 * anywhere and so cannot be gone back to.
 */
export function rewriteConfigVersions(
  directory: string,
  change: (config: Record<string, unknown>) => Record<string, unknown> | undefined
): number {
  let rewritten = 0;
  for (const version of readAll(directory)) {
    const config = change(version.config);
    if (!config) continue;
    writeVersion(directory, { ...version, config });
    rewritten += 1;
  }
  return rewritten;
}
