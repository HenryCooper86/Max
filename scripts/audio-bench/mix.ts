import { BENCH_RATE, power } from "./wav";

/** Where speech really is in a clean recording, found from its loudness. */
export function speechBounds(speech: Float32Array): { onset: number; offset: number } {
  const window = Math.round(BENCH_RATE * 0.02);
  let peak = 0;
  const levels: number[] = [];
  for (let start = 0; start + window <= speech.length; start += window) {
    const level = Math.sqrt(power(speech, start, start + window));
    levels.push(level);
    if (level > peak) peak = level;
  }
  // 30 dB below the loudest moment: quiet consonants count, room hiss does not.
  const floor = peak * 0.03;
  const first = levels.findIndex((level) => level > floor);
  let last = levels.length - 1;
  while (last > first && levels[last]! <= floor) last -= 1;
  if (first < 0) return { onset: 0, offset: speech.length };
  return { onset: first * window, offset: Math.min(speech.length, (last + 1) * window) };
}

export type Mixed = {
  samples: Float32Array;
  /** Sample at which speech starts and ends in the mix. */
  onset: number;
  offset: number;
};

/**
 * Lays speech over a noise bed at a signal-to-noise ratio measured where the
 * speech actually is, with noise alone before and after it: the lead-in is
 * where a speech detector must stay quiet, the tail is where it must let go.
 *
 * `snrDb: null` is the clean reference: no noise at all.
 */
export function mixAtSnr(
  speech: Float32Array,
  noise: Float32Array,
  snrDb: number | null,
  leadSeconds = 2,
  tailSeconds = 1.5
): Mixed {
  const bounds = speechBounds(speech);
  const active = speech.subarray(bounds.onset, bounds.offset);
  const lead = Math.round(leadSeconds * BENCH_RATE);
  const tail = Math.round(tailSeconds * BENCH_RATE);
  const samples = new Float32Array(lead + active.length + tail);
  if (snrDb !== null) {
    if (noise.length < samples.length) throw new Error("noise bed is shorter than the scenario");
    const wanted = power(active) / 10 ** (snrDb / 10);
    const gain = Math.sqrt(wanted / Math.max(power(noise, lead, lead + active.length), 1e-12));
    for (let index = 0; index < samples.length; index += 1) samples[index] = noise[index]! * gain;
  }
  for (let index = 0; index < active.length; index += 1) samples[lead + index]! += active[index]!;
  // Keep clear of clipping without changing the ratio.
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let index = 0; index < samples.length; index += 1) samples[index]! *= scale;
  }
  return { samples, onset: lead, offset: lead + active.length };
}
