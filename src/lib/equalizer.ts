// The viewer's voice-equaliser choice and how it reaches the relay. The relay
// does the signal processing (AgentHealth.voice.equalizer describes what it
// offers): a classic ten-band graphic equaliser plus a preamp. The client
// only picks settings, remembers them, and sends them in session.start.
// Everything is in dB, -12…12, in 1 dB steps.

import {
  EQUALIZER_FREQUENCIES,
  type VoiceEqualizer,
  type VoiceEqualizerOptions,
  type VoiceEqualizerPreset
} from "../../shared/agent";

const EQ_BAND_COUNT = EQUALIZER_FREQUENCIES.length;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
/** The preset an "off" equaliser asks for. */
const FLAT_PRESET_ID = "flat";

const FLAT_BANDS: readonly number[] = Array.from({ length: EQ_BAND_COUNT }, () => 0);
const PRESET_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

/** A gain as the client stores and sends it: a finite number clamped to
 *  -12…12 and rounded to whole dB; anything else is undefined. */
export function clampDb(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, value)));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Exactly ten finite gains, clamped; anything else (the old five-band
 *  shape, a short array, a stray string) is null. */
export function normalizeBands(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EQ_BAND_COUNT) return null;
  const bands = value.map(clampDb);
  return bands.every((band): band is number => band !== undefined) ? bands : null;
}

/** Normalise untrusted (stored or relay) settings: a plausible preset id,
 *  ten clamped bands and a clamped preamp. Fields of the retired five-band
 *  shape are dropped, so an old stored setting normalises to null. */
export function normalizeEqualizer(value: unknown): VoiceEqualizer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const clean: VoiceEqualizer = {};
  if (typeof source.preset === "string" && PRESET_ID.test(source.preset.trim())) clean.preset = source.preset.trim();
  const bands = normalizeBands(source.bands);
  if (bands) clean.bands = bands;
  const preamp = clampDb(source.preamp);
  if (preamp !== undefined) clean.preamp = preamp;
  return Object.keys(clean).length ? clean : null;
}

function validPreset(value: unknown): VoiceEqualizerPreset | null {
  if (!value || typeof value !== "object") return null;
  const preset = value as Partial<VoiceEqualizerPreset>;
  const bands = normalizeBands(preset.bands);
  const preamp = clampDb(preset.preamp ?? 0);
  if (typeof preset.id !== "string" || !PRESET_ID.test(preset.id) || !bands || preamp === undefined) return null;
  return {
    id: preset.id,
    label: typeof preset.label === "string" && preset.label.trim() ? preset.label.trim().slice(0, 40) : preset.id,
    ...(typeof preset.description === "string" && preset.description.trim()
      ? { description: preset.description.trim().slice(0, 160) }
      : {}),
    bands,
    preamp
  };
}

/** The relay's equaliser offer in the ten-band shape, or undefined when it
 *  has none the client can use — an older relay still reporting five-band
 *  presets, or a malformed offer. Invalid presets are dropped; with none
 *  left the whole offer is unusable. */
export function usableEqualizerOptions(options: unknown): VoiceEqualizerOptions | undefined {
  if (!options || typeof options !== "object") return undefined;
  const source = options as Partial<VoiceEqualizerOptions>;
  const presets = Array.isArray(source.presets)
    ? source.presets.map(validPreset).filter((preset): preset is VoiceEqualizerPreset => preset !== null)
    : [];
  if (!presets.length) return undefined;
  const frequencies =
    Array.isArray(source.frequencies) &&
    source.frequencies.length === EQ_BAND_COUNT &&
    source.frequencies.every((hz) => typeof hz === "number" && Number.isFinite(hz) && hz > 0)
      ? [...source.frequencies]
      : [...EQUALIZER_FREQUENCIES];
  return {
    default: normalizeEqualizer(source.default) ?? {},
    presets,
    frequencies,
    adjustable: source.adjustable === true
  };
}

export type ResolvedEqualizer = {
  /** The preset in effect, or null for a custom curve. */
  preset: string | null;
  bands: number[];
  preamp: number;
};

const FLAT: ResolvedEqualizer = { preset: null, bands: [...FLAT_BANDS], preamp: 0 };

function findPreset(options: VoiceEqualizerOptions | undefined, id: string | undefined) {
  return id ? options?.presets.find((candidate) => candidate.id === id) : undefined;
}

function sameCurve(a: { bands: readonly number[]; preamp: number }, b: { bands: readonly number[]; preamp: number }) {
  return a.preamp === b.preamp && a.bands.every((band, index) => band === b.bands[index]);
}

function resolveAgainst(settings: VoiceEqualizer, base: ResolvedEqualizer, options?: VoiceEqualizerOptions) {
  const preset = findPreset(options, settings.preset);
  const start: ResolvedEqualizer = preset
    ? { preset: preset.id, bands: [...preset.bands], preamp: preset.preamp }
    : base;
  const bands = settings.bands ? [...settings.bands] : [...start.bands];
  const preamp = settings.preamp ?? start.preamp;
  const resolved = { bands, preamp };
  if (start.preset && sameCurve(resolved, start)) return { preset: start.preset, ...resolved };
  // A hand-made curve that lands exactly on a preset is that preset.
  const match = options?.presets.find((candidate) => sameCurve(resolved, candidate));
  return { preset: match?.id ?? null, ...resolved };
}

/** What the relay's default sounds like. */
export function resolveDefaultEqualizer(options: VoiceEqualizerOptions | undefined): ResolvedEqualizer {
  return resolveAgainst(normalizeEqualizer(options?.default) ?? {}, FLAT, options);
}

/** The curve a viewer's choice produces: a known preset sets every band;
 *  explicit bands and preamp override it (and then, unless they match a
 *  preset, it is a custom curve). A choice naming a preset this relay does
 *  not offer, with no bands of its own, falls back to the relay default. */
export function resolveEqualizer(
  choice: VoiceEqualizer | null | undefined,
  options: VoiceEqualizerOptions | undefined
): ResolvedEqualizer {
  const fallback = resolveDefaultEqualizer(options);
  const settings = normalizeEqualizer(choice);
  if (!settings) return fallback;
  return resolveAgainst(settings, fallback, options);
}

/** The `equalizer` field for session.start, or undefined to leave it out.
 *  The relay must offer an adjustable ten-band equaliser. Off asks for the
 *  flat preset; an untouched preset goes by id alone; a custom curve sends
 *  its ten bands and preamp. No choice means the relay default. */
export function equalizerForSession(
  choice: VoiceEqualizer | null | undefined,
  options: VoiceEqualizerOptions | undefined,
  enabled = true
): VoiceEqualizer | undefined {
  if (!options?.adjustable) return undefined;
  if (!enabled) {
    return findPreset(options, FLAT_PRESET_ID) ? { preset: FLAT_PRESET_ID } : { bands: [...FLAT_BANDS], preamp: 0 };
  }
  const settings = normalizeEqualizer(choice);
  if (!settings) return undefined;
  // A remembered preset this relay no longer offers means "no preference".
  if (!settings.bands && settings.preamp === undefined && !findPreset(options, settings.preset)) return undefined;
  const resolved = resolveEqualizer(settings, options);
  return resolved.preset ? { preset: resolved.preset } : { bands: resolved.bands, preamp: resolved.preamp };
}

/** Short frequency label: 60, 125, 1K, 9K. */
export function frequencyLabel(hz: number): string {
  return hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}K` : String(hz);
}

/** Signed dB with a true minus sign, for readouts. */
export function formatDb(db: number): string {
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db)} dB`;
}
