/**
 * Web navigation controller: bridges `device.command` (navigation.start/stop)
 * and the relay's `nav.route`/`nav.error` answers to the pure guidance engine
 * (`shared/guidance.ts`). Plain TypeScript — no React, no DOM — so it is
 * testable headless; `useHelmetAgent` (Task 8) owns wiring it to the socket,
 * the geolocation watch, and React state.
 *
 * Every GPS fix crosses the WGS84→GCJ02 boundary exactly once, in
 * `updatePosition`: everything held here (route, progress, positions in
 * `NavPhase`) is GCJ-02, matching every nav.* coordinate on the wire.
 *
 * Truthful `device.result` ordering: navigation.start's result is HELD until
 * the matching `nav.route` (ok) or `nav.error` (failed, reason = the error
 * code) arrives — never optimistically acked. Every `device.result` goes
 * through the single private `sendResult` below.
 */

import { wgs84ToGcj02, type GeoPoint } from "../../shared/geo";
import { INITIAL_PROGRESS, step, type GuidanceProgress, type GuidanceUpdate } from "../../shared/guidance";
import type { NavErrorEvent, NavRouteEvent } from "../../shared/agent";

/** Client-side cooldown between reroute requests, separate from the relay's
 *  own server-side minimum-interval guard (server/routing.ts) — this one
 *  exists so a rider drifting off-route for many fixes in a row doesn't spam
 *  `nav.request` before the first reroute answer (or its failure) lands. */
const REROUTE_COOLDOWN_MS = 20_000;

export type NavPhase =
  | { phase: "idle" }
  | { phase: "requesting"; query: string }
  | { phase: "guiding"; route: NavRouteEvent; update: GuidanceUpdate; position: GeoPoint };

type DeviceCommand = { commandId: string; action: string; args: Record<string, unknown> };
type AgentEvent = { type: string } & Record<string, unknown>;

