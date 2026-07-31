import { describe, expect, it } from "vitest";
import { createPoweroffController, type PoweroffCue } from "../rdk/agent/src/device/poweroff";

/** Deterministic timers: the countdown is 10 s of real time nobody wants in CI. */
function fakeTimers() {
  type Entry = { at: number; fn: () => void };
  const timers = new Map<number, Entry>();
  let id = 0;
  let now = 0;
  return {
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
    }
  };
}

function harness() {
  const timers = fakeTimers();
  const cues: PoweroffCue[] = [];
  let executed = 0;
  const controller = createPoweroffController({
    exec: () => {
      executed += 1;
    },
    cue: (kind) => cues.push(kind),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  return { timers, cues, controller, executed: () => executed };
}

describe("createPoweroffController", () => {
  it("arms audibly and does not execute early", () => {
    const h = harness();
    expect(h.controller.schedule()).toBe("scheduled");
    expect(h.cues).toEqual(["armed"]);
    h.timers.advance(9_999);
    expect(h.executed()).toBe(0);
  });

  it("ticks through the window, then plays the final tone and executes once", () => {
    const h = harness();
    h.controller.schedule();
    h.timers.advance(10_000);
    expect(h.cues).toEqual(["armed", "tick", "tick", "tick", "tick", "final"]);
    expect(h.executed()).toBe(1);
  });

  it("cancel inside the window stops everything", () => {
    const h = harness();
    h.controller.schedule();
    h.timers.advance(5_000);
    expect(h.controller.cancel()).toBe(true);
    const at_cancel = [...h.cues];
    h.timers.advance(60_000);
    expect(h.cues).toEqual(at_cancel);
    expect(h.cues[h.cues.length - 1]).toBe("cancelled");
    expect(h.executed()).toBe(0);
  });

  it("a second schedule does not extend or duplicate the countdown", () => {
    const h = harness();
    expect(h.controller.schedule()).toBe("scheduled");
    h.timers.advance(6_000);
    expect(h.controller.schedule()).toBe("already");
    h.timers.advance(4_000);
    expect(h.executed()).toBe(1);
  });

  it("cancel with nothing pending is a truthful no", () => {
    const h = harness();
    expect(h.controller.cancel()).toBe(false);
    expect(h.cues).toEqual([]);
  });

  it("cancel after execution is too late", () => {
    const h = harness();
    h.controller.schedule();
    h.timers.advance(10_000);
    expect(h.controller.cancel()).toBe(false);
    expect(h.executed()).toBe(1);
  });
});
