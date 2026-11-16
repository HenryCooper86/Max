import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mixAtSnr, speechBounds } from "../scripts/audio-bench/mix";
import { NOISE_KINDS, synthesizeNoise } from "../scripts/audio-bench/noise";
import {
  LIMITS,
  errorRate,
  scoreDetection,
  scoreEcho,
  tokens,
  verdictAtLeast,
  verdictAtMost
} from "../scripts/audio-bench/score";
import { BENCH_RATE, decibels, power, readBenchWav, readWav, writeWav } from "../scripts/audio-bench/wav";

/** Something speech-like: syllables of a wobbling tone with gaps between. */
function syllables(seconds: number, level = 0.2): Float32Array {
  const out = new Float32Array(Math.round(seconds * BENCH_RATE));
  for (let index = 0; index < out.length; index += 1) {
    const time = index / BENCH_RATE;
    const syllable = Math.sin(Math.PI * ((time * 4) % 1)) ** 2; // four a second
    out[index] = level * syllable * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(time * 9)) * time);
  }
  return out;
}

function padded(speech: Float32Array, leadSeconds: number, tailSeconds: number): Float32Array {
  const lead = Math.round(leadSeconds * BENCH_RATE);
  const out = new Float32Array(lead + speech.length + Math.round(tailSeconds * BENCH_RATE));
  out.set(speech, lead);
  return out;
}

/** Share of a signal's power below a frequency, by a crude one-pole split. */
function lowShare(samples: Float32Array, hz: number): number {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / BENCH_RATE);
  const low = new Float32Array(samples.length);
  let state = 0;
  for (let index = 0; index < samples.length; index += 1) {
    state += a * (samples[index]! - state);
    low[index] = state;
  }
  return power(low) / power(samples);
}

describe("WAV files", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("round-trips a recording and refuses the wrong rate with the fix", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-wav-"));
    const file = path.join(directory, "clip.wav");
    const clip = syllables(0.5);
    writeWav(file, clip);
    const back = readBenchWav(file);
    expect(back).toHaveLength(clip.length);
    expect(Math.abs(back[1234]! - clip[1234]!)).toBeLessThan(1 / 16000);

    writeWav(file, clip, 48_000);
    expect(readWav(file).sampleRate).toBe(48_000);
    expect(() => readBenchWav(file)).toThrow(/ffmpeg .* -ar 16000/);
    fs.writeFileSync(file, "not audio at all, just text that is long enough to pass a length check");
    expect(() => readWav(file)).toThrow(/not a WAV/);
  });
});

describe("noise beds", () => {
  it("are the same on every run and all at one loudness", () => {
    for (const kind of NOISE_KINDS) {
      const first = synthesizeNoise(kind, 3);
      const second = synthesizeNoise(kind, 3);
      expect(Array.from(first.subarray(0, 200))).toEqual(Array.from(second.subarray(0, 200)));
      expect(decibels(power(first))).toBeCloseTo(-20, 0);
    }
    expect(synthesizeNoise("wind", 1, 1)[500]).not.toBe(synthesizeNoise("wind", 1, 2)[500]);
  });

  it("have the character of what they stand in for", () => {
    const wind = synthesizeNoise("wind", 6);
    const engine = synthesizeNoise("engine", 6);
    const street = synthesizeNoise("street", 6);
    // Wind is nearly all rumble; street hiss reaches far higher.
    expect(lowShare(wind, 300)).toBeGreaterThan(0.8);
    expect(lowShare(street, 300)).toBeLessThan(lowShare(wind, 300));
    // Wind comes in gusts: its loudness moves a lot from second to second.
    const seconds = (noise: Float32Array) =>
      Array.from({ length: 6 }, (_, second) => power(noise, second * BENCH_RATE, (second + 1) * BENCH_RATE));
    const spread = (values: number[]) => decibels(Math.max(...values) / Math.min(...values));
    expect(spread(seconds(wind))).toBeGreaterThan(spread(seconds(engine)));
  });
});

