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
  | { phase: "locating"; query: string }
  | { phase: "unavailable"; message: string }
  | { phase: "guiding"; route: NavRouteEvent; update: GuidanceUpdate; position: GeoPoint; locationStale?: boolean };

type DeviceCommand = { commandId: string; action: string; args: Record<string, unknown> };
type AgentEvent = { type: string } & Record<string, unknown>;

export function createNavigationController(deps: {
  sendJson: (payload: unknown) => void;

  onState: (state: NavPhase) => void;
  /** True unless location permission is KNOWN to be denied. Mirrors
   *  iOS's `stream.authorization() == .denied` / Android's
   *  `hasLocationPermission()`: checked before the first-fix wait even
   *  starts, so a genuine denial still fails fast with `permission.location`
   *  instead of waiting 8s to tell a rider to go outside. Optional —
   *  defaults to "never denied" so callers (and every existing test) that
   *  don't track permission state keep today's wait-for-fix behavior. */
  hasLocationPermission?: () => boolean;
  now?: () => number;
  /** Injected so tests stay deterministic. Returns a cancel function. */
  schedule?: (ms: number, fn: () => void) => () => void;
}): {
  handleDeviceCommand(command: DeviceCommand): boolean;
  handleAgentEvent(event: AgentEvent): void;
  updatePosition(wgs: GeoPoint & { timestamp?: number; accuracy?: number }): boolean;
  reset(): void;
} {
  const now = deps.now ?? (() => Date.now());
  const hasLocationPermission = deps.hasLocationPermission ?? (() => true);
  const schedule =
    deps.schedule ??
    ((ms: number, fn: () => void) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });

  const FIRST_FIX_ANNOUNCE_MS = 1_500;
  const FIRST_FIX_TIMEOUT_MS = 8_000;

  const NO_FIX_DETAIL = "还没定位到，到室外或空旷处再说一次。";

  let lastFix: GeoPoint | null = null;
  let lastFixAt = 0;
  let cancelFixExpiry: (() => void) | undefined;
  const FIX_MAX_AGE_MS = 10_000;
  function freshFix() {
    return lastFix !== null && now() - lastFixAt < FIX_MAX_AGE_MS;
  }
  let lastGuidance: Extract<NavPhase, { phase: "guiding" }> | undefined;
  let guidancePaused = false;
  function pauseGuidance() {
    if (!activeRoute || guidancePaused) return;
    guidancePaused = true;
    prompt("locationLost");
    const position = wgs84ToGcj02(lastFix!);
    const update = lastGuidance?.route === activeRoute ? lastGuidance.update : step(position, activeRoute, progress);
    deps.onState({ phase: "guiding", route: activeRoute, update, position, locationStale: true });
  }
  // Set only while a start is waiting for its first fix.
  let awaitingFix: { commandId: string; query: string; cancels: (() => void)[] } | null = null;
  // Set only while a navigation.start's device.result is held, awaiting the
  // matching nav.route/nav.error. Never set at the same time as activeRoute.
  let pendingCommandId: string | null = null;
  let activeRoute: NavRouteEvent | null = null;
  let progress: GuidanceProgress = INITIAL_PROGRESS;
  // True while exactly one reroute nav.request is outstanding. The client
  // never has two reroutes in flight at once. Also match its command id so
  // a delayed response from a superseded start cannot replace the route.
  let rerouteInFlight = false;
  let lastRerouteSentAt: number | null = null;
  let rerouteSequence = 0;
  let promptSequence = 0;
  let rerouteCommandId: string | null = null;

  function prompt(kind: "offRoute" | "rerouteFailed" | "arrived" | "locationLost") {
    if (!activeRoute) return;
    deps.sendJson({
      type: "nav.prompt",
      promptId: `web-${++promptSequence}`,
      routeCommandId: activeRoute.commandId,
      kind
    });
  }
  // First-off-route-detection-per-excursion latch; cleared once back on route.
  let offRouteAnnounced = false;

  function clearFixWait(): void {
    awaitingFix?.cancels.forEach((cancel) => cancel());
    awaitingFix = null;
  }

  function sendResult(commandId: string, status: "ok" | "failed" | "denied", reason?: string, detail?: string): void {
    const payload: Record<string, unknown> = { type: "device.result", commandId, status };
    if (reason !== undefined) payload.reason = reason;
    if (detail !== undefined) payload.detail = detail;
    deps.sendJson(payload);
  }

  function emitIdle(): void {
    deps.onState({ phase: "idle" });
  }

  function emitGuiding(update: GuidanceUpdate, position: GeoPoint): void {
    if (!activeRoute) return;
    guidancePaused = false;
    lastGuidance = { phase: "guiding", route: activeRoute, update, position };
    deps.onState(lastGuidance);
  }

  function resetNavigationState(): void {
    lastGuidance = undefined;
    guidancePaused = false;
    pendingCommandId = null;
    activeRoute = null;
    progress = INITIAL_PROGRESS;
    rerouteInFlight = false;
    rerouteCommandId = null;
    lastRerouteSentAt = null;
    offRouteAnnounced = false;
  }

  function isActive(): boolean {
    return pendingCommandId !== null || activeRoute !== null || awaitingFix !== null;
  }

  /** Resolves a still-held navigation.start's device.result before it would
   *  otherwise be silently dropped by a state reset (superseding start, a
   *  start still awaiting its first fix, or stop while requesting/awaiting).
   *  "Exactly one device.result per command; silence is a bug" — leaving it
   *  unresolved would let the relay's own ~8s silence-timeout speak an
   *  unrelated generic failure instead of the truth. `detail` is what the
   *  relay actually speaks (reconciliation prefers `result.detail` over the
   *  FAILURE_SPEECH map), so no server-side change is needed for this to be
   *  heard correctly. `awaitingFix` and `pendingCommandId` are never both
   *  set at once, so at most one branch below fires. No-op when nothing is
   *  held. */
  function cancelHeldStart(): void {
    if (awaitingFix) {
      const commandId = awaitingFix.commandId;
      clearFixWait();
      sendResult(commandId, "failed", "navigation.cancelled", "已取消导航请求。");
    }
    if (pendingCommandId === null) return;
    sendResult(pendingCommandId, "failed", "navigation.cancelled", "已取消导航请求。");
  }

  /** Runs one guidance step from `lastFix` and pushes the resulting phase.
   *  Only called where `lastFix` is known-present (start-ack and reroute-ack
   *  both require a prior fix by construction). */
  function stepAndEmit(): void {
    if (!activeRoute || !lastFix) return;
    if (!freshFix()) {
      pauseGuidance();
      return;
    }
    const position = wgs84ToGcj02(lastFix);
    const update = step(position, activeRoute, progress);
    // Preview the HUD without consuming a prompt that has not been sent.
    emitGuiding(update, position);
  }

  function handleNavigationStart(commandId: string, args: Record<string, unknown>): void {
    const query = typeof args.query === "string" ? args.query : "";
    // Checked before anything else, same as iOS/Android: a genuine denial is
    // not "the fix is merely slow" and must not wait 8s only to arrive at
    // the same conclusion. Mirrors the platforms' own early-return — it does
    // not cancel any unrelated start already held, exactly as neither of
    // theirs does.
    if (!hasLocationPermission()) {
      sendResult(commandId, "denied", "permission.location");
      if (!isActive()) deps.onState({ phase: "unavailable", message: "请在浏览器设置中允许定位，再重新发起导航。" });
      return;
    }
    if (!freshFix()) {
      // Not a permission fault: permission may be granted and the fix merely
      // slow, which is the common case indoors. Wait, say so, and only then
      // fail with copy that names the cause. A previous still-waiting start
      // is resolved FIRST (failed, "navigation.cancelled") — same rule as
      // startWithFix's own supersede — so it is never silently dropped.
      cancelHeldStart();
      resetNavigationState();
      awaitingFix = {
        commandId,
        query,
        cancels: [
          schedule(FIRST_FIX_ANNOUNCE_MS, () => {
            if (awaitingFix?.commandId === commandId) deps.onState({ phase: "locating", query });
          }),
          schedule(FIRST_FIX_TIMEOUT_MS, () => {
            if (awaitingFix?.commandId !== commandId) return;
            clearFixWait();
            deps.onState({ phase: "unavailable", message: NO_FIX_DETAIL });
            sendResult(commandId, "failed", "route.unavailable", NO_FIX_DETAIL);
          })
        ]
      };
      return;
    }
    startWithFix(commandId, query);
  }

  function startWithFix(commandId: string, query: string): void {
    if (!lastFix) return;
    // navigation.start while a previous request/route is still active
    // supersedes it outright. A still-held previous start is resolved FIRST
    // (failed, "navigation.cancelled") — sent before this start's own
    // nav.request — so its device.result is never silently dropped. Any late
    // nav.route/nav.error answer for the dropped commandId will not match the
    // new pendingCommandId and is ignored as stale (see below).
    cancelHeldStart();
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
    // A held start (stop arriving while still "requesting", or while still
    // awaiting its first fix) is resolved BEFORE the stop's own ok, so the
    // spoken sequence is the cancellation followed by the stop confirmation,
    // not the reverse.
    cancelHeldStart();
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
    if (activeRoute && rerouteInFlight && event.commandId === rerouteCommandId) {
      // Reroute answer: swap the route in, restart progress; relay speaks the confirmation.
      activeRoute = event;
      progress = INITIAL_PROGRESS;
      rerouteInFlight = false;
      offRouteAnnounced = false;
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
      deps.onState({
        phase: "unavailable",
        message:
          event.code === "destination.notFound"
            ? "没有找到目的地，请换一个名称重新导航。"
            : "地图服务暂不可用，请稍后重新发起导航。"
      });
      return;
    }
    if (activeRoute && rerouteInFlight && event.commandId === rerouteCommandId) {
      // Spec rule (2026-08-06): a reroute failure mid-ride stops cleanly with
      // a spoken explanation, never leaves the rider guided on a route the
      // engine can no longer correct — matching iOS's and Android's
      // NavigationController, which speak this same line on this same case.
      prompt("rerouteFailed");
      resetNavigationState();
      deps.onState({ phase: "unavailable", message: "重新规划失败，导航已停止。请稍后重新发起导航。" });
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
    rerouteCommandId = `reroute-${lastRerouteSentAt}-${rerouteSequence}`;
    deps.sendJson({
      type: "nav.request",
      commandId: rerouteCommandId,
      reason: "reroute",
      origin: position,
      destination: activeRoute.destination,
      destinationName: activeRoute.destinationName
    });
  }

  function updatePosition(wgs: GeoPoint & { timestamp?: number; accuracy?: number }): boolean {
    const timestamp = wgs.timestamp ?? now();
    if (
      !Number.isFinite(wgs.lat) ||
      !Number.isFinite(wgs.lon) ||
      Math.abs(wgs.lat) > 90 ||
      Math.abs(wgs.lon) > 180 ||
      !Number.isFinite(timestamp) ||
      now() - timestamp >= FIX_MAX_AGE_MS ||
      timestamp > now() + 1000 ||
      (lastFix !== null && timestamp < lastFixAt) ||
      (wgs.accuracy !== undefined && (!Number.isFinite(wgs.accuracy) || wgs.accuracy < 0 || wgs.accuracy > 50))
    )
      return false;
    lastFix = wgs;
    lastFixAt = timestamp;
    cancelFixExpiry?.();
    cancelFixExpiry = schedule(Math.max(1, FIX_MAX_AGE_MS - (now() - timestamp)), pauseGuidance);
    if (awaitingFix) {
      const { commandId, query } = awaitingFix;
      clearFixWait();
      startWithFix(commandId, query);
    }
    if (!activeRoute) return true;

    const position = wgs84ToGcj02(wgs);
    const maneuverIndex = progress.maneuverIndex;
    const update = step(position, activeRoute, progress);
    progress = update.progress;

    if (!update.arrived && update.firedThreshold) {
      const maneuver = activeRoute.steps[maneuverIndex];
      const alongRouteMeters = activeRoute.distanceMeters - update.remainingMeters;
      deps.sendJson({
        type: "nav.prompt",
        promptId: `web-${++promptSequence}`,
        routeCommandId: activeRoute.commandId,
        kind: "maneuver",
        maneuverIndex,
        threshold: update.firedThreshold,
        distanceMeters: Math.max(0, (maneuver?.alongRouteMeters ?? alongRouteMeters) - alongRouteMeters)
      });
    }

    // Arrival takes priority over off-route bookkeeping: the engine derives
    // `arrived` independently of `offRoute` (pure distance-to-destination),
    // so a rider who is technically off-polyline but within the arrival
    // radius should be told they've arrived, not sent through a pointless
    // reroute.
    if (update.arrived) {
      prompt("arrived");
      resetNavigationState();
      emitIdle();
      return true;
    }

    if (update.offRoute) {
      if (!offRouteAnnounced) {
        offRouteAnnounced = true;
        prompt("offRoute");
      }
      maybeSendReroute(position);
      emitGuiding(update, position);
      return true;
    }

    offRouteAnnounced = false;
    emitGuiding(update, position);
    return true;
  }

  function reset(): void {
    cancelFixExpiry?.();
    cancelFixExpiry = undefined;
    lastFix = null;
    clearFixWait();
    resetNavigationState();
  }

  return { handleDeviceCommand, handleAgentEvent, updatePosition, reset };
}
