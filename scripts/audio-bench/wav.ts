import fs from "node:fs";

/** PCM16 audio as the bench handles it: mono, samples in -1..1. */
export type Clip = { sampleRate: number; samples: Float32Array };

/** The rate everything in the bench is scored at: what a device sends the relay. */
export const BENCH_RATE = 16_000;

/**
 * Reads a 16-bit PCM WAV. A stereo file is mixed down to mono. Anything else
 * (float, 24-bit, compressed) is refused with the ffmpeg line that fixes it,
 * since guessing at a format would silently score the wrong signal.
 */
export function readWav(file: string): Clip {
  const data = fs.readFileSync(file);
  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: not a WAV file`);
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; tag: number } | undefined;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        tag: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14)
      };
    } else if (id === "data") {
      if (!format) break;
      // 1 is PCM; 0xFFFE is "extensible", which wraps PCM in most recorders.
      if ((format.tag !== 1 && format.tag !== 0xfffe) || format.bits !== 16 || format.channels < 1) {
        throw new Error(
          `${file}: need 16-bit PCM. Convert with: ffmpeg -i "${file}" -ar ${BENCH_RATE} -ac 1 -c:a pcm_s16le out.wav`
        );
      }
      const frames = Math.floor(Math.min(size, data.length - body) / (2 * format.channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < format.channels; channel += 1) {
          sum += data.readInt16LE(body + (frame * format.channels + channel) * 2);
        }
        samples[frame] = sum / format.channels / 32768;
      }
      return { sampleRate: format.sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file}: no audio data found`);
}

/** Reads a WAV that must already be at the bench rate. */
export function readBenchWav(file: string): Float32Array {
  const clip = readWav(file);
  if (clip.sampleRate !== BENCH_RATE) {
    throw new Error(
      `${file}: is ${clip.sampleRate} Hz, need ${BENCH_RATE} Hz. Convert with: ffmpeg -i "${file}" -ar ${BENCH_RATE} -ac 1 -c:a pcm_s16le out.wav`
    );
  }
  return clip.samples;
}

export function toPcm16(samples: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return pcm;
}

export function writeWav(file: string, samples: Float32Array, sampleRate = BENCH_RATE): void {
  const pcm = toPcm16(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

/** Mean power of a stretch of samples. */
export function power(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  for (let index = start; index < end; index += 1) sum += samples[index]! * samples[index]!;
  return end > start ? sum / (end - start) : 0;
}

export function decibels(ratio: number): number {
  return 10 * Math.log10(Math.max(ratio, 1e-12));
}