export function createNavigationController(deps: {
  sendJson: (payload: unknown) => void;
  speak: (text: string) => void;
  onState: (state: NavPhase) => void;
  now?: () => number;
}): {
  handleDeviceCommand(command: DeviceCommand): boolean;
  handleAgentEvent(event: AgentEvent): void;
  updatePosition(wgs: GeoPoint): void;
  reset(): void;
} {
  const now = deps.now ?? (() => Date.now());

  let lastFix: GeoPoint | null = null;
  // Set only while a navigation.start's device.result is held, awaiting the
  // matching nav.route/nav.error. Never set at the same time as activeRoute.
  let pendingCommandId: string | null = null;
  let activeRoute: NavRouteEvent | null = null;
  let progress: GuidanceProgress = INITIAL_PROGRESS;
  // True while exactly one reroute nav.request is outstanding. The client
  // never has two reroutes in flight at once (this flag itself prevents
  // sending a second), so the next nav.route/nav.error received while guiding
  // and this flag is set is unambiguously that reroute's answer — matched by
  // the flag rather than by re-deriving/storing its commandId.
  let rerouteInFlight = false;
  let lastRerouteSentAt: number | null = null;
  let rerouteSequence = 0;
  // First-off-route-detection-per-excursion latch; cleared once back on route.
  let offRouteAnnounced = false;

  function sendResult(commandId: string, status: "ok" | "failed" | "denied", reason?: string): void {
    deps.sendJson(
      reason !== undefined
        ? { type: "device.result", commandId, status, reason }
        : { type: "device.result", commandId, status }
    );
  }

  function emitIdle(): void {
    deps.onState({ phase: "idle" });
  }

  function emitGuiding(update: GuidanceUpdate, position: GeoPoint): void {
    if (!activeRoute) return;
    deps.onState({ phase: "guiding", route: activeRoute, update, position });
  }

  function resetNavigationState(): void {
    pendingCommandId = null;
    activeRoute = null;
    progress = INITIAL_PROGRESS;
    rerouteInFlight = false;
    lastRerouteSentAt = null;
    offRouteAnnounced = false;
  }

  function isActive(): boolean {
    return pendingCommandId !== null || activeRoute !== null;
  }

  /** Runs one guidance step from `lastFix` and pushes the resulting phase.
   *  Only called where `lastFix` is known-present (start-ack and reroute-ack
   *  both require a prior fix by construction). */
  function stepAndEmit(): void {
    if (!activeRoute || !lastFix) return;
    const position = wgs84ToGcj02(lastFix);
    const update = step(position, activeRoute, progress);
    progress = update.progress;
    emitGuiding(update, position);
  }

  function handleNavigationStart(commandId: string, args: Record<string, unknown>): void {
    if (!lastFix) {
      sendResult(commandId, "denied", "permission.location");
      return;
    }
    const query = typeof args.query === "string" ? args.query : "";
    // Judgment call: navigation.start while a previous request/route is still
    // active supersedes it outright. If the previous start's device.result
    // was already held (never acked/failed), it stays unresolved forever from
    // this controller's side rather than being falsely acked or invented a
    // failure reason for — the relay's own device.result timeout is the
    // documented fallback for silence (see shared/agent.ts DeviceResultEvent).
    // Any late nav.route/nav.error answer for the dropped commandId will not
    // match the new pendingCommandId and is ignored as stale (see below).
    resetNavigationState();
    pendingCommandId = commandId;
    deps.sendJson({
      type: "nav.request",
      commandId,
      reason: "start",
      origin: wgs84ToGcj02(lastFix),
      query
    });
    deps.onState({ phase: "requesting", query });
  }

  function handleNavigationStop(commandId: string): void {
    if (!isActive()) {
      sendResult(commandId, "failed", "navigation.notActive");
      return;
    }
    resetNavigationState();
    sendResult(commandId, "ok");
    emitIdle();
  }

  function handleDeviceCommand(command: DeviceCommand): boolean {
    if (command.action === "navigation.start") {
      handleNavigationStart(command.commandId, command.args);
      return true;
    }
    if (command.action === "navigation.stop") {
      handleNavigationStop(command.commandId);
      return true;
    }
    return false;
  }

  function handleNavRoute(event: NavRouteEvent): void {
    if (pendingCommandId !== null && event.commandId === pendingCommandId) {
      // Answer to the held navigation.start: ack it, enter guiding.
      activeRoute = event;
      progress = INITIAL_PROGRESS;
      const commandId = pendingCommandId;
      pendingCommandId = null;
      sendResult(commandId, "ok");
      stepAndEmit();
      return;
    }
    if (activeRoute && rerouteInFlight) {
      // Reroute answer: swap the route in, restart progress, announce it.
      activeRoute = event;
      progress = INITIAL_PROGRESS;
      rerouteInFlight = false;
      offRouteAnnounced = false;
      deps.speak("已重新规划路线");
      stepAndEmit();
      return;
    }
    // Stale/unknown commandId — a late answer to a superseded start, a
    // duplicate delivery, or any nav.route this controller isn't expecting.
    // Nothing is currently waiting on it: ignore rather than guess.
  }

  function handleNavError(event: NavErrorEvent): void {
    if (pendingCommandId !== null && event.commandId === pendingCommandId) {
      const commandId = pendingCommandId;
      resetNavigationState();
      sendResult(commandId, "failed", event.code);
      emitIdle();
      return;
    }
    if (activeRoute && rerouteInFlight) {
      // The reroute attempt failed while still guiding on the old route.
      // Clear the in-flight marker only — lastRerouteSentAt (and so the 20 s
      // cooldown) still applies from send time, and guidance continues
      // uninterrupted on the existing route rather than aborting the ride.
      // Not spoken: no reroute-failure phrase is specified, and inventing
      // one would go beyond the exact strings this task owns.
      rerouteInFlight = false;
      return;
    }
    // Stale/unknown commandId: nothing active it could belong to. Ignore.
  }

  function handleAgentEvent(event: AgentEvent): void {
    if (event.type === "nav.route") {
      handleNavRoute(event as unknown as NavRouteEvent);
      return;
    }
    if (event.type === "nav.error") {
      handleNavError(event as unknown as NavErrorEvent);
    }
  }

  function maybeSendReroute(position: GeoPoint): void {
    if (!activeRoute || rerouteInFlight) return;
    const cooledDown = lastRerouteSentAt === null || now() - lastRerouteSentAt >= REROUTE_COOLDOWN_MS;
    if (!cooledDown) return;
    rerouteInFlight = true;
    lastRerouteSentAt = now();
    rerouteSequence += 1;
    deps.sendJson({
      type: "nav.request",
      commandId: `reroute-${lastRerouteSentAt}-${rerouteSequence}`,
      reason: "reroute",
      origin: position,
      destination: activeRoute.destination,
      destinationName: activeRoute.destinationName
    });
  }

  function updatePosition(wgs: GeoPoint): void {
    lastFix = wgs;
    if (!activeRoute) return;

    const position = wgs84ToGcj02(wgs);
    const update = step(position, activeRoute, progress);
    progress = update.progress;

    if (update.spokenPrompt) deps.speak(update.spokenPrompt);

    // Arrival takes priority over off-route bookkeeping: the engine derives
    // `arrived` independently of `offRoute` (pure distance-to-destination),
    // so a rider who is technically off-polyline but within the arrival
    // radius should be told they've arrived, not sent through a pointless
    // reroute.
    if (update.arrived) {
      deps.speak("已到达目的地");
      resetNavigationState();
      emitIdle();
      return;
    }

    if (update.offRoute) {
      if (!offRouteAnnounced) {
        offRouteAnnounced = true;
        deps.speak("已偏离路线，正在重新规划");
      }
      maybeSendReroute(position);
      emitGuiding(update, position);
      return;
    }

    offRouteAnnounced = false;
    emitGuiding(update, position);
  }

  function reset(): void {
    lastFix = null;
    resetNavigationState();
  }

  return { handleDeviceCommand, handleAgentEvent, updatePosition, reset };
}
