import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPlayback } from "../rdk/agent/src/audio/playback";

function fakeChild() {
  const stdin = new PassThrough();
  const kill = vi.fn();
  return {
    stdin,
    kill,
    child: {
      stdin,
      kill,
      on: () => undefined
    }
  };
}

function harness(overrides: { schedule?: (fn: () => void, ms: number) => NodeJS.Timeout } = {}) {
  const fake = fakeChild();
  const stdin: Buffer[] = [];
  const reference: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let spawns = 0;
  let referenceFlushes = 0;
  fake.stdin.on("data", (chunk: Buffer) => stdin.push(Buffer.from(chunk)));
  const playback = createPlayback({
    device: "plughw:0,0",
    spawn: () => {
      spawns += 1;
      return fake.child;
    },
    now: () => 0,
    schedule:
      overrides.schedule ??
      ((fn, ms) => {
        timers.push({ fn, ms });
        return 0 as unknown as NodeJS.Timeout;
      }),
    reference: {
      write: (pcm) => reference.push(pcm.length),
      flush: () => {
        referenceFlushes += 1;
      },
      close: () => undefined
    }
  });
  return {
    fake,
    playback,
    timers,
    spawns: () => spawns,
    stdinBytes: () => stdin.reduce((total, chunk) => total + chunk.byteLength, 0),
    stdinBuffer: () => Buffer.concat(stdin),
    reference,
    referenceFlushes: () => referenceFlushes
  };
}

describe("ranked playback writes", () => {
  it.each([
    ["rankless voice under caution", 1, undefined],
    ["ordinary voice under critical", 2, 0],
    ["caution under critical", 2, 1]
  ])("rejects %s before any playback side effect", (_name, heldRank, writeRank) => {
    const h = harness();
    h.playback.holdPriority(heldRank);
    expect(h.playback.write(new Int16Array([123]), writeRank)).toBe(false);
    expect(h.spawns()).toBe(0);
    expect(h.stdinBytes()).toBe(0);
    expect(h.reference).toEqual([]);
    expect(h.timers).toEqual([]);
    expect(h.referenceFlushes()).toBe(0);
  });

  it("accepts equal-ranked caution and critical chunks", () => {
    for (const rank of [1, 2]) {
      const h = harness();
      h.playback.holdPriority(rank);
      expect(h.playback.write(new Int16Array(480), rank)).toBe(true);
      expect(h.spawns()).toBe(1);
      expect(h.reference).toEqual([960]);
    }
  });

  it("lets critical preempt caution without letting lower or equal ranks preempt critical", () => {
    const h = harness();
    h.playback.holdPriority(1);
    expect(h.playback.write(new Int16Array(480), 1)).toBe(true);
    h.playback.flush(2);
    expect(h.fake.kill).toHaveBeenCalledTimes(1);
    h.playback.holdPriority(2);
    expect(h.playback.priorityRank()).toBe(2);
    expect(h.playback.write(new Int16Array(480), 2)).toBe(true);
    h.playback.flush(1);
    h.playback.flush(2);
    h.playback.holdPriority(1);
    expect(h.playback.priorityRank()).toBe(2);
    expect(h.playback.write(new Int16Array(480), 1)).toBe(false);
    h.playback.releasePriority();
    expect(h.playback.priorityRank()).toBe(2);
    expect(h.fake.kill).toHaveBeenCalledTimes(1);
  });

  it("treats empty and invalid-ranked writes as ordinary and never lets them bypass a hold", () => {
    const h = harness();
    h.playback.holdPriority(1);
    const invalidRanks = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      3,
      Number.MAX_SAFE_INTEGER,
      "2",
      {},
      null
    ] as unknown as Array<number | undefined>;
    for (const rank of invalidRanks) expect(h.playback.write(new Int16Array([7]), rank)).toBe(false);
    expect(h.playback.write(new Int16Array(0), 0)).toBe(false);
    expect(h.spawns()).toBe(0);
    expect(h.stdinBytes()).toBe(0);
    expect(h.reference).toEqual([]);
    expect(h.timers).toEqual([]);
    h.playback.flush(99);
    h.playback.holdPriority(99);
    expect(h.playback.priorityRank()).toBe(1);
    h.playback.releasePriority();
    expect(h.fake.kill).not.toHaveBeenCalled();
  });

  it("does not advance DSP state, queue, DAC, or reference for a rejected chunk and never replays it", () => {
    const guarded = harness();
    guarded.playback.holdPriority(2);
    expect(guarded.playback.write(new Int16Array([30_000]), 0)).toBe(false);
    guarded.playback.releasePriority();
    expect(guarded.playback.priorityRank()).toBe(0);
    expect(guarded.playback.write(new Int16Array([0]), 0)).toBe(true);
    for (const timer of guarded.timers.splice(0)) timer.fn();

    const clean = harness();
    expect(clean.playback.write(new Int16Array([0]), 0)).toBe(true);
    expect(guarded.spawns()).toBe(1);
    expect(guarded.stdinBuffer()).toEqual(clean.stdinBuffer());
    expect(guarded.reference).toEqual(clean.reference);
  });

  it("drops already queued ordinary PCM if a hold begins before its pump timer", () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) expect(h.playback.write(new Int16Array(480), 0)).toBe(true);
    const beforeHold = h.stdinBytes();
    expect(h.timers.length).toBeGreaterThan(0);
    h.playback.holdPriority(1);
    for (const timer of h.timers.splice(0)) timer.fn();
    expect(h.stdinBytes()).toBe(beforeHold);
    expect(h.reference.reduce((total, samples) => total + samples, 0)).toBe(beforeHold / 2);
    h.playback.releasePriority();
    for (const timer of h.timers.splice(0)) timer.fn();
    expect(h.stdinBytes()).toBe(beforeHold);
  });

  it("does not leak lower PCM to the DAC when the reference callback starts a hazard", () => {
    const fake = fakeChild();
    const stdin: Buffer[] = [];
    let referenceWrites = 0;
    let referenceFlushes = 0;
    fake.stdin.on("data", (chunk: Buffer) => stdin.push(Buffer.from(chunk)));
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      now: () => 0,
      reference: {
        write: () => {
          referenceWrites += 1;
          playback.flush(2);
          playback.holdPriority(2);
        },
        flush: () => {
          referenceFlushes += 1;
        },
        close: () => undefined
      }
    });

    playback.write(new Int16Array(480));
    expect(playback.priorityRank()).toBe(2);
    expect(referenceWrites).toBe(1);
    expect(referenceFlushes).toBe(1);
    expect(Buffer.concat(stdin)).toHaveLength(0);
  });

  it("does not let a reentrant hazard be killed by an older ordinary flush", () => {
    const fake = fakeChild();
    let startHazard = false;
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      now: () => 0,
      reference: {
        write: () => undefined,
        flush: () => {
          if (!startHazard) return;
          startHazard = false;
          playback.holdPriority(2);
          playback.write(new Int16Array(480), 2);
        },
        close: () => undefined
      }
    });
    playback.write(new Int16Array(480));
    startHazard = true;

    playback.flush();

    expect(playback.priorityRank()).toBe(2);
    expect(fake.kill).not.toHaveBeenCalled();
  });
});

