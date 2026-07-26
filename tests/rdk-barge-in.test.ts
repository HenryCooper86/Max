import { describe, expect, it } from "vitest";
import { createBargeInGuard } from "../rdk/agent/src/audio/barge-in";

describe("createBargeInGuard", () => {
  it("allows a barge-in the local gate agrees with", () => {
    const guard = createBargeInGuard({ windowMs: 500, now: () => 1000 });
    guard.observe(true, 900);
    expect(guard.allow(1000)).toBe(true);
  });

  it("blocks one the local gate never heard", () => {
    // Doubao's VAD fired but our own mic — already echo-cancelled — heard no
    // rider. While Max is talking the thing tripping that VAD is his own echo.
    const guard = createBargeInGuard({ windowMs: 500, now: () => 1000 });
    guard.observe(false, 900);
    expect(guard.allow(1000)).toBe(false);
  });

  it("still allows it shortly after the rider stops, mid-syllable", () => {
    // Speech has gaps. Requiring the gate to be high at the exact millisecond
    // the event lands would drop real interruptions between words.
    const guard = createBargeInGuard({ windowMs: 500, now: () => 1000 });
    guard.observe(true, 800);
    expect(guard.allow(1200)).toBe(true);
  });

  it("expires, so an old confirmation cannot authorise a later echo", () => {
    const guard = createBargeInGuard({ windowMs: 500, now: () => 1000 });
    guard.observe(true, 800);
    expect(guard.allow(1400)).toBe(false);
  });

  it("never blocks when AEC is off, since the gate would be hearing echo", () => {
    // With no cancellation the local gate hears Max too, so it cannot be used
    // as a witness. Falling back to trusting the relay keeps the old behaviour.
    const guard = createBargeInGuard({ windowMs: 500, now: () => 1000, enabled: false });
    guard.observe(false, 900);
    expect(guard.allow(1000)).toBe(true);
  });
});
