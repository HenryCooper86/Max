/**
 * Query the Amap v5 REST API to resolve destinations and plan driving routes.
 * Supports place search (resolveDestination) and turn-by-turn directions (planRoute).
 *
 * Empty searches return null; service failures throw and become route.unavailable
 * at the session boundary, so outages never masquerade as missing destinations.
 *
 * Credentials: `AMAP_API_KEY` (Amap public cloud), not `DOUBAO_API_KEY` /
 * `ARK_API_KEY` — those authenticate the speech socket and vision respectively.
 * AMAP_API_KEY gates navigation and is separate by design.
 */

import type { NavErrorEvent, NavManeuver, NavRequestEvent, NavRouteEvent } from "../shared/agent";
import type { GeoPoint } from "../shared/geo";
import { haversineMeters } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { REROUTE_OK_SPEECH, navRouteOkSpeech } from "./device-actions";
import type { Logger } from "./logger";

export type NavHandler = ((event: NavRequestEvent) => Promise<void>) & {
  activeRoute(): NavRouteEvent | undefined;
  /** Drop the cached route without waiting for a new "start" request. Called
   *  by navigation-prompts.ts when the client reports a genuine end of route
   *  (`nav.prompt` kind "arrived"/"rerouteFailed") — see activeRoute's own
   *  staleness caveat below for why this exists and what it still cannot
   *  cover. */
  clearRoute(): void;
};

export type NavPromptSpeech = {
  text: string;
  interrupt: boolean;
  expiresAt?: number;
};

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
    throw new Error(`Amap failure: ${reason}`);
  };
  async function getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return fail(`http.${response.status}`);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail("response.shape");
      const record = body as Record<string, unknown>;
      if (record.status !== "1") {
        const code =
          typeof record.infocode === "string" && /^\d{5}$/.test(record.infocode) ? record.infocode : "unknown";
        return fail(`api.${code}`);
      }
      return record;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Amap failure:")) throw error;
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
      if (body.pois.length === 0) return null;
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
      const etaSeconds = Number((path.cost as { duration?: unknown } | undefined)?.duration);
      const rawSteps = Array.isArray(path.steps) ? (path.steps as Array<Record<string, unknown>>) : [];
      // path.distance is validated as a sanity check but deliberately NOT used:
      // every distance the route reports is derived from the polyline instead
      // (see below), so the guidance engine's snap-to-polyline positions and
      // the maneuvers' alongRouteMeters share one base. Amap's step_distance
      // sums drift from the polyline's haversine length by >100 m on real
      // routes (126 m measured on a 2.8 km ride), which advanced maneuvers and
      // fired the "now" prompt that far early.
      if (!Number.isFinite(Number(path.distance)) || !Number.isFinite(etaSeconds) || !rawSteps.length) {
        return fail("driving.shape");
      }
      const polyline: GeoPoint[] = [];
      const steps: NavManeuver[] = [];
      let cumulativeMeters = 0;
      for (const rawStep of rawSteps) {
        if (
          typeof rawStep.instruction !== "string" ||
          typeof rawStep.polyline !== "string" ||
          !Number.isFinite(Number(rawStep.step_distance))
        ) {
          return fail("driving.step");
        }
        const points = rawStep.polyline.split(";").map(parseLonLat);
        if (points.some((p) => p === null) || !points.length) return fail("driving.polyline");
        for (const point of points as GeoPoint[]) {
          const last = polyline.at(-1);
          if (!last || last.lat !== point.lat || last.lon !== point.lon) {
            if (last) cumulativeMeters += haversineMeters(last, point);
            polyline.push(point);
          }
        }
        const end = polyline.at(-1)!;
        steps.push({
          instruction: rawStep.instruction,
          lat: end.lat,
          lon: end.lon,
          alongRouteMeters: Math.round(cumulativeMeters)
        });
      }
      return { distanceMeters: Math.round(cumulativeMeters), etaSeconds, polyline, steps };
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
// selection (vision.ts's selectVisionProvider uses the same latch and references this comment).
// Sessions re-select a provider on every connection, so a per-session warn would print for every
// rider connection. The once-per-process latch implements startup semantics — the warning
// surfaces once when the relay boots without AMAP_API_KEY, not once per connection.
let warnedMissingKey = false;

