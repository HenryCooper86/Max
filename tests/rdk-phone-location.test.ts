import { describe, expect, it, vi } from "vitest";
import type { PhoneLocationEvent } from "../shared/agent";

const convert = vi.hoisted(() => vi.fn());

vi.mock("../shared/geo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/geo")>();
  convert.mockImplementation(actual.wgs84ToGcj02);
  return { ...actual, wgs84ToGcj02: convert };
});

import {
  createPhoneLocationSource,
  type PhoneLocationSource,
  type PhoneLocationState
} from "../rdk/agent/src/navigation/phone-location";

function fakeClock(start = 1_000_000) {
  type Entry = { at: number; fn: () => void };
  const timers = new Map<number, Entry>();
  let id = 0;
  let now = start;

  return {
    now: () => now,
    setTimer: ((fn: () => void, ms: number) => {
      id += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimer: ((handle: number) => {
      timers.delete(handle);
    }) as unknown as typeof clearTimeout,
    advance(ms: number): void {
      now += ms;
      for (const [handle, entry] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at <= now && timers.has(handle)) {
          timers.delete(handle);
          entry.fn();
        }
      }
    },
    pending(): number {
      return timers.size;
    }
  };
}

function sharingSource(clock = fakeClock()) {
  const states: PhoneLocationState[] = [];
  const fixes: Array<{ sequence: number }> = [];
  const source = createPhoneLocationSource({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onState: (state) => states.push(state),
    onFix: (fix) => fixes.push(fix)
  });
  source.acceptStatus({ type: "phone.location.status", state: "sharing" });
  return { clock, source, states, fixes };
}

function fix(
  clock: ReturnType<typeof fakeClock>,
  sequence = 1,
  overrides: Partial<PhoneLocationEvent> = {}
): PhoneLocationEvent {
  return {
    type: "phone.location",
    sequence,
    lat: 31.1774276,
    lon: 121.5272106,
    horizontalAccuracyMeters: 5,
    timestamp: clock.now(),
    ...overrides
  };
}

describe("createPhoneLocationSource", () => {
  it("accepts boundary coordinates and converts an accurate WGS-84 fix once", () => {
    const h = sharingSource();
    convert.mockClear();

    expect(h.source.acceptLocation(fix(h.clock, 1, { lat: -90, lon: 180, horizontalAccuracyMeters: 50 }))).toBe(true);
    expect(h.source.latest()).toMatchObject({
      sequence: 1,
      position: { lat: -90, lon: 180 },
      horizontalAccuracyMeters: 50,
      timestamp: h.clock.now()
    });
    expect(convert).toHaveBeenCalledTimes(1);

    expect(h.source.acceptLocation(fix(h.clock, 2))).toBe(true);
    expect(h.source.latest()?.position.lat).toBeCloseTo(31.17530398, 4);
    expect(Math.abs(h.source.latest()!.position.lon - 121.53146073)).toBeLessThan(1e-4);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(h.fixes.map((received) => received.sequence)).toEqual([1, 2]);
  });

  it("drops malformed, out-of-range, stale, future, and non-increasing fixes without conversion or state changes", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock))).toBe(true);
    const truthful = h.source.latest();
    const beforeStates = h.states.length;
    convert.mockClear();

    const rejected = [
      fix(h.clock, 2, { lat: Number.NaN }),
      fix(h.clock, 2, { lon: 180.0001 }),
      fix(h.clock, 2, { horizontalAccuracyMeters: Number.POSITIVE_INFINITY }),
      fix(h.clock, 2, { timestamp: Number.NaN }),
      fix(h.clock, 2, { timestamp: h.clock.now() - 20_001 }),
      fix(h.clock, 2, { timestamp: h.clock.now() + 2_001 }),
      fix(h.clock, 2, { courseDegrees: Number.NaN }),
      fix(h.clock, 2, { courseDegrees: 360.1 }),
      fix(h.clock, 2, { speedMps: Number.POSITIVE_INFINITY }),
      fix(h.clock, 2, { speedMps: -0.1 }),
      fix(h.clock, 1)
    ];
    for (const event of rejected) expect(h.source.acceptLocation(event)).toBe(false);

    expect(h.source.latest()).toEqual(truthful);
    expect(h.states).toHaveLength(beforeStates);
    expect(convert).not.toHaveBeenCalled();
  });

  it("accepts timestamps exactly at the freshness boundaries", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock, 1, { timestamp: h.clock.now() - 20_000 }))).toBe(true);
    expect(h.source.acceptLocation(fix(h.clock, 2, { timestamp: h.clock.now() + 2_000 }))).toBe(true);
  });

  it("pauses immediately for a new well-formed inaccurate update until another accurate fix arrives", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock))).toBe(true);
    const accepted = h.source.latest();
    convert.mockClear();

    expect(h.source.acceptLocation(fix(h.clock, 2, { horizontalAccuracyMeters: 50.01 }))).toBe(false);
    expect(h.source.latest()).toBeUndefined();
    expect(h.states.at(-1)).toMatchObject({ connection: "sharing", usable: false, reason: "inaccurate" });
    expect(convert).not.toHaveBeenCalled();

    expect(h.source.acceptLocation(fix(h.clock, 3))).toBe(true);
    expect(h.source.latest()).toMatchObject({ sequence: 3 });
    expect(h.source.latest()).not.toEqual(accepted);
  });

  it("resets sequence only after a new connected or sharing lifecycle", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock, 4))).toBe(true);
    h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    expect(h.source.acceptLocation(fix(h.clock, 1))).toBe(false);

    h.source.acceptStatus({ type: "phone.location.status", state: "stopped" });
    h.source.acceptStatus({ type: "phone.location.status", state: "connected" });
    h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    expect(h.source.acceptLocation(fix(h.clock, 1))).toBe(true);
  });

  it("ends the lifecycle on received or timer-generated stale and resets a restarted sequence only after status", () => {
    for (const stale of ["received", "timer"] as const) {
      const h = sharingSource();
      expect(h.source.acceptLocation(fix(h.clock, 10))).toBe(true);
      if (stale === "received") {
        h.source.acceptStatus({ type: "phone.location.status", state: "stale" });
      } else {
        h.clock.advance(20_000);
      }

      h.source.acceptStatus({ type: "phone.location.status", state: "connected" });
      h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
      expect(h.source.acceptLocation(fix(h.clock, 1))).toBe(true);
      expect(h.source.acceptLocation(fix(h.clock, 1))).toBe(false);
    }
  });

  it("requires a new sharing or connected status before unpaired and stopped restarts may use sequence one", () => {
    for (const ending of ["unpaired", "stopped"] as const) {
      const h = sharingSource();
      expect(h.source.acceptLocation(fix(h.clock, 8))).toBe(true);
      h.source.acceptStatus({ type: "phone.location.status", state: ending });
      expect(h.source.acceptLocation(fix(h.clock, 1))).toBe(false);
      h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
      expect(h.source.acceptLocation(fix(h.clock, 1))).toBe(true);
    }
  });

  it("keeps duplicate sharing truthful and continues the same sequence through connected then sharing", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock, 10))).toBe(true);
    const statesAfterFix = h.states.length;
    const timersAfterFix = h.clock.pending();

    h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    expect(h.source.latest()).toMatchObject({ sequence: 10 });
    expect(h.states).toHaveLength(statesAfterFix);
    expect(h.clock.pending()).toBe(timersAfterFix);

    h.source.acceptStatus({ type: "phone.location.status", state: "connected" });
    expect(h.source.latest()).toBeUndefined();
    const statesAfterDisconnect = h.states.length;
    h.source.acceptStatus({ type: "phone.location.status", state: "connected" });
    expect(h.states).toHaveLength(statesAfterDisconnect);
    h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    expect(h.source.acceptLocation(fix(h.clock, 10))).toBe(false);
    expect(h.source.acceptLocation(fix(h.clock, 11))).toBe(true);
  });

  it("keeps a duplicate sharing status from overwriting a truthful inaccurate state", () => {
    const h = sharingSource();
    expect(
      h.source.acceptLocation(fix(h.clock, 1, { horizontalAccuracyMeters: 50.01, timestamp: h.clock.now() - 500 }))
    ).toBe(false);
    const before = h.states.length;
    expect(h.states.at(-1)).toMatchObject({
      connection: "sharing",
      usable: false,
      horizontalAccuracyMeters: 50.01,
      ageMs: 500,
      reason: "inaccurate"
    });

    h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    expect(h.states).toHaveLength(before);
    expect(h.states.at(-1)).toMatchObject({ reason: "inaccurate" });
  });

  it("recovers directly from stale only with a higher continuing sequence", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock, 4))).toBe(true);
    h.clock.advance(20_000);
    expect(h.source.acceptLocation(fix(h.clock, 4))).toBe(false);
    expect(h.source.acceptLocation(fix(h.clock, 5))).toBe(true);
    expect(h.source.latest()).toMatchObject({ sequence: 5 });
    expect(h.states.at(-1)).toMatchObject({ connection: "sharing", usable: true });
  });

  it("cancels every accepted-fix effect when onState closes reentrantly", async () => {
    const clock = fakeClock();
    let fixes = 0;
    let states = 0;
    const source: PhoneLocationSource = createPhoneLocationSource({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onState: (state) => {
        states += 1;
        if (state.usable) source.close();
      },
      onFix: () => {
        fixes += 1;
      }
    });
    source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    const first = source.waitForUsableFix();
    const second = source.waitForUsableFix();

    expect(source.acceptLocation(fix(clock))).toBe(true);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(source.latest()).toBeUndefined();
    expect(fixes).toBe(0);
    expect(clock.pending()).toBe(0);
    const statesAfterClose = states;
    clock.advance(60_000);
    expect(states).toBe(statesAfterClose);
  });

  it("does not report a fix after onState reentrantly stops sharing", async () => {
    const clock = fakeClock();
    let fixes = 0;
    let lastState: PhoneLocationState | undefined;
    const source: PhoneLocationSource = createPhoneLocationSource({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onState: (state) => {
        lastState = state;
        if (state.usable) source.acceptStatus({ type: "phone.location.status", state: "stopped" });
      },
      onFix: () => {
        fixes += 1;
      }
    });
    source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    const waiting = source.waitForUsableFix();

    expect(source.acceptLocation(fix(clock))).toBe(true);
    expect(source.latest()).toBeUndefined();
    expect(fixes).toBe(0);
    expect(clock.pending()).toBe(1);
    expect(lastState).toMatchObject({ connection: "stopped", usable: false, reason: "stopped" });
    clock.advance(2_999);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("makes a source timestamp stale exactly twenty seconds later and clears a stale status", () => {
    const h = sharingSource();
    expect(h.source.acceptLocation(fix(h.clock, 1, { timestamp: h.clock.now() - 500 }))).toBe(true);
    h.clock.advance(19_499);
    expect(h.source.latest()).toMatchObject({ sequence: 1 });
    h.clock.advance(1);
    expect(h.source.latest()).toBeUndefined();
    expect(h.states.at(-1)).toMatchObject({ connection: "stale", usable: false, reason: "stale" });
  });

  it("clears usability for relay lifecycle statuses", () => {
    for (const [status, reason] of [
      ["connected", "disconnected"],
      ["stopped", "stopped"],
      ["unpaired", "unpaired"],
      ["stale", "stale"]
    ] as const) {
      const h = sharingSource();
      h.source.acceptLocation(fix(h.clock));
      h.source.acceptStatus({ type: "phone.location.status", state: status });
      expect(h.source.latest()).toBeUndefined();
      expect(h.states.at(-1)).toMatchObject({ connection: status, usable: false, reason });
    }
  });

  it("resolves every current waiter with the accepted fix and times out at the exact default deadline", async () => {
    const h = sharingSource();
    const first = h.source.waitForUsableFix();
    const second = h.source.waitForUsableFix(3_000);
    expect(h.source.acceptLocation(fix(h.clock))).toBe(true);
    await expect(first).resolves.toMatchObject({ sequence: 1 });
    await expect(second).resolves.toMatchObject({ sequence: 1 });

    const timeoutHarness = sharingSource();
    const timeout = timeoutHarness.source.waitForUsableFix();
    timeoutHarness.clock.advance(2_999);
    let settled = false;
    void timeout.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    timeoutHarness.clock.advance(1);
    await expect(timeout).resolves.toBeUndefined();
  });

  it("cancels waiters and future callbacks on idempotent close", async () => {
    const h = sharingSource();
    const waiting = h.source.waitForUsableFix();
    h.source.close();
    h.source.close();
    await expect(waiting).resolves.toBeUndefined();
    const stateCount = h.states.length;
    const fixCount = h.fixes.length;
    h.clock.advance(60_000);
    h.source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    expect(h.source.acceptLocation(fix(h.clock))).toBe(false);
    expect(h.states).toHaveLength(stateCount);
    expect(h.fixes).toHaveLength(fixCount);
    expect(h.clock.pending()).toBe(0);
  });
});
