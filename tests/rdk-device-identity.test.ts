import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
const TEMPORARY_DIRECTORIES: string[] = [];
const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "max-device-identity-"));
  TEMPORARY_DIRECTORIES.push(directory);
  return join(directory, "state", "device-id");
}

function child(
  path: string,
  id: string,
  extra: NodeJS.ProcessEnv = {}
): { process: ChildProcess; done: Promise<string> } {
  const childProcess = spawn(process.execPath, ["--import", tsxImport, "tests/fixtures/rdk-device-identity-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, IDENTITY_PATH: path, IDENTITY_ID: id, ...extra },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let error = "";
  childProcess.stdout?.on("data", (chunk: Buffer) => (output += chunk));
  childProcess.stderr?.on("data", (chunk: Buffer) => (error += chunk));
  return {
    process: childProcess,
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
  for (const directory of TEMPORARY_DIRECTORIES.splice(0)) {
    // This test created the directory with mkdtempSync, so deleting it cannot
    // affect persistent or shared state.
    // The state directory can contain a failed-call temp file; remove it via
    // the test runner's isolated temporary directory after each assertion.
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadOrCreateDeviceId", () => {
  it("converges concurrent initializers on one persisted identity", async () => {
    const path = temporaryPath();
    const first = child(path, DEVICE_ID, { IDENTITY_HOLD_MS: "250" });
    await wait(50);
    const second = child(path, "rdk-123e4567-e89b-42d3-a456-426614174001");

    await expect(Promise.all([first.done, second.done])).resolves.toEqual([DEVICE_ID, DEVICE_ID]);
    expect(readFileSync(path, "utf8")).toBe(`${DEVICE_ID}\n`);
  });

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

  it("reclaims a recoverable marker and preserves its recorded candidate", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const markerPath = join(dirname(path), ".device-id.marker");
    writeFileSync(
      markerPath,
      `${JSON.stringify({ version: 1, owner: "00000000-0000-4000-8000-000000000000", pid: process.pid, candidate: DEVICE_ID, phase: "recoverable" })}\n`,
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
