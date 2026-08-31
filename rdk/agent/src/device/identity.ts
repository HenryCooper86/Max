import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";

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
  candidate: string;
  token: string;
  pid: number;
  createdAt: number;
  ownerFingerprint: string;
  temporary: string;
};
const ID = /^rdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FINGERPRINT_LENGTH = 256;
const WAIT_MS = 25;
const MAX_WAITS = 240;
const STALE_OWNER_MS = 5_000;
const active = new Set<string>();
const seamKey = "__maxRdkDeviceIdentityFsSeam";
type InternalFsSeam = Partial<
  Pick<typeof import("node:fs"), "openSync" | "fsyncSync" | "closeSync" | "linkSync" | "unlinkSync" | "writeFileSync">
> & {
  now?: () => number;
  wait?: (milliseconds: number) => void;
  fingerprint?: (pid: number) => string | undefined;
};

function internalSeam(): InternalFsSeam {
  return ((globalThis as typeof globalThis & { __maxRdkDeviceIdentityFsSeam?: InternalFsSeam })[seamKey] ??
    {}) as InternalFsSeam;
}

function required(value: string): string {
  if (!ID.test(value)) throw new Error("Device identity must be a canonical lowercase rdk-UUIDv4");
  return value;
}
function uid(): number | undefined {
  return process.getuid?.();
}
function closeAfter(fd: number, close: typeof closeSync, primary: unknown, context: "read" | "sync"): void {
  let closeFailure: unknown;
  try {
    close(fd);
  } catch (error) {
    closeFailure = error;
  }
  if (primary && closeFailure) {
    throw new Error(
      `Device identity ${context} failed: ${primary instanceof Error ? primary.message : String(primary)}; close failed: ${closeFailure instanceof Error ? closeFailure.message : String(closeFailure)}`,
      { cause: closeFailure }
    );
  }
  if (primary) throw primary;
  if (closeFailure) throw closeFailure;
}
function sync(path: string): void {
  const io = internalSeam();
  const fd = (io.openSync ?? openSync)(path, "r");
  let primary: unknown;
  try {
    (io.fsyncSync ?? fsyncSync)(fd);
  } catch (error) {
    primary = error;
  }
  closeAfter(fd, io.closeSync ?? closeSync, primary, "sync");
}
function markerPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.marker`);
}
function pendingMarkerPath(canonical: string): string {
  return `${canonical}.pending`;
}
function markerSourcePath(canonical: string, token: string): string {
  return `${canonical}.new-${token}`;
}
function recoveryTemporaryPath(marker: Marker): string {
  return `${marker.temporary}.recover`;
}
function requirePrivateEntry(entry: Stats, directory: boolean, singleLink = !directory): void {
  if ((directory ? !entry.isDirectory() : !entry.isFile()) || entry.isSymbolicLink())
    throw new Error(
      `Device identity ${directory ? "parent" : "file"} is not a real ${directory ? "directory" : "regular file"}`
    );
  if ((entry.mode & 0o777) !== (directory ? 0o700 : 0o600))
    throw new Error(`Device identity ${directory ? "parent" : "file"} must be private`);
  if (singleLink && entry.nlink !== 1) throw new Error("Device identity file must not be linked");
  if (uid() !== undefined && entry.uid !== uid())
    throw new Error(`Device identity ${directory ? "parent" : "file"} has the wrong owner`);
}
function privateEntry(path: string, directory: boolean, singleLink = !directory): Stats {
  const entry = lstatSync(path);
  requirePrivateEntry(entry, directory, singleLink);
  return entry;
}
function secureParents(path: string, mkdir: typeof mkdirSync): void {
  const parent = resolve(dirname(path));
  try {
    privateEntry(parent, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdir(parent, { recursive: true, mode: 0o700 });
    privateEntry(parent, true);
  }
  const canonical = realpathSync(parent);
  const macVarAlias =
    process.platform === "darwin" && parent.startsWith("/var/") && canonical.startsWith("/private/var/");
  if (canonical !== parent && !macVarAlias) throw new Error("Device identity parent has a symlinked ancestor");
  for (let current = parent, root = parse(parent).root; current !== root; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink() && !(process.platform === "darwin" && current === "/var")) {
      throw new Error("Device identity parent has a symlinked ancestor");
    }
  }
}
function existing(path: string, read: typeof readFileSync): string | undefined {
  let before: Stats;
  try {
    before = privateEntry(path, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const io = internalSeam();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = (io.openSync ?? openSync)(path, flags);
  let primary: unknown;
  let result: string | undefined;
  try {
    const opened = fstatSync(fd);
    requirePrivateEntry(opened, false);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Device identity file changed while being opened");
    const contents = read(fd, "utf8");
    const after = privateEntry(path, false);
    if (opened.dev !== after.dev || opened.ino !== after.ino)
      throw new Error("Device identity file changed while being read");
    if (typeof contents !== "string") throw new Error("Device identity file did not contain text");
    result = required(contents.replace(/\n$/, ""));
  } catch (error) {
    primary = error;
  }
  closeAfter(fd, io.closeSync ?? closeSync, primary, "read");
  if (result === undefined) throw new Error("Device identity read produced no result");
  return result;
}
function expectedTemporary(canonical: string, token: string): string {
  const markerName = basename(canonical);
  const identityName = markerName.slice(1, -".marker".length);
  return join(dirname(canonical), `.${identityName}.tmp-${token}`);
}
function validFingerprint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FINGERPRINT_LENGTH &&
    value.trim() === value &&
    !/[\0\r\n]/.test(value)
  );
}
function readMarker(path: string, canonical = path): Marker | undefined {
  try {
    privateEntry(path, false, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Device identity marker is malformed", { cause: error });
  }
  const m = raw as Partial<Marker>;
  if (
    m.version !== 1 ||
    typeof m.candidate !== "string" ||
    typeof m.token !== "string" ||
    !TOKEN.test(m.token) ||
    typeof m.pid !== "number" ||
    !Number.isInteger(m.pid) ||
    m.pid <= 0 ||
    typeof m.createdAt !== "number" ||
    !Number.isFinite(m.createdAt) ||
    m.createdAt < 0 ||
    !validFingerprint(m.ownerFingerprint) ||
    typeof m.temporary !== "string" ||
    m.temporary !== expectedTemporary(canonical, m.token)
  )
    throw new Error("Device identity marker is malformed");
  required(m.candidate);
  return m as Marker;
}

function markersMatch(left: Marker, right: Marker): boolean {
  return (
    left.version === right.version &&
    left.candidate === right.candidate &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.createdAt === right.createdAt &&
    left.ownerFingerprint === right.ownerFingerprint &&
    left.temporary === right.temporary
  );
}

function defaultFingerprint(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (bootId.length === 0) throw new Error("Linux boot ID is empty");
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0) {
        const fieldsAfterCommand = stat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/);
        const startTime = fieldsAfterCommand[19];
        const fingerprint = `linux:${bootId}:${startTime ?? ""}`;
        if (/^\d+$/.test(startTime ?? "") && validFingerprint(fingerprint)) return fingerprint;
      }
    } catch {
      // Fall through to the portable process-start fingerprint.
    }
  }
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const fingerprint = `ps:${startedAt}`;
    return validFingerprint(fingerprint) && startedAt.length > 0 ? fingerprint : undefined;
  } catch {
    return undefined;
  }
}

function fingerprint(pid: number): string | undefined {
  const resolver = internalSeam().fingerprint ?? defaultFingerprint;
  try {
    const value = resolver(pid);
    return validFingerprint(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function now(): number {
  const value = (internalSeam().now ?? Date.now)();
  if (!Number.isFinite(value) || value < 0) throw new Error("Device identity clock is invalid");
  return value;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type OwnerDisposition = { takeOver: boolean; mayRemoveTemporary: boolean };

function ownerDisposition(marker: Marker): OwnerDisposition {
  if (marker.pid === process.pid) {
    const abandoned = !active.has(marker.token);
    return { takeOver: abandoned, mayRemoveTemporary: abandoned };
  }
  if (!pidExists(marker.pid)) return { takeOver: true, mayRemoveTemporary: true };
  const observedFingerprint = fingerprint(marker.pid);
  if (observedFingerprint && observedFingerprint !== marker.ownerFingerprint)
    return { takeOver: true, mayRemoveTemporary: true };
  const age = now() - marker.createdAt;
  return { takeOver: age < 0 || age >= STALE_OWNER_MS, mayRemoveTemporary: false };
}

function internalUnlink(path: string): boolean {
  try {
    (internalSeam().unlinkSync ?? unlinkSync)(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function linkMatchingMarker(
  source: string,
  target: string,
  marker: Marker,
  canonical: string,
  existingTargetIsContention: boolean
): void {
  try {
    (internalSeam().linkSync ?? linkSync)(source, target);
  } catch (error) {
    const found = readMarker(target, canonical);
    if (found && markersMatch(found, marker)) return;
    if (found && !existingTargetIsContention)
      throw new Error("Device identity marker publication conflicts", { cause: error });
    throw error;
  }
}

function cleanupMarkerSource(marker: Marker, canonical: string): void {
  const source = markerSourcePath(canonical, marker.token);
  const found = readMarker(source, canonical);
  if (!found) return;
  if (!markersMatch(found, marker)) throw new Error("Device identity marker source conflicts");
  internalUnlink(source);
  sync(dirname(canonical));
}

function throwPublicationFailure(marker: Marker, canonical: string, primary: unknown): never {
  let cleanupFailure: unknown;
  try {
    cleanupMarkerSource(marker, canonical);
  } catch (error) {
    cleanupFailure = error;
  }
  if (cleanupFailure) {
    throw new Error(
      `Device identity marker publication failed: ${primary instanceof Error ? primary.message : String(primary)}; marker temp cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
      { cause: cleanupFailure }
    );
  }
  throw primary;
}

