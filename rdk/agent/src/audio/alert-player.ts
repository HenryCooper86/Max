/**
 * Plays a pre-rendered hazard clip with absolute priority.
 *
 * Audio goes through `playback.write`, never a separate aplay. That path
 * already carries the soft limiter, the pacing, and — critically — the AEC
 * reference tap. An alert leaves the same speaker and enters the same
 * microphone as Max's voice, so if APM is not told about it, the mic hears an
 * uncancelled warning, Doubao's VAD fires on it, and the echo loop returns:
 * triggered by our own safety alert. See the AEC section of rdk/README.md for
 * what that cost the last time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** playback.write consumes 24 kHz PCM16, so clips must be rendered at that rate. */
export const ALERT_RATE = 24_000;

/** 20 ms at 24 kHz — the cadence the relay delivers speech in. */
const CHUNK_SAMPLES = 480;

export type AlertPlayback = {
  write(pcm: Int16Array, rank?: number): boolean;
  flush(rank?: number): void;
  holdPriority(rank?: number): void;
  releasePriority(): void;
};

/** Severity → preemption rank. A strictly higher rank cuts a playing alert's
 *  audible tail (decision 2026-08-01); equal severity queues behind it, and a
 *  severity this map does not know sinks to caution — an unrecognised string
 *  must never outrank a real critical. */
const SEVERITY_RANK: Record<string, number> = { caution: 1, critical: 2 };

export type AlertPlayerOptions = {
  dir: string;
  playback: AlertPlayback;
  now?: () => number;
};

/**
 * Reads a clip, or throws describing what is wrong with it.
 *
 * The chunk list is walked rather than read at the canonical offsets 22/24/34
 * and 44. Those offsets are only right for a WAV with nothing between `fmt `
 * and `data`, which is true of `tools/render_alerts.py` today and of nothing
 * else in particular: an encoder that stamps a LIST/INFO chunk shifts the
 * payload, and every fixed offset then lands inside metadata. Measured against
 * a 480-sample clip carrying a 64-byte LIST, the old parse returned 516
 * "samples" of chunk header — noise the rider would have been taught to read
 * as a collision warning. Refusing a file we cannot parse is the same ruling
 * as `play()`'s: silence beats a sound that does not mean what it should.
 */
export function readWavMono24k(path: string): Int16Array {
  const buffer = readFileSync(path);
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let channels: number | undefined;
  let rate: number | undefined;
  let bits: number | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    // A size past the end of the file is a truncated or lying chunk. Stop
    // rather than reading whatever memory the subarray would cover.
    if (size > buffer.length - body) break;
    if (id === "fmt " && size >= 16) {
      channels = buffer.readUInt16LE(body + 2);
      rate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buffer.subarray(body, body + size);
    }
    // RIFF chunks are word-aligned: an odd size carries a pad byte.
    at = body + size + (size % 2);
  }

  if (rate === undefined || channels === undefined || bits === undefined) {
    throw new Error(`${path}: no fmt chunk`);
  }
  if (rate !== ALERT_RATE) {
    throw new Error(`${path}: expected ${ALERT_RATE} Hz, got ${rate}`);
  }
  if (channels !== 1) {
    throw new Error(`${path}: expected mono, got ${channels} channels`);
  }
  if (bits !== 16) {
    throw new Error(`${path}: expected 16-bit, got ${bits}-bit`);
  }
  if (data === undefined) {
    throw new Error(`${path}: no data chunk`);
  }

  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2);
  return samples;
}

export function createAlertPlayer(options: AlertPlayerOptions): {
  /** Resolves the milliseconds it took to HAND the clip to playback. Not time-to-audible: pacing drains the queue at 80 ms per cycle after this returns. */
  play(threat: string, severity?: string): Promise<number | null>;
} {
  const now = options.now ?? (() => Date.now());

  return {
    async play(threat: string, severity?: string): Promise<number | null> {
      const path = join(options.dir, `${threat}.wav`);
      if (!existsSync(path)) {
        console.log(`[adas] no clip for ${threat}; staying silent`);
        return null;
      }

      let pcm: Int16Array;
      try {
        pcm = readWavMono24k(path);
      } catch (error) {
        // Half-playing a malformed clip is worse than silence: the rider would
        // learn a sound that does not mean what they think it means.
        console.log(`[adas] unusable clip for ${threat}: ${(error as Error).message}`);
        return null;
      }

      const started = now();
      const rank = SEVERITY_RANK[severity ?? ""] ?? SEVERITY_RANK.caution;
      // Preempt first, then take the lock. Holding first would make our own
      // flush a no-op against our own lock, and Max would talk over the
      // warning. The rank rides both calls: the flush cuts only a playing
      // alert it strictly outranks, and the hold defends this clip at its
      // own level.
      options.playback.flush(rank);
      options.playback.holdPriority(rank);
      let acceptedAny = false;
      try {
        for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
          if (options.playback.write(pcm.subarray(offset, offset + CHUNK_SAMPLES), rank)) acceptedAny = true;
        }
      } catch (error) {
        console.log(`[adas] alert playback failed for ${threat}: ${(error as Error).message}`);
        return null;
      } finally {
        // Always: a stuck lock would silence Max for the rest of the ride.
        options.playback.releasePriority();
      }
      return acceptedAny ? now() - started : null;
    }
  };
}
