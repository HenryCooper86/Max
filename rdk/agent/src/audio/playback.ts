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
};

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
  stop(): void;
} {
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args) as unknown as ChildProcessLike);
  let child: ChildProcessLike | null = null;
  let upsample = createUpsampler2x();

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
      const target = ensure();
      const limited = applySoftLimit(upsample(pcm), options.gain, options.threshold);
      // Post-limiter, so the canceller models exactly what the DAC receives.
      // Tapping before it would hide the limiter's non-linearity from a filter
      // that assumes the echo path is linear, and cancellation would fall apart
      // precisely when Max is loudest.
      options.reference?.write(limited);
      target.stdin?.write(Buffer.from(limited.buffer, limited.byteOffset, limited.byteLength));
    },

    /**
     * Barge-in. Killing the child is what actually discards the queued tail;
     * the next write respawns it.
     */
    flush(): void {
      // Before the kill, not after: the reset marker must sit in the reference
      // pipe behind the audio it invalidates. Everything already queued is
      // about to be discarded unheard, and APM has to forget exactly that much
      // or it spends the rider's interruption subtracting an echo that never
      // reached the speaker.
      options.reference?.flush();
      child?.kill("SIGKILL");
      child = null;
    },

    stop(): void {
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