function publishMarker(marker: Marker, canonical: string): void {
  const source = markerSourcePath(canonical, marker.token);
  const pending = pendingMarkerPath(canonical);
  let pendingEstablished = false;
  try {
    (internalSeam().writeFileSync ?? writeFileSync)(source, `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    sync(source);
    linkMatchingMarker(source, pending, marker, canonical, true);
    pendingEstablished = true;
    sync(dirname(canonical));
    linkMatchingMarker(pending, canonical, marker, canonical, false);
    sync(dirname(canonical));
    internalUnlink(pending);
    sync(dirname(canonical));
    cleanupMarkerSource(marker, canonical);
  } catch (error) {
    if (!pendingEstablished) throwPublicationFailure(marker, canonical, error);
    throw error;
  }
}

function reconcileMarker(canonical: string): Marker | undefined {
  const pendingPath = pendingMarkerPath(canonical);
  const pending = readMarker(pendingPath, canonical);
  let published = readMarker(canonical, canonical);
  if (pending) {
    if (published && !markersMatch(pending, published)) throw new Error("Device identity pending marker conflicts");
    if (!published) {
      linkMatchingMarker(pendingPath, canonical, pending, canonical, false);
      published = readMarker(canonical, canonical);
      if (!published || !markersMatch(pending, published))
        throw new Error("Device identity pending marker promotion failed");
    }
    sync(dirname(canonical));
    internalUnlink(pendingPath);
    sync(dirname(canonical));
    cleanupMarkerSource(pending, canonical);
    return pending;
  }
  if (published) cleanupMarkerSource(published, canonical);
  return published;
}
function wait(): void {
  const injected = internalSeam().wait;
  if (injected) {
    injected(WAIT_MS);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);
}

function removeMarker(path: string, unlink: typeof unlinkSync): void {
  try {
    unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  sync(dirname(path));
}

function stabilizeMarker(marker: Marker, canonical: string): void {
  sync(canonical);
  sync(dirname(canonical));
  cleanupMarkerSource(marker, canonical);
}

function cleanupAfterFailure(path: string, unlink: typeof unlinkSync, primary: unknown): never {
  try {
    unlink(path);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Device identity initialization failed: ${primary instanceof Error ? primary.message : String(primary)}; candidate temp cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError }
      );
    }
  }
  throw primary;
}

function ensureRecoveryTemporary(
  path: string,
  candidate: string,
  write: typeof writeFileSync,
  unlink: typeof unlinkSync
): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let existingCandidate: string | undefined;
    try {
      existingCandidate = existing(path, readFileSync);
    } catch (error) {
      try {
        privateEntry(path, false);
      } catch (validationError) {
        if ((validationError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        unlink(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw unlinkError;
      }
      sync(dirname(path));
      continue;
    }
    if (existingCandidate) {
      if (existingCandidate !== candidate) throw new Error("Device identity recovery temp conflicts");
      return;
    }
    try {
      write(path, `${candidate}\n`, { mode: 0o600, flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Device identity recovery temp could not be established");
}

function finishMatchingFinal(
  path: string,
  candidate: string,
  read: typeof readFileSync,
  chmod: typeof chmodSync,
  canonical: string,
  unlink: typeof unlinkSync,
  removeRecoverableMarker: boolean
): string | undefined {
  const final = existing(path, read);
  if (!final) return undefined;
  if (final !== candidate) throw new Error("Device identity marker and file disagree");
  chmod(path, 0o600);
  sync(path);
  sync(dirname(path));
  if (removeRecoverableMarker) removeMarker(canonical, unlink);
  return candidate;
}

export function loadOrCreateDeviceId(options: DeviceIdentityOptions): string {
  const read = options.readFile ?? readFileSync,
    write = options.writeFile ?? writeFileSync,
    rename = options.rename ?? renameSync,
    chmod = options.chmod ?? chmodSync,
    mkdir = options.mkdir ?? mkdirSync,
    unlink = options.unlink ?? unlinkSync;
  secureParents(options.path, mkdir);
  const canonical = markerPath(options.path);
  for (let attempts = 0; attempts < MAX_WAITS; attempts += 1) {
    const marker = reconcileMarker(canonical),
      final = existing(options.path, read);
    if (marker) {
      if (final && final !== marker.candidate) throw new Error("Device identity marker and file disagree");
      const disposition = ownerDisposition(marker);
      if (final === marker.candidate) {
        return finishMatchingFinal(
          options.path,
          marker.candidate,
          read,
          chmod,
          canonical,
          unlink,
          disposition.takeOver
        )!;
      }
      if (!disposition.takeOver) {
        wait();
        continue;
      }
      // The immutable marker remains the authority after a crash or failed call.
      active.add(marker.token);
      const recoveryTemporary = recoveryTemporaryPath(marker);
      try {
        stabilizeMarker(marker, canonical);
        if (disposition.mayRemoveTemporary) {
          try {
            unlink(marker.temporary);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        ensureRecoveryTemporary(recoveryTemporary, marker.candidate, write, unlink);
        sync(recoveryTemporary);
        rename(recoveryTemporary, options.path);
        chmod(options.path, 0o600);
        sync(options.path);
        sync(dirname(options.path));
        removeMarker(canonical, unlink);
        return marker.candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const converged = finishMatchingFinal(options.path, marker.candidate, read, chmod, canonical, unlink, true);
          if (converged) return converged;
        }
        cleanupAfterFailure(recoveryTemporary, unlink, error);
      } finally {
        active.delete(marker.token);
      }
    }
    if (final) return final;
    const ownerFingerprint = fingerprint(process.pid);
    if (!ownerFingerprint) throw new Error("Device identity owner fingerprint is unavailable or invalid");
    const createdAt = now(),
      candidate = required(options.randomId?.() ?? `rdk-${randomUUID()}`),
      token = randomUUID();
    const ours: Marker = {
      version: 1,
      candidate,
      token,
      pid: process.pid,
      createdAt,
      ownerFingerprint,
      temporary: join(dirname(options.path), `.${basename(options.path)}.tmp-${token}`)
    };
    active.add(token);
    try {
      publishMarker(ours, canonical);
    } catch (error) {
      active.delete(token);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      write(ours.temporary, `${candidate}\n`, { mode: 0o600, flag: "wx" });
      sync(ours.temporary);
      rename(ours.temporary, options.path);
      chmod(options.path, 0o600);
      sync(options.path);
      sync(dirname(options.path));
      removeMarker(canonical, unlink);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const converged = finishMatchingFinal(options.path, candidate, read, chmod, canonical, unlink, true);
        if (converged) return converged;
      }
      cleanupAfterFailure(ours.temporary, unlink, error);
    } finally {
      active.delete(token);
    }
  }
  throw new Error("Timed out waiting for device identity initialization");
}
