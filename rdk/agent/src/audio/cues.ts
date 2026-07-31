/**
 * Locally synthesized signal tones for the poweroff countdown.
 *
 * Tones, not speech, on purpose: the deterministic spoken confirmations need
 * `DOUBAO_TTS_*` credentials the relay does not have, and the model's chatter
 * has already narrated a recording that never happened. A tone generated on
 * the board cannot be faked and cannot go missing with a credential.
 *
 * Everything goes through `playback.write`, never a separate aplay — that
 * path carries the soft limiter, the pacing, and the AEC reference tap. See
 * alert-player.ts for what routing around it cost.
 */

/** playback.write consumes 24 kHz PCM16. */
export const CUE_RATE = 24_000;

/** 20 ms at 24 kHz — the cadence the relay delivers speech in, and the unit
 *  the playback pacing was measured with. */
const CHUNK_SAMPLES = 480;

/** Loud enough for a helmet speaker, far enough from full scale that the
 *  soft limiter has nothing to catch. */
const AMPLITUDE = 9_000;

/** 5 ms raised-cosine fade at each edge, so a tone cannot click. */
const FADE_SAMPLES = Math.round(CUE_RATE * 0.005);

export type CueKind = "armed" | "tick" | "final" | "cancelled";

function tone(freqHz: number, ms: number): Int16Array {
  const samples = new Int16Array(Math.round((CUE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    let gain = 1;
    if (i < FADE_SAMPLES) gain = (1 - Math.cos((Math.PI * i) / FADE_SAMPLES)) / 2;
    const fromEnd = samples.length - 1 - i;
    if (fromEnd < FADE_SAMPLES) gain = Math.min(gain, (1 - Math.cos((Math.PI * fromEnd) / FADE_SAMPLES)) / 2);
    samples[i] = Math.round(AMPLITUDE * gain * Math.sin((2 * Math.PI * freqHz * i) / CUE_RATE));
  }
  return samples;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((CUE_RATE * ms) / 1000));
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Each kind is a distinct, recognisable figure — the rider learns them fast:
 *  armed = three urgent beeps, tick = one short blip, final = one long low
 *  tone, cancelled = a rising pair ("all clear"). */
export function cuePcm(kind: CueKind): Int16Array {
  switch (kind) {
    case "armed":
      return concat([tone(880, 120), silence(80), tone(880, 120), silence(80), tone(880, 120)]);
    case "tick":
      return tone(660, 80);
    case "final":
      return tone(440, 600);
    case "cancelled":
      return concat([tone(660, 120), silence(60), tone(880, 160)]);
  }
}

/** Hands one cue to playback in 20 ms chunks, matching how relay speech
 *  arrives, so the pacing guarantee (and with it the AEC reference) holds. */
export function writeCue(playback: { write(pcm: Int16Array): void }, kind: CueKind): void {
  const pcm = cuePcm(kind);
  for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
    playback.write(pcm.subarray(offset, Math.min(offset + CHUNK_SAMPLES, pcm.length)));
  }
}
