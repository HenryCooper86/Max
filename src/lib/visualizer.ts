// The live voice display's styles and the spectrum that drives them. Like a
// media player's visualiser: one signal, several looks. The spectrum comes
// from a real AnalyserNode when the app has one with sound on it (the
// wearer's microphone, or the assistant's PCM playback), and is otherwise
// synthesised from the session state and the microphone level, so every
// style animates in every state, in tests, and with browser TTS.

import type { VoiceVisualizer } from "../../shared/agent";

type Bilingual = { zh: string; en: string };

export const VISUALIZERS: ReadonlyArray<{ id: VoiceVisualizer; label: Bilingual }> = [
  { id: "wave", label: { zh: "波形", en: "Wave" } },
  { id: "bars", label: { zh: "频谱", en: "Bars" } },
  { id: "mirror", label: { zh: "镜像", en: "Mirror" } },
  { id: "dots", label: { zh: "点阵", en: "Dots" } },
  { id: "ring", label: { zh: "环形", en: "Ring" } }
];

const DEFAULT_VISUALIZER: VoiceVisualizer = "wave";
const IDS = new Set<string>(VISUALIZERS.map((entry) => entry.id));

export function isVisualizer(value: unknown): value is VoiceVisualizer {
  return typeof value === "string" && IDS.has(value);
}

/** Default → relay assistant.visualizer → the viewer's own choice, which is
 *  ignored when the owner pinned the look (templateSwitching === false). */
export function resolveVisualizer(input: {
  relay?: unknown;
  viewer?: unknown;
  templateSwitching?: boolean;
}): VoiceVisualizer {
  if (input.templateSwitching !== false && isVisualizer(input.viewer)) return input.viewer;
  return isVisualizer(input.relay) ? input.relay : DEFAULT_VISUALIZER;
}

/** What the lens shows; mirrors VisorVisual's modes. */
export type SpectrumMode = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "offline";

/** Bars across the lens. */
export const SPECTRUM_BINS = 24;

function bump(x: number, center: number, width: number): number {
  return Math.exp(-((x - center) ** 2) / (2 * width ** 2));
}

/** A speech-like envelope over the bins: strong low formants, a presence
 *  hump, little at the top. */
function voiceEnvelope(x: number): number {
  return 0.12 + 0.62 * bump(x, 0.16, 0.1) + 0.46 * bump(x, 0.38, 0.12) + 0.28 * bump(x, 0.62, 0.1);
}

/** Per-bin wobble 0…1, deterministic in (bin, time) so frames are smooth. */
function wobble(index: number, t: number, speed: number): number {
  const rate = speed * (0.7 + ((index * 37) % 11) / 10);
  const phase = (index * 2.399) % (Math.PI * 2);
  return 0.5 + 0.25 * Math.sin(t * rate + phase) + 0.25 * Math.sin(t * rate * 1.73 + phase * 2.1);
}

const clamp01 = (value: number) => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/**
 * A plausible spectrum for `mode` at time `t` (seconds), written into `out`
 * (every value 0…1). `level` is the live microphone level (0…1) and scales
 * the listening state. Each state has its own character: idle and ready
 * breathe low, connecting sweeps across, listening follows the voice,
 * speaking is full and rhythmic, thinking drifts a single hump, offline is
 * flat.
 */
