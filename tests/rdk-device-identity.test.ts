import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../rdk/agent/src/config";
import { loadOrCreateDeviceId } from "../rdk/agent/src/device/identity";

const DEVICE_ID = "rdk-123e4567-e89b-42d3-a456-426614174000";
const COMPETING_DEVICE_ID = "rdk-123e4567-e89b-42d3-a456-426614174001";
const TEMPORARY_DIRECTORIES: string[] = [];

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "max-device-identity-"));
  TEMPORARY_DIRECTORIES.push(directory);
  return join(directory, "state", "device-id");
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
    expect(() => statSync(dirname(path))).toThrow();
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

  it("fails closed while another initializer owns the identity lock", () => {
    const path = temporaryPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = join(dirname(path), ".device-id.lock");
    writeFileSync(lockPath, "another initializer");

    expect(() => loadOrCreateDeviceId({ path, randomId: () => DEVICE_ID })).toThrow(/initialization/i);
    expect(readFileSync(lockPath, "utf8")).toBe("another initializer");
    expect(readdirSync(dirname(path))).toEqual([".device-id.lock"]);
  });

  it("fails loudly when an existing identity cannot be read", () => {
    const path = temporaryPath();

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

    expect(readdirSync(dirname(path))).toEqual([]);
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

    expect(readdirSync(dirname(path))).toEqual(["unrelated"]);
  });

  it("returns the already-persisted winner if finalization finds one", () => {
    const path = temporaryPath();

    expect(
      loadOrCreateDeviceId({
        path,
        randomId: () => DEVICE_ID,
        rename: (_source, target) => {
          writeFileSync(target, `${COMPETING_DEVICE_ID}\n`, { mode: 0o600, flag: "wx" });
          const error = new Error("identity already created") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
      })
    ).toBe(COMPETING_DEVICE_ID);
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
  });

  it("uses the configured identity file path", () => {
    expect(loadConfig({ MAX_RELAY_URL: "ws://relay.test/agent" }).deviceIdFile).toBe("/var/lib/max/device-id");
    expect(loadConfig({ MAX_RELAY_URL: "ws://relay.test/agent", MAX_DEVICE_ID_FILE: "/state/id" }).deviceIdFile).toBe(
      "/state/id"
    );
  });
});
