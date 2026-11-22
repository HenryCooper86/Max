import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createNoiseSuppressor, loadNoiseSuppression, noiseSuppressionFromEnv } from "../server/noise-suppression";

// These tests run the real model on a real voice recording that ships with
// the repository (one of the spoken hazard alerts), mixed with noise.

const RATE = 16_000;

/** A 24 kHz mono WAV from the repository, as 16 kHz samples. */
function speech(): Float32Array {
  const wav = fs.readFileSync("public/audio/adas/female/forward_collision.wav");
  const start = wav.indexOf(Buffer.from("data")) + 8;
  const source = new Int16Array(wav.buffer, wav.byteOffset + start, (wav.length - start) >> 1);
  const out = new Float32Array(Math.floor((source.length * 2) / 3));
  for (let i = 0; i < out.length; i += 1) {
    const at = i * 1.5;
    const low = Math.floor(at);
    out[i] = source[low]! + (source[Math.min(low + 1, source.length - 1)]! - source[low]!) * (at - low);
  }
  return out;
}

function pcm(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(samples[i]!))), i * 2);
  }
  return buffer;
}

function rms(buffer: Buffer, fromSample = 0, toSample = buffer.length / 2): number {
  let sum = 0;
  for (let i = fromSample; i < toSample; i += 1) sum += buffer.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / (toSample - fromSample));
}

const decibels = (ratio: number) => 20 * Math.log10(ratio);

/** A fan: noise with most of its energy low down. Seeded, so every run hears the same room. */
function fan(length: number, level: number): Float32Array {
  let seed = 12_345;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const out = new Float32Array(length);
  let y = 0;
  for (let i = 0; i < length; i += 1) out[i] = y = y * 0.97 + random() * 0.3;
  let sum = 0;
  for (const value of out) sum += value * value;
  const scale = level / Math.sqrt(sum / length);
  return out.map((value) => value * scale);
}

function clean(input: Buffer, pieceBytes = 640): Buffer {
  const suppressor = createNoiseSuppressor()!;
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += pieceBytes) {
    pieces.push(suppressor.process(input.subarray(offset, Math.min(offset + pieceBytes, input.length))));
  }
  suppressor.close();
  return Buffer.concat(pieces);
}

describe("noiseSuppressionFromEnv", () => {
  it("is off unless asked for, and says what it cannot use", () => {
    expect(noiseSuppressionFromEnv({})).toEqual({ mode: "off", problems: [] });
    expect(noiseSuppressionFromEnv({ NOISE_SUPPRESSION: "off" })).toEqual({ mode: "off", problems: [] });
    expect(noiseSuppressionFromEnv({ NOISE_SUPPRESSION: " Phone " })).toEqual({ mode: "phone", problems: [] });
    expect(noiseSuppressionFromEnv({ NOISE_SUPPRESSION: "on" })).toEqual({ mode: "on", problems: [] });
    expect(noiseSuppressionFromEnv({ NOISE_SUPPRESSION: "loud" })).toEqual({
      mode: "off",
      problems: ["NOISE_SUPPRESSION=loud is not one of off, phone, on"]
    });
  });
});

