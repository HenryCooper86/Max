/**
 * Pure guidance math ported from the iOS spec (07-24): snap the rider's
 * position onto the route polyline, derive along-route progress, and decide
 * when to advance maneuvers, prompt the rider, or declare arrival. No Date,
 * no I/O, no randomness — the caller owns `GuidanceProgress` across fixes and
 * is free to re-run a step (e.g. after a GPS correction), so nothing here
 * mutates its input in place. Reroute policy (what to do while `offRoute`)
 * belongs to the caller; this module only reports the fact.
 */

import type { GeoPoint } from "./geo";
import type { NavRouteEvent } from "./agent";

type PromptThreshold = "far" | "near" | "now";

export type GuidanceProgress = {
  maneuverIndex: number;
  /** Thresholds already spoken for the *current* maneuver only; cleared on advance. */
  firedThresholds: PromptThreshold[];
  arrived: boolean;
};

export const INITIAL_PROGRESS: GuidanceProgress = {
  maneuverIndex: 0,
  firedThresholds: [],
  arrived: false
};

export type GuidanceUpdate = {
  progress: GuidanceProgress;
  distanceToManeuverMeters: number;
  remainingMeters: number;
  remainingSeconds: number;
  offRoute: boolean;
  arrived: boolean;
  spokenPrompt: string | null;
  currentInstruction: string | null;
};

const EARTH_RADIUS_METERS = 6371008.8;
const OFF_ROUTE_METERS = 50;
const ARRIVAL_METERS = 30;
const MANEUVER_ADVANCE_METERS = 30;

const THRESHOLDS: Array<{ id: PromptThreshold; meters: number }> = [
  { id: "far", meters: 400 },
  { id: "near", meters: 150 },
  { id: "now", meters: 40 }
];

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Standard great-circle distance, R = 6371008.8 m (WGS-84 mean radius). */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

type LocalPoint = { x: number; y: number };

/** Equirectangular projection around `origin`, accurate enough for the
 *  helmet-scale (sub-tens-of-km) segments a single route leg spans. */
function toLocal(origin: GeoPoint, p: GeoPoint): LocalPoint {
  const originLatRad = toRad(origin.lat);
  return {
    x: toRad(p.lon - origin.lon) * EARTH_RADIUS_METERS * Math.cos(originLatRad),
    y: toRad(p.lat - origin.lat) * EARTH_RADIUS_METERS
  };
}

type SegmentSnap = {
  crossTrackMeters: number;
  alongSegmentMeters: number;
  segmentLengthMeters: number;
};

/** Point-to-segment projection: clamps to the segment endpoints (no
 *  extrapolation past a-b) and returns both the cross-track distance and how
 *  far along the segment the projection landed. */
function nearestOnSegment(p: GeoPoint, a: GeoPoint, b: GeoPoint): SegmentSnap {
  const pB = toLocal(a, b);
  const pP = toLocal(a, p);
  const segLenSq = pB.x * pB.x + pB.y * pB.y;
  const segmentLengthMeters = Math.sqrt(segLenSq);
  const t = segLenSq === 0 ? 0 : Math.max(0, Math.min(1, (pP.x * pB.x + pP.y * pB.y) / segLenSq));
  const projX = t * pB.x;
  const projY = t * pB.y;
  const crossTrackMeters = Math.hypot(pP.x - projX, pP.y - projY);
  return { crossTrackMeters, alongSegmentMeters: t * segmentLengthMeters, segmentLengthMeters };
}

type RouteSnap = { crossTrackMeters: number; alongRouteMeters: number };

/** Snaps `position` to the nearest point on the polyline, tracking both
 *  cross-track distance (for off-route) and cumulative along-route distance
 *  (for maneuver/arrival math) from the best-matching segment. */
function snapToRoute(position: GeoPoint, polyline: readonly GeoPoint[]): RouteSnap {
  if (polyline.length === 0) return { crossTrackMeters: Infinity, alongRouteMeters: 0 };
  const first = polyline[0];
  if (polyline.length === 1 && first) {
    return { crossTrackMeters: haversineMeters(position, first), alongRouteMeters: 0 };
  }

  let cumulativeMeters = 0;
  let best: RouteSnap = { crossTrackMeters: Infinity, alongRouteMeters: 0 };
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (!a || !b) continue;
    const snap = nearestOnSegment(position, a, b);
    if (snap.crossTrackMeters < best.crossTrackMeters) {
      best = { crossTrackMeters: snap.crossTrackMeters, alongRouteMeters: cumulativeMeters + snap.alongSegmentMeters };
    }
    cumulativeMeters += snap.segmentLengthMeters;
  }
  return best;
}

