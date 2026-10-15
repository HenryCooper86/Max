import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADAS_SCENARIOS } from "../shared/adas";

describe("bundled ADAS warning audio", () => {
  it("contains real, distinct male/female PCM for every exact catalog warning", () => {
    const manifest = JSON.parse(readFileSync("public/audio/adas/manifest.json", "utf8")) as {
      sampleRate: number;
      channels: number;
      sampleFormat: string;
      assets: Array<{
        threat: string;
        gender: string;
        text: string;
        file: string;
        url: string;
        samples: number;
        durationSeconds: number;
        sha256: string;
        pcmSha256: string;
      }>;
    };
    expect(manifest).toMatchObject({ sampleRate: 24000, channels: 1, sampleFormat: "s16le" });
    expect(manifest.assets).toHaveLength(ADAS_SCENARIOS.length * 2);
    for (const scenario of ADAS_SCENARIOS) {
      const pair = manifest.assets.filter((asset) => asset.threat === scenario.threat);
      expect(pair.map((asset) => asset.gender).sort()).toEqual(["female", "male"]);
      expect(pair[0]!.pcmSha256).not.toBe(pair[1]!.pcmSha256);
      for (const asset of pair) {
        expect(asset.text).toBe(`${scenario.message} ${scenario.advice}`);
        const wav = readFileSync(`public/audio/adas/${asset.file}`);
        expect(createHash("sha256").update(wav).digest("hex")).toBe(asset.sha256);
        expect(new URL(asset.url, "https://max.example").searchParams.get("v")).toBe(asset.sha256.slice(0, 16));
        expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
        expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
        let pcm: Buffer | undefined;
        for (let at = 12; at + 8 <= wav.length;) {
          const kind = wav.toString("ascii", at, at + 4);
          const length = wav.readUInt32LE(at + 4);
          if (kind === "fmt ") {
            expect(wav.readUInt16LE(at + 8)).toBe(1);
            expect(wav.readUInt16LE(at + 10)).toBe(1);
            expect(wav.readUInt32LE(at + 12)).toBe(24000);
            expect(wav.readUInt16LE(at + 22)).toBe(16);
          }
          if (kind === "data") pcm = wav.subarray(at + 8, at + 8 + length);
          at += 8 + length + (length % 2);
        }
        expect(pcm).toBeDefined();
        expect(pcm!.length / 2).toBe(asset.samples);
        expect(asset.durationSeconds).toBeCloseTo(asset.samples / 24000, 5);
        expect(asset.durationSeconds).toBeGreaterThan(1);
        expect(pcm!.some((value) => value !== 0)).toBe(true);
        expect(createHash("sha256").update(pcm!).digest("hex")).toBe(asset.pcmSha256);
      }
    }
  });
});
