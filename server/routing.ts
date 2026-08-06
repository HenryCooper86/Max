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

import type { NavErrorEvent, NavManeuver, NavRequestEvent, NavRouteEvent } from "../shared/agent";
import type { GeoPoint } from "../shared/geo";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import type { Logger } from "./logger";

const PLACE_ENDPOINT = "https://restapi.amap.com/v5/place/text";
const DRIVING_ENDPOINT = "https://restapi.amap.com/v5/direction/driving";
// A "start" nav.request makes two sequential calls (resolveDestination, then
// planRoute) that together must finish inside the relay's 8 s device-result
// timeout, which also has to cover four WebSocket/HTTP hops (device → relay →
// Amap → relay → device) around those two calls. 2 × 3000 ms caps provider
// time at 6 s, leaving headroom for those hops instead of eating the whole
// budget on the two fetches alone.
const DEFAULT_TIMEOUT_MS = 3000;

type ResolvedDestination = { name: string; location: GeoPoint };
type PlannedRoute = {
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

// A rejected-by-interval reroute returns the current route unchanged, so 10 s
// is the quota guard for chatty riders (or a GPS-jitter off-route loop)
// re-requesting a reroute faster than the routing API should be re-queried.
const DEFAULT_MIN_REROUTE_INTERVAL_MS = 10_000;

function toNavRouteEvent(
  commandId: string,
  destinationName: string,
  destination: GeoPoint,
  planned: PlannedRoute
): NavRouteEvent {
  return {
    type: "nav.route",
    commandId,
    destinationName,
    destination,
    distanceMeters: planned.distanceMeters,
    etaSeconds: planned.etaSeconds,
    polyline: planned.polyline,
    steps: planned.steps
  };
}

/** One instance per session (see AgentSessionController): handles every
 *  `nav.request` the rider's device sends, answering with `nav.route` or
 *  `nav.error` over `send`. Never throws — every provider failure becomes a
 *  `nav.error` so a flaky map API degrades to speech, not a dropped session. */
export function createNavHandler(options: {
  provider: RouteProvider;
  send: (payload: NavRouteEvent | NavErrorEvent) => void;
  now?: () => number;
  minRerouteIntervalMs?: number;
}): (event: NavRequestEvent) => Promise<void> {
  const { provider, send, now = Date.now, minRerouteIntervalMs = DEFAULT_MIN_REROUTE_INTERVAL_MS } = options;
  let lastRoute: NavRouteEvent | undefined;
  let lastRerouteAt: number | undefined;

  return async function handleNavRequest(event: NavRequestEvent): Promise<void> {
    if (event.reason === "start") {
      // A new navigation session must never inherit the previous cache —
      // success or failure — or a reroute that lands seconds later (still
      // inside the guard window) could silently resend turn-by-turn for the
      // stale, now-irrelevant destination.
      lastRoute = undefined;
      lastRerouteAt = undefined;
      const resolved = await provider.resolveDestination(event.query ?? "", event.origin);
      if (!resolved) {
        send({ type: "nav.error", commandId: event.commandId, code: "destination.notFound" });
        return;
      }
      const planned = await provider.planRoute(event.origin, resolved.location);
      if (!planned) {
        send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
        return;
      }
      lastRoute = toNavRouteEvent(event.commandId, resolved.name, resolved.location, planned);
      lastRerouteAt = now();
      send(lastRoute);
      return;
    }

    // reason: "reroute" — inside the quota-guard window, resend the cached
    // route unchanged (with the new commandId) instead of calling the
    // provider again. Only when the request targets the SAME destination as
    // the cache: the client echoes nav.route's destination verbatim, so an
    // exact match means "still routing to what we already answered" and a
    // mismatch means the rider (or app) asked for somewhere new, which must
    // always get a fresh plan rather than the old destination's turn-by-turn.
    if (
      lastRoute &&
      lastRerouteAt !== undefined &&
      now() - lastRerouteAt < minRerouteIntervalMs &&
      event.destination &&
      event.destination.lat === lastRoute.destination.lat &&
      event.destination.lon === lastRoute.destination.lon
    ) {
      send({ ...lastRoute, commandId: event.commandId });
      return;
    }

    const destination = event.destination;
    if (!destination) {
      send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
      return;
    }
    const planned = await provider.planRoute(event.origin, destination);
    if (!planned) {
      send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
      return;
    }
    lastRoute = toNavRouteEvent(event.commandId, event.destinationName ?? "", destination, planned);
    lastRerouteAt = now();
    send(lastRoute);
  };
}
