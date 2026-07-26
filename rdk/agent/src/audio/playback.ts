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

export function createPlayback(options: PlaybackOptions): {
  write(pcm: Int16Array): void;
  flush(): void;
  holdPriority(): void;
  releasePriority(): void;
  stop(): void;
} {
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args) as unknown as ChildProcessLike);
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  let child: ChildProcessLike | null = null;
  let upsample = createUpsampler2x();

  // Audio waiting to be handed to aplay, and the wall-clock time at which
  // everything already handed over finishes playing.
  let queue: Int16Array[] = [];
  let drainedUntil = 0;
  let pumping = false;
  // While a hazard alert is playing, nothing may cut it off. The spec makes
  // this absolute: an alert preempts Max and is never itself preempted.
  let priorityHeld = false;

  function pump(): void {
    pumping = false;
    const target = ensure();
    const at = now();
    if (drainedUntil < at) drainedUntil = at;

    while (queue.length > 0 && drainedUntil - at < MAX_QUEUE_MS) {
      const chunk = queue.shift() as Int16Array;
      // The reference goes out here, alongside the write to the DAC, so APM is
      // told about audio when it plays rather than when it was received.
      options.reference?.write(chunk);
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
      child = spawn("aplay", playbackArgs(options.device));
      // Barge-in SIGKILLs this child, so a write already in flight lands on a
      // dead pipe. Node raises 'error' on the stdin socket, and with no listener
      // that is an unhandled 'error' event — which crashed the agent the first
      // time a rider actually talked over Max. EPIPE here is expected and
      // discardable: the next write respawns aplay.
      child.stdin?.on("error", () => {});
      upsample = createUpsampler2x();
    }
    return child;
  }

  return {
    /** Accepts 24 kHz PCM16 from the relay. */
    write(pcm: Int16Array): void {
      ensure();
      // Post-limiter, so the canceller models exactly what the DAC receives.
      // Tapping before it would hide the limiter's non-linearity from a filter
      // that assumes the echo path is linear, and cancellation would fall apart
      // precisely when Max is loudest.
      queue.push(applySoftLimit(upsample(pcm), options.gain, options.threshold));
      pump();
    },

    /**
     * Barge-in. Killing the child is what actually discards the queued tail;
     * the next write respawns it.
     */
    flush(): void {
      // A hazard alert is playing. Doubao's VAD fires on the rider reacting to
      // it — "什么?" mid-warning — and honouring that would cut the collision
      // alert in half.
      if (priorityHeld) return;
      // Before the kill, not after: the reset marker must sit in the reference
      // pipe behind the audio it invalidates. Everything already queued is
      // about to be discarded unheard, and APM has to forget exactly that much
      // or it spends the rider's interruption subtracting an echo that never
      // reached the speaker.
      // Audio still queued here was never handed to aplay, so it will never be
      // heard and APM must not be told about it.
      queue = [];
      drainedUntil = 0;
      options.reference?.flush();
      child?.kill("SIGKILL");
      child = null;
    },

    holdPriority(): void {
      priorityHeld = true;
    },

    releasePriority(): void {
      priorityHeld = false;
    },

    /** Process teardown, not barge-in: this ignores the priority lock. */
    stop(): void {
      priorityHeld = false;
      queue = [];
      drainedUntil = 0;
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
