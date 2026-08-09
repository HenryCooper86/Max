import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type DeviceIdentityOptions = {
  path: string;
  readFile?: typeof readFileSync;
  writeFile?: typeof writeFileSync;
  rename?: typeof renameSync;
  chmod?: typeof chmodSync;
  mkdir?: typeof mkdirSync;
  unlink?: typeof unlinkSync;
  randomId?: () => string;
};

const DEVICE_ID = /^rdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireDeviceId(candidate: string): string {
  if (!DEVICE_ID.test(candidate)) throw new Error("Device identity must be a canonical lowercase rdk-UUIDv4");
  return candidate;
}

function persistedDeviceId(contents: string): string {
  const match = /^(rdk-[0-9a-f-]+)\n?$/.exec(contents);
  if (!match) throw new Error("Device identity file is empty or malformed");
  return requireDeviceId(match[1]!);
}

function existingDeviceId(readFile: typeof readFileSync, path: string): string | undefined {
  try {
    return persistedDeviceId(readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Returns the one durable identity assigned to this board. A persistence error
 * is fatal: silently rotating the ID would strand an existing phone pairing.
 */
export function loadOrCreateDeviceId(options: DeviceIdentityOptions): string {
  const readFile = options.readFile ?? readFileSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const rename = options.rename ?? renameSync;
  const chmod = options.chmod ?? chmodSync;
  const mkdir = options.mkdir ?? mkdirSync;
  const unlink = options.unlink ?? unlinkSync;

  const existing = existingDeviceId(readFile, options.path);
  if (existing) return existing;

  const candidate = requireDeviceId(options.randomId?.() ?? `rdk-${randomUUID()}`);
  const parent = dirname(options.path);
  const temporary = join(parent, `.${basename(options.path)}.tmp-${process.pid}-${randomUUID()}`);
  const lock = join(parent, `.${basename(options.path)}.lock`);
  let writeAttempted = false;
  let temporaryCreated = false;
  let lockDescriptor: number | undefined;

  try {
    mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      lockDescriptor = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Device identity initialization is already in progress", { cause: error });
      }
      throw error;
    }

    const winner = existingDeviceId(readFile, options.path);
    if (winner) return winner;

    writeAttempted = true;
    writeFile(temporary, `${candidate}\n`, { mode: 0o600, flag: "wx" });
    temporaryCreated = true;
    syncPath(temporary);
    try {
      rename(temporary, options.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      unlink(temporary);
      temporaryCreated = false;
      const winner = existingDeviceId(readFile, options.path);
      if (winner) return winner;
      throw error;
    }
    temporaryCreated = false;
    chmod(options.path, 0o600);
    syncPath(options.path);
    syncPath(parent);
    return candidate;
  } catch (error) {
    // `wx` reports EEXIST before creating anything. For every other failed
    // write attempt, a temp file at our unguessable per-call path belongs to
    // this call (including a partial file created before an I/O error).
    const existingTemp = (error as NodeJS.ErrnoException).code !== "EEXIST" && writeAttempted;
    if (temporaryCreated || existingTemp) {
      try {
        unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `Device identity persistence failed and temporary cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            { cause: cleanupError }
          );
        }
      }
    }
    throw error;
  } finally {
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      unlink(lock);
    }
  }
}
