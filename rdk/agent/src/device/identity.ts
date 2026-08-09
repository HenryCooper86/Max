import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
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

type Marker = {
  version: 1;
  owner: string;
  pid: number;
  candidate: string;
  phase: "preparing" | "recoverable" | "published";
};

const DEVICE_ID = /^rdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WAIT_MS = 25;
const MAX_WAITS = 200;

function requireDeviceId(candidate: string): string {
  if (!DEVICE_ID.test(candidate)) throw new Error("Device identity must be a canonical lowercase rdk-UUIDv4");
  return candidate;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function requirePrivate(path: string, directory: boolean): void {
  const entry = lstatSync(path);
  if ((directory ? !entry.isDirectory() : !entry.isFile()) || entry.isSymbolicLink()) {
    throw new Error(
      `Device identity ${directory ? "parent" : "file"} must be a real ${directory ? "directory" : "regular file"}`
    );
  }
  if ((entry.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw new Error(`Device identity ${directory ? "parent" : "file"} must have a private mode`);
  }
  const uid = currentUid();
  if (uid !== undefined && entry.uid !== uid)
    throw new Error(`Device identity ${directory ? "parent" : "file"} has the wrong owner`);
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function markerPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.marker`);
}

function tempPath(path: string, owner: string): string {
  return join(dirname(path), `.${basename(path)}.tmp-${owner}`);
}

function readMarker(path: string): Marker | undefined {
  try {
    requirePrivate(path, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Device identity marker is malformed", { cause: error });
  }
  const marker = parsed as Partial<Marker>;
  if (
    marker.version !== 1 ||
    typeof marker.owner !== "string" ||
    !/^[0-9a-f-]{36}$/.test(marker.owner) ||
    typeof marker.pid !== "number" ||
    !Number.isInteger(marker.pid) ||
    marker.pid <= 0 ||
    typeof marker.candidate !== "string" ||
    !["preparing", "recoverable", "published"].includes(marker.phase ?? "")
  ) {
    throw new Error("Device identity marker is malformed");
  }
  requireDeviceId(marker.candidate);
  return marker as Marker;
}

function writeMarker(path: string, marker: Marker, exclusive: boolean): void {
  writeFileSync(path, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: exclusive ? "wx" : "w" });
  syncPath(path);
  syncPath(dirname(path));
}

function removeOwnedMarker(path: string, owner: string): void {
  const marker = readMarker(path);
  if (!marker || marker.owner !== owner) return;
  unlinkSync(path);
  syncPath(dirname(path));
}

function existingDeviceId(path: string, readFile: typeof readFileSync): string | undefined {
  try {
    requirePrivate(path, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return requireDeviceId(readFile(path, "utf8").replace(/\n$/, ""));
}

function createParent(path: string, mkdir: typeof mkdirSync): void {
  const parent = dirname(path);
  try {
    requirePrivate(parent, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdir(parent, { recursive: true, mode: 0o700 });
    requirePrivate(parent, true);
  }
}

/** Returns the durable, canonical identity for this board or throws loudly. */
export function loadOrCreateDeviceId(options: DeviceIdentityOptions): string {
  const readFile = options.readFile ?? readFileSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const rename = options.rename ?? renameSync;
  const chmod = options.chmod ?? chmodSync;
  const mkdir = options.mkdir ?? mkdirSync;
  const unlink = options.unlink ?? unlinkSync;
  const markerFile = markerPath(options.path);
  let candidate: string | undefined;
  const nextCandidate = (): string => {
    if (!candidate) candidate = requireDeviceId(options.randomId?.() ?? `rdk-${randomUUID()}`);
    return candidate;
  };

  createParent(options.path, mkdir);
  for (let waits = 0; waits < MAX_WAITS; waits += 1) {
    const marker = readMarker(markerFile);
    const final = existingDeviceId(options.path, readFile);

    if (marker) {
      if (final) {
        if (final !== marker.candidate) throw new Error("Device identity marker and file disagree");
        chmod(options.path, 0o600);
        syncPath(options.path);
        syncPath(dirname(options.path));
        removeOwnedMarker(markerFile, marker.owner);
        return final;
      }
      if (marker.phase === "recoverable" || !alive(marker.pid)) {
        const ownedTemp = tempPath(options.path, marker.owner);
        try {
          unlink(ownedTemp);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        removeOwnedMarker(markerFile, marker.owner);
        candidate = marker.candidate;
        continue;
      }
      pause();
      continue;
    }
    if (final) return final;

    const owner = randomUUID();
    const ours: Marker = { version: 1, owner, pid: process.pid, candidate: nextCandidate(), phase: "preparing" };
    try {
      writeMarker(markerFile, ours, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    const temporary = tempPath(options.path, owner);
    let published = false;
    try {
      const winner = existingDeviceId(options.path, readFile);
      if (winner) {
        removeOwnedMarker(markerFile, owner);
        return winner;
      }
      writeFile(temporary, `${ours.candidate}\n`, { mode: 0o600, flag: "wx" });
      syncPath(temporary);
      rename(temporary, options.path);
      published = true;
      writeMarker(markerFile, { ...ours, phase: "published" }, false);
      chmod(options.path, 0o600);
      syncPath(options.path);
      syncPath(dirname(options.path));
      removeOwnedMarker(markerFile, owner);
      return ours.candidate;
    } catch (error) {
      if (!published) {
        try {
          unlink(temporary);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
        writeMarker(markerFile, { ...ours, phase: "recoverable" }, false);
      }
      throw error;
    }
  }
  throw new Error("Timed out waiting for device identity initialization");
}
