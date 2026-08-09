import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../rdk/agent/src/config";
import { loadOrCreateDeviceId } from "../rdk/agent/src/device/identity";

const DEVICE_ID = "rdk-123e4567-e89b-42d3-a456-426614174000";
const OTHER_DEVICE_ID = "rdk-123e4567-e89b-42d3-a456-426614174001";
const MARKER_TOKEN = "00000000-0000-4000-8000-000000000000";
const OWNER_FINGERPRINT = "test-boot:12345";
const TEMPORARY_DIRECTORIES: string[] = [];
const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;
const seam = globalThis as typeof globalThis & {
  __maxRdkDeviceIdentityFsSeam?: {
    fsyncSync?: typeof import("node:fs").fsyncSync;
    linkSync?: typeof import("node:fs").linkSync;
    openSync?: typeof import("node:fs").openSync;
    closeSync?: typeof import("node:fs").closeSync;
    unlinkSync?: typeof import("node:fs").unlinkSync;
    writeFileSync?: typeof import("node:fs").writeFileSync;
    now?: () => number;
    wait?: (milliseconds: number) => void;
    fingerprint?: (pid: number) => string | undefined;
  };
};

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "max-device-identity-"));
  TEMPORARY_DIRECTORIES.push(directory);
  return join(directory, "state", "device-id");
}

function canonicalMarkerPath(path: string): string {
  return join(dirname(path), ".device-id.marker");
}

function pendingMarkerPath(path: string): string {
  return `${canonicalMarkerPath(path)}.pending`;
}

function markerSourcePaths(path: string): string[] {
  return readdirSync(dirname(path))
    .filter((entry) => entry.startsWith(".device-id.marker.new-"))
    .map((entry) => join(dirname(path), entry));
}

function writeMarker(
  path: string,
  overrides: Partial<{
    version: number;
    candidate: string;
    token: string;
    pid: number;
    createdAt: number;
    ownerFingerprint: unknown;
    temporary: string;
  }> = {}
): { markerPath: string; temporary: string } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const markerPath = join(dirname(path), ".device-id.marker");
  const temporary = join(dirname(path), `.device-id.tmp-${MARKER_TOKEN}`);
  writeFileSync(
    markerPath,
    `${JSON.stringify({
      version: 1,
      candidate: DEVICE_ID,
      token: MARKER_TOKEN,
      pid: process.ppid,
      createdAt: 1_000,
      ownerFingerprint: OWNER_FINGERPRINT,
      temporary,
      ...overrides
    })}\n`,
    { mode: 0o600 }
  );
  return { markerPath, temporary };
}

