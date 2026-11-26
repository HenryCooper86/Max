import { describe, expect, it, vi } from "vitest";
import { createBargeInGuard } from "../shared/barge-in";

const BASE = { rmsThreshold: 900, windowMs: 600, minFrames: 3, graceMs: 300 };

describe("createBargeInGuard", () => {
  it("honours a barge-in the mic already heard", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    for (let i = 0; i < 3; i += 1) guard.observe(2000, 1000);
    guard.request(confirm, 1000);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("ignores one the mic never heard", () => {
    // Doubao's VAD fired but our echo-cancelled mic heard no rider. While Max
    // is talking, the thing tripping that VAD is his own residual echo.
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    guard.observe(100, 1000);
    guard.request(confirm, 1000);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("waits for the mic when the relay notices first", () => {
    // The relay's VAD is often faster than ours. Discarding the request on
    // arrival would lose the interruption, since it is sent once per turn.
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    guard.request(confirm, 1000);
    expect(confirm).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i += 1) guard.observe(2000, 1120);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("gives up if the mic never agrees within the grace period", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    guard.request(confirm, 1000);
    for (let i = 0; i < 3; i += 1) guard.observe(2000, 1400);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("needs more than a single loud frame, so a transient is not a rider", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    guard.observe(2000, 1000);
    guard.observe(2000, 1020);
    guard.request(confirm, 1030);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("restarts the run when the mic drops quiet", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    guard.observe(2000, 1000);
    guard.observe(2000, 1020);
    guard.observe(100, 1040); // a gap resets the count
    guard.observe(2000, 1060);
    guard.request(confirm, 1070);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("still honours it between syllables, inside the window", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    for (let i = 0; i < 3; i += 1) guard.observe(2000, 1000);
    guard.request(confirm, 1500); // quiet gap, still mid-sentence
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("expires, so an old confirmation cannot authorise a later echo", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    for (let i = 0; i < 3; i += 1) guard.observe(2000, 1000);
    guard.request(confirm, 1700);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms only once, even if the mic keeps hearing the rider", () => {
    const guard = createBargeInGuard(BASE);
    const confirm = vi.fn();
    guard.request(confirm, 1000);
    for (let i = 0; i < 6; i += 1) guard.observe(2000, 1100 + i);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("never blocks when AEC is off, since the mic would be hearing Max", () => {
    const guard = createBargeInGuard({ ...BASE, enabled: false });
    const confirm = vi.fn();
    guard.observe(0, 1000);
    guard.request(confirm, 1000);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