export function selectRouteProvider(amapApiKey: string, log?: Pick<Logger, "warn">): RouteProvider {
  if (amapApiKey) {
    return createAmapRouteProvider({
      apiKey: amapApiKey,
      onFailure: (reason) => log?.warn(`Amap navigation failed: ${reason}`)
    });
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
  /** Called exactly once per "start" request answered with nav.route, with
   *  the relay-spoken summary composed from that same route. Never called
   *  for a reroute answer or a nav.error. Providers without a navigation
   *  confirmation path (see AgentProvider.attachNavOkSpeech) omit this. */
  onRouteAnnounced?: (speech: string) => void;
  /** Called exactly once per "reroute" request answered with a FRESH,
   *  non-superseded nav.route — with the fixed REROUTE_OK_SPEECH line. Never
   *  called for the cache-resend fast path (the `lastRoute && …` block
   *  below — pre-await and atomic, so it never needs the epoch guard
   *  either), a superseded reroute, or a nav.error. Unlike onRouteAnnounced,
   *  a reroute has no navigation.start device.command to attach a summary to
   *  (see device-actions.ts's PendingDeviceCommands.attachOkSpeech), so the
   *  relay speaks this line directly through the provider's speakNavLine
   *  rather than reconciling it against a dispatched command. Providers
   *  without a navigation confirmation path (see AgentProvider.speakNavLine)
   *  omit this. */
  onRerouteAnnounced?: (speech: string) => void;
}): NavHandler {
  const {
    provider,
    send,
    now = Date.now,
    minRerouteIntervalMs = DEFAULT_MIN_REROUTE_INTERVAL_MS,
    onRouteAnnounced,
    onRerouteAnnounced
  } = options;
  // Cleared by a new "start" request (below) and by clearRoute() — the latter
  // called from navigation-prompts.ts on a genuine end of route reported by
  // the client. Neither is exhaustive: NavRequestEvent's reason is only
  // "start" | "reroute" (no "stop"), and clearRoute only fires for the two
  // nav.prompt kinds ("arrived"/"rerouteFailed") that unambiguously mean the
  // route is over — a paused route ("locationLost"), a route the client
  // abandons without ever reporting arrival, or a client that goes away
  // entirely (app killed, connectivity lost) never clears this. activeRoute()
  // can therefore still read stale-true after the rider has, in fact,
  // stopped navigating.
  let lastRoute: NavRouteEvent | undefined;
  let lastRerouteAt: number | undefined;
  // Bumped at every "start" request, so an in-flight provider round trip can
  // tell, once it finally resolves, whether it is still the rider's current
  // destination or has been superseded by a later start. session-controller.ts
  // dispatches nav.request fire-and-forget (never awaited), so two starts can
  // legitimately run concurrently here — the phone cancels the old one and
  // fires a new one the instant the rider asks for somewhere else, but the
  // old provider call (Amap, up to a few seconds) keeps running until it
  // settles on its own. Without this guard the later of the two completions
  // to land — not the later of the two REQUESTS — would win: it could
  // overwrite `lastRoute`/`lastRerouteAt` with the abandoned destination and
  // send/announce that destination's summary on top of the correct one
  // already delivered, and a subsequent reroute could then be served from
  // the wrong cached route (the same root cause, so this one guard closes
  // both cases).
  let startEpoch = 0;

  const handleNavRequest = async (event: NavRequestEvent): Promise<void> => {
    const epoch = event.reason === "start" ? ++startEpoch : startEpoch;
    try {
      if (event.reason === "start") {
        // A new navigation session must never inherit the previous cache —
        // success or failure — or a reroute that lands seconds later (still
        // inside the guard window) could silently resend turn-by-turn for the
        // stale, now-irrelevant destination. Unconditional (not epoch-gated):
        // this runs synchronously in the newest start's own call, before any
        // await, so it can never race a stale completion — see the epoch
        // field's comment above for what DOES need gating.
        lastRoute = undefined;
        lastRerouteAt = undefined;
        const resolved = await provider.resolveDestination(event.query ?? "", event.origin);
        // Superseded by a later start while awaiting the provider — drop this
        // completion entirely, including its nav.error case just below: an
        // error reply for a destination the rider already abandoned is exactly
        // as misleading as a stale route would be, and the client is waiting
        // on the newer request's own answer instead.
        if (epoch !== startEpoch) return;
        if (!resolved) {
          send({ type: "nav.error", commandId: event.commandId, code: "destination.notFound" });
          return;
        }
        const planned = await provider.planRoute(event.origin, resolved.location);
        if (epoch !== startEpoch) return; // superseded during the second provider call
        if (!planned) {
          send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
          return;
        }
        lastRoute = toNavRouteEvent(event.commandId, resolved.name, resolved.location, planned);
        lastRerouteAt = now();
        send(lastRoute);
        onRouteAnnounced?.(navRouteOkSpeech(resolved.name, planned.distanceMeters, planned.etaSeconds));
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
        lastRoute = { ...lastRoute, commandId: event.commandId };
        send(lastRoute);
        return;
      }

      const destination = event.destination;
      if (!destination) {
        send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
        return;
      }
      // Epoch guard, mirroring the start path's above exactly: capture before
      // the await, re-check after. Deliberately reuses the SAME startEpoch
      // counter rather than a separate rerouteEpoch — a "start" landing while
      // this reroute's planRoute is still in flight (the rider asked for
      // somewhere new mid-reroute) must supersede it, and bumping startEpoch
      // already gives that for free. This does NOT guard reroute against an
      // overlapping reroute: the client (session-controller.ts's per-session
      // nav.request dispatch) is single-outstanding, so two reroutes racing
      // each other should never occur in practice — a rerouteEpoch bumped here
      // would only defend against a scenario that should be unreachable. If
      // that assumption ever changes, add one, bumped at this same point,
      // exactly like startEpoch's own comment above documents for "start".
      const rerouteEpoch = startEpoch;
      const planned = await provider.planRoute(event.origin, destination);
      // Superseded by a start while awaiting the provider — drop this
      // completion entirely, including its nav.error case just below, same
      // reasoning as the start path's own superseded-completion comment.
      if (rerouteEpoch !== startEpoch) return;
      if (!planned) {
        send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
        return;
      }
      lastRoute = toNavRouteEvent(event.commandId, event.destinationName ?? "", destination, planned);
      lastRerouteAt = now();
      send(lastRoute);
      onRerouteAnnounced?.(REROUTE_OK_SPEECH);
    } catch {
      if (epoch === startEpoch) send({ type: "nav.error", commandId: event.commandId, code: "route.unavailable" });
    }
  };
  handleNavRequest.activeRoute = () => lastRoute;
  handleNavRequest.clearRoute = () => {
    lastRoute = undefined;
    lastRerouteAt = undefined;
  };
  return handleNavRequest;
}