function child(
  path: string,
  id: string,
  extra: NodeJS.ProcessEnv = {}
): { process: ChildProcess; done: Promise<string>; ready: Promise<void> } {
  const childProcess = spawn(process.execPath, ["--import", tsxImport, "tests/fixtures/rdk-device-identity-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, IDENTITY_PATH: path, IDENTITY_ID: id, ...extra },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  let error = "";
  childProcess.stdout?.on("data", (chunk: Buffer) => (output += chunk));
  childProcess.stderr?.on("data", (chunk: Buffer) => (error += chunk));
  const ready = new Promise<void>((resolve) => childProcess.once("message", () => resolve()));
  return {
    process: childProcess,
    ready,
    done: new Promise((resolve, reject) =>
      childProcess.once("exit", (code, signal) => {
        if (code === 0) resolve(output);
        else reject(new Error(`identity child failed code=${code} signal=${signal}: ${error}`));
      })
    )
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(() => {
  delete seam.__maxRdkDeviceIdentityFsSeam;
  for (const directory of TEMPORARY_DIRECTORIES.splice(0)) {
    // This test created the directory with mkdtempSync, so deleting it cannot
    // affect persistent or shared state.
    // The state directory can contain a failed-call temp file; remove it via
    // the test runner's isolated temporary directory after each assertion.
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadOrCreateDeviceId", () => {
  it("captures injected creation time and process fingerprint in the canonical marker", () => {
    const path = temporaryPath();
    const fingerprintCalls: number[] = [];
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 42_000,
      fingerprint: (pid) => {
        fingerprintCalls.push(pid);
        return OWNER_FINGERPRINT;
      }
    };

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        writeFile: () => {
          throw new Error("stop after marker publication");
        }
      })
    ).toThrow("stop after marker publication");

    const marker = JSON.parse(readFileSync(join(dirname(path), ".device-id.marker"), "utf8")) as {
      createdAt: number;
      ownerFingerprint: string;
    };
    expect(marker).toMatchObject({ createdAt: 42_000, ownerFingerprint: OWNER_FINGERPRINT });
    expect(fingerprintCalls).toEqual([process.pid]);
  });

  it("allows a new candidate only when a crash loses the not-yet-durable pending assignment", () => {
    const path = temporaryPath();
    const pending = pendingMarkerPath(path);
    let denied = false;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: (fd) => {
        if (!denied && existsSync(pending) && !existsSync(canonicalMarkerPath(path))) {
          denied = true;
          throw new Error("pending parent fsync denied");
        }
        fsyncSync(fd);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow("pending parent fsync denied");
    expect(existsSync(pending)).toBe(true);

    // Model a crash losing directory entries whose parent fsync did not finish.
    unlinkSync(pending);
    for (const source of markerSourcePaths(path)) unlinkSync(source);
    delete seam.__maxRdkDeviceIdentityFsSeam;

    expect(loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toBe(OTHER_DEVICE_ID);
  });

  it("promotes the durable pending candidate after an unconfirmed canonical entry is lost", () => {
    const path = temporaryPath();
    const pending = pendingMarkerPath(path);
    const canonical = canonicalMarkerPath(path);
    let denied = false;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: (fd) => {
        if (!denied && existsSync(pending) && existsSync(canonical) && !existsSync(path)) {
          denied = true;
          throw new Error("canonical parent fsync denied");
        }
        fsyncSync(fd);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow("canonical parent fsync denied");
    expect(existsSync(pending)).toBe(true);

    // The canonical link was visible but its directory fsync failed, so model
    // that entry disappearing across the crash while durable pending survives.
    unlinkSync(canonical);
    delete seam.__maxRdkDeviceIdentityFsSeam;

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must promote pending candidate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("reconciles a pending unlink that was lost after canonical publication", () => {
    const path = temporaryPath();
    const pending = pendingMarkerPath(path);
    const canonical = canonicalMarkerPath(path);
    let observedPublishedPair = false;
    let denied = false;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: (fd) => {
        if (existsSync(pending) && existsSync(canonical)) observedPublishedPair = true;
        if (observedPublishedPair && !denied && !existsSync(pending) && existsSync(canonical) && !existsSync(path)) {
          denied = true;
          throw new Error("pending unlink parent fsync denied");
        }
        fsyncSync(fd);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(
      "pending unlink parent fsync denied"
    );

    // Model the uncommitted unlink disappearing: pending returns as a hard link
    // to the already durable canonical record.
    linkSync(canonical, pending);
    delete seam.__maxRdkDeviceIdentityFsSeam;

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reconcile published marker");
        }
      })
    ).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("re-cleans a unique marker source whose durable unlink was lost", () => {
    const path = temporaryPath();
    const pending = pendingMarkerPath(path);
    const canonical = canonicalMarkerPath(path);
    let sourcePath = "";
    let observedPending = false;
    let pendingRemovalSynced = false;
    let denied = false;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: (fd) => {
        const sources = markerSourcePaths(path);
        if (sources[0]) sourcePath = sources[0];
        if (existsSync(pending)) observedPending = true;
        if (observedPending && existsSync(canonical) && !existsSync(pending) && sources.length > 0)
          pendingRemovalSynced = true;
        if (pendingRemovalSynced && !denied && existsSync(canonical) && sources.length === 0 && !existsSync(path)) {
          denied = true;
          throw new Error("marker source unlink parent fsync denied");
        }
        fsyncSync(fd);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(
      "marker source unlink parent fsync denied"
    );

    // Model the unique source unlink being lost across the crash.
    linkSync(canonical, sourcePath);
    delete seam.__maxRdkDeviceIdentityFsSeam;

    expect(loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("promotes a pending-only marker and removes the pending name", () => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path, { pid: 2_147_483_647 });
    renameSync(markerPath, pendingMarkerPath(path));

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("pending assignment must win");
        }
      })
    ).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("reconciles matching pending and canonical marker names", () => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path, { pid: 2_147_483_647 });
    linkSync(markerPath, pendingMarkerPath(path));

    expect(loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it.each(["conflicting", "torn"])("fails closed on a %s pending marker beside canonical", (kind) => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path, { pid: 2_147_483_647 });
    const pending = pendingMarkerPath(path);
    if (kind === "torn") {
      writeFileSync(pending, "{", { mode: 0o600 });
    } else {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { candidate: string };
      marker.candidate = OTHER_DEVICE_ID;
      writeFileSync(pending, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    }

    expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(
      /pending|marker|conflict|malformed|disagree/i
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["oversized", "x".repeat(1_024)]
  ])("fails safely when the current owner fingerprint is %s", (_label, fingerprint) => {
    const path = temporaryPath();
    let randomCalls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = { fingerprint: () => fingerprint };

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return DEVICE_ID;
        }
      })
    ).toThrow(/owner fingerprint/i);
    expect(randomCalls).toBe(0);
    expect(existsSync(join(dirname(path), ".device-id.marker"))).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["non-string", 42],
    ["oversized", "x".repeat(1_024)]
  ])("rejects a marker whose owner fingerprint is %s", (_label, ownerFingerprint) => {
    const path = temporaryPath();
    writeMarker(path, { ownerFingerprint });

    expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(/marker is malformed/i);
  });

  it("waits for a fresh matching owner to publish and does not remove that owner's marker", () => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path);
    const removedByContender: string[] = [];
    let waits = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => OWNER_FINGERPRINT,
      wait: () => {
        waits += 1;
        writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600, flag: "wx" });
        unlinkSync(markerPath);
      }
    };

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("contender must not generate");
        },
        unlink: (target) => {
          removedByContender.push(target.toString());
          unlinkSync(target);
        }
      })
    ).toBe(DEVICE_ID);
    expect(waits).toBe(1);
    expect(removedByContender).not.toContain(markerPath);
  });

  it("recovers the immutable candidate immediately when a live PID has a different fingerprint", () => {
    const path = temporaryPath();
    writeMarker(path);
    let waits = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => "test-boot:reused-pid",
      wait: () => {
        waits += 1;
      }
    };

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("PID-reuse recovery must not generate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(waits).toBe(0);
  });

  it("recovers the immutable candidate immediately when its owner process is dead", () => {
    const path = temporaryPath();
    writeMarker(path, { pid: 2_147_483_647 });
    let waits = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => OWNER_FINGERPRINT,
      wait: () => {
        waits += 1;
      }
    };

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("dead-owner recovery must not generate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(waits).toBe(0);
  });

  it("takes over a matching live owner after the bounded stale threshold", () => {
    const path = temporaryPath();
    writeMarker(path);
    let waits = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 86_401_000,
      fingerprint: () => OWNER_FINGERPRINT,
      wait: () => {
        waits += 1;
      }
    };

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("stale-owner recovery must not generate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(waits).toBe(0);
  });

  it.each(["final", "parent"])(
    "retains a proven-live stale owner's temp and marker when helper %s sync fails",
    (failureTarget) => {
      const path = temporaryPath();
      const { markerPath, temporary } = writeMarker(path);
      writeFileSync(temporary, `${DEVICE_ID}\n`, { mode: 0o600 });
      const opened = new Map<number, string>();
      seam.__maxRdkDeviceIdentityFsSeam = {
        now: () => 86_401_000,
        fingerprint: () => OWNER_FINGERPRINT,
        openSync: (target, flags) => {
          const fd = openSync(target, flags);
          opened.set(fd, target.toString());
          return fd;
        },
        fsyncSync: (fd) => {
          const target = opened.get(fd);
          if (
            existsSync(path) &&
            ((failureTarget === "final" && target === path) || (failureTarget === "parent" && target === dirname(path)))
          ) {
            throw new Error(`helper ${failureTarget} fsync denied`);
          }
          fsyncSync(fd);
        },
        closeSync: (fd) => {
          opened.delete(fd);
          closeSync(fd);
        }
      };

      expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(
        `helper ${failureTarget} fsync denied`
      );
      expect(readFileSync(temporary, "utf8")).toBe(`${DEVICE_ID}\n`);
      expect(existsSync(markerPath)).toBe(true);
    }
  );

  it("cleans a deterministic orphaned recovery temp on a later successful retry", () => {
    const path = temporaryPath();
    const { temporary } = writeMarker(path, { pid: 2_147_483_647 });
    const sentinel = join(dirname(dirname(path)), "recovery-sentinel");
    writeFileSync(sentinel, "preserve");
    const expectedRecovery = `${temporary}.recover`;
    let observedRecovery = "";

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("recovery must not generate");
        },
        writeFile: (target, data, options) => {
          if (target.toString().includes(".recover")) {
            observedRecovery = target.toString();
            writeFileSync(target, data, options);
            throw new Error("recovery write failed after create");
          }
          writeFileSync(target, data, options);
        },
        unlink: (target) => {
          if (target.toString() === observedRecovery) throw new Error("recovery cleanup denied");
          unlinkSync(target);
        }
      })
    ).toThrow(/recovery write failed after create.*recovery cleanup denied/i);
    expect(observedRecovery).toBe(expectedRecovery);
    expect(readFileSync(observedRecovery, "utf8")).toBe(`${DEVICE_ID}\n`);

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("retry must reuse marker candidate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
    expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  });

  it("durably replaces a malformed owned deterministic recovery temp", () => {
    const path = temporaryPath();
    const { temporary } = writeMarker(path, { pid: 2_147_483_647 });
    const recoveryTemporary = `${temporary}.recover`;
    writeFileSync(recoveryTemporary, "partial", { mode: 0o600 });

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("malformed recovery retry must not generate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it.each([undefined, ""])("treats an unavailable live-owner fingerprint as unknown (%s)", (observed) => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path);
    let waits = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => observed,
      wait: () => {
        waits += 1;
      }
    };

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("unknown ownership must not generate");
        }
      })
    ).toThrow(/timed out/i);
    expect(waits).toBeGreaterThan(0);
    expect(existsSync(markerPath)).toBe(true);
  });

  it("bounds fresh-owner waiting without a real sleep and retains the marker", () => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path);
    let waits = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => OWNER_FINGERPRINT,
      wait: () => {
        waits += 1;
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(/timed out/i);
    expect(waits).toBeGreaterThan(0);
    expect(existsSync(markerPath)).toBe(true);
  });

  it.each([1, 2])("retains a fresh live owner's marker when helper durability sync %i fails", (failureCall) => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path);
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });
    let syncCalls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => OWNER_FINGERPRINT,
      fsyncSync: (fd) => {
        syncCalls += 1;
        if (syncCalls === failureCall) throw new Error(`helper sync ${failureCall} denied`);
        fsyncSync(fd);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(
      `helper sync ${failureCall} denied`
    );
    expect(existsSync(markerPath)).toBe(true);

    delete seam.__maxRdkDeviceIdentityFsSeam;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => OWNER_FINGERPRINT
    };
    expect(loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toBe(DEVICE_ID);
    expect(existsSync(markerPath)).toBe(true);
  });

  it.each([1, 2])("removes a reused-PID marker only after helper durability sync %i completes", (failureCall) => {
    const path = temporaryPath();
    const { markerPath } = writeMarker(path);
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });
    let syncCalls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => "test-boot:reused-pid",
      fsyncSync: (fd) => {
        syncCalls += 1;
        if (syncCalls === failureCall) throw new Error(`takeover sync ${failureCall} denied`);
        fsyncSync(fd);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(
      `takeover sync ${failureCall} denied`
    );
    expect(existsSync(markerPath)).toBe(true);

    delete seam.__maxRdkDeviceIdentityFsSeam;
    seam.__maxRdkDeviceIdentityFsSeam = {
      now: () => 1_100,
      fingerprint: () => "test-boot:reused-pid"
    };
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("durability helper must not generate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("fails closed on a torn canonical marker", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirname(path), ".device-id.marker"), "{", { mode: 0o600 });

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(/marker is malformed/i);
  });

  it("fails closed on a torn canonical marker even when a matching final is visible", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });
    writeFileSync(join(dirname(path), ".device-id.marker"), "{", { mode: 0o600 });

    expect(() => loadOrCreateDeviceId({ path, randomId: () => OTHER_DEVICE_ID })).toThrow(/marker is malformed/i);
  });

  it("cleans an unpublished marker candidate after a temporary sync failure", () => {
    const path = temporaryPath();
    let randomCalls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: () => {
        throw new Error("fsync denied");
      }
    };
    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return DEVICE_ID;
        }
      })
    ).toThrow("fsync denied");
    delete seam.__maxRdkDeviceIdentityFsSeam;

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return "rdk-123e4567-e89b-42d3-a456-426614174001";
        }
      })
    ).toBe("rdk-123e4567-e89b-42d3-a456-426614174001");
    expect(randomCalls).toBe(2);
  });

  it("reports both a pre-canonical primary failure and owned marker-temp cleanup failure", () => {
    const path = temporaryPath();
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: () => {
        throw new Error("marker fsync denied");
      },
      unlinkSync: () => {
        throw new Error("marker temp cleanup denied");
      }
    };
    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(
      /marker fsync denied.*marker temp cleanup denied/i
    );
  });

  it.each(["before-create", "after-create"])(
    "cleans an unpublished marker temp when its write fails %s",
    (failurePoint) => {
      const path = temporaryPath();
      let randomCalls = 0;
      seam.__maxRdkDeviceIdentityFsSeam = {
        writeFileSync: (target, data, options) => {
          if (failurePoint === "after-create") writeFileSync(target, data, options);
          throw new Error(`marker write ${failurePoint} denied`);
        }
      };

      expect(() =>
        loadOrCreateDeviceId({
          path,
          randomId: () => {
            randomCalls += 1;
            return DEVICE_ID;
          }
        })
      ).toThrow(`marker write ${failurePoint} denied`);
      expect(readdirSync(dirname(path))).toEqual([]);

      delete seam.__maxRdkDeviceIdentityFsSeam;
      expect(
        loadOrCreateDeviceId({
          path,
          randomId: () => {
            randomCalls += 1;
            return OTHER_DEVICE_ID;
          }
        })
      ).toBe(OTHER_DEVICE_ID);
      expect(randomCalls).toBe(2);
    }
  );

  it("cleans an unpublished marker temp after hard-link publication fails", () => {
    const path = temporaryPath();
    let randomCalls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      linkSync: () => {
        const error = new Error("marker link denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
    };

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return DEVICE_ID;
        }
      })
    ).toThrow("marker link denied");
    expect(readdirSync(dirname(path))).toEqual([]);

    delete seam.__maxRdkDeviceIdentityFsSeam;
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return OTHER_DEVICE_ID;
        }
      })
    ).toBe(OTHER_DEVICE_ID);
    expect(randomCalls).toBe(2);
  });

  it("does not unlink an unrelated entry that collides with the unique marker source", () => {
    const path = temporaryPath();
    let collision = "";
    seam.__maxRdkDeviceIdentityFsSeam = {
      writeFileSync: (target) => {
        collision = target.toString();
        writeFileSync(target, "unrelated", { mode: 0o600, flag: "wx" });
        const error = new Error("marker source collision") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow("marker source collision");
    expect(readFileSync(collision, "utf8")).toBe("unrelated");
  });

  it("recovers the canonical candidate and cleans the marker publication link after its unlink fails", () => {
    const path = temporaryPath();
    seam.__maxRdkDeviceIdentityFsSeam = {
      unlinkSync: (target) => {
        if (target.toString().includes(".device-id.marker.new-")) throw new Error("marker publication cleanup denied");
        unlinkSync(target);
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(
      "marker publication cleanup denied"
    );
    expect(readdirSync(dirname(path)).sort()).toEqual([
      ".device-id.marker",
      expect.stringMatching(/^\.device-id\.marker\.new-/)
    ]);

    delete seam.__maxRdkDeviceIdentityFsSeam;
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reuse the canonical marker candidate");
        }
      })
    ).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("retains the canonical candidate when candidate-temp cleanup also fails", () => {
    const path = temporaryPath();
    const sentinel = join(dirname(dirname(path)), "sentinel");
    writeFileSync(sentinel, "preserve");
    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        rename: () => {
          throw new Error("rename denied");
        },
        unlink: (target) => {
          if (target.toString().includes(".tmp-")) throw new Error("candidate cleanup denied");
          unlinkSync(target);
        }
      })
    ).toThrow(/rename denied.*candidate temp cleanup failed.*candidate cleanup denied/i);
    expect(readFileSync(sentinel, "utf8")).toBe("preserve");
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reuse marker candidate");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it.each(["openSync", "closeSync"] as const)("cleans an unpublished marker temp after %s fails", (operation) => {
    const path = temporaryPath();
    let randomCalls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      [operation]: () => {
        throw new Error(`${operation} denied`);
      }
    };
    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return DEVICE_ID;
        }
      })
    ).toThrow(`${operation} denied`);
    delete seam.__maxRdkDeviceIdentityFsSeam;
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          randomCalls += 1;
          return "rdk-123e4567-e89b-42d3-a456-426614174001";
        }
      })
    ).toBe("rdk-123e4567-e89b-42d3-a456-426614174001");
    expect(randomCalls).toBe(2);
  });

  it("retains the canonical marker when committed-marker cleanup fails", () => {
    const path = temporaryPath();
    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        unlink: (target) => {
          if (target.toString().endsWith(".device-id.marker")) throw new Error("marker unlink denied");
          unlinkSync(target);
        }
      })
    ).toThrow("marker unlink denied");
    expect(readFileSync(path, "utf8")).toBe(`${DEVICE_ID}\n`);
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reuse final");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it("returns the durable final after post-unlink parent fsync fails", () => {
    const path = temporaryPath();
    let calls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: (fd) => {
        calls += 1;
        if (calls === 9) throw new Error("post-unlink fsync denied");
        fsyncSync(fd);
      }
    };
    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow("post-unlink fsync denied");
    delete seam.__maxRdkDeviceIdentityFsSeam;
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must trust durable final");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9])("reuses the canonical candidate after fsync failure %i", (failureCall) => {
    const path = temporaryPath();
    let calls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: (fd) => {
        calls += 1;
        if (calls === failureCall) throw new Error(`fsync ${failureCall} denied`);
        fsyncSync(fd);
      }
    };
    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(`fsync ${failureCall} denied`);
    delete seam.__maxRdkDeviceIdentityFsSeam;

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reuse canonical candidate");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9])("reuses the canonical candidate after open failure %i", (failureCall) => {
    const path = temporaryPath();
    let calls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      openSync: (target, flags) => {
        calls += 1;
        if (calls === failureCall) throw new Error(`open ${failureCall} denied`);
        return openSync(target, flags);
      }
    };
    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(`open ${failureCall} denied`);
    delete seam.__maxRdkDeviceIdentityFsSeam;
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reuse marker candidate");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9])("reuses the canonical candidate after close failure %i", (failureCall) => {
    const path = temporaryPath();
    let calls = 0;
    seam.__maxRdkDeviceIdentityFsSeam = {
      closeSync: (fd) => {
        calls += 1;
        if (calls === failureCall) throw new Error(`close ${failureCall} denied`);
        closeSync(fd);
      }
    };
    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(`close ${failureCall} denied`);
    delete seam.__maxRdkDeviceIdentityFsSeam;
    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must reuse marker candidate");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it("accepts an ambiguous hard-link publication only after finding its immutable marker", () => {
    const path = temporaryPath();
    seam.__maxRdkDeviceIdentityFsSeam = {
      linkSync: (from, to) => {
        linkSync(from, to);
        throw new Error("link status lost");
      }
    };
    expect(loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toBe(DEVICE_ID);
  });

  it("reports both fsync and descriptor-close failures without losing the primary cause", () => {
    const path = temporaryPath();
    seam.__maxRdkDeviceIdentityFsSeam = {
      fsyncSync: () => {
        throw new Error("marker fsync denied");
      },
      closeSync: () => {
        throw new Error("marker close denied");
      }
    };

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(
      /marker fsync denied.*marker close denied/i
    );
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("converges concurrent initializers on one persisted identity", async () => {
    const path = temporaryPath();
    const first = child(path, DEVICE_ID, { IDENTITY_HOLD_MS: "250" });
    await first.ready;
    const second = child(path, "rdk-123e4567-e89b-42d3-a456-426614174001");

    await expect(Promise.all([first.done, second.done])).resolves.toEqual([DEVICE_ID, DEVICE_ID]);
    expect(readFileSync(path, "utf8")).toBe(`${DEVICE_ID}\n`);
  });

  it("lets a stale helper and the still-live slow owner converge on the same identity", async () => {
    const path = temporaryPath();
    const first = child(path, DEVICE_ID, { IDENTITY_HOLD_MS: "6500" });
    await first.ready;
    const second = child(path, OTHER_DEVICE_ID);

    await expect(Promise.all([first.done, second.done])).resolves.toEqual([DEVICE_ID, DEVICE_ID]);
    expect(readFileSync(path, "utf8")).toBe(`${DEVICE_ID}\n`);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  }, 15_000);

  it("reclaims the recorded candidate after an owner crashes before publish", async () => {
    const path = temporaryPath();
    const first = child(path, DEVICE_ID, { IDENTITY_HOLD_MS: "1000" });
    await waitForPath(join(dirname(path), ".device-id.marker"));
    first.process.kill("SIGKILL");
    await expect(first.done).rejects.toThrow(/signal=SIGKILL/);

    await expect(child(path, "rdk-123e4567-e89b-42d3-a456-426614174001").done).resolves.toBe(DEVICE_ID);
  });

  it("commits the same candidate after a crash following rename", async () => {
    const path = temporaryPath();
    const first = child(path, DEVICE_ID, { IDENTITY_CRASH_AFTER_RENAME: "1" });
    await expect(first.done).rejects.toThrow(/signal=SIGKILL/);

    await expect(child(path, "rdk-123e4567-e89b-42d3-a456-426614174001").done).resolves.toBe(DEVICE_ID);
  });

  it("creates and atomically persists a canonical RDK identity with private modes", () => {
    const path = temporaryPath();

    expect(loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toBe(DEVICE_ID);

    expect(readFileSync(path, "utf8")).toBe(`${DEVICE_ID}\n`);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("reloads the same persisted identity without generating a replacement", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => {
          throw new Error("must not generate");
        }
      })
    ).toBe(DEVICE_ID);
  });

  it("rejects a final identity symlink instead of following it", () => {
    const path = temporaryPath();
    const external = join(dirname(dirname(path)), "external-device-id");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(external, `${DEVICE_ID}\n`, { mode: 0o600 });
    symlinkSync(external, path);

    expect(() => loadOrCreateDeviceId({ path })).toThrow(/regular|symlink|identity/i);
  });

  it("fails closed when the final path is replaced between validation and reading", () => {
    const path = temporaryPath();
    const external = join(dirname(dirname(path)), "replacement-device-id");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });
    writeFileSync(external, `${OTHER_DEVICE_ID}\n`, { mode: 0o600 });

    expect(() =>
      loadOrCreateDeviceId({
        path,
        readFile: (target, options) => {
          unlinkSync(path);
          symlinkSync(external, path);
          return readFileSync(target, options);
        }
      })
    ).toThrow(/changed|regular|symlink/i);
  });

  it("rejects an insecure existing identity mode", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => loadOrCreateDeviceId({ path })).toThrow(/private|mode|identity/i);
  });

  it("rejects a symlinked or insecure state parent", () => {
    const path = temporaryPath();
    const realParent = join(dirname(dirname(path)), "real-state");
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    symlinkSync(realParent, dirname(path));

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(/parent|directory|private/i);
    expect(lstatSync(dirname(path)).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked ancestor above the private state directory", () => {
    const path = temporaryPath();
    const ancestor = join(dirname(dirname(path)), "ancestor");
    const target = join(dirname(dirname(path)), "target");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, ancestor);
    const linkedPath = join(ancestor, "state", "device-id");

    expect(() => loadOrCreateDeviceId({ path: linkedPath, randomId: () => DEVICE_ID })).toThrow(/symlinked ancestor/i);
  });

  it("rejects a nonregular FIFO without attempting a blocking read", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [path]);

    expect(() => loadOrCreateDeviceId({ path })).toThrow(/regular file/i);
  });

  it("rejects a multiply linked final identity", () => {
    const path = temporaryPath();
    const second = join(dirname(dirname(path)), "linked-device-id");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });
    linkSync(path, second);

    expect(() => loadOrCreateDeviceId({ path })).toThrow(/linked/i);
  });

  it.each(["", "rdk-123e4567-e89b-12d3-a456-426614174000\n", "RDK-123e4567-e89b-42d3-a456-426614174000\n"])(
    "rejects an empty or malformed persisted identity",
    (contents) => {
      const path = temporaryPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, contents, { mode: 0o600 });

      expect(() => loadOrCreateDeviceId({ path })).toThrow(/device identity/i);
    }
  );

  it("rejects a malformed generated identity before writing it", () => {
    const path = temporaryPath();

    expect(() => loadOrCreateDeviceId({ path, randomId: () => "rdk-not-a-uuid" })).toThrow(/device identity/i);
  });

  it("fails loudly when its state directory cannot be created", () => {
    const path = temporaryPath();

    expect(() =>
      loadOrCreateDeviceId({
        path,
        mkdir: () => {
          throw new Error("mkdir denied");
        }
      })
    ).toThrow("mkdir denied");
  });

  it("reclaims an immutable stale marker and preserves its recorded candidate", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const markerPath = join(dirname(path), ".device-id.marker");
    writeFileSync(
      markerPath,
      `${JSON.stringify({ version: 1, token: "00000000-0000-4000-8000-000000000000", pid: 999999, candidate: DEVICE_ID, createdAt: 0, ownerFingerprint: "dead-owner", temporary: join(dirname(path), ".device-id.tmp-00000000-0000-4000-8000-000000000000") })}\n`,
      { mode: 0o600 }
    );

    expect(loadOrCreateDeviceId({ path, randomId: () => "rdk-123e4567-e89b-42d3-a456-426614174001" })).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
  });

  it("fails loudly when an existing identity cannot be read", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${DEVICE_ID}\n`, { mode: 0o600 });

    expect(() =>
      loadOrCreateDeviceId({
        path,
        readFile: () => {
          throw new Error("read denied");
        }
      })
    ).toThrow("read denied");
  });

  it("cleans up its own temporary file when a write fails after creating it", () => {
    const path = temporaryPath();
    let createdTemporaryPath = "";

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        writeFile: (file, data, options) => {
          createdTemporaryPath = file.toString();
          writeFileSync(file, data, options);
          throw new Error("write failed after create");
        }
      })
    ).toThrow("write failed after create");

    expect(loadOrCreateDeviceId({ path })).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id"]);
    expect(createdTemporaryPath).toContain(".device-id.tmp-");
  });

  it("cleans up its own temporary file when rename fails", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirname(path), "unrelated"), "preserve");

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        rename: () => {
          throw new Error("rename denied");
        }
      })
    ).toThrow("rename denied");

    expect(loadOrCreateDeviceId({ path })).toBe(DEVICE_ID);
    expect(readdirSync(dirname(path))).toEqual(["device-id", "unrelated"]);
  });

  it("fails loudly when the final private mode cannot be applied", () => {
    const path = temporaryPath();

    expect(() =>
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        chmod: () => {
          throw new Error("chmod denied");
        }
      })
    ).toThrow("chmod denied");
    expect(loadOrCreateDeviceId({ path })).toBe(DEVICE_ID);
  });

  it("uses the configured identity file path", () => {
    expect(loadConfig({ MAX_RELAY_URL: "ws://relay.test/agent" }).deviceIdFile).toBe("/var/lib/max/device-id");
    expect(loadConfig({ MAX_RELAY_URL: "ws://relay.test/agent", MAX_DEVICE_ID_FILE: "/state/id" }).deviceIdFile).toBe(
      "/state/id"
    );
  });
});
