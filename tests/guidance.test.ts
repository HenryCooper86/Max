import { describe, expect, it } from "vitest";
import { INITIAL_PROGRESS, haversineMeters, step } from "../shared/guidance";
import type { NavRouteEvent } from "../shared/agent";

const route: NavRouteEvent = {
  type: "nav.route",
  commandId: "t",
  destinationName: "测试终点",
  destination: { lat: 31.24, lon: 121.47 },
  distanceMeters: 1109,
  etaSeconds: 240,
  polyline: [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.235, lon: 121.47 },
    { lat: 31.24, lon: 121.47 }
  ],
  steps: [
    { instruction: "右转", lat: 31.235, lon: 121.47, alongRouteMeters: 555 },
    { instruction: "到达终点", lat: 31.24, lon: 121.47, alongRouteMeters: 1109 }
  ]
};

// Same fixture as `route`, but the destination sits ~100 m past the last
// polyline vertex — arrival must key on the vertex (rule 6), not this coordinate.
const routeWithDestinationPastLastVertex: NavRouteEvent = {
  ...route,
  destination: { lat: 31.2409, lon: 121.47 }
};

describe("haversineMeters", () => {
  it("measures ~1109 m across the test route", () => {
    expect(haversineMeters({ lat: 31.23, lon: 121.47 }, { lat: 31.24, lon: 121.47 })).toBeCloseTo(1109, -1);
  });
});

describe("step", () => {
  it("reports distance to the first maneuver from the start", () => {
    const u = step({ lat: 31.23, lon: 121.47 }, route, INITIAL_PROGRESS);
    expect(u.distanceToManeuverMeters).toBeGreaterThan(540);
    expect(u.distanceToManeuverMeters).toBeLessThan(570);
    expect(u.offRoute).toBe(false);
    expect(u.spokenPrompt).toBeNull(); // 555 m > far threshold
    expect(u.currentInstruction).toBe("右转");
  });

  it("fires far once, then near once, then now once", () => {
    let progress = INITIAL_PROGRESS;
    const at = (lat: number) => {
      const u = step({ lat, lon: 121.47 }, route, progress);
      progress = u.progress;
      return u;
    };
    expect(at(31.232)).toMatchObject({ spokenPrompt: "前方350米，右转", firedThreshold: "far" }); // ~333 m → far
    expect(at(31.2325)).toMatchObject({ spokenPrompt: null, firedThreshold: null }); // far already fired
    expect(at(31.234)).toMatchObject({ spokenPrompt: "前方100米，右转", firedThreshold: "near" }); // ~111 m → near
    expect(at(31.2348)).toMatchObject({ spokenPrompt: "右转", firedThreshold: "now" }); // ~22 m → now
    expect(at(31.2349)).toMatchObject({ spokenPrompt: null, firedThreshold: null });
  });

  it("advances past the maneuver and clears thresholds", () => {
    let progress = INITIAL_PROGRESS;
    for (const lat of [31.232, 31.234, 31.2348, 31.2355]) {
      progress = step({ lat, lon: 121.47 }, route, progress).progress;
    }
    expect(progress.maneuverIndex).toBe(1);
    const u = step({ lat: 31.2355, lon: 121.47 }, route, progress);
    expect(u.currentInstruction).toBe("到达终点");
  });

  it("flags off-route beyond 50 m cross-track", () => {
    // 0.001° lon at lat 31.23 ≈ 95 m east of the line.
    const u = step({ lat: 31.232, lon: 121.471 }, route, INITIAL_PROGRESS);
    expect(u.offRoute).toBe(true);
    expect(u.spokenPrompt).toBeNull(); // no prompts while off-route
  });

  it("arrives within 30 m of the destination", () => {
    let progress = INITIAL_PROGRESS;
    for (const lat of [31.232, 31.234, 31.2348, 31.2355, 31.2398]) {
      progress = step({ lat, lon: 121.47 }, route, progress).progress;
    }
    expect(progress.arrived).toBe(true);
  });

  it("scales remaining time from remaining distance", () => {
    const u = step({ lat: 31.235, lon: 121.47 }, route, INITIAL_PROGRESS);
    expect(u.remainingMeters).toBeGreaterThan(520);
    expect(u.remainingMeters).toBeLessThan(590);
    expect(u.remainingSeconds).toBeGreaterThan(110);
    expect(u.remainingSeconds).toBeLessThan(130);
  });

  it("off-route never advances the maneuver", () => {
    // Along-route projection lands past the first maneuver's 555 m, but
    // ~95 m cross-track keeps this fix off-route: progression must freeze.
    const u = step({ lat: 31.236, lon: 121.471 }, route, INITIAL_PROGRESS);
    expect(u.offRoute).toBe(true);
    expect(u.progress.maneuverIndex).toBe(0);
    expect(u.progress.firedThresholds).toEqual([]);
  });

  it("the now prompt fires before advancement on the same tick", () => {
    // ~22 m along-route from a fresh start: crosses "now" and the 30 m
    // reached radius in the same fix. The prompt for the maneuver just
    // completed must still be reported alongside the post-advance progress.
    const u = step({ lat: 31.2348, lon: 121.47 }, route, INITIAL_PROGRESS);
    expect(u.spokenPrompt).toBe("右转");
    expect(u.firedThreshold).toBe("now");
    expect(u.progress.maneuverIndex).toBe(1);
    expect(u.progress.firedThresholds).toEqual([]);
  });

  it("arrival keys on the last polyline vertex, not the destination", () => {
    // destination is ~100 m past the last vertex (31.24). Fix (a) is ~167 m
    // from the vertex and ~267 m from the destination → not arrived. Fix (b)
    // is ~22 m from the vertex (inside the 30 m radius) but ~122 m from the
    // destination → an engine measuring to `destination` would miss this.
    let progress = INITIAL_PROGRESS;
    const notYet = step({ lat: 31.2385, lon: 121.47 }, routeWithDestinationPastLastVertex, progress);
    progress = notYet.progress;
    expect(notYet.arrived).toBe(false);

    const arrived = step({ lat: 31.2398, lon: 121.47 }, routeWithDestinationPastLastVertex, progress);
    expect(arrived.arrived).toBe(true);
  });
});
