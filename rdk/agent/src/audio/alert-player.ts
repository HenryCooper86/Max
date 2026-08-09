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

export function readWavMono24k(path: string): Int16Array {
  const buffer = readFileSync(path);
  const channels = buffer.readUInt16LE(22);
  const rate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (rate !== ALERT_RATE) {
    throw new Error(`${path}: expected ${ALERT_RATE} Hz, got ${rate}`);
  }
  if (channels !== 1) {
    throw new Error(`${path}: expected mono, got ${channels} channels`);
  }
  if (bits !== 16) {
    throw new Error(`${path}: expected 16-bit, got ${bits}-bit`);
  }
  const bytes = buffer.subarray(44);
  const samples = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
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
