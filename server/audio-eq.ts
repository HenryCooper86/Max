import {
  EQUALIZER_FREQUENCIES,
  type VoiceEqualizer,
  type VoiceEqualizerOptions,
  type VoiceEqualizerPreset
} from "../shared/agent";

/**
 * Voice equaliser for the assistant's outgoing speech.
 *
 * A ten-band graphic equaliser with a preamp, in the classic media-player
 * layout. It runs on the relay so it sounds the same everywhere, including on
 * a board that plays raw PCM and has no audio stack of its own.
 *
 * The bands sit where speech lives. Reply audio is 24 kHz, so it carries
 * nothing above 12 kHz; the usual 12/14/16 kHz sliders would move nothing, and
 * the ten are spread over 60 Hz – 9 kHz instead, with three of them across the
 * 2–4 kHz region that decides whether speech is understood.
 *
 * Each band is a biquad (RBJ audio-EQ cookbook): shelves at the two ends,
 * peaking filters between, run in series over 16-bit mono PCM. A soft limiter
 * at the end keeps boosted speech from wrapping into loud digital clicks.
 */

const BAND_COUNT = EQUALIZER_FREQUENCIES.length;
const LIMIT_DB = 12;
const FLAT_BANDS: readonly number[] = new Array<number>(BAND_COUNT).fill(0);

function preset(id: string, label: string, description: string, bands: number[], preamp = 0): VoiceEqualizerPreset {
  return { id, label, description, bands, preamp };
}

//                                                              60  125  250  500   1k   2k   3k   4k   6k   9k
export const EQUALIZER_PRESETS: readonly VoiceEqualizerPreset[] = [
  preset("flat", "Flat", "The voice as the backend produced it.", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  preset("clarity", "Clarity", "Lifts consonants so speech is easier to follow.", [-3, -2, -1, 0, 0, 2, 4, 4, 2, 1]),
  preset(
    "wind",
    "Helmet · wind",
    "Cuts the lows that wind and engine noise mask and pushes the speech band through.",
    [-12, -10, -6, -2, 0, 3, 5, 5, 3, 1],
    2
  ),
  preset(
    "open-ear",
    "Open-ear glasses",
    "Adds the body that small open speakers lose.",
    [4, 6, 5, 3, 1, 1, 2, 2, 0, 0]
  ),
  preset("outdoor", "Outdoor", "Forward and loud, for streets and trails.", [-6, -4, -2, 0, 1, 3, 4, 4, 2, 0], 3),
  preset(
    "warm",
    "Warm",
    "Softer and rounder, for quiet rooms and long listening.",
    [2, 3, 3, 2, 0, -1, -1, -2, -3, -4]
  ),
  preset(
    "quiet",
    "Quiet",
    "Lower and gentler, so people nearby are not disturbed.",
    [-2, -1, 0, 0, 0, 1, 1, 0, -2, -3],
    -5
  ),
  preset(
    "night",
    "Night",
    "Smooth and low, with the sharp edges taken off.",
    [-4, -2, 0, 1, 0, -1, -2, -3, -5, -6],
    -3
  ),
  preset("loud", "Loud", "Fuller lows and highs with more level.", [5, 4, 2, 0, -1, 0, 2, 3, 4, 4], 2),
  preset("bass-boost", "Bass boost", "More weight in the low end.", [7, 6, 4, 2, 0, 0, 0, 0, 0, 0]),
  preset("treble-boost", "Treble boost", "Brighter, with more air.", [0, 0, 0, 0, 0, 1, 2, 4, 6, 7]),
  preset("vocal", "Vocal", "The mid-range forward, like a broadcast voice.", [-4, -3, -1, 2, 4, 4, 3, 2, 0, -1]),
  preset("radio", "Radio", "A small-speaker radio voice.", [-10, -7, -2, 2, 4, 4, 2, -1, -5, -9]),
  preset("telephone", "Telephone", "Narrow, like a phone line.", [-12, -12, -6, 1, 4, 4, 1, -8, -12, -12]),
  preset("soft", "Soft", "Gentle highs for sensitive ears.", [1, 1, 1, 0, 0, -1, -2, -3, -4, -5], -1)
];

function clampDb(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(-LIMIT_DB, Math.min(LIMIT_DB, Math.round(value * 10) / 10));
}

/** The five speech bands the first version of the equaliser used, spread over
 *  the ten that replaced them, so a config written for it keeps its sound. */
function legacyBands(input: Record<string, unknown>): number[] | undefined {
  const bass = clampDb(input.bass);
  const mid = clampDb(input.mid);
  const presence = clampDb(input.presence);
  const treble = clampDb(input.treble);
  if (bass === undefined && mid === undefined && presence === undefined && treble === undefined) return undefined;
  const b = bass ?? 0;
  const m = mid ?? 0;
  const p = presence ?? 0;
  const t = treble ?? 0;
  const half = (value: number) => Math.round(value * 5) / 10;
  return [b, b, half(b), half(m), m, half(m + p), p, p, half(p + t), t];
}

/** Keeps only well-formed fields from untrusted input (config or a client).
 *  Returns undefined when nothing usable is left. */
export function normalizeEqualizer(raw: unknown): VoiceEqualizer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const result: VoiceEqualizer = {};
  if (typeof input.preset === "string" && EQUALIZER_PRESETS.some((candidate) => candidate.id === input.preset)) {
    result.preset = input.preset;
  }
  if (Array.isArray(input.bands) && input.bands.length === BAND_COUNT) {
    const bands = input.bands.map(clampDb);
    if (bands.every((value): value is number => value !== undefined)) result.bands = bands;
  } else {
    const legacy = legacyBands(input);
    if (legacy) result.bands = legacy;
  }
  const preamp = clampDb(input.preamp ?? input.gain);
  if (preamp !== undefined) result.preamp = preamp;
  return Object.keys(result).length ? result : undefined;
}

