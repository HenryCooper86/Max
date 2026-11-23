import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listConfigVersions,
  readConfigVersion,
  recordConfigVersion,
  removeConfigVersion,
  rewriteConfigVersions,
  stableJson
} from "../server/config-history";

let directory: string;

beforeEach(() => {
  directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "config-history-")), "history");
});

afterEach(() => {
  fs.rmSync(path.dirname(directory), { recursive: true, force: true });
});

describe("stableJson", () => {
  it("writes two configs that say the same the same way", () => {
    expect(stableJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      stableJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 })
    );
    expect(stableJson({ a: [1, 2] })).not.toBe(stableJson({ a: [2, 1] }));
    expect(stableJson(undefined)).toBe("null");
  });
});

describe("the configs that have been live", () => {
  it("keeps each config, newest first, with who made it live and what changed", () => {
    const first = recordConfigVersion(directory, { name: "Ava", greeting: "Hello." }, "file", {
      now: 1_800_000_000_000
    });
    const second = recordConfigVersion(
      directory,
      { name: "Ava", greeting: "Good day.", version: "2026-11-24", guardrails: { blockedTerms: ["Acme"] } },
      "nora",
      { now: 1_800_000_060_000 }
    );
    expect(first).toMatch(/^1800000000000-[0-9a-f]{8}$/);
    expect(listConfigVersions(directory)).toEqual([
      {
        id: second,
        savedAt: 1_800_000_060_000,
        by: "nora",
        name: "Ava",
        version: "2026-11-24",
        changed: ["greeting", "guardrails", "version"],
        current: false
      },
      { id: first, savedAt: 1_800_000_000_000, by: "file", name: "Ava", changed: [], current: false }
    ]);
    // With the live config given, the newest version that says the same is the current one.
    expect(
      listConfigVersions(directory, { greeting: "Hello.", name: "Ava" }).map((version) => version.current)
    ).toEqual([false, true]);
    expect(readConfigVersion(directory, first!)).toEqual({
      id: first,
      savedAt: 1_800_000_000_000,
      by: "file",
      config: { name: "Ava", greeting: "Hello." }
    });
  });

  it("does not keep a config again that is the newest one kept, however its keys are ordered", () => {
    expect(recordConfigVersion(directory, { name: "Ava", wake: { en: ["Ava"] } }, "file")).toBeDefined();
    expect(recordConfigVersion(directory, { wake: { en: ["Ava"] }, name: "Ava" }, "nora")).toBeUndefined();
    expect(listConfigVersions(directory)).toHaveLength(1);
    // The same config again after another one is a change, and is kept.
    recordConfigVersion(directory, { name: "Bea" }, "nora");
    expect(recordConfigVersion(directory, { name: "Ava", wake: { en: ["Ava"] } }, "nora")).toBeDefined();
    expect(listConfigVersions(directory).map((version) => version.name)).toEqual(["Ava", "Bea", "Ava"]);
  });

  it("keeps the order when the clock goes back", () => {
    recordConfigVersion(directory, { name: "One" }, "file", { now: 1_800_000_000_000 });
    recordConfigVersion(directory, { name: "Two" }, "file", { now: 1_700_000_000_000 });
    const versions = listConfigVersions(directory);
    expect(versions.map((version) => version.name)).toEqual(["Two", "One"]);
    expect(versions[0]!.savedAt).toBe(1_800_000_000_001);
  });

  it("keeps the last fifty", () => {
    for (let index = 0; index < 55; index += 1) {
      recordConfigVersion(directory, { name: `N${index}` }, "file", { now: 1_800_000_000_000 + index });
    }
    const versions = listConfigVersions(directory);
    expect(versions).toHaveLength(50);
    expect(versions[0]!.name).toBe("N54");
    expect(versions.at(-1)!.name).toBe("N5");
    expect(fs.readdirSync(directory)).toHaveLength(50);
  });

  it("writes files only the relay's user can read, and says who restored what", () => {
    const first = recordConfigVersion(directory, { name: "Ava" }, "file")!;
    recordConfigVersion(directory, { name: "Bea" }, "nora");
    const back = recordConfigVersion(directory, { name: "Ava" }, "nora", { restoredFrom: first })!;
    expect(fs.statSync(path.join(directory, `${back}.json`)).mode & 0o777).toBe(0o600);
    expect(listConfigVersions(directory)[0]).toMatchObject({ id: back, restoredFrom: first, changed: ["name"] });
  });

  it("reads nothing for an id it did not make, and skips files that are not versions", () => {
    recordConfigVersion(directory, { name: "Ava" }, "file");
    fs.writeFileSync(path.join(directory, "notes.json"), "{}");
    fs.writeFileSync(path.join(directory, "1800000000000-zzzzzzzz.json"), "{}");
    fs.writeFileSync(path.join(directory, "1800000000009-0123abcd.json"), "not json");
    fs.writeFileSync(path.join(path.dirname(directory), "secret.json"), JSON.stringify({ savedAt: 1, config: {} }));
    expect(listConfigVersions(directory)).toHaveLength(1);
    for (const id of ["../secret", "..%2Fsecret", "notes", "", "1800000000009-0123abcd"]) {
      expect(readConfigVersion(directory, id)).toBeUndefined();
    }
    expect(listConfigVersions(path.join(directory, "nowhere"))).toEqual([]);
  });

  it("compares a new config with the newest version it can read, and stays above a damaged file", () => {
    recordConfigVersion(directory, { name: "Ava" }, "file", { now: 1_800_000_000_000 });
    fs.writeFileSync(path.join(directory, "1800000000500-0123abcd.json"), "not json");
    // The same config again: the damaged file in between does not make it new.
    expect(recordConfigVersion(directory, { name: "Ava" }, "nora", { now: 1_800_000_000_100 })).toBeUndefined();
    // A new one sorts above the damaged file although the clock says otherwise.
    expect(recordConfigVersion(directory, { name: "Bea" }, "nora", { now: 1_800_000_000_100 })).toMatch(
      /^1800000000501-/
    );
    expect(listConfigVersions(directory).map((version) => version.name)).toEqual(["Bea", "Ava"]);
  });

  it("removes one version, and only a version", () => {
    const first = recordConfigVersion(directory, { name: "Ava", secret: "s3" }, "file")!;
    recordConfigVersion(directory, { name: "Ava" }, "nora");
    expect(removeConfigVersion(directory, "../history")).toBe(false);
    expect(removeConfigVersion(directory, "1800000000000-00000000")).toBe(false);
    expect(removeConfigVersion(directory, first)).toBe(true);
    expect(removeConfigVersion(directory, first)).toBe(false);
    expect(listConfigVersions(directory)).toHaveLength(1);
    expect(fs.readdirSync(directory)).toHaveLength(1);
  });

  it("changes kept configs in place, keeping when and by whom", () => {
    const first = recordConfigVersion(directory, { name: "Ava", voice: { id: "v_1" } }, "file", {
      now: 1_800_000_000_000
    })!;
    recordConfigVersion(directory, { name: "Bea" }, "nora", { now: 1_800_000_000_001 });
    const changed = rewriteConfigVersions(directory, (config) => (config.voice ? { name: config.name } : undefined));
    expect(changed).toBe(1);
    expect(readConfigVersion(directory, first)).toEqual({
      id: first,
      savedAt: 1_800_000_000_000,
      by: "file",
      config: { name: "Ava" }
    });
    expect(fs.statSync(path.join(directory, `${first}.json`)).mode & 0o777).toBe(0o600);
  });
});
