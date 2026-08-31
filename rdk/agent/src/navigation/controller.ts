import type {
  DeviceResultEvent,
  NavErrorEvent,
  NavPromptEvent,
  NavRequestEvent,
  NavRouteEvent
} from "../../../../shared/agent";
import {
  INITIAL_PROGRESS,
  step,
  type GuidanceProgress,
  type GuidanceUpdate,
  type PromptThreshold
} from "../../../../shared/guidance";
import type { DeviceCommand } from "../device/dispatch";
import type { PhoneFix, PhoneLocationSource, PhoneLocationState } from "./phone-location";

const DEFAULT_ROUTE_TIMEOUT_MS = 7_000;
const REROUTE_COOLDOWN_MS = 20_000;
const LOCATION_LOST_PROMPT_COOLDOWN_MS = 60_000;

/**
 * Most points the HUD's route polyline may carry.
 *
 * The bench card is a 280×160 viewBox, so a route drawn with more than ~150
 * points spends the extra ones sub-pixel: nothing a developer can see. Amap
 * returns every shape point of every step, which is thousands for a
 * multi-kilometre route, and the cost is paid far more often than once:
 * `createHudServer`'s `publish` re-serialises the entire `HudState` — route
 * included — to every socket on every frame, and the page rebuilds the whole
 * SVG subtree from each message. Capping here is what keeps both bounded on a
 * 3 GB aarch64 board. It also keeps `computeBounds`' `Math.min(...lats)` off a
 * multi-thousand-element spread.
 */
const HUD_POLYLINE_MAX_POINTS = 150;

type Timer = ReturnType<typeof setTimeout>;

export type RdkNavigationSnapshot = {
  phase: "idle" | "starting" | "guiding" | "rerouting" | "paused";
  destinationName?: string;
  instruction?: string;
  distanceToManeuverMeters?: number;
  remainingMeters?: number;
  remainingSeconds?: number;
  offRoute?: boolean;
  /** GCJ-02, like every other coordinate here. Present only once a fix exists. */
  position?: { lat: number; lon: number };
  location?: PhoneLocationState;
};

/** What the bench HUD needs to draw a route: the line, and where the turns
 *  are. Deliberately not `NavRouteEvent` — instruction text and
 *  `alongRouteMeters` already reach the HUD through the snapshot. */
export type RdkRouteGeometry = {
  destinationName?: string;
  polyline: Array<{ lat: number; lon: number }>;
  steps: Array<{ lat: number; lon: number }>;
};

export type RdkNavigationController = {
  handleCommand(command: DeviceCommand): Promise<DeviceResultEvent>;
  handleRoute(event: NavRouteEvent): void;
  handleError(event: NavErrorEvent): void;
  handleFix(fix: PhoneFix): void;
  handleLocationState(state: PhoneLocationState): void;
  close(): void;
};

type PendingStart = {
  generation: number;
  deviceCommandId: string;
  query: string;
  navCommandId?: string;
  timer?: Timer;
  resolve: (result: DeviceResultEvent) => void;
};

type PendingReroute = {
  generation: number;
  commandId: string;
  /** Same bound the start path puts on a nav.request. Without it an answer the
   *  relay never sends leaves this record set forever, `maybeReroute` returns
   *  early on every later fix, and the rider is stuck in `rerouting` for the
   *  rest of the session — no further attempt, no way back to `guiding`. */
  timer?: Timer;
};

type FinishingNavigation = {
  generation: number;
  route: NavRouteEvent;
  token: symbol;
};

type OneShotPrompt = {
  status: "eligible" | "emitting" | "delivered" | "suppressed";
};

function eligibleOneShot(): OneShotPrompt {
  return { status: "eligible" };
}

function copyLocation(state: PhoneLocationState): PhoneLocationState {
  return { ...state };
}

function copyRoute(route: NavRouteEvent): NavRouteEvent {
  return {
    ...route,
    destination: { ...route.destination },
    polyline: route.polyline.map((point) => ({ ...point })),
    steps: route.steps.map((maneuver) => ({ ...maneuver }))
  };
}

/**
 * Thin an over-long polyline to `HUD_POLYLINE_MAX_POINTS` by uniform stride.
 *
 * The first and last points are always kept exactly — the route has to start
 * and end where it really does — and a polyline already within the cap is
 * returned untouched. A uniform stride is deliberate: the card is an overview,
 * not a map, so shape-preserving simplification (Douglas-Peucker) would cost
 * more than the difference is worth at this size. Only the polyline is ever
 * thinned; maneuver markers are few and each one marks a turn.
 */
