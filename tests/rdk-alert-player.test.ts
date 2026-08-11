import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAlertPlayer, readWavMono24k } from "../rdk/agent/src/audio/alert-player";
import { createPlayback } from "../rdk/agent/src/audio/playback";

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

/** A valid WAV carrying an extra chunk between `fmt ` and `data` — what most
 *  encoders emit when they stamp metadata (LIST/INFO), and what a re-render of
 *  the alert clips could easily produce. */
function wavWithMetadata(samples: number, metadataBytes: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(1000, i * 2);
  const list = Buffer.alloc(8 + metadataBytes);
  list.write("LIST", 0);
  list.writeUInt32LE(metadataBytes, 4);
  list.write("INFO", 8);
  const head = Buffer.alloc(36);
  head.write("RIFF", 0);
  head.writeUInt32LE(28 + list.length + 8 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, list, dataHeader, data]);
}

function fakePlayback(accept: (pcm: Int16Array, rank: number | undefined) => boolean = () => true) {
  const order: string[] = [];
  const written: number[] = [];
  const writeRanks: Array<number | undefined> = [];
  const accepted: number[] = [];
  const flushRanks: Array<number | undefined> = [];
  const holdRanks: Array<number | undefined> = [];
  return {
    order,
    written,
    writeRanks,
    accepted,
    flushRanks,
    holdRanks,
    write(pcm: Int16Array, rank?: number) {
      written.push(pcm.length);
      writeRanks.push(rank);
      order.push("write");
      const didAccept = accept(pcm, rank);
      if (didAccept) accepted.push(pcm.length);
      return didAccept;
    },
    flush(rank?: number) {
      flushRanks.push(rank);
      order.push("flush");
    },
    holdPriority(rank?: number) {
      holdRanks.push(rank);
      order.push("hold");
    },
    releasePriority() {
      order.push("release");
    }
  };
}

function playbackChild() {
  const stdin = new PassThrough();
  const kill = vi.fn();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    stdin,
    kill,
    child: {
      stdin,
      kill,
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }
    }
  };
}