export function synthesizeSpectrum(out: Float32Array, mode: SpectrumMode, level: number, t: number): Float32Array {
  const n = out.length;
  const voice = clamp01(Number.isFinite(level) ? level : 0);
  for (let i = 0; i < n; i += 1) {
    const x = n > 1 ? i / (n - 1) : 0;
    let value: number;
    switch (mode) {
      case "speaking": {
        const syllable = 0.55 + 0.45 * Math.abs(Math.sin(t * 5.3 + Math.sin(t * 1.7)));
        value = voiceEnvelope(x) * (0.5 + 0.5 * wobble(i, t, 7)) * syllable;
        break;
      }
      case "listening": {
        const amplitude = 0.1 + Math.min(1, voice * 2.4) * 0.85;
        value = voiceEnvelope(x) * amplitude * (0.55 + 0.45 * wobble(i, t, 6));
        break;
      }
      case "connecting": {
        const center = ((t * 0.65) % 1.3) - 0.15;
        value = 0.05 + 0.55 * bump(x, center, 0.07);
        break;
      }
      case "thinking":
        value = 0.04 + 0.2 * bump(x, 0.5 + 0.32 * Math.sin(t * 1.4), 0.12);
        break;
      case "ready":
        value = 0.05 + 0.1 * voiceEnvelope(x) * wobble(i, t, 1.6);
        break;
      case "idle":
        value = 0.03 + 0.07 * voiceEnvelope(x) * wobble(i, t, 0.8);
        break;
      default:
        value = 0.02;
    }
    out[i] = clamp01(value);
  }
  return out;
}

/** The analyser's band edges, log-spaced over the speech range. */
const LOW_HZ = 90;
const HIGH_HZ = 7000;

/**
 * Fold an AnalyserNode's frequency data into `out` (0…1 per bin, log-spaced
 * 90 Hz – 7 kHz). Returns the loudest bin so the caller can tell silence (no
 * PCM playing, a muted mic) from sound and fall back to synthesis.
 */
export function spectrumFromAnalyser(
  analyser: Pick<AnalyserNode, "frequencyBinCount" | "getByteFrequencyData" | "context">,
  scratch: Uint8Array<ArrayBuffer>,
  out: Float32Array
): number {
  analyser.getByteFrequencyData(scratch);
  const nyquist = analyser.context.sampleRate / 2;
  const count = analyser.frequencyBinCount;
  let loudest = 0;
  for (let i = 0; i < out.length; i += 1) {
    const from = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / out.length);
    const to = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((i + 1) / out.length);
    const start = Math.min(count - 1, Math.floor((from / nyquist) * count));
    const end = Math.max(start + 1, Math.min(count, Math.ceil((to / nyquist) * count)));
    let sum = 0;
    for (let bin = start; bin < end; bin += 1) sum += scratch[bin] ?? 0;
    const value = clamp01(sum / (end - start) / 255);
    out[i] = value;
    if (value > loudest) loudest = value;
  }
  return loudest;
}

/** Below this the analyser is treated as silent. */
export const ANALYSER_SILENCE = 0.06;

/** Peak caps that jump up with the signal and fall back slowly, like a
 *  classic media-player analyser. `dt` in seconds. */
export function updatePeaks(peaks: Float32Array, values: Float32Array, dt: number, fallPerSecond = 0.55): void {
  const fall = Math.max(0, dt) * fallPerSecond;
  for (let i = 0; i < peaks.length; i += 1) {
    const value = values[i] ?? 0;
    peaks[i] = Math.max(value, (peaks[i] ?? 0) - fall);
  }
}

/** Ease displayed values toward the target so bars rise fast and fall soft. */
export function smoothSpectrum(display: Float32Array, target: Float32Array, dt: number): void {
  const rise = 1 - Math.exp(-dt * 30);
  const fall = 1 - Math.exp(-dt * 9);
  for (let i = 0; i < display.length; i += 1) {
    const current = display[i] ?? 0;
    const next = target[i] ?? 0;
    display[i] = current + (next - current) * (next > current ? rise : fall);
  }
}

/** An AnalyserNode hung off `input` for the voice display, tuned to the
 *  speech range. Best-effort: a browser without analysers just gets the
 *  synthesised display. */
export function createVoiceAnalyser(context: BaseAudioContext, input: AudioNode): AnalyserNode | null {
  try {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    analyser.minDecibels = -88;
    analyser.maxDecibels = -22;
    input.connect(analyser);
    return analyser;
  } catch {
    return null;
  }
}