/** The gains a setting means: its preset's, overridden by explicit values. */
export function equalizerCurve(settings: VoiceEqualizer | undefined): { bands: number[]; preamp: number } {
  const base = EQUALIZER_PRESETS.find((candidate) => candidate.id === settings?.preset);
  const bands = settings?.bands?.length === BAND_COUNT ? settings.bands : (base?.bands ?? FLAT_BANDS);
  return { bands: [...bands], preamp: settings?.preamp ?? base?.preamp ?? 0 };
}

type Coefficients = { b0: number; b1: number; b2: number; a1: number; a2: number };

function peak(frequency: number, gainDb: number, q: number, rate: number): Coefficients {
  const a = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * frequency) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha / a;
  return {
    b0: (1 + alpha * a) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * a) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / a) / a0
  };
}

function shelf(kind: "low" | "high", frequency: number, gainDb: number, rate: number): Coefficients {
  const a = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * frequency) / rate;
  const cos = Math.cos(w);
  // Shelf slope 1: the steepest shelf that stays monotonic.
  const alpha = (Math.sin(w) / 2) * Math.SQRT2;
  const root = 2 * Math.sqrt(a) * alpha;
  const sign = kind === "low" ? 1 : -1;
  const a0 = a + 1 + sign * (a - 1) * cos + root;
  return {
    b0: (a * (a + 1 - sign * (a - 1) * cos + root)) / a0,
    b1: (sign * 2 * a * (a - 1 - sign * (a + 1) * cos)) / a0,
    b2: (a * (a + 1 - sign * (a - 1) * cos - root)) / a0,
    a1: (sign * -2 * (a - 1 + sign * (a + 1) * cos)) / a0,
    a2: (a + 1 + sign * (a - 1) * cos - root) / a0
  };
}

/** Width of each peaking band. The lower bands are an octave apart; from 2 kHz
 *  up they sit closer, so they are narrower to keep neighbours from stacking. */
function bandQ(index: number): number {
  return index >= 5 && index <= 7 ? 2.4 : 1.4;
}

/** Speech stays below this; above it the limiter bends the peak instead of clipping. */
const KNEE = 0.82;

function limit(sample: number): number {
  const magnitude = Math.abs(sample);
  if (magnitude <= KNEE) return sample;
  // Smoothly approaches full scale and never exceeds it.
  const over = (magnitude - KNEE) / (1 - KNEE);
  const bent = KNEE + (1 - KNEE) * Math.tanh(over);
  return sample < 0 ? -bent : bent;
}

export type Equalizer = {
  /** True when the settings change nothing; `process` then returns its input. */
  readonly bypass: boolean;
  /** Filters PCM16 mono. Chunks may split a sample; the stray byte is carried
   *  to the next call, so the total number of bytes out equals bytes in. */
  process(pcm: Buffer): Buffer;
};

export function createEqualizer(settings: VoiceEqualizer | undefined, sampleRate = 24_000): Equalizer {
  const curve = equalizerCurve(settings);
  const bypass = curve.preamp === 0 && curve.bands.every((value) => value === 0);
  if (bypass) return { bypass: true, process: (pcm) => pcm };

  const nyquist = sampleRate / 2;
  const last = BAND_COUNT - 1;
  const stages: Coefficients[] = [];
  curve.bands.forEach((gain, index) => {
    const frequency = EQUALIZER_FREQUENCIES[index]!;
    // A band at or above the Nyquist frequency is not a filter at this rate.
    if (gain === 0 || frequency >= nyquist * 0.92) return;
    // A shelf reaches only half its gain at its corner. The end bands' corners
    // sit a little inside the range, so the slider's full gain is heard at the
    // frequency printed under it and there is no dip beside the next band.
    if (index === 0) stages.push(shelf("low", frequency * 1.5, gain, sampleRate));
    else if (index === last) stages.push(shelf("high", frequency / 1.3, gain, sampleRate));
    else stages.push(peak(frequency, gain, bandQ(index), sampleRate));
  });
  const preamp = 10 ** (curve.preamp / 20);
  // Transposed direct form II state, two values per stage.
  const state = new Float64Array(stages.length * 2);
  let carry: Buffer | undefined;

  return {
    bypass: false,
    process(pcm) {
      let input = carry ? Buffer.concat([carry, pcm]) : pcm;
      carry = undefined;
      if (input.length % 2 === 1) {
        carry = Buffer.from(input.subarray(input.length - 1));
        input = input.subarray(0, input.length - 1);
      }
      const output = Buffer.allocUnsafe(input.length);
      for (let offset = 0; offset < input.length; offset += 2) {
        let sample = (input.readInt16LE(offset) / 32768) * preamp;
        for (let index = 0; index < stages.length; index += 1) {
          const c = stages[index]!;
          const z = index * 2;
          const filtered = c.b0 * sample + state[z]!;
          state[z] = c.b1 * sample - c.a1 * filtered + state[z + 1]!;
          state[z + 1] = c.b2 * sample - c.a2 * filtered;
          sample = filtered;
        }
        const out = Math.round(limit(sample) * 32767);
        output.writeInt16LE(Math.max(-32768, Math.min(32767, out)), offset);
      }
      return output;
    }
  };
}

/** What `/health` reports so clients can offer the equaliser. */
export function equalizerOptions(defaults: VoiceEqualizer | undefined, adjustable: boolean): VoiceEqualizerOptions {
  return {
    default: defaults ?? { preset: "flat" },
    presets: EQUALIZER_PRESETS.map((entry) => ({ ...entry, bands: [...entry.bands] })),
    frequencies: [...EQUALIZER_FREQUENCIES],
    adjustable
  };
}