describe("mixing", () => {
  it("finds where the speech is", () => {
    const clip = padded(syllables(1), 0.5, 0.7);
    const bounds = speechBounds(clip);
    expect(bounds.onset / BENCH_RATE).toBeCloseTo(0.5, 1);
    expect(bounds.offset / BENCH_RATE).toBeCloseTo(1.5, 1);
  });

  it("hits the asked-for ratio over the speech, with noise alone either side", () => {
    const speech = padded(syllables(1.5), 0.3, 0.3);
    const noise = synthesizeNoise("street", 10);
    for (const snr of [20, 10, 0]) {
      const mixed = mixAtSnr(speech, noise, snr);
      const quiet = mixAtSnr(speech, noise, null);
      // Same scale for both: recover the noise by subtracting the clean mix.
      const scale = Math.sqrt(power(mixed.samples, 0, mixed.onset) / power(noise, 0, mixed.onset));
      const noisePower = power(noise, mixed.onset, mixed.offset) * scale * scale;
      const speechPower = power(quiet.samples, quiet.onset, quiet.offset);
      const normalised = power(mixed.samples, mixed.onset, mixed.offset) - noisePower;
      // Either the mix was not rescaled (speech power unchanged) or it was scaled as a whole.
      expect(decibels(Math.max(normalised, 1e-9) / noisePower)).toBeCloseTo(snr, 0);
      expect(speechPower).toBeGreaterThan(0);
      expect(mixed.onset).toBe(2 * BENCH_RATE);
    }
  });

  it("makes the clean reference with no noise at all", () => {
    const mixed = mixAtSnr(padded(syllables(1), 0.2, 0.2), new Float32Array(0), null);
    expect(power(mixed.samples, 0, mixed.onset)).toBe(0);
  });
});

describe("speech detection score", () => {
  it("detects clear speech quickly and without false starts", () => {
    const mixed = mixAtSnr(padded(syllables(2), 0.2, 0.2), new Float32Array(0), null);
    const score = scoreDetection(mixed.samples, mixed.onset, mixed.offset);
    expect(score.detected).toBe(true);
    expect(score.onsetDelayMs).toBeLessThanOrEqual(LIMITS.onsetDelayMs.good);
    expect(score.falseStarts).toBe(0);
    expect(score.releaseDelayMs).toBeGreaterThan(0);
  });

  it("reports a miss when the speech is too quiet to detect", () => {
    const mixed = mixAtSnr(padded(syllables(2, 0.004), 0.2, 0.2), new Float32Array(0), null);
    const score = scoreDetection(mixed.samples, mixed.onset, mixed.offset);
    expect(score).toMatchObject({ detected: false, onsetDelayMs: null, falseStarts: 0 });
  });

  it("counts the detector firing on loud noise before anyone speaks", () => {
    const mixed = mixAtSnr(padded(syllables(2), 0.2, 0.2), synthesizeNoise("engine", 10), 0);
    expect(scoreDetection(mixed.samples, mixed.onset, mixed.offset).falseStarts).toBeGreaterThan(0);
  });
});

describe("echo score", () => {
  it("measures what the canceller removed and how far the voice stands above the echo", () => {
    const assistant = syllables(3, 0.3);
    const raw = assistant.map((value) => value * 0.3);
    const cancelled = assistant.map((value) => value * 0.003);
    const score = scoreEcho(cancelled, raw, syllables(3, 0.09));
    expect(score.erleDb).toBeCloseTo(40, 0);
    expect(score.speechOverEchoDb).toBeCloseTo(40, 0);
    expect(score.falseInterruptions).toBe(0);
    expect(verdictAtLeast(score.erleDb!, LIMITS.erleDb)).toBe("good");
  });

  it("counts the echo being mistaken for the wearer", () => {
    const loudEcho = padded(syllables(3, 0.3), 0.5, 0.5);
    const score = scoreEcho(loudEcho);
    expect(score.falseInterruptions).toBeGreaterThan(0);
    expect(score.erleDb).toBeUndefined();
  });
});

describe("recognition error rate", () => {
  it("counts words in English and characters in Chinese", () => {
    expect(tokens("Max, what's the weather ahead?")).toEqual(["max", "what's", "the", "weather", "ahead"]);
    expect(tokens("Max，前面天气怎么样？")).toEqual(["max", "前", "面", "天", "气", "怎", "么", "样"]);
  });

  it("ignores case and punctuation, and counts substitutions, drops and additions", () => {
    expect(errorRate("Max, what's the weather ahead?", "max what’s the weather ahead")).toBe(0);
    expect(errorRate("call home now", "call phone now")).toBeCloseTo(1 / 3);
    expect(errorRate("call home now", "call now")).toBeCloseTo(1 / 3);
    expect(errorRate("call home", "please call home right now")).toBeCloseTo(3 / 2);
    expect(errorRate("导航去加油站", "导航去加油")).toBeCloseTo(1 / 6);
    expect(errorRate("call home", "")).toBe(1);
    expect(errorRate("", "")).toBe(0);
  });

  it("turns numbers into verdicts", () => {
    expect(verdictAtMost(0.05, LIMITS.errorRate)).toBe("good");
    expect(verdictAtMost(0.2, LIMITS.errorRate)).toBe("usable");
    expect(verdictAtMost(0.5, LIMITS.errorRate)).toBe("poor");
    expect(verdictAtLeast(18, LIMITS.erleDb)).toBe("usable");
    expect(verdictAtLeast(5, LIMITS.erleDb)).toBe("poor");
  });
});
