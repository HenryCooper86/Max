// The viewer's voice-equaliser choice and how it reaches the relay. The relay
// does the signal processing (AgentHealth.voice.equalizer describes what it
// offers); the client only picks settings, remembers them, and sends them in
// session.start. Everything is in dB, -12…12, in 1 dB steps.

import type { VoiceEqualizer, VoiceEqualizerOptions } from "../../shared/agent";

export const EQ_BANDS = ["bass", "mid", "presence", "treble", "gain"] as const;
export type EqBand = (typeof EQ_BANDS)[number];
export type EqBands = Record<EqBand, number>;

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

/** Centre (or corner) frequency of each tone band, in Hz. `gain` is flat. */
export const EQ_BAND_HZ: Record<Exclude<EqBand, "gain">, number> = {
  bass: 180,
  mid: 1000,
  presence: 3000,
  treble: 7000
};

const FLAT: EqBands = { bass: 0, mid: 0, presence: 0, treble: 0, gain: 0 };
const PRESET_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

/** A band value as the client stores and sends it: a finite number clamped
 *  to -12…12 and rounded to whole dB; anything else is undefined. */
export function clampDb(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, value)));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Normalise untrusted (stored or relay) equaliser settings: a plausible
 *  preset id plus clamped bands. Returns null when nothing usable is left. */
export function normalizeEqualizer(value: unknown): VoiceEqualizer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const clean: VoiceEqualizer = {};
  if (typeof source.preset === "string" && PRESET_ID.test(source.preset.trim())) clean.preset = source.preset.trim();
  for (const band of EQ_BANDS) {
    const db = clampDb(source[band]);
    if (db !== undefined) clean[band] = db;
  }
  return Object.keys(clean).length ? clean : null;
}

export type ResolvedEqualizer = {
  /** The preset in effect, or null for a custom curve. */
  preset: string | null;
  bands: EqBands;
};

function presetBands(options: VoiceEqualizerOptions | undefined, id: string | undefined): EqBands | null {
  const preset = id ? options?.presets.find((candidate) => candidate.id === id) : undefined;
  if (!preset) return null;
  const bands = { ...FLAT };
  for (const band of EQ_BANDS) bands[band] = clampDb(preset.bands[band]) ?? 0;
  return bands;
}

function overlay(base: EqBands, settings: VoiceEqualizer): { bands: EqBands; changed: boolean } {
  const bands = { ...base };
  let changed = false;
  for (const band of EQ_BANDS) {
    const db = clampDb(settings[band]);
    if (db === undefined) continue;
    if (db !== bands[band]) changed = true;
    bands[band] = db;
  }
  return { bands, changed };
}

function resolveAgainst(settings: VoiceEqualizer, base: ResolvedEqualizer, options?: VoiceEqualizerOptions) {
  const fromPreset = presetBands(options, settings.preset);
  const start = fromPreset ? { preset: settings.preset!, bands: fromPreset } : base;
  const { bands, changed } = overlay(start.bands, settings);
  return { preset: changed ? null : start.preset, bands };
}

/** What the relay's default sounds like: its default preset (if it names a
 *  known one) with any explicit default bands on top. */
export function resolveDefaultEqualizer(options: VoiceEqualizerOptions | undefined): ResolvedEqualizer {
  return resolveAgainst(normalizeEqualizer(options?.default) ?? {}, { preset: null, bands: { ...FLAT } }, options);
}

/** The curve a viewer's choice produces: a known preset sets every band,
 *  explicit bands override it (and then it is a custom curve). A choice that
 *  names a preset this relay does not offer, with no bands of its own, falls
 *  back to the relay default. */
export function resolveEqualizer(
  choice: VoiceEqualizer | null | undefined,
  options: VoiceEqualizerOptions | undefined
): ResolvedEqualizer {
  const fallback = resolveDefaultEqualizer(options);
  const settings = normalizeEqualizer(choice);
  if (!settings) return fallback;
  return resolveAgainst(settings, fallback, options);
}

/** The `equalizer` field for session.start, or undefined to leave it out:
 *  the relay must offer an adjustable equaliser and the viewer must have
 *  chosen something. A preset goes by id alone, so the relay applies its
 *  own (possibly finer than 1 dB) bands; a custom curve sends all five. */
export function equalizerForSession(
  choice: VoiceEqualizer | null | undefined,
  options: VoiceEqualizerOptions | undefined
): VoiceEqualizer | undefined {
  const settings = normalizeEqualizer(choice);
  if (!options?.adjustable || !settings) return undefined;
  const hasBands = EQ_BANDS.some((band) => settings[band] !== undefined);
  // A remembered preset this relay no longer offers means "no preference".
  if (!hasBands && !presetBands(options, settings.preset)) return undefined;
  const resolved = resolveEqualizer(settings, options);
  return resolved.preset ? { preset: resolved.preset } : { ...resolved.bands };
}

/** Approximate response in dB at `hz` for drawing the preview: a low shelf,
 *  two peaks and a high shelf, each a smooth bump in log-frequency, plus the
 *  flat gain. Display only — the relay's filters are the real thing. */
export function equalizerResponse(bands: EqBands, hz: number): number {
  const octaves = (center: number) => Math.log2(hz / center);
  const shelf = (center: number, direction: 1 | -1) => 1 / (1 + Math.exp(direction * 3 * octaves(center)));
  const peak = (center: number, width: number) => Math.exp(-(octaves(center) ** 2) / (2 * width ** 2));
  return (
    bands.gain +
    bands.bass * shelf(EQ_BAND_HZ.bass, 1) +
    bands.mid * peak(EQ_BAND_HZ.mid, 0.9) +
    bands.presence * peak(EQ_BAND_HZ.presence, 0.75) +
    bands.treble * shelf(EQ_BAND_HZ.treble, -1)
  );
}
