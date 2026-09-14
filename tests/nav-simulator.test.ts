// tests/nav-simulator.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRideSimulator } from "../src/lib/nav-simulator";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { wgs84ToGcj02 } from "../shared/geo";
import { haversineMeters } from "../shared/guidance";

describe("createRideSimulator", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("emits positions that land on the GCJ-02 route after conversion", () => {
    vi.useFakeTimers();
    const emitted: Array<{ lat: number; lon: number }> = [];
    const sim = createRideSimulator({
      route: MOCK_ROUTE,
      tickMs: 1000,
      speedMps: 12,
      onPosition: (p) => emitted.push(p)
    });
    sim.start(false);
    vi.advanceTimersByTime(3000);
    sim.stop();
    expect(emitted.length).toBe(3);
    const gcj = wgs84ToGcj02(emitted[0]);
    const start = MOCK_ROUTE.polyline[0];
    expect(haversineMeters(gcj, start)).toBeLessThan(30);
    vi.useRealTimers();
  });

  it("leaves the route during a detour run", () => {
    vi.useFakeTimers();
    const emitted: Array<{ lat: number; lon: number }> = [];
    const sim = createRideSimulator({
      route: MOCK_ROUTE,
      tickMs: 1000,
      speedMps: 12,
      onPosition: (p) => emitted.push(p)
    });
    sim.start(true);
    vi.advanceTimersByTime(6000);
    sim.stop();
    const detourPoint = wgs84ToGcj02(emitted[4]);
    const nearestVertex = Math.min(...MOCK_ROUTE.polyline.map((v) => haversineMeters(detourPoint, v)));
    expect(nearestVertex).toBeGreaterThan(50);
    vi.useRealTimers();
  });
  it("emits the destination once and releases its timer", () => {
    vi.useFakeTimers();
    const onPosition = vi.fn();
    const destination = { lat: 31.2301, lon: 121.47 };
    const sim = createRideSimulator({
      route: { polyline: [{ lat: 31.23, lon: 121.47 }, destination] },
      speedMps: 100,
      onPosition
    });
    sim.start(true);
    vi.advanceTimersByTime(60_000);
    expect(onPosition).toHaveBeenCalledTimes(1);
    expect(haversineMeters(wgs84ToGcj02(onPosition.mock.calls[0][0]), destination)).toBeLessThan(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not generate a fabricated position for an empty route", () => {
    vi.useFakeTimers();
    const onPosition = vi.fn();
    const sim = createRideSimulator({ route: { polyline: [] }, onPosition });
    sim.start(false);
    vi.advanceTimersByTime(10_000);
    expect(onPosition).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can restart from its completion callback without losing the new timer", () => {
    vi.useFakeTimers();
    let delivered = 0;
    const sim = createRideSimulator({
      route: { polyline: [{ lat: 31.23, lon: 121.47 }] },
      onPosition: () => {
        if (++delivered === 1) sim.start(false);
      }
    });
    sim.start(false);
    vi.advanceTimersByTime(2_000);
    expect(delivered).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
