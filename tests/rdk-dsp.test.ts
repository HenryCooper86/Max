import { describe, expect, it } from "vitest";
import {
  FRAME_BYTES,
  FRAME_SAMPLES,
  LOW_PASS_48K,
  applySoftLimit,
  createDecimator,
  createFramer,
  createUpsampler2x,
  designLowPass,
  rms,
  softLimitSample
} from "../rdk/agent/src/audio/dsp";

function tone(hz: number, sampleRate: number, samples: number, amplitude = 0.5): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 32767);
  }
  return out;
}

describe("designLowPass", () => {
  it("produces an odd-length kernel with unity DC gain", () => {
    const taps = designLowPass(31, 7500, 48000);
    expect(taps.length).toBe(31);
    const sum = taps.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("is symmetric, so the filter has linear phase", () => {
    const taps = designLowPass(31, 7500, 48000);
    for (let i = 0; i < 15; i += 1) {
      expect(taps[i]).toBeCloseTo(taps[30 - i]!, 10);
    }
  });
});

describe("createDecimator", () => {
  it("outputs one sample per factor input samples", () => {
    const decimate = createDecimator(3, LOW_PASS_48K);
    const out = decimate(tone(440, 48000, 4800));
    expect(out.length).toBe(1600);
  });

  it("passes a 440 Hz tone through largely intact", () => {
    const decimate = createDecimator(3, LOW_PASS_48K);
    const out = decimate(tone(440, 48000, 48000));
    // Skip the filter warm-up, then compare energy against the input.
    expect(rms(out.subarray(200))).toBeGreaterThan(0.35 * 32767);
  });

  it("rejects a 20 kHz tone that would otherwise alias to 4 kHz", () => {
    const decimate = createDecimator(3, LOW_PASS_48K);
    const out = decimate(tone(20000, 48000, 48000));
    expect(rms(out.subarray(200))).toBeLessThan(0.02 * 32767);
  });

  it("keeps filter state across chunk boundaries", () => {
    const whole = createDecimator(3, LOW_PASS_48K)(tone(440, 48000, 4800));
    const split = createDecimator(3, LOW_PASS_48K);
    const first = split(tone(440, 48000, 4800).subarray(0, 2400));
    const rest = tone(440, 48000, 4800).subarray(2400);
    const second = split(rest);
    expect(first.length + second.length).toBe(whole.length);
    expect(Array.from(second.subarray(0, 20))).toEqual(Array.from(whole.subarray(first.length, first.length + 20)));
  });
});

describe("createUpsampler2x", () => {
  it("doubles the sample count", () => {
    const up = createUpsampler2x();
    expect(up(tone(440, 24000, 240)).length).toBe(480);
  });

  it("places the original samples on odd indices", () => {
    const up = createUpsampler2x();
    const input = Int16Array.from([1000, 2000, 3000]);
    const out = up(input);
    expect(out[1]).toBe(1000);
    expect(out[3]).toBe(2000);
    expect(out[5]).toBe(3000);
  });

  it("interpolates across chunk boundaries", () => {
    const up = createUpsampler2x();
    up(Int16Array.from([1000]));
    const out = up(Int16Array.from([3000]));
    expect(out[0]).toBe(2000);
  });
});

describe("softLimitSample", () => {
  it("is linear below the threshold", () => {
    expect(softLimitSample(0.2, 1.6, 0.7)).toBeCloseTo(0.32, 6);
  });

  it("never exceeds full scale", () => {
    for (const x of [0.8, 0.95, 1, -1, -0.95]) {
      expect(Math.abs(softLimitSample(x, 4, 0.7))).toBeLessThanOrEqual(1);
    }
  });

  it("is sign-symmetric", () => {
    expect(softLimitSample(-0.9, 1.6, 0.7)).toBeCloseTo(-softLimitSample(0.9, 1.6, 0.7), 10);
  });

  it("is monotonic", () => {
    let previous = -Infinity;
    for (let x = -1; x <= 1; x += 0.05) {
      const value = softLimitSample(x, 1.6, 0.7);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe("applySoftLimit", () => {
  it("clamps a loud buffer inside int16 range", () => {
    const loud = tone(440, 24000, 240, 0.99);
    for (const sample of applySoftLimit(loud, 4, 0.7)) {
      expect(sample).toBeLessThanOrEqual(32767);
      expect(sample).toBeGreaterThanOrEqual(-32768);
    }
  });
});

describe("createFramer", () => {
  it("emits only whole frames and buffers the remainder", () => {
    const frame = createFramer();
    expect(frame(new Int16Array(100))).toEqual([]);
    const out = frame(new Int16Array(600));
    expect(out.length).toBe(2);
    expect(out[0]!.length).toBe(FRAME_SAMPLES);
    expect(out[0]!.byteLength).toBe(FRAME_BYTES);
  });

  it("preserves sample order across calls", () => {
    const frame = createFramer(4);
    frame(Int16Array.from([1, 2, 3]));
    const out = frame(Int16Array.from([4, 5, 6, 7, 8]));
    expect(Array.from(out[0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(out[1]!)).toEqual([5, 6, 7, 8]);
  });
});
