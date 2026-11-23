import type { Logger } from "./logger";

/**
 * Noise suppression in the relay, for every backend.
 *
 * A browser cleans up its own microphone, and a headset is quiet to begin
 * with. A phone call from a street, or a device with a bare microphone, is
 * neither: the fan, the traffic and the hum reach the model, which hears them
 * as speech and interrupts itself. With `NOISE_SUPPRESSION` set, the relay
 * runs RNNoise (a small recurrent network, Apache-2.0, compiled to
 * WebAssembly) over the microphone audio before any backend sees it.
 *
 *   NOISE_SUPPRESSION=phone   phone calls only
 *   NOISE_SUPPRESSION=on      every session
 *
 * RNNoise works on 10 ms frames at 48 kHz. The relay's microphone audio is
 * 16 kHz, so each frame is brought up by linear interpolation and taken back
 * down by keeping every third sample, which returns the original samples
 * exactly where the network changed nothing. The cost is about a fifth of a
 * millisecond of CPU per 10 ms of audio, and 20 ms of delay.
 */

export type NoiseSuppressionMode = "off" | "phone" | "on";

export function noiseSuppressionFromEnv(env: NodeJS.ProcessEnv = process.env): {
  mode: NoiseSuppressionMode;
  problems: string[];
} {
  const raw = env.NOISE_SUPPRESSION?.trim().toLowerCase();
  if (!raw || raw === "off") return { mode: "off", problems: [] };
  if (raw === "on" || raw === "phone") return { mode: raw, problems: [] };
  return { mode: "off", problems: [`NOISE_SUPPRESSION=${raw} is not one of off, phone, on`] };
}

/** The part of the RNNoise WebAssembly module that is used here. */
type RnnoiseModule = {
  ready?: Promise<unknown>;
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _rnnoise_create(): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, output: number, input: number): number;
};

const RATE_FACTOR = 3;
/** 10 ms at 16 kHz, which is one RNNoise frame at 48 kHz. */
const FRAME_SAMPLES = 160;
const MODEL_FRAME_SAMPLES = FRAME_SAMPLES * RATE_FACTOR;

let rnnoise: RnnoiseModule | undefined;
let loading: Promise<boolean> | undefined;

/**
 * Loads the model once. Resolves to whether suppression is available: the
 * package is an optional dependency, and a relay without it still runs.
 */
export function loadNoiseSuppression(log?: Logger): Promise<boolean> {
  loading ??= (async () => {
    try {
      // The build with the model inlined: nothing is fetched or read from disk at run time.
      const imported = await import("@jitsi/rnnoise-wasm/dist/rnnoise-sync.js");
      const created: RnnoiseModule = imported.default();
      await created.ready;
      rnnoise = created;
      return true;
    } catch (error) {
      log?.error("NOISE_SUPPRESSION is set but the noise model could not be loaded", {
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  })();
  return loading;
}

/** Cleans one microphone stream. Keep one per session: the model has memory. */
export class NoiseSuppressor {
  private readonly state: number;
  private readonly buffer: number;
  private carry: Buffer = Buffer.alloc(0);
  private previous = 0;
  private closed = false;

  constructor(private readonly module: RnnoiseModule) {
    this.state = module._rnnoise_create();
    this.buffer = module._malloc(MODEL_FRAME_SAMPLES * 4);
  }

  /**
   * Takes 16 kHz PCM16 in pieces of any size and returns the cleaned audio for
   * every whole 10 ms it now has. What is left over waits for the next piece,
   * so the stream out is the stream in, 20 ms later.
   */
  process(pcm: Buffer): Buffer {
    if (this.closed) return pcm;
    const input = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const frames = Math.floor(input.length / (FRAME_SAMPLES * 2));
    const used = frames * FRAME_SAMPLES * 2;
    // A copy: the caller may reuse its buffer before the rest is processed.
    this.carry = Buffer.from(input.subarray(used));
    if (frames === 0) return Buffer.alloc(0);
    const output = Buffer.allocUnsafe(used);
    for (let frame = 0; frame < frames; frame += 1) {
      // The heap can move when the module grows its memory: look it up each frame.
      const heap = this.module.HEAPF32;
      const base = this.buffer >> 2;
      const offset = frame * FRAME_SAMPLES * 2;
      let previous = this.previous;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const sample = input.readInt16LE(offset + i * 2);
        const step = (sample - previous) / RATE_FACTOR;
        heap[base + i * 3] = previous + step;
        heap[base + i * 3 + 1] = previous + step * 2;
        heap[base + i * 3 + 2] = sample;
        previous = sample;
      }
      this.previous = previous;
      this.module._rnnoise_process_frame(this.state, this.buffer, this.buffer);
      const cleaned = this.module.HEAPF32;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const value = Math.round(cleaned[base + i * 3 + 2] ?? 0);
        output.writeInt16LE(value > 32_767 ? 32_767 : value < -32_768 ? -32_768 : value, offset + i * 2);
      }
    }
    return output;
  }

  /** Frees the model's memory for this stream. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.carry = Buffer.alloc(0);
    this.module._rnnoise_destroy(this.state);
    this.module._free(this.buffer);
  }
}

/** A suppressor for one session, or nothing while the model is not loaded. */
export function createNoiseSuppressor(): NoiseSuppressor | undefined {
  return rnnoise ? new NoiseSuppressor(rnnoise) : undefined;
}