describe("noise suppression", () => {
  beforeAll(async () => {
    expect(await loadNoiseSuppression()).toBe(true);
  });

  it("silences a noisy room when nobody is speaking", () => {
    const room = pcm(fan(RATE * 3, 1500));
    const out = clean(room);
    // The first second is the model getting to know the room.
    const before = rms(room, RATE, RATE * 3);
    const after = rms(out, RATE, out.length / 2);
    expect(decibels(before / Math.max(after, 1))).toBeGreaterThan(25);
  });

  it("keeps the voice and takes the noise out from between the words", () => {
    const voice = speech();
    const voiceLevel = rms(pcm(voice));
    // Two seconds of room alone, then the voice in that room at 10 dB above the noise, then the room again.
    const lead = RATE * 2;
    const tail = RATE;
    const noise = fan(lead + voice.length + tail, voiceLevel / 10 ** (10 / 20));
    const mixed = new Float32Array(noise.length);
    for (let i = 0; i < mixed.length; i += 1) mixed[i] = noise[i]! + (voice[i - lead] ?? 0);
    const input = pcm(mixed);
    const out = clean(input);

    // The voice comes through at close to its own level.
    const voiceOut = rms(out, lead, lead + voice.length);
    expect(Math.abs(decibels(voiceOut / voiceLevel))).toBeLessThan(3);
    // The room after the last word is far quieter than it was.
    const roomBefore = rms(input, lead + voice.length + 4000, input.length / 2);
    const roomAfter = rms(out, lead + voice.length + 4000, out.length / 2);
    expect(decibels(roomBefore / Math.max(roomAfter, 1))).toBeGreaterThan(20);
  });

  it("works on the narrow band of a phone call too", () => {
    // What a phone line carries: nothing above 4 kHz. Halve the rate and bring it back.
    const wide = speech();
    const voice = new Float32Array(wide.length - (wide.length % 2));
    for (let i = 0; i + 1 < voice.length; i += 2) {
      const sample = (wide[i]! + wide[i + 1]!) / 2;
      const next = i + 3 < wide.length ? (wide[i + 2]! + wide[i + 3]!) / 2 : sample;
      voice[i] = sample;
      voice[i + 1] = (sample + next) / 2;
    }
    const voiceLevel = rms(pcm(voice));
    const lead = RATE * 2;
    const noise = fan(lead + voice.length + RATE, voiceLevel / 10 ** (10 / 20));
    const mixed = new Float32Array(noise.length);
    for (let i = 0; i < mixed.length; i += 1) mixed[i] = noise[i]! + (voice[i - lead] ?? 0);
    const input = pcm(mixed);
    const out = clean(input);
    expect(Math.abs(decibels(rms(out, lead, lead + voice.length) / voiceLevel))).toBeLessThan(3);
    const roomBefore = rms(input, lead + voice.length + 4000, input.length / 2);
    const roomAfter = rms(out, lead + voice.length + 4000, out.length / 2);
    expect(decibels(roomBefore / Math.max(roomAfter, 1))).toBeGreaterThan(20);
  });

  it("leaves a clean voice as it was, 20 ms later", () => {
    const input = pcm(speech());
    const out = clean(input);
    expect(Math.abs(decibels(rms(out) / rms(input)))).toBeLessThan(1);
    // The output lines up with the input when shifted by the model's delay.
    const correlation = (lag: number) => {
      let both = 0;
      let a = 0;
      let b = 0;
      for (let i = 8000; i < input.length / 2 - 8000; i += 1) {
        const x = input.readInt16LE(i * 2);
        const y = out.readInt16LE((i + lag) * 2);
        both += x * y;
        a += x * x;
        b += y * y;
      }
      return both / Math.sqrt(a * b);
    };
    expect(correlation(320)).toBeGreaterThan(0.95);
    expect(correlation(320)).toBeGreaterThan(correlation(0));
  });

  it("gives the same audio however the stream is cut up", () => {
    const input = pcm(speech()).subarray(0, RATE * 2);
    const whole = clean(input, input.length);
    expect(whole.length).toBe(input.length);
    // Odd sizes, including pieces shorter than one 10 ms frame.
    for (const pieceBytes of [640, 322, 100, 2]) expect(clean(input, pieceBytes).equals(whole)).toBe(true);
  });

  it("holds back what does not fill a frame, and passes audio through once closed", () => {
    const suppressor = createNoiseSuppressor()!;
    expect(suppressor.process(Buffer.alloc(300))).toHaveLength(0);
    expect(suppressor.process(Buffer.alloc(40))).toHaveLength(320);
    suppressor.close();
    suppressor.close();
    const later = Buffer.alloc(640, 1);
    expect(suppressor.process(later)).toBe(later);
  });

  it("keeps separate streams apart", () => {
    const voice = pcm(speech()).subarray(0, RATE);
    const alone = clean(voice);
    const a = createNoiseSuppressor()!;
    const b = createNoiseSuppressor()!;
    const noisy = pcm(fan(RATE, 4000));
    const outA: Buffer[] = [];
    for (let offset = 0; offset < voice.length; offset += 640) {
      outA.push(a.process(voice.subarray(offset, offset + 640)));
      b.process(noisy.subarray(offset, offset + 640));
    }
    a.close();
    b.close();
    expect(Buffer.concat(outA).equals(alone)).toBe(true);
  });
});
