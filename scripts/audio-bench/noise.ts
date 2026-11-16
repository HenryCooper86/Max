import { BENCH_RATE, power } from "./wav";

/**
 * Noise beds for the bench, synthesised rather than recorded.
 *
 * They are stand-ins: each has the character that makes its real counterpart
 * hard for a microphone and a speech detector, generated from a seed so every
 * run and every machine scores the same signal. They are not a substitute for
 * a recording made on your own device on a real road; the bench accepts those
 * in their place (see docs/audio/test-bench.md).
 *
 * - wind: almost all of its energy below a few hundred hertz, arriving in
 *   gusts. This is what overloads a microphone and hides the low end of speech.
 * - engine: a harmonic stack on a fundamental that wanders with the revs, on
 *   a bed of broadband roar. Tonal noise sits right where vowels do.
 * - street: steady hiss with vehicles passing and the occasional horn. It is
 *   the changing parts that make a speech detector fire when nobody spoke.
 */
export type NoiseKind = "wind" | "engine" | "street";
export const NOISE_KINDS: readonly NoiseKind[] = ["wind", "engine", "street"];

/** A small seeded generator, so a bed is the same on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass coefficient for a corner frequency. */
function pole(hz: number): number {
  return 1 - Math.exp((-2 * Math.PI * hz) / BENCH_RATE);
}

/** Slow random movement between 0 and 1: gusts, revs, traffic. */
function drift(length: number, hz: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  const a = pole(hz);
  let first = 0;
  let second = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let index = 0; index < length; index += 1) {
    first += a * (random() * 2 - 1 - first);
    second += a * (first - second);
    out[index] = second;
    if (second < low) low = second;
    if (second > high) high = second;
  }
  const span = high - low || 1;
  for (let index = 0; index < length; index += 1) out[index] = (out[index]! - low) / span;
  return out;
}

function wind(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  const gusts = drift(length, 0.8, random);
  const a = pole(160);
  let first = 0;
  let second = 0;
  for (let index = 0; index < length; index += 1) {
    first += a * (random() * 2 - 1 - first);
    second += a * (first - second);
    out[index] = second * (0.25 + 0.75 * gusts[index]! ** 2);
  }
  return out;
}

function engine(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  const revs = drift(length, 0.25, random);
  const roarPole = pole(1800);
  let phase = 0;
  let roar = 0;
  for (let index = 0; index < length; index += 1) {
    const fundamental = 85 + 45 * revs[index]!;
    phase += (2 * Math.PI * fundamental) / BENCH_RATE;
    let tone = 0;
    for (let harmonic = 1; harmonic <= 12; harmonic += 1) {
      tone += Math.sin(phase * harmonic + harmonic) / harmonic ** 0.8;
    }
    // Every other firing is a little stronger, as on a real twin.
    tone *= 0.8 + 0.2 * Math.sin(phase / 2);
    roar += roarPole * (random() * 2 - 1 - roar);
    out[index] = tone * 0.22 + roar * 0.6;
  }
  return out;
}

function street(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  // Pink-ish hiss: three low-passes at spread corners, summed.
  const poles = [pole(120), pole(900), pole(5000)];
  const state = [0, 0, 0];
  const traffic = drift(length, 0.35, random);
  const passPole = pole(500);
  let pass = 0;
  for (let index = 0; index < length; index += 1) {
    const white = random() * 2 - 1;
    let hiss = 0;
    for (let stage = 0; stage < 3; stage += 1) {
      state[stage]! += poles[stage]! * (white - state[stage]!);
      hiss += state[stage]!;
    }
    pass += passPole * (random() * 2 - 1 - pass);
    // A vehicle passing is a swell of low rumble.
    out[index] = hiss * 0.35 + pass * 2.2 * Math.max(0, traffic[index]! - 0.55);
  }
  // A horn now and then: two tones, a short blast.
  const blast = Math.round(0.45 * BENCH_RATE);
  for (let start = Math.round(BENCH_RATE * (1.5 + random() * 2)); start + blast < length;) {
    for (let index = 0; index < blast; index += 1) {
      const time = index / BENCH_RATE;
      const edge = Math.min(1, index / 400, (blast - index) / 400);
      out[start + index]! += 0.5 * edge * (Math.sin(2 * Math.PI * 420 * time) + Math.sin(2 * Math.PI * 525 * time));
    }
    start += Math.round(BENCH_RATE * (4 + random() * 5));
  }
  return out;
}

/** A noise bed of the given kind and length, at a fixed loudness. */
export function synthesizeNoise(kind: NoiseKind, seconds: number, seed = 20261116): Float32Array {
  const length = Math.round(seconds * BENCH_RATE);
  const random = generator(seed + NOISE_KINDS.indexOf(kind) * 7919);
  const raw =
    kind === "wind" ? wind(length, random) : kind === "engine" ? engine(length, random) : street(length, random);
  const gain = Math.sqrt(0.01 / Math.max(power(raw), 1e-12));
  for (let index = 0; index < raw.length; index += 1) raw[index]! *= gain;
  return raw;
}
