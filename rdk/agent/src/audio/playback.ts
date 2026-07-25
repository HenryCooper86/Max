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
      target.stdin?.write(Buffer.from(limited.buffer, limited.byteOffset, limited.byteLength));
    },

    /**
     * Barge-in. Killing the child is what actually discards the queued tail;
     * the next write respawns it.
     */
    flush(): void {
      child?.kill("SIGKILL");
      child = null;
    },

    stop(): void {
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
