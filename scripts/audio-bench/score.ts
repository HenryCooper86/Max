import { createVad } from "../../server/providers/live/pipeline";
import { BENCH_RATE, decibels, power, toPcm16 } from "./wav";

const FRAME = BENCH_RATE / 50; // 20 ms

/** When the relay's own speech detector fired on a recording, in samples. */
type Detections = { starts: number[]; ends: number[] };

/**
 * Runs a recording through the same speech detector the relay uses for its
 * speech-to-text backends, frame by frame as a device would send it.
 */
function detectSpeech(samples: Float32Array): Detections {
  const starts: number[] = [];
  const ends: number[] = [];
  let position = 0;
  const vad = createVad({ onStart: () => starts.push(position), onEnd: () => ends.push(position) });
  const pcm = toPcm16(samples);
  for (let offset = 0; offset + FRAME * 2 <= pcm.length; offset += FRAME * 2) {
    position = offset / 2 + FRAME;
    vad.push(pcm.subarray(offset, offset + FRAME * 2));
  }
  return { starts, ends };
}

export type DetectionScore = {
  /** The detector fired while the wearer was speaking. */
  detected: boolean;
  /** Milliseconds from the first sound of speech to the detector firing. */
  onsetDelayMs: number | null;
  /** Milliseconds from the last sound of speech to the detector letting go. */
  releaseDelayMs: number | null;
  /** Times the detector fired on noise alone, before or after the speech. */
  falseStarts: number;
};

const ms = (samples: number) => Math.round((samples / BENCH_RATE) * 1000);

/** Scores the detector against where the speech really was. */
export function scoreDetection(samples: Float32Array, onset: number, offset: number): DetectionScore {
  const { starts, ends } = detectSpeech(samples);
  // A start shortly before the true onset is the detector catching a breath
  // or the pre-roll; one well before it, or after the speech, is a false start.
  const early = Math.round(0.15 * BENCH_RATE);
  const real = starts.find((start) => start >= onset - early && start <= offset);
  const falseStarts = starts.filter((start) => start < onset - early || start > offset).length;
  const release = real === undefined ? undefined : ends.find((end) => end > real);
  return {
    detected: real !== undefined,
    onsetDelayMs: real === undefined ? null : Math.max(0, ms(real - onset)),
    releaseDelayMs: release === undefined ? null : ms(release - offset),
    falseStarts
  };
}

export type EchoScore = {
  /** Level of the echo at the microphone, dB relative to full scale. */
  echoDbfs: number;
  /** Times the relay's detector took the echo for the wearer speaking. */
  falseInterruptions: number;
  /** How much the echo canceller removed, when a recording without it was given. */
  erleDb?: number;
  /** How far the wearer's voice stands above the echo, when a voice recording was given. */
  speechOverEchoDb?: number;
};

/**
 * Scores a recording of the device's microphone while the assistant talks and
 * nobody else does. What matters most is `falseInterruptions`: each one is a
 * moment the assistant would have stopped itself mid-sentence.
 */
export function scoreEcho(echo: Float32Array, raw?: Float32Array, speech?: Float32Array): EchoScore {
  const echoPower = power(echo);
  const score: EchoScore = {
    echoDbfs: Math.round(decibels(echoPower) * 10) / 10,
    falseInterruptions: detectSpeech(echo).starts.length
  };
  if (raw) score.erleDb = Math.round(decibels(power(raw) / Math.max(echoPower, 1e-12)) * 10) / 10;
  if (speech) score.speechOverEchoDb = Math.round(decibels(power(speech) / Math.max(echoPower, 1e-12)) * 10) / 10;
  return score;
}

const CJK = /[㐀-鿿぀-ヿ가-힯]/;

/** Words for spaced languages, characters for Chinese, Japanese and Korean. */
export function tokens(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ");
  const out: string[] = [];
  for (const word of cleaned.split(/\s+/).filter(Boolean)) {
    if (CJK.test(word)) out.push(...Array.from(word).filter((char) => char.trim()));
    else out.push(word);
  }
  return out;
}

/**
 * Recognition error rate: the edits needed to turn what was recognised into
 * what was said, over the length of what was said. 0 is perfect; it can pass
 * 1 when the recogniser invents more than was spoken.
 */
export function errorRate(said: string, recognised: string): number {
  const reference = tokens(said);
  const hypothesis = tokens(recognised);
  if (!reference.length) return hypothesis.length ? 1 : 0;
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      const substitution = previous[column - 1]! + (reference[row - 1] === hypothesis[column - 1] ? 0 : 1);
      current[column] = Math.min(substitution, previous[column]! + 1, current[column - 1]! + 1);
    }
    previous = current;
  }
  return previous[hypothesis.length]! / reference.length;
}

/** Rule-of-thumb limits. They are starting points, not a standard: tighten
 *  or loosen them for your product in docs/audio/test-bench.md's terms. */
export const LIMITS = {
  onsetDelayMs: { good: 250, usable: 450 },
  errorRate: { good: 0.1, usable: 0.25 },
  erleDb: { good: 25, usable: 15 }
} as const;

export type Verdict = "good" | "usable" | "poor";

export function verdictAtMost(value: number, limit: { good: number; usable: number }): Verdict {
  return value <= limit.good ? "good" : value <= limit.usable ? "usable" : "poor";
}

export function verdictAtLeast(value: number, limit: { good: number; usable: number }): Verdict {
  return value >= limit.good ? "good" : value >= limit.usable ? "usable" : "poor";
}
