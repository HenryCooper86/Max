/**
 * Demo ride simulator: walks a route polyline at a constant speed on a fixed
 * tick, so `useHelmetAgent` can drive `NavigationController.updatePosition`
 * for a 演示导航/演示偏航 rehearsal without a real GPS fix.
 *
 * Every fixture polyline (`MOCK_ROUTE`, and every real `nav.route` answer) is
 * GCJ-02 (see `shared/geo.ts`), and `NavigationController.updatePosition`
 * converts every fix it receives WGS84→GCJ02 before snapping it to the route.
 * A position emitted here must therefore *arrive* on the intended GCJ-02
 * point only after that conversion. This codebase deliberately has no
 * GCJ→WGS inverse (see the comment in `geo.ts`), so rather than inverting the
 * transform exactly, this subtracts the local offset the forward transform
 * would apply at the target point: for the sub-hundred-meter segments one
 * route leg spans, `wgs84ToGcj02`'s offset changes negligibly between the
 * target and its own WGS-equivalent, so
 * `wgs ≈ target − (wgs84ToGcj02(target) − target)` lands within ~2 m of the
 * intended GCJ-02 point — far below the 50 m off-route / 30 m arrival
 * thresholds `shared/guidance.ts` applies.
 */

import { wgs84ToGcj02, type GeoPoint } from "../../shared/geo";
import { haversineMeters } from "../../shared/guidance";

const DEFAULT_TICK_MS = 1000;
const DEFAULT_SPEED_MPS = 12;

// Detour run: ticks 4-6 (1-indexed by fire count) shift this many degrees of
// longitude east — ≈190 m at these latitudes, comfortably past the 50 m
// off-route threshold in shared/guidance.ts — then the walk returns to the
// true polyline on tick 7.
const DETOUR_OFFSET_LON_DEG = 0.002;
const DETOUR_FIRST_TICK = 4;
const DETOUR_LAST_TICK = 6;

/** Linear interpolation along the polyline's segments by cumulative
 *  haversine distance from the start; clamps to the final vertex once
 *  `distanceMeters` exceeds the route's total length. */
function pointAtDistance(polyline: readonly GeoPoint[], distanceMeters: number): GeoPoint {
  const first = polyline[0];
  if (!first) return { lat: 0, lon: 0 };
  if (polyline.length === 1) return first;

  let remaining = Math.max(0, distanceMeters);
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (!a || !b) continue;
    const segmentMeters = haversineMeters(a, b);
    if (remaining <= segmentMeters) {
      const t = segmentMeters === 0 ? 0 : remaining / segmentMeters;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    remaining -= segmentMeters;
  }
  return polyline[polyline.length - 1] ?? first;
}

/** Inverse-offset approximation — see the module doc comment. */
function wgsEquivalentOf(target: GeoPoint): GeoPoint {
  const gcj = wgs84ToGcj02(target);
  return { lat: target.lat - (gcj.lat - target.lat), lon: target.lon - (gcj.lon - target.lon) };
}

export function createRideSimulator(options: {
  route: { polyline: readonly GeoPoint[] };
  tickMs?: number;
  speedMps?: number;
  onPosition: (position: GeoPoint) => void;
}): { start(detour: boolean): void; stop(): void } {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const speedMps = options.speedMps ?? DEFAULT_SPEED_MPS;
  const { route, onPosition } = options;

  const routeLength = route.polyline
    .slice(1)
    .reduce((total, point, index) => total + haversineMeters(route.polyline[index]!, point), 0);

  let timer: ReturnType<typeof setInterval> | null = null;
  let tickCount = 0;

  function emitTick(detour: boolean): void {
    tickCount += 1;
    const distanceMeters = tickCount * speedMps * (tickMs / 1000);
    const target = pointAtDistance(route.polyline, distanceMeters);
    const arrived = distanceMeters >= routeLength;
    const shifted =
      !arrived && detour && tickCount >= DETOUR_FIRST_TICK && tickCount <= DETOUR_LAST_TICK
        ? { lat: target.lat, lon: target.lon + DETOUR_OFFSET_LON_DEG }
        : target;
    // Stop before invoking the consumer, which may start a new simulation.
    if (arrived) stop();
    onPosition(wgsEquivalentOf(shifted));
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start(detour: boolean): void {
    stop();
    tickCount = 0;
    if (route.polyline.length === 0) return;
    timer = setInterval(() => emitTick(detour), tickMs);
  }

  return { start, stop };
}