async function nestedRealAlerts(cautionSamples: number, triggerReferenceWrite: number) {
  const dir = mkdtempSync(join(tmpdir(), "alerts-ranked-"));
  writeFileSync(join(dir, "tailgating.wav"), wav(cautionSamples));
  writeFileSync(join(dir, "forward_collision.wav"), wav(480));
  const children: ReturnType<typeof playbackChild>[] = [];
  const timers: Array<() => void> = [];
  const nested: {
    player?: ReturnType<typeof createAlertPlayer>;
    result?: Promise<number | null>;
  } = {};
  let referenceWrites = 0;
  let triggered = false;
  const playback = createPlayback({
    device: "plughw:0,0",
    spawn: () => {
      const child = playbackChild();
      children.push(child);
      return child.child;
    },
    now: () => 0,
    schedule: (fn) => {
      timers.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    },
    reference: {
      write: () => {
        referenceWrites += 1;
        if (triggered || referenceWrites !== triggerReferenceWrite) return;
        triggered = true;
        nested.result = nested.player!.play("forward_collision", "critical");
      },
      flush: () => undefined,
      close: () => undefined
    }
  });
  let cautionClock = 0;
  let criticalClock = 0;
  nested.player = createAlertPlayer({ dir, playback, now: () => (criticalClock += 5) });
  const caution = createAlertPlayer({ dir, playback, now: () => (cautionClock += 5) });
  const cautionResult = await caution.play("tailgating", "caution");
  const criticalResult = await nested.result;
  return { playback, children, timers, cautionResult, criticalResult };
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

  it("finds the data chunk behind a metadata chunk rather than playing the metadata as audio", () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "meta.wav"), wavWithMetadata(480, 64));
    const pcm = readWavMono24k(join(dir, "meta.wav"));
    expect(pcm.length).toBe(480);
    // Every sample of the real payload is 1000. Reading from a fixed offset 44
    // would land inside LIST/INFO and hand the rider that as a safety alert.
    expect(pcm[0]).toBe(1000);
    expect(pcm.at(-1)).toBe(1000);
  });

  it("rejects a WAV with no data chunk instead of returning whatever follows the header", () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    const headerOnly = wav(480).subarray(0, 36);
    writeFileSync(join(dir, "nodata.wav"), headerOnly);
    expect(() => readWavMono24k(join(dir, "nodata.wav"))).toThrow(/data/);
  });

  it("rejects a file that is not RIFF/WAVE at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "mp3.wav"), Buffer.alloc(200, 0x55));
    expect(() => readWavMono24k(join(dir, "mp3.wav"))).toThrow(/RIFF|WAVE/);
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

  it("a critical alert carries its rank into the preempt and the hold", async () => {
    // Decision 2026-08-01: strictly-higher severity cuts a playing alert's
    // tail. The rank must ride both calls — the flush that does the cutting
    // and the hold that defends the new clip at its own level.
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "forward_collision.wav"), wav(960));
    const playback = fakePlayback();
    await createAlertPlayer({ dir, playback }).play("forward_collision", "critical");
    expect(playback.flushRanks).toEqual([2]);
    expect(playback.holdRanks).toEqual([2]);
    expect(playback.writeRanks).toEqual([2, 2]);
  });

  it("a caution alert carries the caution rank and an unknown severity sinks to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "tailgating.wav"), wav(960));
    const playback = fakePlayback();
    const player = createAlertPlayer({ dir, playback });
    await player.play("tailgating", "caution");
    await player.play("tailgating", "somehow-new");
    await player.play("tailgating");
    // Never let an unrecognised severity outrank a real critical.
    expect(playback.flushRanks).toEqual([1, 1, 1]);
    expect(playback.holdRanks).toEqual([1, 1, 1]);
    expect(playback.writeRanks).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("hands the whole clip over in chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "forward_collision.wav"), wav(2400));
    const playback = fakePlayback();
    await createAlertPlayer({ dir, playback }).play("forward_collision");
    expect(playback.accepted.reduce((a, b) => a + b, 0)).toBe(2400);
    expect(playback.writeRanks).toEqual([1, 1, 1, 1, 1]);
  });

  it("returns null rather than claiming a fully rejected lower alert was audible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-"));
    writeFileSync(join(dir, "tailgating.wav"), wav(960));
    const playback = fakePlayback(() => false);
    await expect(createAlertPlayer({ dir, playback }).play("tailgating", "caution")).resolves.toBeNull();
    expect(playback.written).toEqual([480, 480]);
    expect(playback.writeRanks).toEqual([1, 1]);
    expect(playback.accepted).toEqual([]);
    expect(playback.order.at(-1)).toBe("release");
  });

  it("reports null when a nested real critical alert invalidates caution before its first sink handoff", async () => {
    const h = await nestedRealAlerts(480, 1);
    expect(h.criticalResult).not.toBeNull();
    expect(h.cautionResult).toBeNull();
    expect(h.children).toHaveLength(2);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.children[0]!.stdin.readableLength).toBe(0);
    expect(h.children[1]!.stdin.readableLength).toBe(1_920);
    expect(h.playback.priorityRank()).toBe(2);
    expect(h.timers).toHaveLength(1);
    h.timers[0]!();
    expect(h.playback.priorityRank()).toBe(0);
  });

  it("retains a non-null result only when caution handed off a chunk before nested critical preemption", async () => {
    const h = await nestedRealAlerts(960, 2);
    expect(h.criticalResult).not.toBeNull();
    expect(h.cautionResult).not.toBeNull();
    expect(h.children[0]!.stdin.readableLength).toBe(1_920);
    expect(h.children[1]!.stdin.readableLength).toBe(1_920);
    expect(h.playback.priorityRank()).toBe(2);
    expect(h.timers).toHaveLength(1);
  });
});
