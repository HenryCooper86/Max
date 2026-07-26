import { spawn as nodeSpawn } from "node:child_process";
import { CAPTURE_RATE, LOW_PASS_48K, createDecimator, createFramer } from "./dsp";

export type ChildProcessLike = {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  /** fd 3 is the far-end reference pipe when the child is max-aec. */
  stdio?: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>;
  kill(signal?: string): void;
  on(event: "exit", listener: () => void): void;
};

export type SpawnLike = (command: string, args: string[]) => ChildProcessLike;

export type AecOptions = {
  bin: string;
  delayMs: number;
  /** 0 low, 1 moderate, 2 high. See the sweep in rdk/aec/src/apm.h. */
  suppression: number;
};

export type CaptureOptions = {
  device: string;
  onFrame(frame: Int16Array): void;
  spawn?: SpawnLike;
  /** When set, max-aec replaces arecord and already emits 16 kHz. */
  aec?: AecOptions;
  /** Receives fd 3 of max-aec, or null when AEC is off. */
  onReference?(stream: NodeJS.WritableStream | null): void;
};

export function captureArgs(device: string): string[] {
  return ["-D", device, "-f", "S16_LE", "-r", String(CAPTURE_RATE), "-c", "1", "-t", "raw", "-q"];
}

export function aecArgs(device: string, delayMs: number, suppression: number): string[] {
  return ["--device", device, "--delay-ms", String(delayMs), "--suppression", String(suppression)];
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
  const spawn =
    options.spawn ??
    ((command, args) =>
      nodeSpawn(command, args, {
        // fd 3 carries the far-end reference into max-aec. arecord ignores it.
        stdio: ["ignore", "pipe", "inherit", "pipe"]
      }) as unknown as ChildProcessLike);
  let child: ChildProcessLike | null = null;
  let leftover = Buffer.alloc(0);

  return {
    start(): void {
      if (child) return;
      const useAec = options.aec !== undefined;
      // max-aec emits 16 kHz already. Decimating its output again would put the
      // uplink at 5.3 kHz and Doubao would hear a slowed-down rider.
      const decimate = useAec ? null : createDecimator(3, LOW_PASS_48K);
      const frame = createFramer();
      leftover = Buffer.alloc(0);

      child = options.aec
        ? spawn(options.aec.bin, aecArgs(options.device, options.aec.delayMs, options.aec.suppression))
        : spawn("arecord", captureArgs(options.device));
      // Unplugging the headset kills the child mid-stream; an unhandled 'error'
      // on this stream would take the whole agent down. Losing the mic must
      // degrade the session, not end the process.
      child.stdout?.on("error", () => {});
      options.onReference?.(useAec ? ((child.stdio?.[3] as NodeJS.WritableStream | undefined) ?? null) : null);
      child.stdout?.on("data", (chunk: Buffer) => {
        // ALSA hands us bytes, not samples: a chunk can split a sample in half.
        const merged = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
        const usable = merged.length - (merged.length % 2);
        leftover = Buffer.from(merged.subarray(usable));

        const samples = new Int16Array(usable / 2);
        for (let i = 0; i < samples.length; i += 1) samples[i] = merged.readInt16LE(i * 2);

        for (const output of frame(decimate ? decimate(samples) : samples)) options.onFrame(output);
      });
    },
    stop(): void {
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
