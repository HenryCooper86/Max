import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPoweroffController, type PoweroffCue } from "../rdk/agent/src/device/poweroff";
import { runPoweroffCommand } from "../rdk/agent/src/main";

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

describe("runPoweroffCommand", () => {
  /** A real EventEmitter, so an unlistened 'error' throws exactly as a real
   *  ChildProcess does — that is the production failure being pinned, not a
   *  property of the fake. */
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    return child;
  }

  it("survives and reports a shutdown binary that cannot be spawned", () => {
    const child = fakeChild();
    const log = vi.fn();
    runPoweroffCommand({ spawn: () => child, log });
    // Node reports spawn failures asynchronously on the child, not by throwing
    // from spawn(). With no listener this is an unhandled 'error' event, which
    // took the whole agent down after the rider had already heard the final tone.
    expect(() => child.emit("error", new Error("spawn /usr/sbin/shutdown ENOENT"))).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });

  it("spawns the real poweroff command and lets the process outlive the agent", () => {
    const child = fakeChild();
    const unref = vi.spyOn(child, "unref");
    const spawn = vi.fn(() => child);
    runPoweroffCommand({ spawn, log: vi.fn() });
    expect(spawn).toHaveBeenCalledWith("/usr/sbin/shutdown", ["-h", "now"]);
    expect(unref).toHaveBeenCalled();
  });
});

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
