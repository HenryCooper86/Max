import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConfigVersions, readConfigVersion, recordConfigVersion, stableJson } from "../server/config-history";

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
        changed: ["greeting", "guardrails", "version"]
      },
      { id: first, savedAt: 1_800_000_000_000, by: "file", name: "Ava", changed: [] }
    ]);
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
});
