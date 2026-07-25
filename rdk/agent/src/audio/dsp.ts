/**
 * Pure DSP for the embedded audio path. The board captures and plays at 48 kHz
 * while the relay protocol is 16 kHz up / 24 kHz down; both are exact integer
 * ratios, so conversion is cheap and lossless to specify. We do it here rather
 * than letting ALSA's `plughw:` plug layer resample, because the plug layer
 * hides the rate mismatch, resamples at mediocre quality, and costs us exact
 * frame alignment.
 */

export const CAPTURE_RATE = 48_000;
export const UPLINK_RATE = 16_000;
export const DOWNLINK_RATE = 24_000;

/** 20 ms at 16 kHz — byte-identical to `public/pcm-worklet.js`. */
export const FRAME_SAMPLES = 320;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * Windowed-sinc low-pass. `taps` must be odd so the kernel is symmetric about a
 * whole sample, which gives linear phase.
 */
export function designLowPass(taps: number, cutoffHz: number, sampleRate: number): Float32Array {
  if (taps % 2 === 0) throw new Error("designLowPass requires an odd tap count");
  const kernel = new Float32Array(taps);
  const middle = (taps - 1) / 2;
  const fc = cutoffHz / sampleRate;
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - middle;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i]!;
  }
  for (let i = 0; i < taps; i += 1) kernel[i] = kernel[i]! / sum;
  return kernel;
}

/**
 * Anti-alias filter for 48 kHz → 16 kHz. The cutoff sits below the 8 kHz Nyquist
 * of the decimated rate: without it, naive ÷3 decimation folds everything above
 * 8 kHz back into the speech band and degrades ASR.
 */
export const LOW_PASS_48K = designLowPass(31, 7_500, CAPTURE_RATE);

function clampPcm(value: number): number {
  const scaled = Math.round(value * 32768);
  if (scaled > 32767) return 32767;
  if (scaled < -32768) return -32768;
  return scaled;
}

/**
 * Streaming decimator. Retains `taps.length - 1` samples of history and the
 * decimation phase across calls, so chunk boundaries are invisible in the
 * output.
 */
export function createDecimator(factor: number, taps: Float32Array): (input: Int16Array) => Int16Array {
  const width = taps.length;
  let history = new Float32Array(width - 1);
  let phase = 0;

  return (input: Int16Array): Int16Array => {
    const total = history.length + input.length;
    const buffer = new Float32Array(total);
    buffer.set(history, 0);
    for (let i = 0; i < input.length; i += 1) {
      buffer[history.length + i] = input[i]! / 32768;
    }

    const out: number[] = [];
    for (let i = width - 1; i < total; i += 1) {
      if (phase === 0) {
        let accumulator = 0;
        for (let k = 0; k < width; k += 1) accumulator += taps[k]! * buffer[i - k]!;
        out.push(clampPcm(accumulator));
      }
      phase = (phase + 1) % factor;
    }

    history = buffer.slice(total - (width - 1));
    return Int16Array.from(out);
  };
}

/**
 * Linear 2× interpolation for 24 kHz → 48 kHz. Original samples land on odd
 * indices; the midpoint between the previous and current sample lands on even
 * ones. The previous sample is retained so chunk boundaries interpolate.
 */
export function createUpsampler2x(): (input: Int16Array) => Int16Array {
  let previous = 0;
  return (input: Int16Array): Int16Array => {
    const out = new Int16Array(input.length * 2);
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i]!;
      out[i * 2] = Math.round((previous + current) / 2);
      out[i * 2 + 1] = current;
      previous = current;
    }
    return out;
  };
}

/**
 * Per-sample soft limiter, matching the iOS/Android behavior: the helmet speaker
 * needs real gain, but a hard clip sounds harsh. Below the threshold this is
 * plain gain; above it the excess is compressed with a tanh knee that
 * asymptotically approaches full scale without ever crossing it.
 */
export function softLimitSample(x: number, gain: number, threshold: number): number {
  const boosted = x * gain;
  const magnitude = Math.abs(boosted);
  if (magnitude <= threshold) return boosted;
  const range = 1 - threshold;
  const shaped = threshold + range * Math.tanh((magnitude - threshold) / range);
  return boosted < 0 ? -shaped : shaped;
}

export function applySoftLimit(input: Int16Array, gain = 1.6, threshold = 0.7): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = clampPcm(softLimitSample(input[i]! / 32768, gain, threshold));
  }
  return out;
}

/** Buffers a sample stream into fixed-size frames, retaining any remainder. */
export function createFramer(frameSamples = FRAME_SAMPLES): (input: Int16Array) => Int16Array[] {
  let pending = new Int16Array(0);
  return (input: Int16Array): Int16Array[] => {
    const merged = new Int16Array(pending.length + input.length);
    merged.set(pending, 0);
    merged.set(input, pending.length);

    const frames: Int16Array[] = [];
    let offset = 0;
    while (merged.length - offset >= frameSamples) {
      frames.push(merged.slice(offset, offset + frameSamples));
      offset += frameSamples;
    }
    pending = merged.slice(offset);
    return frames;
  };
}

/** Root-mean-square of a PCM16 frame, in int16 units. */
export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}
