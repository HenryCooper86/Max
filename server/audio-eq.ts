import type { VoiceEqualizer, VoiceEqualizerOptions, VoiceEqualizerPreset } from "../shared/agent";

/**
 * Voice equaliser for the assistant's outgoing speech.
 *
 * Runs on the relay so it sounds the same everywhere, including on a board
 * that plays raw PCM and has no audio stack of its own. Four bands chosen for
 * speech rather than music, plus an overall gain:
 *
 *   bass      low shelf  180 Hz   body; the first thing to cut under wind noise
 *   mid       peak       1 kHz    fullness
 *   presence  peak       3 kHz    consonants — what makes speech intelligible
 *   treble    high shelf 7 kHz    air and sibilance
 *
 * Filters are standard biquads (RBJ audio-EQ cookbook) run in series over
 * 16-bit mono PCM. A soft limiter after the gain keeps boosted speech from
 * wrapping around into loud digital clicks.
 */

type Bands = Required<Omit<VoiceEqualizer, "preset">>;

const LIMIT_DB = 12;
const FLAT: Bands = { bass: 0, mid: 0, presence: 0, treble: 0, gain: 0 };

export const EQUALIZER_PRESETS: readonly VoiceEqualizerPreset[] = [
  { id: "flat", label: "Flat", description: "The voice as the backend produced it.", bands: FLAT },
  {
    id: "clarity",
    label: "Clarity",
    description: "Lifts consonants so speech is easier to follow.",
    bands: { bass: -2, mid: 0, presence: 4, treble: 2, gain: 0 }
  },
  {
    id: "wind",
    label: "Helmet · wind",
    description: "Cuts the lows that wind and engine noise mask, pushes the speech band through.",
    bands: { bass: -8, mid: -1, presence: 5, treble: 2, gain: 2 }
  },
  {
    id: "open-ear",
    label: "Open-ear glasses",
    description: "Adds the body that small open speakers lose.",
    bands: { bass: 6, mid: 1, presence: 2, treble: 0, gain: 0 }
  },
  {
    id: "warm",
    label: "Warm",
    description: "Softer and rounder, for quiet rooms and long listening.",
    bands: { bass: 3, mid: 0, presence: -1, treble: -3, gain: 0 }
  },
  {
    id: "quiet",
    label: "Quiet",
    description: "Lower and gentler, so people nearby are not disturbed.",
    bands: { bass: -1, mid: 0, presence: 1, treble: -2, gain: -5 }
  }
];

function clampDb(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(-LIMIT_DB, Math.min(LIMIT_DB, Math.round(value * 10) / 10));
}

/** Keeps only well-formed fields from untrusted input (config or a client).
 *  Returns undefined when nothing usable is left. */
export function normalizeEqualizer(raw: unknown): VoiceEqualizer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const result: VoiceEqualizer = {};
  if (typeof input.preset === "string" && EQUALIZER_PRESETS.some((preset) => preset.id === input.preset)) {
    result.preset = input.preset;
  }
  for (const band of ["bass", "mid", "presence", "treble", "gain"] as const) {
    const value = clampDb(input[band]);
    if (value !== undefined) result[band] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** The band gains a setting means: its preset's bands, overridden by any
 *  explicit values. */
export function equalizerBands(settings: VoiceEqualizer | undefined): Bands {
  const preset = EQUALIZER_PRESETS.find((candidate) => candidate.id === settings?.preset)?.bands ?? FLAT;
  return {
    bass: settings?.bass ?? preset.bass,
    mid: settings?.mid ?? preset.mid,
    presence: settings?.presence ?? preset.presence,
    treble: settings?.treble ?? preset.treble,
    gain: settings?.gain ?? preset.gain
  };
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
  const bands = equalizerBands(settings);
  const bypass = Object.values(bands).every((value) => value === 0);
  if (bypass) return { bypass: true, process: (pcm) => pcm };

  // A shelf above the Nyquist frequency is not a filter; skip it at low rates.
  const stages: Coefficients[] = [];
  if (bands.bass !== 0) stages.push(shelf("low", 180, bands.bass, sampleRate));
  if (bands.mid !== 0) stages.push(peak(1000, bands.mid, 0.9, sampleRate));
  if (bands.presence !== 0 && sampleRate > 7000) stages.push(peak(3000, bands.presence, 0.9, sampleRate));
  if (bands.treble !== 0 && sampleRate > 16_000) stages.push(shelf("high", 7000, bands.treble, sampleRate));
  const gain = 10 ** (bands.gain / 20);
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
        let sample = input.readInt16LE(offset) / 32768;
        for (let index = 0; index < stages.length; index += 1) {
          const c = stages[index]!;
          const z = index * 2;
          const filtered = c.b0 * sample + state[z]!;
          state[z] = c.b1 * sample - c.a1 * filtered + state[z + 1]!;
          state[z + 1] = c.b2 * sample - c.a2 * filtered;
          sample = filtered;
        }
        const out = Math.round(limit(sample * gain) * 32767);
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
    presets: EQUALIZER_PRESETS.map((preset) => ({ ...preset, bands: { ...preset.bands } })),
    adjustable
  };
}
