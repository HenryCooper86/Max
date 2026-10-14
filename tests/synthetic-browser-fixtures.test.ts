import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  REQUIRED_FIXTURES,
  validateManifest,
  verifyFixture,
  type Fixture
} from "../scripts/synthetic-qa/browser/fixtures";
const bytes = new Int16Array([0, 1200, -800, 50]).buffer;
const fixture: Fixture = {
  file: "baseline.pcm",
  text: "Generated speech",
  durationSeconds: 4 / 16000,
  sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
};
function manifest() {
  return {
    sampleRate: 16000,
    channels: 1,
    sampleFormat: "s16le",
    fixtures: Object.fromEntries(
      REQUIRED_FIXTURES.map((name) => [
        name,
        { ...fixture, file: `${name}.pcm`, ...(name === "wind" ? { snrDb: 12 } : {}) }
      ])
    )
  };
}
describe("synthetic browser preflight", () => {
  it("accepts all required mono fixtures and verifies their content", async () => {
    expect(validateManifest(manifest()).sampleRate).toBe(16000);
    await expect(verifyFixture(fixture, bytes)).resolves.toBeUndefined();
  });
  it("rejects missing fixtures and formats that would invalidate a live session", () => {
    const missing = manifest();
    delete missing.fixtures.network;
    expect(() => validateManifest(missing)).toThrow("network");
    expect(() => validateManifest({ ...manifest(), channels: 2 })).toThrow("mono");
  });
  it("rejects substituted PCM even when duration is unchanged", async () => {
    await expect(verifyFixture(fixture, new Int16Array([0, 1200, -801, 50]).buffer)).rejects.toThrow("hash mismatch");
  });
  it("rejects truncated and odd-length PCM before capture", async () => {
    await expect(verifyFixture(fixture, new ArrayBuffer(6))).rejects.toThrow("duration mismatch");
    await expect(verifyFixture(fixture, new ArrayBuffer(7))).rejects.toThrow("PCM length");
  });
  it("rejects path traversal and absent declared wind conditions", () => {
    const escaped = manifest();
    escaped.fixtures.baseline!.file = "../connection.json";
    expect(() => validateManifest(escaped)).toThrow("baseline");
    const noSnr = manifest();
    delete noSnr.fixtures.wind!.snrDb;
    expect(() => validateManifest(noSnr)).toThrow("12 dB");
  });
});
