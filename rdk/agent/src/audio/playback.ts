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
  type QueuedChunk = {
    pcm: Int16Array;
    rank: number;
    operation: number;
    outcome: "pending" | "accepted" | "rejected";
  };

  let queue: QueuedChunk[] = [];
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
  // Separate from alert-release ownership: this invalidates synchronous work
  // that captured a child or chunk before flush/stop/preemption/death.
  let operationGeneration = 0;
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

  function reject(chunk: QueuedChunk): void {
    if (chunk.outcome === "pending") chunk.outcome = "rejected";
  }

  function rejectQueue(): void {
    for (const chunk of queue) reject(chunk);
    queue = [];
    queuedSamples = 0;
  }

  function rejectQueueOwnedBy(operation: number): void {
    const kept: QueuedChunk[] = [];
    let keptSamples = 0;
    for (const chunk of queue) {
      if (chunk.operation === operation) {
        reject(chunk);
        continue;
      }
      kept.push(chunk);
      keptSamples += chunk.pcm.length;
    }
    queue = kept;
    queuedSamples = keptSamples;
  }

  function discardSuppressedQueue(): void {
    if (!priorityHeld || queue.length === 0) return;
    const kept: QueuedChunk[] = [];
    let keptSamples = 0;
    for (const chunk of queue) {
      if (chunk.rank < heldRank) {
        reject(chunk);
        continue;
      }
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

  function ownsOperation(expected: number, target: ChildProcessLike, chunk?: QueuedChunk): boolean {
    return (
      operationGeneration === expected &&
      child === target &&
      (chunk === undefined || (chunk.outcome !== "rejected" && !suppressed(chunk.rank)))
    );
  }

  function pump(): void {
    pumping = false;
    discardSuppressedQueue();
    if (queue.length === 0) return;
    const expectedOperation = operationGeneration;
    const target = ensure();
    if (!ownsOperation(expectedOperation, target)) {
      discardSuppressedQueue();
      return;
    }
    const at = now();
    if (!ownsOperation(expectedOperation, target)) {
      discardSuppressedQueue();
      return;
    }
    discardSuppressedQueue();
    if (queue.length === 0) return;
    if (drainedUntil < at) drainedUntil = at;

    while (queue.length > 0 && drainedUntil - at < MAX_QUEUE_MS) {
      discardSuppressedQueue();
      const queued = queue.shift();
      if (!queued) break;
      const { pcm: chunk } = queued;
      queuedSamples -= chunk.length;
      if (!ownsOperation(expectedOperation, target, queued)) {
        reject(queued);
        break;
      }
      // The reference goes out here, alongside the write to the DAC, so APM is
      // told about audio when it plays rather than when it was received.
      const resetBeforeWrite = referenceResetGeneration;
      try {
        options.reference?.write(chunk);
      } catch (error) {
        reject(queued);
        if (referenceResetGeneration === resetBeforeWrite) resetReference();
        throw error;
      }
      if (!ownsOperation(expectedOperation, target, queued)) {
        reject(queued);
        // AlertPlayer normally flushed before taking its hold. If a hold began
        // directly inside the reference callback, add the same in-band reset
        // so APM never models PCM that the DAC did not receive.
        if (referenceResetGeneration === resetBeforeWrite) resetReference();
        break;
      }
      const stdin = target.stdin;
      if (!stdin || !ownsOperation(expectedOperation, target, queued)) {
        reject(queued);
        if (referenceResetGeneration === resetBeforeWrite) resetReference();
        break;
      }
      try {
        stdin.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } catch (error) {
        reject(queued);
        if (referenceResetGeneration === resetBeforeWrite) resetReference();
        throw error;
      }
      queued.outcome = "accepted";
      // stdin.write is observable and may reenter flush/stop/child lifecycle.
      // The handoff remains accepted, but stale timing must not survive it.
      if (!ownsOperation(expectedOperation, target)) break;
      drainedUntil += (chunk.length / CAPTURE_RATE) * 1000;
    }

    if (queue.length > 0 && !pumping) {
      pumping = true;
      const scheduledOperation = operationGeneration;
      schedule(() => {
        if (operationGeneration !== scheduledOperation) return;
        pump();
      }, PUMP_MS);
    }
  }

  function ensure(): ChildProcessLike {
    if (!child) {
      const expectedOperation = operationGeneration;
      const spawned = spawn("aplay", playbackArgs(options.device));
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
        const invalidatedOperation = operationGeneration;
        if (child !== spawned || operationGeneration !== invalidatedOperation) return;
        rejectQueueOwnedBy(invalidatedOperation);
        drainedUntil = 0;
        pumping = false;
        operationGeneration += 1;
        child = null;
        console.log(`[playback] aplay exited code=${code} signal=${signal}; respawning on next write`);
      });
      spawned.on("error", (error) => {
        if (child !== spawned) return;
        const invalidatedOperation = operationGeneration;
        if (child !== spawned || operationGeneration !== invalidatedOperation) return;
        rejectQueueOwnedBy(invalidatedOperation);
        drainedUntil = 0;
        pumping = false;
        operationGeneration += 1;
        child = null;
        console.log(`[playback] aplay failed to start: ${error.message}`);
      });
      // spawn is an injected/external boundary. A synchronous stop/flush or a
      // reentrant write may have installed a newer owner before it returned.
      if (operationGeneration !== expectedOperation || child !== null) {
        spawned.kill("SIGTERM");
        return child ?? spawned;
      }
      child = spawned;
      upsample = createUpsampler2x();
    }
    return child;
  }

  return {
    /** Accepts 24 kHz PCM16 from the relay. */
    write(pcm: Int16Array, rank?: number): boolean {
      const effectiveRank = normalizedRank(rank, 0);
      if (suppressed(effectiveRank)) return false;
      const expectedOperation = operationGeneration;
      const target = ensure();
      // spawn() is injectable and can reenter alert handling. Once a higher
      // hold exists, this write must stop before it mutates DSP or the queue.
      if (!ownsOperation(expectedOperation, target) || suppressed(effectiveRank)) return false;
      // Post-limiter, so the canceller models exactly what the DAC receives.
      // Tapping before it would hide the limiter's non-linearity from a filter
      // that assumes the echo path is linear, and cancellation would fall apart
      // precisely when Max is loudest.
      const processed = applySoftLimit(upsample(pcm), options.gain, options.threshold);
      const queued: QueuedChunk = {
        pcm: processed,
        rank: effectiveRank,
        operation: expectedOperation,
        outcome: "pending"
      };
      queue.push(queued);
      queuedSamples += processed.length;
      pump();
      return queued.outcome !== "rejected";
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
      const flushOperation = ++operationGeneration;
      rejectQueue();
      drainedUntil = 0;
      resetReference();
      // The reference sink is an injected boundary and may synchronously
      // start an alert. Reapply strict-higher-only preemption before killing
      // the child so an older rank-0 flush cannot cut that new hazard.
      if (operationGeneration !== flushOperation || (priorityHeld && rank <= heldRank)) return;
      const target = child;
      child = null;
      target?.kill("SIGKILL");
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
      operationGeneration += 1;
      holdClaims.length = 0;
      rejectQueue();
      drainedUntil = 0;
      const target = child;
      child = null;
      target?.kill("SIGTERM");
    }
  };
}
