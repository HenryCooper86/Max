import { spawn as nodeSpawn } from "node:child_process";
import { CAPTURE_RATE, applySoftLimit, createUpsampler2x } from "./dsp";
import type { ChildProcessLike, SpawnLike } from "./capture";

/**
 * 120 ms at 48 kHz. `aplay`'s ALSA buffer cannot be drained from outside the
 * process, so this cap is what bounds the residual tail when the rider barges
 * in — the default (~500 ms) would leave Max talking over them for half a
 * second, which the other three clients never do.
 */
const BUFFER_FRAMES = 5_760;

export type PlaybackOptions = {
  device: string;
  spawn?: SpawnLike;
  gain?: number;
  threshold?: number;
  /** Far-end reference for AEC. Fed the post-limiter signal — see the spec. */
  reference?: { write(pcm: Int16Array): void; flush(): void; close(): void };
  /** Injectable for tests. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
};

export type Playback = {
  write(pcm: Int16Array, rank?: number): boolean;
  flush(rank?: number): void;
  holdPriority(rank?: number): void;
  releasePriority(): void;
  priorityRank(): number;
  stop(): void;
};

/**
 * How far ahead of the DAC audio is allowed to sit in aplay's stdin pipe.
 *
 * This exists because of a measurement, not a guess. Writing relay audio
 * straight through parked it in a 64 KB pipe — 683 ms at 48 kHz — on top of the
 * 120 ms ALSA buffer, so the echo reached the mic 953 ms after the reference
 * had been handed to APM. WebRTC's filter reaches ~500 ms at best, so it saw no
 * echo at all: it reported ERLE -100 dB and removed 1-2 dB. Capping the queue
 * puts the round trip back inside the filter's reach.
 */
const MAX_QUEUE_MS = 80;

/** How often the pump tops aplay up. Small enough to keep the buffer fed. */
const PUMP_MS = 10;

export function playbackArgs(device: string): string[] {
  return [
    "-D",
    device,
    "-f",
    "S16_LE",
    "-r",
    String(CAPTURE_RATE),
    "-c",
    "1",
    "-t",
    "raw",
    "--buffer-size",
    String(BUFFER_FRAMES),
    "-q"
  ];
}

export function createPlayback(options: PlaybackOptions): Playback {
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args) as unknown as ChildProcessLike);
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  let child: ChildProcessLike | null = null;
  let upsample = createUpsampler2x();

  // Audio waiting to be handed to aplay, and the wall-clock time at which
  // everything already handed over finishes playing.
  let queue: Array<{ pcm: Int16Array; rank: number }> = [];
  let drainedUntil = 0;
  let pumping = false;
  // While a hazard alert is playing, voice may never cut it off — but a
  // strictly-higher-severity alert may (decision 2026-08-01: a critical
  // forward-collision must not queue behind a caution clip's audible tail).
  // The rank is meaningful only while the hold is set.
  let priorityHeld = false;
  let heldRank = 0;
  // Samples sitting in `queue`, not yet handed to aplay. Counted at 48 kHz
  // post-upsample, same as drainedUntil, so the two combine into one duration.
  let queuedSamples = 0;
  // Incremented by holdPriority/stop so a scheduled release from a previous
  // alert can recognise itself as stale and do nothing.
  let releaseGeneration = 0;
  let referenceResetGeneration = 0;
  // Synchronous AlertPlayer calls normally nest only through injected I/O
  // callbacks. Keeping those acquisitions explicit lets an ignored lower
  // alert's finally-release be a true no-op instead of unlocking the hazard
  // that rejected it.
  const holdClaims: Array<{ accepted: boolean; rank: number }> = [];

  function normalizedRank(rank: number | undefined, omitted: number): number {
    if (rank === undefined) return omitted;
    return rank === 0 || rank === 1 || rank === 2 ? rank : 0;
  }

  function suppressed(rank: number): boolean {
    return priorityHeld && rank < heldRank;
  }

  function discardSuppressedQueue(): void {
    if (!priorityHeld || queue.length === 0) return;
    const kept: Array<{ pcm: Int16Array; rank: number }> = [];
    let keptSamples = 0;
    for (const chunk of queue) {
      if (chunk.rank < heldRank) continue;
      kept.push(chunk);
      keptSamples += chunk.pcm.length;
    }
    queue = kept;
    queuedSamples = keptSamples;
  }

  function resetReference(): void {
    options.reference?.flush();
    referenceResetGeneration += 1;
  }

  function pump(): void {
    pumping = false;
    discardSuppressedQueue();
    if (queue.length === 0) return;
    const target = ensure();
    const at = now();
    if (drainedUntil < at) drainedUntil = at;

    while (queue.length > 0 && drainedUntil - at < MAX_QUEUE_MS) {
      discardSuppressedQueue();
      const queued = queue.shift();
      if (!queued) break;
      const { pcm: chunk, rank } = queued;
      queuedSamples -= chunk.length;
      if (suppressed(rank)) continue;
      // The reference goes out here, alongside the write to the DAC, so APM is
      // told about audio when it plays rather than when it was received.
      const resetBeforeWrite = referenceResetGeneration;
      options.reference?.write(chunk);
      if (suppressed(rank)) {
        // AlertPlayer normally flushed before taking its hold. If a hold began
        // directly inside the reference callback, add the same in-band reset
        // so APM never models PCM that the DAC did not receive.
        if (referenceResetGeneration === resetBeforeWrite) resetReference();
        continue;
      }
      target.stdin?.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      drainedUntil += (chunk.length / CAPTURE_RATE) * 1000;
    }

    if (queue.length > 0 && !pumping) {
      pumping = true;
      schedule(pump, PUMP_MS);
    }
  }

  function ensure(): ChildProcessLike {
    if (!child) {
      const spawned = spawn("aplay", playbackArgs(options.device));
      child = spawned;
      // Barge-in SIGKILLs this child, so a write already in flight lands on a
      // dead pipe. Node raises 'error' on the stdin socket, and with no listener
      // that is an unhandled 'error' event — which crashed the agent the first
      // time a rider actually talked over Max. EPIPE here is expected and
      // discardable: the next write respawns aplay.
      spawned.stdin?.on("error", () => {});
      // flush()/stop() null `child` before this event can arrive, so reaching
      // the body means the death was uninvited — an ALSA hiccup, an OOM kill.
      // Respawn-on-next-write is the already-designed path; take it.
      spawned.on("exit", (code, signal) => {
        if (child !== spawned) return;
        console.log(`[playback] aplay exited code=${code} signal=${signal}; respawning on next write`);
        child = null;
      });
      spawned.on("error", (error) => {
        if (child !== spawned) return;
        console.log(`[playback] aplay failed to start: ${error.message}`);
        child = null;
      });
      upsample = createUpsampler2x();
    }
    return child;
  }

  return {
    /** Accepts 24 kHz PCM16 from the relay. */
    write(pcm: Int16Array, rank?: number): boolean {
      const effectiveRank = normalizedRank(rank, 0);
      if (suppressed(effectiveRank)) return false;
      ensure();
      // spawn() is injectable and can reenter alert handling. Once a higher
      // hold exists, this write must stop before it mutates DSP or the queue.
      if (suppressed(effectiveRank)) return false;
      // Post-limiter, so the canceller models exactly what the DAC receives.
      // Tapping before it would hide the limiter's non-linearity from a filter
      // that assumes the echo path is linear, and cancellation would fall apart
      // precisely when Max is loudest.
      const processed = applySoftLimit(upsample(pcm), options.gain, options.threshold);
      queue.push({ pcm: processed, rank: effectiveRank });
      queuedSamples += processed.length;
      pump();
      return true;
    },

    /**
     * Barge-in. Killing the child is what actually discards the queued tail;
     * the next write respawns it.
     */
    flush(rank = 0): void {
      rank = normalizedRank(rank, 0);
      // A hazard alert is playing. Doubao's VAD fires on the rider reacting to
      // it — "什么?" mid-warning — and honouring that would cut the collision
      // alert in half. Voice flushes carry no rank and never pass; only an
      // alert that strictly outranks the playing one cuts its tail.
      if (priorityHeld && rank <= heldRank) return;
      // Before the kill, not after: the reset marker must sit in the reference
      // pipe behind the audio it invalidates. Everything already queued is
      // about to be discarded unheard, and APM has to forget exactly that much
      // or it spends the rider's interruption subtracting an echo that never
      // reached the speaker.
      // Audio still queued here was never handed to aplay, so it will never be
      // heard and APM must not be told about it.
      queue = [];
      queuedSamples = 0;
      drainedUntil = 0;
      resetReference();
      // The reference sink is an injected boundary and may synchronously
      // start an alert. Reapply strict-higher-only preemption before killing
      // the child so an older rank-0 flush cannot cut that new hazard.
      if (priorityHeld && rank <= heldRank) return;
      child?.kill("SIGKILL");
      child = null;
    },

    holdPriority(rank?: number): void {
      const effectiveRank = normalizedRank(rank, 1);
      if (priorityHeld && effectiveRank < heldRank) {
        holdClaims.push({ accepted: false, rank: effectiveRank });
        discardSuppressedQueue();
        return;
      }
      if (priorityHeld && effectiveRank > heldRank) {
        for (const claim of holdClaims) {
          if (claim.accepted && claim.rank < effectiveRank) claim.accepted = false;
        }
      }
      releaseGeneration += 1;
      priorityHeld = true;
      heldRank = effectiveRank;
      holdClaims.push({ accepted: true, rank: effectiveRank });
      discardSuppressedQueue();
    },

    /**
     * Deferred: the lock lifts when the audio queued *at this moment* — the
     * alert — has audibly finished, not when it was merely enqueued. Audio
     * queued after this call (Max resuming) does not extend the hold.
     */
    releasePriority(): void {
      const claim = holdClaims.pop();
      if (!claim?.accepted || !priorityHeld || claim.rank !== heldRank) return;
      if (holdClaims.some((candidate) => candidate.accepted)) return;
      const ownerGeneration = releaseGeneration;
      let at: number;
      try {
        at = now();
      } catch {
        at = Date.now();
      }
      if (releaseGeneration !== ownerGeneration || !priorityHeld || heldRank !== claim.rank) return;
      const remainingMs = Math.max(0, drainedUntil - at) + (queuedSamples / CAPTURE_RATE) * 1000;
      if (remainingMs <= 0) {
        releaseGeneration += 1;
        priorityHeld = false;
        heldRank = 0;
        return;
      }
      releaseGeneration += 1;
      const generation = releaseGeneration;
      try {
        schedule(() => {
          if (releaseGeneration !== generation) return;
          priorityHeld = false;
          heldRank = 0;
        }, remainingMs);
      } catch {
        if (releaseGeneration === generation) {
          priorityHeld = false;
          heldRank = 0;
        }
      }
    },

    priorityRank(): number {
      return priorityHeld ? heldRank : 0;
    },

    /** Process teardown, not barge-in: this ignores the priority lock. */
    stop(): void {
      priorityHeld = false;
      heldRank = 0;
      releaseGeneration += 1;
      holdClaims.length = 0;
      queue = [];
      queuedSamples = 0;
      drainedUntil = 0;
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
