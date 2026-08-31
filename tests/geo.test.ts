import { describe, expect, it } from "vitest";
import { wgs84ToGcj02 } from "../shared/geo";

describe("wgs84ToGcj02", () => {
  it("leaves points outside China untouched", () => {
    const tokyo = { lat: 35.683861, lon: 139.77492 };
    expect(wgs84ToGcj02(tokyo)).toEqual(tokyo);
  });

  it("matches the published Shanghai vector to ~10 m", () => {
    // Vector from the eviltransform reference test suite.
    const gcj = wgs84ToGcj02({ lat: 31.1774276, lon: 121.5272106 });
    expect(Math.abs(gcj.lat - 31.17530398)).toBeLessThan(1e-4);
    expect(Math.abs(gcj.lon - 121.53146073)).toBeLessThan(1e-4);
  });

  it("shifts China points by a plausible offset (100–700 m)", () => {
    // Offset measured as degree-hypot of (lat_delta, lon_delta). Longitude degrees
    // are metrically smaller at higher latitudes (lon_m ≈ lat_m * cos(lat)), so the
    // degree-hypot can legitimately exceed the naive 0.0063° ≈ 700 m bound.
    // The test exists to catch datum errors, which produce ~0 or wildly larger values.
    for (const p of [
      { lat: 39.911954, lon: 116.377817 }, // Beijing
      { lat: 22.543847, lon: 113.912316 }, // Shenzhen
      { lat: 31.2304, lon: 121.4737 } // Shanghai
    ]) {
      const gcj = wgs84ToGcj02(p);
      const offsetDeg = Math.hypot(gcj.lat - p.lat, gcj.lon - p.lon);
      expect(offsetDeg).toBeGreaterThan(0.0009);
      expect(offsetDeg).toBeLessThan(0.008);
    }
  });
});
