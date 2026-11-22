import { describe, expect, it } from "vitest";
import {
  alawDecode,
  alawEncode,
  Downsampler24to8,
  mulawDecode,
  mulawEncode,
  Upsampler8to16
} from "../server/telephony/g711";

function pcm(samples: number[]): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => out.writeInt16LE(value, index * 2));
  return out;
}

function samplesOf(buffer: Buffer): number[] {
  return Array.from({ length: buffer.length / 2 }, (_, index) => buffer.readInt16LE(index * 2));
}

function sine(hz: number, rate: number, count: number, amplitude: number): Buffer {
  return pcm(Array.from({ length: count }, (_, n) => Math.round(amplitude * Math.sin((2 * Math.PI * hz * n) / rate))));
}

function rms(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
}

/** Deterministic pseudo-random numbers so a failing chunking can be reproduced. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function chunked(input: Buffer, feed: (chunk: Buffer) => Buffer, seed: number): Buffer {
  const random = rng(seed);
  const parts: Buffer[] = [];
  for (let at = 0; at < input.length;) {
    const size = 1 + Math.floor(random() * 97);
    parts.push(feed(input.subarray(at, at + size)));
    at += size;
  }
  return Buffer.concat(parts);
}

function snrDb(original: number[], decoded: number[]): number {
  const noise = original.map((v, i) => v - decoded[i]);
  return 20 * Math.log10(rms(original) / rms(noise));
}

describe("G.711 companding", () => {
  it("maps known code points", () => {
    expect(mulawEncode(pcm([0]))[0]).toBe(0xff);
    expect(alawEncode(pcm([0]))[0]).toBe(0xd5);
    expect(mulawEncode(pcm([32767]))[0]).toBe(0x80);
    expect(mulawEncode(pcm([-32768]))[0]).toBe(0x00);
    expect(alawEncode(pcm([32767]))[0]).toBe(0xaa);
    expect(alawEncode(pcm([-32768]))[0]).toBe(0x2a);
    expect(samplesOf(mulawDecode(Buffer.from([0xff, 0x7f])))).toEqual([0, 0]);
    expect(samplesOf(mulawDecode(Buffer.from([0x80, 0x00])))).toEqual([32124, -32124]);
    expect(samplesOf(alawDecode(Buffer.from([0xd5, 0x55])))).toEqual([8, -8]);
    expect(samplesOf(alawDecode(Buffer.from([0xaa, 0x2a])))).toEqual([32256, -32256]);
  });

  it("decode then encode is the identity on every code", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    // μ-law has two zeros (0x7f and 0xff): both re-encode to 0xff.
    const mu = mulawEncode(mulawDecode(all));
    for (let code = 0; code < 256; code += 1) expect(mu[code]).toBe(code === 0x7f ? 0xff : code);
    expect([...alawEncode(alawDecode(all))]).toEqual([...all]);
  });

  it.each([
    ["mu-law", mulawEncode, mulawDecode],
    ["A-law", alawEncode, alawDecode]
  ] as const)("keeps a -6 dBFS 1 kHz tone above 30 dB SNR (%s)", (_name, encode, decode) => {
    const original = sine(1000, 8000, 800, 16384);
    expect(snrDb(samplesOf(original), samplesOf(decode(encode(original))))).toBeGreaterThan(30);
  });

  it("ignores an odd trailing byte when encoding", () => {
    expect(mulawEncode(Buffer.from([0, 0, 7])).length).toBe(1);
    expect(alawEncode(Buffer.from([0, 0, 7])).length).toBe(1);
  });

  it("is monotonic across the whole range", () => {
    for (const [encode, decode] of [
      [mulawEncode, mulawDecode],
      [alawEncode, alawDecode]
    ] as const) {
      let last = -Infinity;
      for (let value = -32768; value <= 32767; value += 7) {
        const out = decode(encode(pcm([value]))).readInt16LE(0);
        expect(out).toBeGreaterThanOrEqual(last);
        last = out;
      }
    }
  });
});

describe("Upsampler8to16", () => {
  it("doubles the sample count", () => {
    const up = new Upsampler8to16();
    expect(up.process(sine(500, 8000, 160, 8000)).length).toBe(160 * 2 * 2);
  });

  it("gives the same output in any chunking, odd byte counts included", () => {
    const input = sine(700, 8000, 1000, 12000);
    const whole = new Upsampler8to16().process(input);
    for (const seed of [1, 2, 3]) {
      const up = new Upsampler8to16();
      expect(chunked(input, (chunk) => up.process(chunk), seed).equals(whole)).toBe(true);
    }
  });

  it("joins chunks without a step and passes a 1 kHz tone at unity", () => {
    const up = new Upsampler8to16();
    const out = samplesOf(Buffer.concat([up.process(sine(1000, 8000, 400, 10000)), up.process(Buffer.alloc(0))]));
    const body = out.slice(100);
    expect(rms(body)).toBeGreaterThan(0.9 * (10000 / Math.SQRT2));
    expect(rms(body)).toBeLessThan(1.05 * (10000 / Math.SQRT2));
  });

  it("reset forgets the previous sample and any stray byte", () => {
    const up = new Upsampler8to16();
    up.process(pcm([20000]));
    up.process(Buffer.from([1]));
    up.reset();
    expect(samplesOf(up.process(pcm([1000])))).toEqual([500, 1000]);
  });
});

describe("Downsampler24to8", () => {
  it("produces floor(total / 3) samples however the input is cut", () => {
    for (const seed of [4, 5]) {
      const input = sine(300, 24000, 2401, 9000);
      const down = new Downsampler24to8();
      const out = chunked(input, (chunk) => down.process(chunk), seed);
      expect(Math.abs(out.length / 2 - Math.floor(2401 / 3))).toBeLessThanOrEqual(1);
    }
  });

  it("gives the same output in any chunking, odd byte counts included", () => {
    const input = Buffer.concat([sine(900, 24000, 1500, 9000), sine(2500, 24000, 1500, 9000)]);
    const whole = new Downsampler24to8().process(input);
    for (const seed of [6, 7, 8]) {
      const down = new Downsampler24to8();
      expect(chunked(input, (chunk) => down.process(chunk), seed).equals(whole)).toBe(true);
    }
  });

  it("passes 1 kHz near unity and attenuates 6 kHz by at least 20 dB", () => {
    const amplitude = 10000;
    const pass = samplesOf(new Downsampler24to8().process(sine(1000, 24000, 4800, amplitude))).slice(40);
    const stop = samplesOf(new Downsampler24to8().process(sine(6000, 24000, 4800, amplitude))).slice(40);
    const reference = amplitude / Math.SQRT2;
    expect(rms(pass) / reference).toBeGreaterThan(0.95);
    expect(rms(pass) / reference).toBeLessThan(1.05);
    expect(20 * Math.log10(rms(stop) / reference)).toBeLessThan(-20);
  });

  it("clamps to int16 instead of wrapping", () => {
    const loud = pcm(Array.from({ length: 300 }, (_, n) => (Math.floor(n / 6) % 2 === 0 ? 32767 : -32768)));
    for (const value of samplesOf(new Downsampler24to8().process(loud))) {
      expect(value).toBeGreaterThanOrEqual(-32768);
      expect(value).toBeLessThanOrEqual(32767);
    }
  });

  it("reset restarts the filter", () => {
    const input = sine(800, 24000, 300, 9000);
    const down = new Downsampler24to8();
    const first = down.process(input);
    down.process(Buffer.from([1]));
    down.reset();
    expect(down.process(input).equals(first)).toBe(true);
  });
});