/**
 * Advances guidance by one fix. Pure function of (position, route, progress):
 * the caller supplies the previous `GuidanceProgress` and gets the next one
 * back in `progress`, never mutated in place, so a fix can be re-run safely.
 *
 * Port contract for the Kotlin/Swift siblings — keep these five rules
 * identical across platforms so guidance never diverges by device:
 *
 * 1. Single distance metric: every prompt threshold AND the "reached this
 *    maneuver" check both read the SAME along-route distance (maneuver
 *    `alongRouteMeters` − snapped along-route position). There is no second,
 *    straight-line-to-coordinate metric — a curved approach means haversine
 *    distance is a chord shorter than the along-route path, and mixing
 *    metrics lets "reached" (30 m) fire before "now" (40 m), skipping the
 *    safety-critical prompt entirely.
 * 2. Prompt-before-advance ordering: within one fix, the current maneuver's
 *    threshold prompt is decided FIRST, using its pre-advance distance; only
 *    then is the advance condition evaluated. A fix that both crosses the
 *    "now" threshold and reaches the maneuver in the same tick still speaks
 *    the prompt — the returned `progress` reflects the post-advance maneuver,
 *    but `spokenPrompt` is the one that just fired for the maneuver being
 *    left behind.
 * 3. Off-route freezes progression, not just prompts: while `offRoute` is
 *    true, `maneuverIndex` and `firedThresholds` are carried through
 *    unchanged — no prompt fires and no advance happens, however far along
 *    the route the (untrusted) snapped position appears to be. Reroute
 *    policy is the caller's job; this function just reports the fact and
 *    waits.
 * 4. `arrived` is sticky: once true it stays true regardless of subsequent
 *    fixes (a noisy GPS reading after arrival must not un-arrive the rider).
 *    The caller resets it by starting a fresh `GuidanceProgress` for a new
 *    route (e.g. `INITIAL_PROGRESS`), not by any in-band "un-arrive" call.
 * 5. Snap tie-break: when two polyline segments are equidistant, the FIRST
 *    one in array order (lowest index) wins — `snapToRoute` only replaces
 *    the best match on a strictly-smaller cross-track distance.
 * 6. Arrival is a DIFFERENT metric from rule 1 by design: it is the
 *    straight-line (haversine) distance from the fix to the route's final
 *    polyline vertex, not an along-route distance. It is evaluated on every
 *    fix regardless of `offRoute` — arrival wins over off-route, because a
 *    rider who is close enough to the destination but has drifted off the
 *    plotted polyline (parking lot, driveway, wrong side of a divided road)
 *    must still be told they've arrived; the web controller relies on this
 *    to end navigation in that case. Like rule 4, arrival is sticky: once
 *    `arrived` is true it stays true regardless of subsequent fixes, and the
 *    caller resets it only by starting a new route (a fresh
 *    `GuidanceProgress`), never by an in-band "un-arrive" call.
 */
export function step(position: GeoPoint, route: NavRouteEvent, progress: GuidanceProgress): GuidanceUpdate {
  const snap = snapToRoute(position, route.polyline);
  const offRoute = snap.crossTrackMeters > OFF_ROUTE_METERS;

  const lastPoint = route.polyline[route.polyline.length - 1];
  const distanceToDestination = lastPoint ? haversineMeters(position, lastPoint) : Infinity;
  const arrived = progress.arrived || distanceToDestination <= ARRIVAL_METERS;

  const steps = route.steps;
  let maneuverIndex = progress.maneuverIndex;
  let firedThresholds = progress.firedThresholds;
  let spokenPrompt: string | null = null;

  // Prompt-then-advance, gated entirely behind on-route — see rules 1–3 above.
  if (!offRoute) {
    const currentManeuver = maneuverIndex < steps.length ? steps[maneuverIndex] : undefined;
    if (currentManeuver) {
      const distanceToManeuver = Math.max(0, currentManeuver.alongRouteMeters - snap.alongRouteMeters);

      const due = THRESHOLDS.filter((t) => distanceToManeuver <= t.meters && !firedThresholds.includes(t.id));
      if (due.length > 0) {
        const urgent = due.reduce((most, candidate) => (candidate.meters < most.meters ? candidate : most));
        firedThresholds = [...firedThresholds, ...due.map((t) => t.id)];
        spokenPrompt =
          urgent.id === "now"
            ? currentManeuver.instruction
            : `前方${Math.round(distanceToManeuver / 50) * 50}米，${currentManeuver.instruction}`;
      }

      const reachedManeuver =
        distanceToManeuver <= MANEUVER_ADVANCE_METERS || snap.alongRouteMeters > currentManeuver.alongRouteMeters;
      const hasNextManeuver = maneuverIndex + 1 < steps.length;
      if (reachedManeuver && hasNextManeuver) {
        maneuverIndex += 1;
        firedThresholds = [];
      }
    }
  }

  const finalManeuver = maneuverIndex < steps.length ? steps[maneuverIndex] : undefined;
  const distanceToManeuverMeters = finalManeuver
    ? Math.max(0, finalManeuver.alongRouteMeters - snap.alongRouteMeters)
    : Math.max(0, route.distanceMeters - snap.alongRouteMeters);
  const currentInstruction = finalManeuver ? finalManeuver.instruction : null;

  const remainingMeters = Math.max(0, route.distanceMeters - snap.alongRouteMeters);
  const remainingSeconds = route.distanceMeters > 0 ? (route.etaSeconds * remainingMeters) / route.distanceMeters : 0;

  return {
    progress: { maneuverIndex, firedThresholds, arrived },
    distanceToManeuverMeters,
    remainingMeters,
    remainingSeconds,
    offRoute,
    arrived,
    spokenPrompt: offRoute ? null : spokenPrompt,
    currentInstruction
  };
}
