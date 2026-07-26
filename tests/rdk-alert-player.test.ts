import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlertPlayer, readWavMono24k } from "../rdk/agent/src/audio/alert-player";

function wav(samples: number, rate = 24000, channels = 1, bits = 16): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(1000, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function fakePlayback() {
  const order: string[] = [];
  const written: number[] = [];
  return {
    order,
    written,
    write(pcm: Int16Array) {
      written.push(pcm.length);
      order.push("write");
    },
    flush() {
      order.push("flush");
    },
    holdPriority() {
      order.push("hold");
    },
    releasePriority() {
      order.push("release");
    }
  };
}

describe("readWavMono24k", () => {
  it("reads mono 16-bit samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "a.wav"), wav(480));
    expect(readWavMono24k(join(dir, "a.wav")).length).toBe(480);
  });

  it("rejects a rate the playback path cannot accept", () => {
    // playback.write consumes 24 kHz. A 16 kHz clip would play half again too
    // slow — the kind of thing nobody notices until a real ride.
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "b.wav"), wav(480, 16000));
    expect(() => readWavMono24k(join(dir, "b.wav"))).toThrow(/24000/);
  });

  it("rejects stereo, which would play at double speed", () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "c.wav"), wav(480, 24000, 2));
    expect(() => readWavMono24k(join(dir, "c.wav"))).toThrow(/mono/);
  });
});

describe("createAlertPlayer", () => {
  it("preempts, takes the lock, plays, then releases — in that order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "forward_collision.wav"), wav(2400));
    const playback = fakePlayback();
    const player = createAlertPlayer({ dir, playback });
    await player.play("forward_collision");
    expect(playback.order[0]).toBe("flush");
    expect(playback.order[1]).toBe("hold");
    expect(playback.order.at(-1)).toBe("release");
    expect(playback.order).toContain("write");
  });

  it("flushes before holding, or Max would talk over the warning", async () => {
    // Holding first would make our own flush a no-op against our own lock.
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "rear_approach.wav"), wav(960));
    const playback = fakePlayback();
    await createAlertPlayer({ dir, playback }).play("rear_approach");
    expect(playback.order.indexOf("flush")).toBeLessThan(playback.order.indexOf("hold"));
  });

  it("stays silent and does not throw when the clip is missing", async () => {
    // Missing audio degrades to silence, never to network TTS: an ADAS alert
    // that needs WiFi is not an ADAS alert.
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    const playback = fakePlayback();
    await expect(createAlertPlayer({ dir, playback }).play("rear_approach")).resolves.toBeNull();
    expect(playback.order).toEqual([]);
  });

  it("stays silent on an unusable clip rather than half-playing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "tailgating.wav"), wav(480, 16000));
    const playback = fakePlayback();
    await expect(createAlertPlayer({ dir, playback }).play("tailgating")).resolves.toBeNull();
    expect(playback.order).toEqual([]);
  });

  it("releases priority even if a write throws", async () => {
    // A stuck lock would silence Max for the rest of the ride.
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "pedestrian_ahead.wav"), wav(960));
    const order: string[] = [];
    const playback = {
      write: () => {
        throw new Error("aplay died");
      },
      flush: () => order.push("flush"),
      holdPriority: () => order.push("hold"),
      releasePriority: () => order.push("release")
    };
    await expect(createAlertPlayer({ dir, playback }).play("pedestrian_ahead")).resolves.toBeNull();
    expect(order).toContain("release");
  });

  it("reports how long the clip took to hand over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "tailgating.wav"), wav(2400));
    let clock = 1000;
    const player = createAlertPlayer({ dir, playback: fakePlayback(), now: () => (clock += 5) });
    expect(await player.play("tailgating")).toBeGreaterThan(0);
  });

  it("hands the whole clip over in chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "forward_collision.wav"), wav(2400));
    const playback = fakePlayback();
    await createAlertPlayer({ dir, playback }).play("forward_collision");
    expect(playback.written.reduce((a, b) => a + b, 0)).toBe(2400);
  });
});
