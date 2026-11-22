import { beforeAll, describe, expect, it } from "vitest";
import { loadOpus, MAX_OPUS_PACKET_BYTES, type OpusFactory } from "../server/webrtc/opus";

// The Opus codec of the WebRTC transport. The wrapper that ships with the
// package breaks once about 40 calls are open at the same time; these tests
// hold many more than that open.

let opus: OpusFactory;
beforeAll(async () => {
  opus = await loadOpus();
});

function tone(rate: number, hz: number, samples: number, phase = 0): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(9000 * Math.sin(((i + phase) * 2 * Math.PI * hz) / rate)), i * 2);
  }
  return pcm;
}

function level(pcm: Buffer): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}

/** Fifty 20 ms frames of a tone through a fresh encoder and decoder. */
function alone(hz: number): Buffer {
  const encoder = opus(24_000);
  const decoder = opus(24_000);
  const out: Buffer[] = [];
  for (let frame = 0; frame < 50; frame += 1) {
    out.push(decoder.decode(encoder.encode(tone(24_000, hz, 480, frame * 480), 480)));
  }
  encoder.delete();
  decoder.delete();
  return Buffer.concat(out);
}

describe("the Opus codec", () => {
  it("carries speech-band audio through at its level, at about 24 kbit/s", () => {
    const encoder = opus(24_000);
    const decoder = opus(24_000);
    let bytes = 0;
    const out: Buffer[] = [];
    for (let frame = 0; frame < 50; frame += 1) {
      const packet = encoder.encode(tone(24_000, 300, 480, frame * 480), 480);
      bytes += packet.length;
      out.push(decoder.decode(packet));
    }
    const decoded = Buffer.concat(out);
    expect(decoded.length).toBe(50 * 960);
    // After the codec's start: the tone's own level is 9000 / √2.
    expect(level(decoded.subarray(9600)) / (9000 / Math.SQRT2)).toBeGreaterThan(0.9);
    expect(level(decoded.subarray(9600)) / (9000 / Math.SQRT2)).toBeLessThan(1.1);
    // One second of audio.
    expect((bytes * 8) / 1000).toBeGreaterThan(8);
    expect((bytes * 8) / 1000).toBeLessThan(48);
    encoder.delete();
    decoder.delete();
  });

  it("keeps 300 calls apart while all of them encode and decode in turn", () => {
    const calls = Array.from({ length: 300 }, (_, index) => {
      const encoder = opus(24_000);
      encoder.encoderCTL(4012, 1);
      encoder.encoderCTL(4014, 10);
      return {
        hz: 200 + (index % 40) * 15,
        // What the relay holds for a call, and a plain pair to compare with a call on its own.
        encoder,
        microphone: opus(16_000),
        plainEncoder: opus(24_000),
        plainDecoder: opus(24_000),
        heard: [] as Buffer[]
      };
    });
    const microphonePacket = opus(16_000);
    for (let frame = 0; frame < 50; frame += 1) {
      for (const call of calls) {
        call.encoder.encode(tone(24_000, 500, 480, frame * 480), 480);
        expect(call.microphone.decode(microphonePacket.encode(tone(16_000, 250, 320), 320))).toHaveLength(640);
        call.heard.push(
          call.plainDecoder.decode(call.plainEncoder.encode(tone(24_000, call.hz, 480, frame * 480), 480))
        );
      }
    }
    // Each call's audio is exactly what the same codecs produce with nothing else running.
    for (const call of [calls[0]!, calls[41]!, calls[150]!, calls[299]!]) {
      expect(Buffer.concat(call.heard).equals(alone(call.hz))).toBe(true);
    }
    for (const call of calls) {
      call.encoder.delete();
      call.microphone.delete();
      call.plainEncoder.delete();
      call.plainDecoder.delete();
    }
    microphonePacket.delete();
    // The memory is given back: a new codec still works.
    expect(alone(300).length).toBe(50 * 960);
  }, 60_000);

  it("refuses what is not a frame or not a packet, and a codec that was deleted", () => {
    const codec = opus(24_000);
    expect(() => codec.encode(Buffer.alloc(100), 480)).toThrow("not one frame");
    expect(() => codec.encode(Buffer.alloc(12_000), 6000)).toThrow("not one frame");
    expect(() => codec.decode(Buffer.alloc(0))).toThrow("not an Opus packet");
    expect(() => codec.decode(Buffer.alloc(MAX_OPUS_PACKET_BYTES + 1))).toThrow("not an Opus packet");
    expect(() => codec.decode(Buffer.from([0xff, 0xff, 0xff]))).toThrow("Opus decode");
    expect(() => codec.encoderCTL(1, 1)).toThrow("Opus encoder request");
    // It still works after each refusal.
    expect(codec.encode(tone(24_000, 300, 480), 480).length).toBeGreaterThan(0);
    codec.delete();
    codec.delete();
    expect(() => codec.encode(tone(24_000, 300, 480), 480)).toThrow("deleted");
  });

  it("hands back audio and packets that later calls do not overwrite", () => {
    const encoder = opus(24_000);
    const decoder = opus(24_000);
    const first = encoder.encode(tone(24_000, 300, 480), 480);
    const copy = Buffer.from(first);
    const audio = decoder.decode(first);
    const audioCopy = Buffer.from(audio);
    for (let i = 0; i < 5; i += 1) decoder.decode(encoder.encode(tone(24_000, 900, 480, i * 480), 480));
    expect(first.equals(copy)).toBe(true);
    expect(audio.equals(audioCopy)).toBe(true);
    encoder.delete();
    decoder.delete();
  });
});
