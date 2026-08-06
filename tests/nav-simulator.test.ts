// tests/nav-simulator.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRideSimulator } from "../src/lib/nav-simulator";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { wgs84ToGcj02 } from "../shared/geo";
import { haversineMeters } from "../shared/guidance";

describe("createRideSimulator", () => {
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
});
