import { describe, expect, it } from "vitest";
import { CUE_RATE, cuePcm, writeCue } from "../rdk/agent/src/audio/cues";

const KINDS = ["armed", "tick", "final", "cancelled"] as const;

describe("cuePcm", () => {
  it("is 24 kHz PCM the playback path accepts, and audibly non-silent", () => {
    expect(CUE_RATE).toBe(24_000);
    for (const kind of KINDS) {
      const pcm = cuePcm(kind);
      expect(pcm.length).toBeGreaterThan(0);
      let peak = 0;
      for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
      // Loud enough to hear at the helmet speaker, far from full scale so the
      // soft limiter has nothing to catch.
      expect(peak).toBeGreaterThan(3_000);
      expect(peak).toBeLessThan(16_000);
    }
  });

  it("each kind sounds different", () => {
    const lengths = new Set(KINDS.map((kind) => cuePcm(kind).length));
    expect(lengths.size).toBeGreaterThan(2);
  });

  it("starts and ends at silence so chunk boundaries cannot click", () => {
    for (const kind of KINDS) {
      const pcm = cuePcm(kind);
      expect(Math.abs(pcm[0])).toBeLessThan(500);
      expect(Math.abs(pcm[pcm.length - 1])).toBeLessThan(500);
    }
  });
});

describe("writeCue", () => {
  it("hands the clip to playback in the 20 ms chunks the pacing expects", () => {
    const chunks: Int16Array[] = [];
    writeCue({ write: (pcm) => chunks.push(pcm) }, "armed");
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBe(cuePcm("armed").length);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(480);
  });
});
