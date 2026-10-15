import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decodeWarningWav } from "../src/lib/warning-wav";

const original = readFileSync("public/audio/adas/female/rear_approach.wav");
const samples = (original.length - 44) / 2;
function context() {
  return {
    state: "running",
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      const channel = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => channel
      };
    })
  };
}
function input(data: Buffer) {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

describe("fixed-format safety warning WAV loading", () => {
  it("loads mono 24k signed PCM16 with exact sample values and duration", () => {
    const audio = context();
    const buffer = decodeWarningWav(audio as unknown as AudioContext, input(original), samples);
    expect(audio.createBuffer).toHaveBeenCalledWith(1, samples, 24000);
    expect(buffer.duration).toBe(samples / 24000);
    for (let i = 0; i < samples; i += 1)
      expect(buffer.getChannelData(0)[i]).toBe(original.readInt16LE(44 + i * 2) / 32768);
  });

  it("rejects malformed headers, incompatible format, sample counts and truncated chunks before allocation", () => {
    const cases = [
      (data: Buffer) => data.write("NOPE", 0),
      (data: Buffer) => data.write("NOPE", 8),
      (data: Buffer) => data.writeUInt32LE(data.length - 7, 4),
      (data: Buffer) => data.writeUInt16LE(3, 20),
      (data: Buffer) => data.writeUInt16LE(2, 22),
      (data: Buffer) => data.writeUInt32LE(48000, 24),
      (data: Buffer) => data.writeUInt32LE(24000, 28),
      (data: Buffer) => data.writeUInt16LE(4, 32),
      (data: Buffer) => data.writeUInt16LE(8, 34),
      (data: Buffer) => data.writeUInt32LE(data.length, 40),
      (data: Buffer) => data.write("JUNK", 36),
      (data: Buffer) => data.writeUInt32LE(15, 16)
    ];
    for (const mutate of cases) {
      const data = Buffer.from(original);
      mutate(data);
      const audio = context();
      expect(() => decodeWarningWav(audio as unknown as AudioContext, input(data), samples)).toThrow();
      expect(audio.createBuffer).not.toHaveBeenCalled();
    }
    for (const length of [0, 11, original.length - 1]) {
      expect(() =>
        decodeWarningWav(context() as unknown as AudioContext, input(original.subarray(0, length)), samples)
      ).toThrow();
    }
    expect(() => decodeWarningWav(context() as unknown as AudioContext, input(original), samples + 1)).toThrow();
  });

  it("does not create buffers on a closed context", () => {
    const audio = context();
    audio.state = "closed";
    expect(() => decodeWarningWav(audio as unknown as AudioContext, input(original), samples)).toThrow();
    expect(audio.createBuffer).not.toHaveBeenCalled();
  });
});
