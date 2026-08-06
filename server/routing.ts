/**
 * Query the Amap v5 REST API to resolve destinations and plan driving routes.
 * Supports place search (resolveDestination) and turn-by-turn directions (planRoute).
 *
 * Returns null on every failure rather than throwing: the caller can speak a
 * fallback message like "我找不到这个地点" instead of crashing if the service
 * is down, the network times out, or the response is malformed.
 *
 * Credentials: `AMAP_API_KEY` (Amap public cloud), not `DOUBAO_API_KEY` /
 * `ARK_API_KEY` — those authenticate the speech socket and vision respectively.
 * AMAP_API_KEY gates navigation and is separate by design.
 */

import type { NavManeuver } from "../shared/agent";
import type { GeoPoint } from "../shared/geo";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import type { Logger } from "./logger";

const PLACE_ENDPOINT = "https://restapi.amap.com/v5/place/text";
const DRIVING_ENDPOINT = "https://restapi.amap.com/v5/direction/driving";
// Must finish well inside the relay's 8 s device-result timeout even when both
// calls (resolve, then plan) run back to back.
const DEFAULT_TIMEOUT_MS = 3500;

export type ResolvedDestination = { name: string; location: GeoPoint };
export type PlannedRoute = {
  distanceMeters: number;
  etaSeconds: number;
  polyline: GeoPoint[];
  steps: NavManeuver[];
};
export type RouteProvider = {
  mode: "amap" | "mock";
  resolveDestination(query: string, near: GeoPoint): Promise<ResolvedDestination | null>;
  planRoute(origin: GeoPoint, destination: GeoPoint): Promise<PlannedRoute | null>;
};

function parseLonLat(pair: string): GeoPoint | null {
  const parts = pair.split(",");
  if (parts.length !== 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function createAmapRouteProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onFailure?: (reason: string) => void;
}): RouteProvider {
  const { apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onFailure } = options;
  const fail = (reason: string) => {
    onFailure?.(reason);
    return null;
  };
  async function getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return fail(`http.${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return fail("network");
    }
  }
  return {
    mode: "amap",
    async resolveDestination(query, near) {
      const url =
        `${PLACE_ENDPOINT}?keywords=${encodeURIComponent(query)}` +
        `&location=${near.lon},${near.lat}&page_size=1&key=${apiKey}`;
      const body = await getJson(url);
      if (!body) return null;
      if (body.status !== "1" || !Array.isArray(body.pois)) return fail("place.status");
      const poi = body.pois[0] as { name?: unknown; location?: unknown } | undefined;
      if (!poi || typeof poi.name !== "string" || typeof poi.location !== "string") return fail("place.empty");
      const location = parseLonLat(poi.location);
      if (!location) return fail("place.location");
      return { name: poi.name, location };
    },
    async planRoute(origin, destination) {
      const url =
        `${DRIVING_ENDPOINT}?origin=${origin.lon},${origin.lat}` +
        `&destination=${destination.lon},${destination.lat}&show_fields=cost,polyline&key=${apiKey}`;
      const body = await getJson(url);
      if (!body) return null;
      const route = body.route as { paths?: unknown } | undefined;
      const path = Array.isArray(route?.paths) ? (route.paths[0] as Record<string, unknown> | undefined) : undefined;
      if (body.status !== "1" || !path) return fail("driving.status");
      const distanceMeters = Number(path.distance);
      const etaSeconds = Number((path.cost as { duration?: unknown } | undefined)?.duration);
      const rawSteps = Array.isArray(path.steps) ? (path.steps as Array<Record<string, unknown>>) : [];
      if (!Number.isFinite(distanceMeters) || !Number.isFinite(etaSeconds) || !rawSteps.length) {
        return fail("driving.shape");
      }
      const polyline: GeoPoint[] = [];
      const steps: NavManeuver[] = [];
      let alongRouteMeters = 0;
      for (const rawStep of rawSteps) {
        const stepDistance = Number(rawStep.step_distance);
        if (
          typeof rawStep.instruction !== "string" ||
          typeof rawStep.polyline !== "string" ||
          !Number.isFinite(stepDistance)
        ) {
          return fail("driving.step");
        }
        const points = rawStep.polyline.split(";").map(parseLonLat);
        if (points.some((p) => p === null) || !points.length) return fail("driving.polyline");
        for (const point of points as GeoPoint[]) {
          const last = polyline.at(-1);
          if (!last || last.lat !== point.lat || last.lon !== point.lon) polyline.push(point);
        }
        alongRouteMeters += stepDistance;
        const end = polyline.at(-1)!;
        steps.push({ instruction: rawStep.instruction, lat: end.lat, lon: end.lon, alongRouteMeters });
      }
      return { distanceMeters, etaSeconds, polyline, steps };
    }
  };
}

export function createMockRouteProvider(): RouteProvider {
  return {
    mode: "mock",
    async resolveDestination(query) {
      return { name: query, location: MOCK_ROUTE.polyline.at(-1)! };
    },
    async planRoute() {
      return MOCK_ROUTE;
    }
  };
}

// Module-level latch for missing-key warning: latches once per process, not once per
// selection (unlike vision.ts's per-instance closure flag). Sessions re-select a provider
// on every connection, so a per-session warn would print for every rider connection. The
// once-per-process latch implements startup semantics — the warning surfaces once when the
// relay boots without AMAP_API_KEY, not once per connection.
let warnedMissingKey = false;

export function selectRouteProvider(amapApiKey: string, log?: Pick<Logger, "warn">): RouteProvider {
  if (amapApiKey) {
    return createAmapRouteProvider({ apiKey: amapApiKey });
  }
  if (!warnedMissingKey) {
    warnedMissingKey = true;
    log?.warn("AMAP_API_KEY is not set; navigation uses the mock route provider");
  }
  return createMockRouteProvider();
}