describe("playback priority ownership", () => {
  it("reports deferred release and restores ordinary writes afterwards", () => {
    const h = harness();
    expect(h.playback.priorityRank()).toBe(0);
    h.playback.holdPriority();
    expect(h.playback.priorityRank()).toBe(1);
    expect(h.playback.write(new Int16Array(12_000), 1)).toBe(true);
    h.playback.releasePriority();
    expect(h.playback.priorityRank()).toBe(1);
    expect(h.playback.write(new Int16Array(1), 0)).toBe(false);
    expect(h.timers).toHaveLength(1);
    h.timers[0]!.fn();
    expect(h.playback.priorityRank()).toBe(0);
    expect(h.playback.write(new Int16Array(1), 0)).toBe(true);
  });

  it("keeps an equal alert safe from an older release timer", () => {
    const h = harness();
    h.playback.holdPriority(2);
    h.playback.write(new Int16Array(12_000), 2);
    h.playback.releasePriority();
    const stale = h.timers[0]!.fn;
    h.playback.holdPriority(2);
    h.playback.write(new Int16Array(12_000), 2);
    h.playback.releasePriority();
    const current = h.timers.at(-1)!.fn;
    stale();
    expect(h.playback.priorityRank()).toBe(2);
    current();
    expect(h.playback.priorityRank()).toBe(0);
  });

  it("does not let a lower hold or release corrupt a critical hold", () => {
    const h = harness();
    h.playback.holdPriority(2);
    h.playback.write(new Int16Array(12_000), 2);
    h.playback.releasePriority();
    const criticalRelease = h.timers[0]!.fn;
    h.playback.holdPriority(1);
    expect(h.playback.priorityRank()).toBe(2);
    expect(h.playback.write(new Int16Array(480), 1)).toBe(false);
    h.playback.releasePriority();
    expect(h.timers).toHaveLength(1);
    expect(h.playback.priorityRank()).toBe(2);
    criticalRelease();
    expect(h.playback.priorityRank()).toBe(0);
  });

  it("keeps higher preemption locked when a stale lower release fires", () => {
    const h = harness();
    h.playback.holdPriority(1);
    h.playback.write(new Int16Array(12_000), 1);
    h.playback.releasePriority();
    const cautionRelease = h.timers[0]!.fn;
    h.playback.flush(2);
    h.playback.holdPriority(2);
    h.playback.write(new Int16Array(12_000), 2);
    h.playback.releasePriority();
    const criticalRelease = h.timers[1]!.fn;
    cautionRelease();
    expect(h.playback.priorityRank()).toBe(2);
    criticalRelease();
    expect(h.playback.priorityRank()).toBe(0);
  });

  it("invalidates old releases on stop and cannot unlock a later alert", () => {
    const h = harness();
    h.playback.holdPriority(1);
    h.playback.write(new Int16Array(12_000), 1);
    h.playback.releasePriority();
    const stale = h.timers[0]!.fn;
    h.playback.stop();
    expect(h.playback.priorityRank()).toBe(0);
    h.playback.holdPriority(2);
    stale();
    expect(h.playback.priorityRank()).toBe(2);
  });

  it("does not leave the helmet permanently muted when release scheduling throws", () => {
    const h = harness({
      schedule: () => {
        throw new Error("timer unavailable");
      }
    });
    h.playback.holdPriority(1);
    h.playback.write(new Int16Array(12_000), 1);
    expect(() => h.playback.releasePriority()).not.toThrow();
    expect(h.playback.priorityRank()).toBe(0);
  });

  it("does not let a release whose clock callback starts a higher alert own that alert", () => {
    const fake = fakeChild();
    const timers: Array<() => void> = [];
    let reenter = false;
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      now: () => {
        if (reenter) {
          reenter = false;
          playback.holdPriority(2);
        }
        return 0;
      },
      schedule: (fn) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }
    });
    playback.holdPriority(1);
    playback.write(new Int16Array(12_000), 1);
    reenter = true;

    playback.releasePriority();

    expect(playback.priorityRank()).toBe(2);
    expect(timers).toEqual([]);
  });
});
