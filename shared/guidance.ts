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
 * Order of operations per fix: snap → off-route → arrival → prompt the
 * *current* maneuver (suppressed while off-route) → advance the maneuver if
 * reached (clearing its thresholds) → report distance/instruction for
 * whichever maneuver is now current.
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

  const currentManeuver = maneuverIndex < steps.length ? steps[maneuverIndex] : undefined;
  if (currentManeuver) {
    const distanceToManeuver = Math.max(0, currentManeuver.alongRouteMeters - snap.alongRouteMeters);

    if (!offRoute) {
      const due = THRESHOLDS.filter((t) => distanceToManeuver <= t.meters && !firedThresholds.includes(t.id));
      if (due.length > 0) {
        const urgent = due.reduce((most, candidate) => (candidate.meters < most.meters ? candidate : most));
        firedThresholds = [...firedThresholds, ...due.map((t) => t.id)];
        spokenPrompt =
          urgent.id === "now"
            ? currentManeuver.instruction
            : `前方${Math.round(distanceToManeuver / 50) * 50}米，${currentManeuver.instruction}`;
      }
    }

    const straightLineToManeuver = haversineMeters(position, { lat: currentManeuver.lat, lon: currentManeuver.lon });
    const reachedManeuver =
      straightLineToManeuver <= MANEUVER_ADVANCE_METERS || snap.alongRouteMeters > currentManeuver.alongRouteMeters;
    const hasNextManeuver = maneuverIndex + 1 < steps.length;
    if (reachedManeuver && hasNextManeuver) {
      maneuverIndex += 1;
      firedThresholds = [];
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
