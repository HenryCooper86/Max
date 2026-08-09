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

type Timer = ReturnType<typeof setTimeout>;

export type RdkNavigationSnapshot = {
  phase: "idle" | "starting" | "guiding" | "rerouting" | "paused";
  destinationName?: string;
  instruction?: string;
  distanceToManeuverMeters?: number;
  remainingMeters?: number;
  remainingSeconds?: number;
  offRoute?: boolean;
  location?: PhoneLocationState;
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
};

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
  now?: () => number;
  randomId?: () => string;
  routeTimeoutMs?: number;
}): RdkNavigationController {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const routeTimeoutMs = options.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;

  let closed = false;
  let generation = 0;
  let pendingStart: PendingStart | undefined;
  let activeRoute: NavRouteEvent | undefined;
  let progress: GuidanceProgress = { ...INITIAL_PROGRESS, firedThresholds: [] };
  let reroute: PendingReroute | undefined;
  let lastRerouteSentAt: number | undefined;
  let locationState: PhoneLocationState | undefined;
  let offRouteAnnounced = false;
  let locationLostAnnounced = false;
  let snapshot: RdkNavigationSnapshot = { phase: "idle" };

  function publish(next: RdkNavigationSnapshot): void {
    snapshot = {
      ...next,
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

  function clearRouteState(): void {
    activeRoute = undefined;
    progress = { ...INITIAL_PROGRESS, firedThresholds: [] };
    reroute = undefined;
    lastRerouteSentAt = undefined;
    offRouteAnnounced = false;
    locationLostAnnounced = false;
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
    expectedGeneration: number
  ): void {
    if (!ownsRoute(expectedGeneration, route)) return;
    if (!promptAllowed()) return;
    if (!ownsRoute(expectedGeneration, route)) return;
    let promptId: string;
    try {
      promptId = randomId();
    } catch {
      return;
    }
    if (!ownsRoute(expectedGeneration, route)) return;
    send({ type: "nav.prompt", promptId, routeCommandId: route.commandId, kind });
  }

  function emitManeuverPrompt(
    route: NavRouteEvent,
    maneuverIndex: number,
    threshold: PromptThreshold,
    update: GuidanceUpdate,
    expectedGeneration: number
  ): void {
    if (!ownsRoute(expectedGeneration, route)) return;
    if (!promptAllowed()) return;
    if (!ownsRoute(expectedGeneration, route)) return;
    const maneuver = route.steps[maneuverIndex];
    if (!maneuver) return;
    const snappedAlongRouteMeters = route.distanceMeters - update.remainingMeters;
    const distanceMeters = Math.round(Math.max(0, maneuver.alongRouteMeters - snappedAlongRouteMeters));
    let promptId: string;
    try {
      promptId = randomId();
    } catch {
      return;
    }
    if (!ownsRoute(expectedGeneration, route)) return;
    if (threshold === "now") {
      try {
        options.interruptOrdinaryPlayback();
      } catch {
        // A failed playback flush must not replay the already-consumed prompt.
      }
      if (!ownsRoute(expectedGeneration, route)) return;
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
      try {
        pending.navCommandId = randomId();
      } catch {
        failPendingStart(pending, "route.unavailable");
        return;
      }
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      const sent = send({
        type: "nav.request",
        commandId: pending.navCommandId,
        reason: "start",
        origin: { ...fix.position },
        query: pending.query
      });
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      if (!sent) {
        failPendingStart(pending, "route.unavailable");
        return;
      }
      pending.timer = setTimeout(() => failPendingStart(pending, "route.unavailable"), routeTimeoutMs);
    })();
  }

  function handleStart(command: DeviceCommand): Promise<DeviceResultEvent> {
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
      publish(withLocation({ phase: "starting", destinationName: query }));
      if (closed || pendingStart !== pending || pending.generation !== generation) return;
      beginStart(pending);
    });
  }

  function handleStop(command: DeviceCommand): Promise<DeviceResultEvent> {
    const wasActive = pendingStart !== undefined || activeRoute !== undefined;
    if (!wasActive) return Promise.resolve(result(command.commandId, "failed", "navigation.notActive"));
    generation += 1;
    cancelPendingStart();
    clearRouteState();
    publishIdle();
    return Promise.resolve(result(command.commandId, "ok"));
  }

  function maybeReroute(fix: PhoneFix, expectedGeneration: number, expectedRoute: NavRouteEvent): void {
    if (closed || generation !== expectedGeneration || activeRoute !== expectedRoute || reroute) return;
    let sentAt: number;
    try {
      sentAt = now();
    } catch {
      return;
    }
    if (!ownsRoute(expectedGeneration, expectedRoute) || reroute) return;
    if (lastRerouteSentAt !== undefined && sentAt - lastRerouteSentAt < REROUTE_COOLDOWN_MS) return;
    let commandId: string;
    try {
      commandId = randomId();
    } catch {
      return;
    }
    if (!ownsRoute(expectedGeneration, expectedRoute) || reroute) return;
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
    if (closed || generation !== expectedGeneration || activeRoute !== expectedRoute) return;
    if (!sent && reroute?.commandId === commandId) reroute = undefined;
  }

  const controller: RdkNavigationController = {
    handleCommand(command): Promise<DeviceResultEvent> {
      if (command.action === "navigation.start") return handleStart(command);
      if (command.action === "navigation.stop") return handleStop(command);
      return Promise.resolve(result(command.commandId, "unsupported"));
    },

    handleRoute(event): void {
      if (closed) return;
      const pending = pendingStart;
      if (pending?.navCommandId === event.commandId && pending.generation === generation) {
        pendingStart = undefined;
        clearPendingTimer(pending);
        activeRoute = copyRoute(event);
        progress = { ...INITIAL_PROGRESS, firedThresholds: [] };
        reroute = undefined;
        offRouteAnnounced = false;
        locationLostAnnounced = false;
        const route = activeRoute;
        if (locationState?.usable === false) {
          locationLostAnnounced = true;
          emitLifecyclePrompt("locationLost", route, generation);
          if (ownsRoute(generation, route)) publish(baseRouteSnapshot("paused"));
        } else {
          publish(baseRouteSnapshot("guiding"));
        }
        pending.resolve(result(pending.deviceCommandId, "ok"));
        return;
      }
      if (!activeRoute || !reroute || reroute.commandId !== event.commandId || reroute.generation !== generation) {
        return;
      }
      activeRoute = copyRoute(event);
      progress = { ...INITIAL_PROGRESS, firedThresholds: [] };
      reroute = undefined;
      offRouteAnnounced = false;
      locationLostAnnounced = false;
      const route = activeRoute;
      if (locationState?.usable === false) {
        locationLostAnnounced = true;
        emitLifecyclePrompt("locationLost", route, generation);
        if (ownsRoute(generation, route)) publish(baseRouteSnapshot("paused"));
      } else {
        publish(baseRouteSnapshot("guiding"));
      }
    },

    handleError(event): void {
      if (closed) return;
      const pending = pendingStart;
      if (pending?.navCommandId === event.commandId && pending.generation === generation) {
        pendingStart = undefined;
        clearPendingTimer(pending);
        clearRouteState();
        publishIdle();
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
      const expectedGeneration = generation;
      emitLifecyclePrompt("rerouteFailed", route, expectedGeneration);
      if (closed || generation !== expectedGeneration || activeRoute !== route || reroute !== outstanding) return;
      clearRouteState();
      publishIdle();
    },

    handleFix(fix): void {
      if (closed) return;
      const route = activeRoute;
      if (!route) return;
      const expectedGeneration = generation;
      locationLostAnnounced = false;
      const maneuverIndex = progress.maneuverIndex;
      const update = step(fix.position, route, progress);
      progress = update.progress;

      if (update.arrived) {
        emitLifecyclePrompt("arrived", route, expectedGeneration);
        if (closed || generation !== expectedGeneration || activeRoute !== route) return;
        clearRouteState();
        publishIdle();
        return;
      }

      if (update.spokenPrompt && update.firedThreshold) {
        emitManeuverPrompt(route, maneuverIndex, update.firedThreshold, update, expectedGeneration);
        if (closed || generation !== expectedGeneration || activeRoute !== route) return;
      }

      if (update.offRoute) {
        if (!offRouteAnnounced) {
          offRouteAnnounced = true;
          emitLifecyclePrompt("offRoute", route, expectedGeneration);
          if (closed || generation !== expectedGeneration || activeRoute !== route) return;
        }
        maybeReroute(fix, expectedGeneration, route);
        if (closed || generation !== expectedGeneration || activeRoute !== route) return;
        publish(updateSnapshot(update, reroute ? "rerouting" : "guiding"));
        return;
      }

      offRouteAnnounced = false;
      publish(updateSnapshot(update, reroute ? "rerouting" : "guiding"));
    },

    handleLocationState(state): void {
      if (closed) return;
      locationState = copyLocation(state);
      const route = activeRoute;
      if (!route) {
        if (pendingStart) publish(withLocation({ phase: "starting", destinationName: pendingStart.query }));
        else publishIdle();
        return;
      }
      if (state.usable) {
        publish({ ...snapshot, location: copyLocation(state) });
        return;
      }
      const expectedGeneration = generation;
      if (!locationLostAnnounced) {
        locationLostAnnounced = true;
        emitLifecyclePrompt("locationLost", route, expectedGeneration);
        if (closed || generation !== expectedGeneration || activeRoute !== route) return;
      }
      publish({ ...snapshot, phase: "paused", location: copyLocation(state) });
    },

    close(): void {
      if (closed) return;
      const wasActive = pendingStart !== undefined || activeRoute !== undefined;
      closed = true;
      generation += 1;
      cancelPendingStart();
      clearRouteState();
      if (wasActive) publishIdle();
    }
  };

  return controller;
}