function decimatePolyline<T>(polyline: readonly T[]): T[] {
  if (polyline.length <= HUD_POLYLINE_MAX_POINTS) return [...polyline];
  const lastIndex = polyline.length - 1;
  const stride = lastIndex / (HUD_POLYLINE_MAX_POINTS - 1);
  const thinned: T[] = [];
  for (let slot = 0; slot < HUD_POLYLINE_MAX_POINTS - 1; slot += 1) {
    thinned.push(polyline[Math.round(slot * stride)]!);
  }
  thinned.push(polyline[lastIndex]!);
  return thinned;
}

function result(commandId: string, status: DeviceResultEvent["status"], reason?: string): DeviceResultEvent {
  return {
    type: "device.result",
    commandId,
    status,
    ...(reason === undefined ? {} : { reason })
  };
}

export function createRdkNavigationController(options: {
  location: Pick<PhoneLocationSource, "waitForUsableFix" | "latest">;
  sendEvent: (event: NavRequestEvent | NavPromptEvent) => void;
  onState: (state: RdkNavigationSnapshot) => void;
  canPrompt: () => boolean;
  interruptOrdinaryPlayback: () => void;
  onRoute?: (route: RdkRouteGeometry | null) => void;
  now?: () => number;
  randomId?: () => string;
  routeTimeoutMs?: number;
}): RdkNavigationController {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const routeTimeoutMs = options.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;

  let closed = false;
  let generation = 0;
  let revision = 0;
  let pendingStart: PendingStart | undefined;
  let activeRoute: NavRouteEvent | undefined;
  let progress: GuidanceProgress = { ...INITIAL_PROGRESS, firedThresholds: [] };
  let reroute: PendingReroute | undefined;
  let lastRerouteSentAt: number | undefined;
  let locationState: PhoneLocationState | undefined;
  let locationUsableForGuidance = false;
  let offRoutePrompt = eligibleOneShot();
  let locationLostPrompt = eligibleOneShot();
  let lastLocationLostPromptAt: number | undefined;
  let finishing: FinishingNavigation | undefined;
  let snapshot: RdkNavigationSnapshot = { phase: "idle" };

  /** The freshest fix, for the HUD's rider dot. Never allowed to break a
   *  publish: a closed or throwing source simply means "no dot yet". */
  function latestPosition(): { lat: number; lon: number } | undefined {
    try {
      const fix = options.location.latest();
      return fix === undefined ? undefined : { lat: fix.position.lat, lon: fix.position.lon };
    } catch {
      return undefined;
    }
  }

  function emitRoute(route: NavRouteEvent | undefined): void {
    if (options.onRoute === undefined) return;
    const geometry: RdkRouteGeometry | null =
      route === undefined
        ? null
        : {
            ...(route.destinationName === undefined ? {} : { destinationName: route.destinationName }),
            polyline: decimatePolyline(route.polyline).map((point) => ({ lat: point.lat, lon: point.lon })),
            steps: route.steps.map((maneuver) => ({ lat: maneuver.lat, lon: maneuver.lon }))
          };
    try {
      options.onRoute(geometry);
    } catch {
      // A HUD observer cannot own or interrupt the navigation lifecycle,
      // matching how `publish` treats `onState`.
    }
  }

  function publish(next: RdkNavigationSnapshot, expectedRevision = revision): boolean {
    if (revision !== expectedRevision) return false;
    const position = latestPosition();
    const nextFiltered = { ...next };
    delete nextFiltered.position; // Strip any inherited stale position before stamping fresh one
    snapshot = {
      ...nextFiltered,
      ...(position === undefined ? {} : { position }),
      ...(next.location === undefined ? {} : { location: copyLocation(next.location) })
    };
    try {
      options.onState({
        ...snapshot,
        ...(snapshot.location === undefined ? {} : { location: copyLocation(snapshot.location) })
      });
    } catch {
      // State observers cannot own or interrupt the navigation lifecycle.
    }
    return revision === expectedRevision;
  }

  function withLocation(next: Omit<RdkNavigationSnapshot, "location">): RdkNavigationSnapshot {
    return {
      ...next,
      ...(locationState === undefined ? {} : { location: copyLocation(locationState) })
    };
  }

  function publishIdle(): void {
    publish(withLocation({ phase: "idle" }));
  }

  function clearReroute(): void {
    if (reroute?.timer !== undefined) clearTimeout(reroute.timer);
    reroute = undefined;
  }

  function clearRouteState(): void {
    activeRoute = undefined;
    progress = { ...INITIAL_PROGRESS, firedThresholds: [] };
    clearReroute();
    lastRerouteSentAt = undefined;
    offRoutePrompt = eligibleOneShot();
    locationLostPrompt = eligibleOneShot();
    lastLocationLostPromptAt = undefined;
    locationUsableForGuidance = false;
    finishing = undefined;
    emitRoute(undefined);
  }

  function clearPendingTimer(pending: PendingStart): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  function cancelPendingStart(): boolean {
    const pending = pendingStart;
    if (!pending) return false;
    pendingStart = undefined;
    clearPendingTimer(pending);
    pending.resolve(result(pending.deviceCommandId, "failed", "navigation.cancelled"));
    return true;
  }

  function failPendingStart(pending: PendingStart, reason: "location.unavailable" | "route.unavailable"): void {
    if (closed || pendingStart !== pending || pending.generation !== generation) return;
    pendingStart = undefined;
    clearPendingTimer(pending);
    clearRouteState();
    publishIdle();
    pending.resolve(result(pending.deviceCommandId, "failed", reason));
  }

  function baseRouteSnapshot(phase: "guiding" | "rerouting" | "paused"): RdkNavigationSnapshot {
    if (!activeRoute) return withLocation({ phase: "idle" });
    return withLocation({
      phase,
      destinationName: activeRoute.destinationName,
      instruction: activeRoute.steps[0]?.instruction,
      distanceToManeuverMeters: activeRoute.steps[0]?.alongRouteMeters ?? activeRoute.distanceMeters,
      remainingMeters: activeRoute.distanceMeters,
      remainingSeconds: activeRoute.etaSeconds,
      offRoute: false
    });
  }

  function updateSnapshot(update: GuidanceUpdate, phase: "guiding" | "rerouting"): RdkNavigationSnapshot {
    if (!activeRoute) return withLocation({ phase: "idle" });
    return withLocation({
      phase,
      destinationName: activeRoute.destinationName,
      ...(update.currentInstruction === null ? {} : { instruction: update.currentInstruction }),
      distanceToManeuverMeters: update.distanceToManeuverMeters,
      remainingMeters: update.remainingMeters,
      remainingSeconds: update.remainingSeconds,
      offRoute: update.offRoute
    });
  }

  function send(event: NavRequestEvent | NavPromptEvent): boolean {
    try {
      options.sendEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  function promptAllowed(): boolean {
    try {
      return options.canPrompt();
    } catch {
      return false;
    }
  }

  function ownsRoute(expectedGeneration: number, route: NavRouteEvent): boolean {
    return !closed && generation === expectedGeneration && activeRoute === route;
  }

  function emitLifecyclePrompt(
    kind: Exclude<NavPromptEvent["kind"], "maneuver">,
    route: NavRouteEvent,
    expectedGeneration: number,
    expectedRevision: number
  ): boolean {
    if (revision !== expectedRevision) return false;
    if (!ownsRoute(expectedGeneration, route)) return false;
    if (!promptAllowed()) return revision === expectedRevision;
    if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return false;
    let promptId: string;
    try {
      promptId = randomId();
    } catch {
      return revision === expectedRevision;
    }
    if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return false;
    send({ type: "nav.prompt", promptId, routeCommandId: route.commandId, kind });
    return revision === expectedRevision;
  }

  function currentOneShot(kind: "offRoute" | "locationLost"): OneShotPrompt {
    return kind === "offRoute" ? offRoutePrompt : locationLostPrompt;
  }

  function emitOneShotPrompt(
    kind: "offRoute" | "locationLost",
    owner: OneShotPrompt,
    route: NavRouteEvent,
    expectedGeneration: number,
    expectedRevision: number
  ): boolean {
    if (owner.status !== "eligible" || currentOneShot(kind) !== owner) return revision === expectedRevision;
    owner.status = "emitting";
    const allowed = promptAllowed();
    if (!allowed) {
      if (currentOneShot(kind) === owner) owner.status = "suppressed";
      return revision === expectedRevision;
    }
    if (!ownsRoute(expectedGeneration, route) || currentOneShot(kind) !== owner) return false;

    let promptId: string;
    try {
      promptId = randomId();
    } catch {
      if (currentOneShot(kind) === owner) owner.status = "suppressed";
      return revision === expectedRevision;
    }
    if (!ownsRoute(expectedGeneration, route) || currentOneShot(kind) !== owner) return false;

    const sent = send({ type: "nav.prompt", promptId, routeCommandId: route.commandId, kind });
    if (currentOneShot(kind) === owner) owner.status = sent ? "delivered" : "suppressed";
    return revision === expectedRevision;
  }

  function emitManeuverPrompt(
    route: NavRouteEvent,
    maneuverIndex: number,
    threshold: PromptThreshold,
    update: GuidanceUpdate,
    expectedGeneration: number,
    expectedRevision: number
  ): boolean {
    if (revision !== expectedRevision) return false;
    if (!ownsRoute(expectedGeneration, route)) return false;
    if (!promptAllowed()) return revision === expectedRevision;
    if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return false;
    const maneuver = route.steps[maneuverIndex];
    if (!maneuver) return true;
    const snappedAlongRouteMeters = route.distanceMeters - update.remainingMeters;
    const distanceMeters = Math.round(Math.max(0, maneuver.alongRouteMeters - snappedAlongRouteMeters));
    let promptId: string;
    try {
      promptId = randomId();
    } catch {
      return revision === expectedRevision;
    }
    if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return false;
    if (threshold === "now") {
      try {
        options.interruptOrdinaryPlayback();
      } catch {
        // A failed playback flush must not replay the already-consumed prompt.
      }
      if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return false;
    }
    send({
      type: "nav.prompt",
      promptId,
      routeCommandId: route.commandId,
      kind: "maneuver",
      maneuverIndex,
      threshold,
      distanceMeters
    });
    return revision === expectedRevision;
  }

  function beginStart(pending: PendingStart): void {
    void (async () => {
      let fix: PhoneFix | undefined;
      try {
        fix = await options.location.waitForUsableFix();
      } catch {
        fix = undefined;
      }
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      if (!fix) {
        failPendingStart(pending, "location.unavailable");
        return;
      }
      const expectedRevision = revision;
      try {
        pending.navCommandId = randomId();
      } catch {
        failPendingStart(pending, "route.unavailable");
        return;
      }
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      if (revision !== expectedRevision) {
        beginStart(pending);
        return;
      }
      pending.timer = setTimeout(() => failPendingStart(pending, "route.unavailable"), routeTimeoutMs);
      const sent = send({
        type: "nav.request",
        commandId: pending.navCommandId,
        reason: "start",
        origin: { ...fix.position },
        query: pending.query
      });
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      if (revision !== expectedRevision) return;
      if (!sent) {
        failPendingStart(pending, "route.unavailable");
      }
    })();
  }

  function handleStart(command: DeviceCommand, expectedRevision: number): Promise<DeviceResultEvent> {
    if (closed) return Promise.resolve(result(command.commandId, "failed", "navigation.cancelled"));
    generation += 1;
    cancelPendingStart();
    clearRouteState();
    const query = typeof command.args["query"] === "string" ? (command.args["query"] as string) : "";
    return new Promise((resolve) => {
      const pending: PendingStart = {
        generation,
        deviceCommandId: command.commandId,
        query,
        resolve
      };
      pendingStart = pending;
      publish(withLocation({ phase: "starting", destinationName: query }), expectedRevision);
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      beginStart(pending);
    });
  }

  function handleStop(command: DeviceCommand, expectedRevision: number): Promise<DeviceResultEvent> {
    const wasActive = pendingStart !== undefined || activeRoute !== undefined;
    if (!wasActive) return Promise.resolve(result(command.commandId, "failed", "navigation.notActive"));
    generation += 1;
    cancelPendingStart();
    clearRouteState();
    publish(withLocation({ phase: "idle" }), expectedRevision);
    return Promise.resolve(result(command.commandId, "ok"));
  }

  function maybeReroute(
    fix: PhoneFix,
    expectedGeneration: number,
    expectedRoute: NavRouteEvent,
    expectedRevision: number
  ): boolean {
    if (revision !== expectedRevision) return false;
    if (closed || generation !== expectedGeneration || activeRoute !== expectedRoute || reroute) return true;
    let sentAt: number;
    try {
      sentAt = now();
    } catch {
      return revision === expectedRevision;
    }
    if (revision !== expectedRevision || !ownsRoute(expectedGeneration, expectedRoute) || reroute) return false;
    if (lastRerouteSentAt !== undefined && sentAt - lastRerouteSentAt < REROUTE_COOLDOWN_MS) return true;
    let commandId: string;
    try {
      commandId = randomId();
    } catch {
      return revision === expectedRevision;
    }
    if (revision !== expectedRevision || !ownsRoute(expectedGeneration, expectedRoute) || reroute) return false;
    reroute = { generation: expectedGeneration, commandId };
    lastRerouteSentAt = sentAt;
    const sent = send({
      type: "nav.request",
      commandId,
      reason: "reroute",
      origin: { ...fix.position },
      destination: { ...expectedRoute.destination },
      destinationName: expectedRoute.destinationName
    });
    if (closed || generation !== expectedGeneration || activeRoute !== expectedRoute) return false;
    if (!sent) {
      if (reroute?.commandId === commandId) clearReroute();
      return revision === expectedRevision;
    }
    // Armed only for a request actually on the wire, and identity-checked in
    // the callback: send() is an injected boundary that may already have
    // replaced this reroute, ended the route, or closed the controller.
    if (reroute?.commandId === commandId) {
      reroute.timer = setTimeout(() => abandonReroute(commandId, expectedGeneration, expectedRoute), routeTimeoutMs);
    }
    return revision === expectedRevision;
  }

  /**
   * A reroute nobody answered. Unlike `nav.error`, this is not evidence that no
   * route exists — only that a reply went missing — so navigation continues on
   * the route the rider is already following rather than ending. Dropping the
   * record is what lets a later off-route fix ask again, still behind the
   * 20 s cooldown.
   */
  function abandonReroute(commandId: string, expectedGeneration: number, expectedRoute: NavRouteEvent): void {
    const outstanding = reroute;
    if (!outstanding || outstanding.commandId !== commandId) return;
    if (!ownsRoute(expectedGeneration, expectedRoute)) return;
    clearReroute();
    publish({ ...snapshot, phase: "guiding" }, ++revision);
  }

  function installRoute(event: NavRouteEvent, expectedRevision: number): void {
    activeRoute = copyRoute(event);
    emitRoute(activeRoute);
    progress = { ...INITIAL_PROGRESS, firedThresholds: [] };
    clearReroute();
    offRoutePrompt = eligibleOneShot();
    locationLostPrompt = eligibleOneShot();
    lastLocationLostPromptAt = undefined;
    locationUsableForGuidance = false;
    finishing = undefined;
    const route = activeRoute;
    snapshot = baseRouteSnapshot("paused");

    let currentFix: PhoneFix | undefined;
    try {
      currentFix = options.location.latest();
    } catch {
      currentFix = undefined;
    }
    if (revision !== expectedRevision || !ownsRoute(generation, route)) return;

    locationUsableForGuidance = currentFix !== undefined && locationState?.usable !== false;
    if (locationUsableForGuidance) {
      publish(baseRouteSnapshot("guiding"), expectedRevision);
      return;
    }

    const owner = locationLostPrompt;
    if (!emitOneShotPrompt("locationLost", owner, route, generation, expectedRevision)) return;
    publish(baseRouteSnapshot("paused"), expectedRevision);
  }

  const controller: RdkNavigationController = {
    handleCommand(command): Promise<DeviceResultEvent> {
      if (command.action === "navigation.start") return handleStart(command, ++revision);
      if (command.action === "navigation.stop") {
        if (pendingStart === undefined && activeRoute === undefined) {
          return Promise.resolve(result(command.commandId, "failed", "navigation.notActive"));
        }
        return handleStop(command, ++revision);
      }
      return Promise.resolve(result(command.commandId, "unsupported"));
    },

    handleRoute(event): void {
      if (closed) return;
      const pending = pendingStart;
      if (pending?.navCommandId === event.commandId && pending.generation === generation) {
        const expectedRevision = ++revision;
        pendingStart = undefined;
        clearPendingTimer(pending);
        installRoute(event, expectedRevision);
        pending.resolve(result(pending.deviceCommandId, "ok"));
        return;
      }
      if (!activeRoute || !reroute || reroute.commandId !== event.commandId || reroute.generation !== generation) {
        return;
      }
      installRoute(event, ++revision);
    },

    handleError(event): void {
      if (closed) return;
      const pending = pendingStart;
      if (pending?.navCommandId === event.commandId && pending.generation === generation) {
        const expectedRevision = ++revision;
        pendingStart = undefined;
        clearPendingTimer(pending);
        clearRouteState();
        publish(withLocation({ phase: "idle" }), expectedRevision);
        pending.resolve(result(pending.deviceCommandId, "failed", event.code));
        return;
      }
      const route = activeRoute;
      const outstanding = reroute;
      if (
        !route ||
        !outstanding ||
        outstanding.commandId !== event.commandId ||
        outstanding.generation !== generation
      ) {
        return;
      }
      const expectedRevision = ++revision;
      const expectedGeneration = generation;
      clearReroute();
      const terminal: FinishingNavigation = { generation: expectedGeneration, route, token: Symbol() };
      finishing = terminal;
      emitLifecyclePrompt("rerouteFailed", route, expectedGeneration, expectedRevision);
      if (closed || generation !== expectedGeneration || activeRoute !== route || finishing?.token !== terminal.token) {
        return;
      }
      clearRouteState();
      publishIdle();
    },

    handleFix(fix): void {
      if (closed) return;
      const route = activeRoute;
      if (!route || finishing || !locationUsableForGuidance) return;
      const expectedRevision = ++revision;
      const expectedGeneration = generation;
      locationLostPrompt = eligibleOneShot();
      const maneuverIndex = progress.maneuverIndex;
      const update = step(fix.position, route, progress);
      progress = update.progress;

      if (update.arrived) {
        const terminal: FinishingNavigation = { generation: expectedGeneration, route, token: Symbol() };
        finishing = terminal;
        emitLifecyclePrompt("arrived", route, expectedGeneration, expectedRevision);
        if (
          closed ||
          generation !== expectedGeneration ||
          activeRoute !== route ||
          finishing?.token !== terminal.token
        ) {
          return;
        }
        clearRouteState();
        publishIdle();
        return;
      }

      if (update.spokenPrompt && update.firedThreshold) {
        if (
          !emitManeuverPrompt(route, maneuverIndex, update.firedThreshold, update, expectedGeneration, expectedRevision)
        ) {
          return;
        }
      }

      if (update.offRoute) {
        if (offRoutePrompt.status === "eligible") {
          const owner = offRoutePrompt;
          if (!emitOneShotPrompt("offRoute", owner, route, expectedGeneration, expectedRevision)) return;
        }
        if (!maybeReroute(fix, expectedGeneration, route, expectedRevision)) return;
        if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return;
        publish(updateSnapshot(update, reroute ? "rerouting" : "guiding"), expectedRevision);
        return;
      }

      offRoutePrompt = eligibleOneShot();
      if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return;
      publish(updateSnapshot(update, reroute ? "rerouting" : "guiding"), expectedRevision);
    },

    handleLocationState(state): void {
      if (closed) return;
      if (finishing) {
        locationState = copyLocation(state);
        locationUsableForGuidance = state.usable;
        return;
      }
      const expectedRevision = ++revision;
      locationState = copyLocation(state);
      locationUsableForGuidance = state.usable;
      const route = activeRoute;
      if (!route) {
        if (pendingStart) {
          publish(withLocation({ phase: "starting", destinationName: pendingStart.query }), expectedRevision);
        } else {
          publish(withLocation({ phase: "idle" }), expectedRevision);
        }
        return;
      }
      if (state.usable) {
        publish({ ...snapshot, location: copyLocation(state) }, expectedRevision);
        return;
      }
      const expectedGeneration = generation;
      // A coarse iOS coordinate is still a live phone heartbeat. Pause route
      // guidance for safety, but do not tell the rider the phone disconnected.
      if (state.reason !== "inaccurate" && locationLostPrompt.status === "eligible") {
        const owner = locationLostPrompt;
        let promptAt: number | undefined;
        try {
          promptAt = now();
        } catch {
          // A clock failure must not abort the navigation state transition.
        }
        if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return;
        if (
          promptAt !== undefined &&
          lastLocationLostPromptAt !== undefined &&
          promptAt - lastLocationLostPromptAt < LOCATION_LOST_PROMPT_COOLDOWN_MS
        ) {
          owner.status = "suppressed";
        } else {
          if (!emitOneShotPrompt("locationLost", owner, route, expectedGeneration, expectedRevision)) return;
          if (owner.status === "delivered" && promptAt !== undefined) lastLocationLostPromptAt = promptAt;
        }
      }
      if (revision !== expectedRevision || !ownsRoute(expectedGeneration, route)) return;
      publish({ ...snapshot, phase: "paused", location: copyLocation(state) }, expectedRevision);
    },

    close(): void {
      if (closed) return;
      const expectedRevision = ++revision;
      const wasActive = pendingStart !== undefined || activeRoute !== undefined;
      closed = true;
      generation += 1;
      cancelPendingStart();
      clearRouteState();
      if (wasActive) publish(withLocation({ phase: "idle" }), expectedRevision);
    }
  };

  return controller;
}
