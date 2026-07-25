import { spawn as nodeSpawn } from "node:child_process";
import { CAPTURE_RATE, LOW_PASS_48K, createDecimator, createFramer } from "./dsp";

export type ChildProcessLike = {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: string): void;
  on(event: "exit", listener: () => void): void;
};

export type SpawnLike = (command: string, args: string[]) => ChildProcessLike;

export type CaptureOptions = {
  device: string;
  onFrame(frame: Int16Array): void;
  spawn?: SpawnLike;
};

export function captureArgs(device: string): string[] {
  return ["-D", device, "-f", "S16_LE", "-r", String(CAPTURE_RATE), "-c", "1", "-t", "raw", "-q"];
}

/**
 * Streams microphone audio as 16 kHz PCM16 frames.
 *
 * `arecord` is used rather than a native addon so the board needs no node-gyp
 * toolchain. The device name is also the AEC seam: point RDK_ALSA_CAPTURE at the
 * raw card for a bare pipeline, or at an echo-cancelled virtual source, and
 * nothing here changes.
 */
export function createCapture(options: CaptureOptions): { start(): void; stop(): void } {
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args) as unknown as ChildProcessLike);
  let child: ChildProcessLike | null = null;
  let leftover = Buffer.alloc(0);

  return {
    start(): void {
      if (child) return;
      const decimate = createDecimator(3, LOW_PASS_48K);
      const frame = createFramer();
      leftover = Buffer.alloc(0);

      child = spawn("arecord", captureArgs(options.device));
      child.stdout?.on("data", (chunk: Buffer) => {
        // ALSA hands us bytes, not samples: a chunk can split a sample in half.
        const merged = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
        const usable = merged.length - (merged.length % 2);
        leftover = Buffer.from(merged.subarray(usable));

        const samples = new Int16Array(usable / 2);
        for (let i = 0; i < samples.length; i += 1) samples[i] = merged.readInt16LE(i * 2);

        for (const output of frame(decimate(samples))) options.onFrame(output);
      });
    },
    stop(): void {
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
