import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavPromptEvent, NavRequestEvent, NavRouteEvent } from "../shared/agent";
import {
  createRdkNavigationController,
  type RdkNavigationSnapshot,
  type RdkRouteGeometry
} from "../rdk/agent/src/navigation/controller";
import {
  createPhoneLocationSource,
  type PhoneFix,
  type PhoneLocationSource,
  type PhoneLocationState
} from "../rdk/agent/src/navigation/phone-location";

const ORIGIN_FIX: PhoneFix = {
  sequence: 1,
  position: { lat: 31.23, lon: 121.47 },
  horizontalAccuracyMeters: 5,
  timestamp: 1_000
};

const USABLE_LOCATION: PhoneLocationState = {
  connection: "sharing",
  usable: true,
  horizontalAccuracyMeters: 5,
  ageMs: 0
};

const ORIGIN_POSITION = { lat: 31.23, lon: 121.47 };

const ROUTE_BASE = {
  type: "nav.route" as const,
  destinationName: "人民广场",
  destination: { lat: 31.24, lon: 121.47 },
  distanceMeters: 1_109,
  etaSeconds: 240,
  polyline: [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.235, lon: 121.47 },
    { lat: 31.24, lon: 121.47 }
  ],
  steps: [
    { instruction: "右转", lat: 31.235, lon: 121.47, alongRouteMeters: 555 },
    { instruction: "到达终点", lat: 31.24, lon: 121.47, alongRouteMeters: 1_109 }
  ]
};

function route(commandId: string, overrides: Partial<NavRouteEvent> = {}): NavRouteEvent {
  return { ...ROUTE_BASE, commandId, ...overrides };
}

function fix(sequence: number, lat: number, lon = 121.47): PhoneFix {
  return {
    sequence,
    position: { lat, lon },
    horizontalAccuracyMeters: 5,
    timestamp: 1_000 + sequence
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type HarnessOptions = {
  initialFix?: PhoneFix;
  waitForFix?: () => Promise<PhoneFix | undefined>;
  canPrompt?: boolean;
  sendEvent?: (event: NavRequestEvent | NavPromptEvent) => void;
  onState?: (state: RdkNavigationSnapshot) => void;
  onRoute?: (route: RdkRouteGeometry | null) => void;
  interrupt?: () => void;
  now?: () => number;
  canPromptHook?: () => void;
  randomIdHook?: (id: string, index: number) => void;
  latest?: () => PhoneFix | undefined;
};

function harness(options: HarnessOptions = {}) {
  const events: Array<NavRequestEvent | NavPromptEvent> = [];
  const states: RdkNavigationSnapshot[] = [];
  const routes: Array<RdkRouteGeometry | null> = [];
  const order: string[] = [];
  const ids = ["nav-1", "prompt-1", "prompt-2", "prompt-3", "reroute-1", "prompt-4", "prompt-5"];
  let randomIdIndex = 0;
  let canPrompt = options.canPrompt ?? true;
  const waitForUsableFix = vi.fn(
    options.waitForFix ?? (() => Promise.resolve(options.initialFix === undefined ? ORIGIN_FIX : options.initialFix))
  );
  const location: Pick<PhoneLocationSource, "waitForUsableFix" | "latest"> = {
    waitForUsableFix,
    latest: options.latest ?? (() => options.initialFix ?? ORIGIN_FIX)
  };
  const controller = createRdkNavigationController({
    location,
    sendEvent: (event) => {
      order.push(`send:${event.type === "nav.request" ? `${event.reason}:${event.commandId}` : event.kind}`);
      events.push(event);
      options.sendEvent?.(event);
    },
    onState: (state) => {
      states.push({ ...state, ...(state.location === undefined ? {} : { location: { ...state.location } }) });
      options.onState?.(state);
    },
    onRoute: (route) => {
      routes.push(route);
      options.onRoute?.(route);
    },
    canPrompt: () => {
      options.canPromptHook?.();
      return canPrompt;
    },
    interruptOrdinaryPlayback: () => {
      order.push("interrupt");
      options.interrupt?.();
    },
    now: options.now ?? (() => Date.now()),
    randomId: () => {
      const id = ids.shift() ?? "extra-id";
      options.randomIdHook?.(id, randomIdIndex++);
      return id;
    }
  });
  return {
    controller,
    events,
    states,
    routes,
    order,
    waitForUsableFix,
    setCanPrompt: (value: boolean) => {
      canPrompt = value;
    }
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function startGuiding(h = harness()) {
  const result = h.controller.handleCommand({
    commandId: "device-1",
    action: "navigation.start",
    args: { query: "人民广场" }
  });
  await flush();
  expect(h.events[0]).toEqual({
    type: "nav.request",
    commandId: "nav-1",
    reason: "start",
    origin: { lat: 31.23, lon: 121.47 },
    query: "人民广场"
  });
  h.controller.handleRoute(route("nav-1"));
  await expect(result).resolves.toEqual({ type: "device.result", commandId: "device-1", status: "ok" });
  return h;
}

describe("RDK navigation command lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails start truthfully when the location source default yields no usable fix", async () => {
    const h = harness({ initialFix: undefined, waitForFix: () => Promise.resolve(undefined) });
    await expect(
      h.controller.handleCommand({ commandId: "device-1", action: "navigation.start", args: { query: "人民广场" } })
    ).resolves.toEqual({
      type: "device.result",
      commandId: "device-1",
      status: "failed",
      reason: "location.unavailable"
    });
    expect(h.waitForUsableFix).toHaveBeenCalledWith();
    expect(h.events).toEqual([]);
  });

  it("holds start until the matching independently identified route arrives", async () => {
    const h = harness();
    let settled = false;
    const result = h.controller
      .handleCommand({ commandId: "device-1", action: "navigation.start", args: { query: "人民广场" } })
      .then((value) => {
        settled = true;
        return value;
      });
    await flush();
    expect(settled).toBe(false);
    expect(h.events).toEqual([
      {
        type: "nav.request",
        commandId: "nav-1",
        reason: "start",
        origin: { lat: 31.23, lon: 121.47 },
        query: "人民广场"
      }
    ]);
    h.controller.handleRoute(route("nav-1"));
    await expect(result).resolves.toEqual({ type: "device.result", commandId: "device-1", status: "ok" });
    expect(h.states.at(-1)).toEqual({
      phase: "guiding",
      destinationName: "人民广场",
      instruction: "右转",
      distanceToManeuverMeters: 555,
      remainingMeters: 1_109,
      remainingSeconds: 240,
      offRoute: false,
      position: ORIGIN_POSITION
    });
  });

  it.each([
    ["destination.notFound", "destination.notFound"],
    ["route.unavailable", "route.unavailable"]
  ] as const)("maps %s route errors to the exact failed result", async (code, reason) => {
    const h = harness();
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    h.controller.handleError({ type: "nav.error", commandId: "nav-1", code });
    await expect(result).resolves.toEqual({ type: "device.result", commandId: "device-1", status: "failed", reason });
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("fails a start after the default seven-second route deadline", async () => {
    const h = harness();
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    await vi.advanceTimersByTimeAsync(6_999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({
      type: "device.result",
      commandId: "device-1",
      status: "failed",
      reason: "route.unavailable"
    });
  });

  it("a second start cancels the first generation and late fixes cannot revive it", async () => {
    const firstFix = deferred<PhoneFix | undefined>();
    const secondFix = deferred<PhoneFix | undefined>();
    const waits = [firstFix, secondFix];
    const h = harness({ waitForFix: () => waits.shift()!.promise });
    const first = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "旧目的地" }
    });
    const second = h.controller.handleCommand({
      commandId: "device-2",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await expect(first).resolves.toEqual({
      type: "device.result",
      commandId: "device-1",
      status: "failed",
      reason: "navigation.cancelled"
    });
    firstFix.resolve(ORIGIN_FIX);
    await flush();
    expect(h.events).toEqual([]);
    secondFix.resolve(ORIGIN_FIX);
    await flush();
    expect(h.events).toHaveLength(1);
    h.controller.handleRoute(route("nav-1"));
    await expect(second).resolves.toEqual({ type: "device.result", commandId: "device-2", status: "ok" });
  });

  it.each(["fix", "route"] as const)("stop during the %s wait cancels start and succeeds once", async (stage) => {
    const pendingFix = deferred<PhoneFix | undefined>();
    const h = harness({ waitForFix: stage === "fix" ? () => pendingFix.promise : undefined });
    const start = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    if (stage === "route") await flush();
    const stop = h.controller.handleCommand({ commandId: "device-stop", action: "navigation.stop", args: {} });
    await expect(start).resolves.toEqual({
      type: "device.result",
      commandId: "device-1",
      status: "failed",
      reason: "navigation.cancelled"
    });
    await expect(stop).resolves.toEqual({ type: "device.result", commandId: "device-stop", status: "ok" });
    pendingFix.resolve(ORIGIN_FIX);
    h.controller.handleRoute(route("nav-1"));
    await flush();
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("reports navigation.notActive only when truly idle", async () => {
    const h = harness();
    await expect(
      h.controller.handleCommand({ commandId: "device-stop", action: "navigation.stop", args: {} })
    ).resolves.toEqual({
      type: "device.result",
      commandId: "device-stop",
      status: "failed",
      reason: "navigation.notActive"
    });
    await startGuiding(h);
    await expect(
      h.controller.handleCommand({ commandId: "device-stop-2", action: "navigation.stop", args: {} })
    ).resolves.toEqual({ type: "device.result", commandId: "device-stop-2", status: "ok" });
    expect(h.routes.at(-1)).toBeNull();
  });

  it("ignores stale and cached route/error answers until the current identity answers", async () => {
    const h = harness();
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    h.controller.handleRoute(route("cached-route"));
    h.controller.handleError({ type: "nav.error", commandId: "cached-error", code: "destination.notFound" });
    expect(h.states.at(-1)).toMatchObject({ phase: "starting" });
    h.controller.handleRoute(route("nav-1"));
    await expect(result).resolves.toMatchObject({ status: "ok" });
  });

  it("accepts a route as paused when location became unusable during the route wait", async () => {
    const h = harness();
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    h.controller.handleRoute(route("nav-1"));
    await expect(result).resolves.toEqual({ type: "device.result", commandId: "device-1", status: "ok" });
    expect(h.events.at(-1)).toEqual({
      type: "nav.prompt",
      promptId: "prompt-1",
      routeCommandId: "nav-1",
      kind: "locationLost"
    });
    expect(h.states.at(-1)).toEqual({
      phase: "paused",
      destinationName: "人民广场",
      instruction: "右转",
      distanceToManeuverMeters: 555,
      remainingMeters: 1_109,
      remainingSeconds: 240,
      offRoute: false,
      position: ORIGIN_POSITION,
      location: { connection: "stale", usable: false, reason: "stale" }
    });
  });

  it("installs the matching initial route as paused when the source current fix disappeared", async () => {
    let current: PhoneFix | undefined = ORIGIN_FIX;
    const h = harness({ latest: () => current });
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    current = undefined;
    h.controller.handleRoute(route("nav-1"));
    await expect(result).resolves.toEqual({ type: "device.result", commandId: "device-1", status: "ok" });
    expect(h.events.at(-1)).toEqual({
      type: "nav.prompt",
      promptId: "prompt-1",
      routeCommandId: "nav-1",
      kind: "locationLost"
    });
    expect(h.states.at(-1)).toMatchObject({ phase: "paused", destinationName: "人民广场" });

    current = fix(2, 31.232);
    h.controller.handleLocationState(USABLE_LOCATION);
    h.controller.handleFix(current);
    expect(h.states.at(-1)?.phase).toBe("guiding");
    expect(h.states.at(-1)!.distanceToManeuverMeters).toBeGreaterThan(320);
    expect(h.states.at(-1)!.distanceToManeuverMeters).toBeLessThan(340);
    expect(h.events.at(-1)).toMatchObject({ kind: "maneuver", threshold: "far" });
  });

  it("treats a throwing current-fix authority as unavailable while keeping the route result truthful", async () => {
    const h = harness({
      latest: () => {
        throw new Error("source closed");
      }
    });
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    expect(() => h.controller.handleRoute(route("nav-1"))).not.toThrow();
    await expect(result).resolves.toEqual({ type: "device.result", commandId: "device-1", status: "ok" });
    expect(h.states.at(-1)).toMatchObject({ phase: "paused", destinationName: "人民广场" });
    expect(h.events.at(-1)).toMatchObject({ kind: "locationLost", routeCommandId: "nav-1" });
  });

  it("does not resume initial route installation after latest reenters with a newer location transition", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let reentered = false;
    const h = harness({
      latest: () => {
        if (!reentered) {
          reentered = true;
          owner.controller?.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
        }
        return ORIGIN_FIX;
      }
    });
    owner.controller = h.controller;
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    h.controller.handleRoute(route("nav-1"));
    await expect(result).resolves.toMatchObject({ status: "ok" });
    expect(h.states.at(-1)).toMatchObject({ phase: "paused", location: { usable: false, reason: "stale" } });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(1);
  });

  it("close is idempotent, cancels a pending command, and ignores every late continuation", async () => {
    const pendingFix = deferred<PhoneFix | undefined>();
    const h = harness({ waitForFix: () => pendingFix.promise });
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    h.controller.close();
    h.controller.close();
    await expect(result).resolves.toEqual({
      type: "device.result",
      commandId: "device-1",
      status: "failed",
      reason: "navigation.cancelled"
    });
    pendingFix.resolve(ORIGIN_FIX);
    h.controller.handleRoute(route("nav-1"));
    h.controller.handleError({ type: "nav.error", commandId: "nav-1", code: "route.unavailable" });
    h.controller.handleFix(fix(2, 31.232));
    await flush();
    expect(h.events).toEqual([]);
  });

  it("a synchronous stop from the starting callback cannot miss or resurrect the pending start", async () => {
    const pendingFix = deferred<PhoneFix | undefined>();
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let stop: Promise<import("../shared/agent").DeviceResultEvent> | undefined;
    const h = harness({
      waitForFix: () => pendingFix.promise,
      onState: (state) => {
        if (state.phase === "starting" && stop === undefined) {
          stop = owner.controller?.handleCommand({ commandId: "device-stop", action: "navigation.stop", args: {} });
        }
      }
    });
    owner.controller = h.controller;
    const start = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    pendingFix.resolve(ORIGIN_FIX);
    await flush();
    h.controller.handleRoute(route("nav-1"));
    await expect(start).resolves.toEqual({
      type: "device.result",
      commandId: "device-1",
      status: "failed",
      reason: "navigation.cancelled"
    });
    await expect(stop).resolves.toEqual({ type: "device.result", commandId: "device-stop", status: "ok" });
    expect(h.events).toEqual([]);
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });
});

describe("RDK route guidance and rerouting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits literal far/near/now prompts with unique IDs and interrupts before now", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.order.length = 0;
    h.controller.handleFix(fix(2, 31.232));
    h.controller.handleFix(fix(3, 31.234));
    h.controller.handleFix(fix(4, 31.2348));
    expect(h.events).toEqual([
      {
        type: "nav.prompt",
        promptId: "prompt-1",
        routeCommandId: "nav-1",
        kind: "maneuver",
        maneuverIndex: 0,
        threshold: "far",
        distanceMeters: 333
      },
      {
        type: "nav.prompt",
        promptId: "prompt-2",
        routeCommandId: "nav-1",
        kind: "maneuver",
        maneuverIndex: 0,
        threshold: "near",
        distanceMeters: 110
      },
      {
        type: "nav.prompt",
        promptId: "prompt-3",
        routeCommandId: "nav-1",
        kind: "maneuver",
        maneuverIndex: 0,
        threshold: "now",
        distanceMeters: 21
      }
    ]);
    expect(h.order).toEqual(["send:maneuver", "send:maneuver", "interrupt", "send:maneuver"]);
  });

  it.each([
    ["canPrompt", ["near"]],
    ["randomId", ["near"]],
    ["sendEvent", ["far", "near"]],
    ["onState", ["far", "near"]]
  ] as const)("keeps the newest same-route fix when %s reenters guidance", async (boundary, expectedThresholds) => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let enabled = false;
    let reentered = false;
    const reenter = () => {
      if (!enabled || reentered) return;
      reentered = true;
      owner.controller?.handleFix(fix(3, 31.234));
    };
    const h = harness({
      canPromptHook: boundary === "canPrompt" ? reenter : undefined,
      randomIdHook: boundary === "randomId" ? (_id, index) => index === 1 && reenter() : undefined,
      sendEvent: boundary === "sendEvent" ? (event) => event.type === "nav.prompt" && reenter() : undefined,
      onState:
        boundary === "onState"
          ? (state) => state.phase === "guiding" && state.distanceToManeuverMeters! > 300 && reenter()
          : undefined
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.events.length = 0;
    enabled = true;
    h.controller.handleFix(fix(2, 31.232));
    expect(h.states.at(-1)?.phase).toBe("guiding");
    expect(h.states.at(-1)!.distanceToManeuverMeters).toBeGreaterThan(100);
    expect(h.states.at(-1)!.distanceToManeuverMeters).toBeLessThan(120);
    expect(
      h.events
        .filter(
          (event): event is Extract<NavPromptEvent, { kind: "maneuver" }> =>
            event.type === "nav.prompt" && event.kind === "maneuver"
        )
        .map((event) => event.threshold)
    ).toEqual(expectedThresholds);
  });

  it("keeps the newer fix when interruptOrdinaryPlayback reenters on the same route", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let reentered = false;
    const h = harness({
      interrupt: () => {
        if (reentered) return;
        reentered = true;
        owner.controller?.handleFix(fix(5, 31.2365));
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.controller.handleFix(fix(2, 31.232));
    h.controller.handleFix(fix(3, 31.234));
    h.events.length = 0;
    h.controller.handleFix(fix(4, 31.2348));
    expect(h.states.at(-1)).toMatchObject({ phase: "guiding", instruction: "到达终点" });
    expect(h.states.at(-1)!.distanceToManeuverMeters).toBeGreaterThan(375);
    expect(h.states.at(-1)!.distanceToManeuverMeters).toBeLessThan(400);
    expect(
      h.events
        .filter(
          (event): event is Extract<NavPromptEvent, { kind: "maneuver" }> =>
            event.type === "nav.prompt" && event.kind === "maneuver"
        )
        .map((event) => [event.maneuverIndex, event.threshold])
    ).toEqual([[1, "far"]]);
  });

  it("keeps a newer paused transition when the reroute clock reenters", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let reentered = false;
    const h = harness({
      now: () => {
        if (!reentered) {
          reentered = true;
          owner.controller?.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
        }
        return 10_000;
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    expect(h.states.at(-1)).toMatchObject({ phase: "paused", location: { usable: false, reason: "stale" } });
    expect(h.events).toEqual([
      { type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "offRoute" },
      { type: "nav.prompt", promptId: "prompt-2", routeCommandId: "nav-1", kind: "locationLost" }
    ]);
  });

  it("consumes arrival before prompt delivery so a synchronous replay emits and clears once", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let replayed = false;
    const h = harness({
      sendEvent: (event) => {
        if (event.type !== "nav.prompt" || event.kind !== "arrived" || replayed) return;
        replayed = true;
        owner.controller?.handleFix(fix(3, 31.2399));
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.2398));
    expect(h.events).toEqual([{ type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "arrived" }]);
    expect(h.states.filter((state) => state.phase === "idle")).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("consumes reroute failure before prompt delivery so a synchronous replay emits and clears once", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let replayed = false;
    const error = { type: "nav.error", commandId: "prompt-2", code: "route.unavailable" } as const;
    const h = harness({
      sendEvent: (event) => {
        if (event.type !== "nav.prompt" || event.kind !== "rerouteFailed" || replayed) return;
        replayed = true;
        owner.controller?.handleError(error);
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    h.controller.handleError(error);
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "rerouteFailed")).toEqual([
      { type: "nav.prompt", promptId: "prompt-3", routeCommandId: "nav-1", kind: "rerouteFailed" }
    ]);
    expect(h.states.filter((state) => state.phase === "idle")).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it.each(["canPrompt", "randomId", "sendEvent"] as const)(
    "delivers arrived exactly once when %s reenters with unusable then usable location",
    async (boundary) => {
      const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
      let enabled = false;
      let reentered = false;
      const reenter = () => {
        if (!enabled || reentered) return;
        reentered = true;
        owner.controller?.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
        owner.controller?.handleLocationState(USABLE_LOCATION);
      };
      const h = harness({
        canPromptHook: boundary === "canPrompt" ? reenter : undefined,
        randomIdHook: boundary === "randomId" ? reenter : undefined,
        sendEvent:
          boundary === "sendEvent"
            ? (event) => event.type === "nav.prompt" && event.kind === "arrived" && reenter()
            : undefined
      });
      owner.controller = h.controller;
      await startGuiding(h);
      h.events.length = 0;
      enabled = true;
      h.controller.handleFix(fix(2, 31.2398));
      expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "arrived")).toHaveLength(1);
      expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(0);
      expect(h.states.at(-1)).toEqual({ phase: "idle", location: USABLE_LOCATION, position: ORIGIN_POSITION });
    }
  );

  it.each(["canPrompt", "randomId", "sendEvent"] as const)(
    "delivers rerouteFailed exactly once when %s reenters with unusable then usable location",
    async (boundary) => {
      const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
      let enabled = false;
      let reentered = false;
      const reenter = () => {
        if (!enabled || reentered) return;
        reentered = true;
        owner.controller?.handleLocationState({ connection: "stopped", usable: false, reason: "stopped" });
        owner.controller?.handleLocationState(USABLE_LOCATION);
      };
      const h = harness({
        canPromptHook: boundary === "canPrompt" ? reenter : undefined,
        randomIdHook: boundary === "randomId" ? reenter : undefined,
        sendEvent:
          boundary === "sendEvent"
            ? (event) => event.type === "nav.prompt" && event.kind === "rerouteFailed" && reenter()
            : undefined
      });
      owner.controller = h.controller;
      await startGuiding(h);
      h.controller.handleFix(fix(2, 31.232, 121.471));
      h.events.length = 0;
      enabled = true;
      h.controller.handleError({ type: "nav.error", commandId: "prompt-2", code: "route.unavailable" });
      expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "rerouteFailed")).toHaveLength(1);
      expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(0);
      expect(h.states.at(-1)).toEqual({ phase: "idle", location: USABLE_LOCATION, position: ORIGIN_POSITION });
    }
  );

  it.each(["canPrompt", "randomId", "sendEvent"] as const)(
    "delivers offRoute exactly once when %s reenters with a newer off-route fix",
    async (boundary) => {
      const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
      let enabled = false;
      let reentered = false;
      const reenter = () => {
        if (!enabled || reentered) return;
        reentered = true;
        owner.controller?.handleFix(fix(3, 31.2321, 121.471));
      };
      const h = harness({
        canPromptHook: boundary === "canPrompt" ? reenter : undefined,
        randomIdHook: boundary === "randomId" ? reenter : undefined,
        sendEvent:
          boundary === "sendEvent"
            ? (event) => event.type === "nav.prompt" && event.kind === "offRoute" && reenter()
            : undefined
      });
      owner.controller = h.controller;
      await startGuiding(h);
      h.events.length = 0;
      enabled = true;
      h.controller.handleFix(fix(2, 31.232, 121.471));
      expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "offRoute")).toHaveLength(1);
      expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(1);
      expect(h.states.at(-1)).toMatchObject({ phase: "rerouting", offRoute: true });
      expect(h.states.at(-1)!.remainingMeters).toBeLessThan(880);
    }
  );

  it.each(["canPrompt", "randomId", "sendEvent"] as const)(
    "delivers locationLost exactly once when %s reenters with a newer unusable state",
    async (boundary) => {
      const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
      let enabled = false;
      let reentered = false;
      const reenter = () => {
        if (!enabled || reentered) return;
        reentered = true;
        owner.controller?.handleLocationState({ connection: "stopped", usable: false, reason: "stopped" });
      };
      const h = harness({
        canPromptHook: boundary === "canPrompt" ? reenter : undefined,
        randomIdHook: boundary === "randomId" ? reenter : undefined,
        sendEvent:
          boundary === "sendEvent"
            ? (event) => event.type === "nav.prompt" && event.kind === "locationLost" && reenter()
            : undefined
      });
      owner.controller = h.controller;
      await startGuiding(h);
      h.events.length = 0;
      enabled = true;
      h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
      expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(1);
      expect(h.states.at(-1)).toMatchObject({ phase: "paused", location: { usable: false, reason: "stopped" } });
    }
  );

  it("suppresses only the offRoute one-shot when canPrompt is false during nested off-route guidance", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let enabled = false;
    let reentered = false;
    const h = harness({
      canPrompt: false,
      canPromptHook: () => {
        if (!enabled || reentered) return;
        reentered = true;
        owner.controller?.handleFix(fix(3, 31.2321, 121.471));
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.events.length = 0;
    enabled = true;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    h.setCanPrompt(true);
    h.controller.handleFix(fix(4, 31.2322, 121.471));
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "offRoute")).toHaveLength(0);
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(1);
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(1);
  });

  it("suppresses one locationLost episode when canPrompt is false and allows a later episode", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let enabled = false;
    let reentered = false;
    const h = harness({
      canPrompt: false,
      canPromptHook: () => {
        if (!enabled || reentered) return;
        reentered = true;
        owner.controller?.handleLocationState({ connection: "stopped", usable: false, reason: "stopped" });
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.events.length = 0;
    enabled = true;
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    h.setCanPrompt(true);
    h.controller.handleLocationState({ connection: "unpaired", usable: false, reason: "unpaired" });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(0);

    h.controller.handleLocationState(USABLE_LOCATION);
    h.controller.handleFix(fix(2, 31.23));
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(1);
  });

  it.each(["arrived", "rerouteFailed"] as const)("suppresses terminal %s when canPrompt is false", async (kind) => {
    const h = await startGuiding();
    h.events.length = 0;
    h.setCanPrompt(false);
    if (kind === "arrived") {
      h.controller.handleFix(fix(2, 31.2398));
    } else {
      h.setCanPrompt(true);
      h.controller.handleFix(fix(2, 31.232, 121.471));
      h.events.length = 0;
      h.setCanPrompt(false);
      h.controller.handleError({ type: "nav.error", commandId: "prompt-2", code: "route.unavailable" });
    }
    expect(h.events.filter((event) => event.type === "nav.prompt")).toHaveLength(0);
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("retains consumed progress while prompt transport is unavailable", async () => {
    const h = await startGuiding(harness({ canPrompt: false }));
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232));
    h.setCanPrompt(true);
    h.controller.handleFix(fix(3, 31.232));
    expect(h.events).toEqual([]);
  });

  it("announces off-route once and keeps exactly one identity-matched reroute in flight", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    h.controller.handleFix(fix(3, 31.2321, 121.471));
    expect(h.events).toEqual([
      { type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "offRoute" },
      {
        type: "nav.request",
        commandId: "prompt-2",
        reason: "reroute",
        origin: { lat: 31.232, lon: 121.471 },
        destination: { lat: 31.24, lon: 121.47 },
        destinationName: "人民广场"
      }
    ]);
    h.controller.handleRoute(route("stale-reroute"));
    h.controller.handleError({ type: "nav.error", commandId: "stale-reroute", code: "route.unavailable" });
    expect(h.states.at(-1)?.phase).toBe("rerouting");
  });

  it("resets route progress after reroute success and enforces the 20-second cooldown", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    h.controller.handleRoute(route("prompt-2", { destinationName: "新路线" }));
    expect(h.states.at(-1)).toMatchObject({
      phase: "guiding",
      destinationName: "新路线",
      instruction: "右转",
      distanceToManeuverMeters: 555
    });
    h.controller.handleFix(fix(3, 31.232, 121.471));
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    h.controller.handleFix(fix(4, 31.232, 121.471));
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(2);
  });

  it("abandons an unanswered reroute instead of wedging the session in rerouting", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(1);
    expect(h.states.at(-1)?.phase).toBe("rerouting");

    // The relay answers with neither nav.route nor nav.error — a dropped
    // reply, not a routing failure. The rider stays on the old route, but the
    // session must stop claiming a reroute is in flight.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.states.at(-1)).toMatchObject({ phase: "guiding", offRoute: true });

    // And a later off-route fix, past the cooldown, may ask again.
    await vi.advanceTimersByTimeAsync(20_000);
    h.controller.handleFix(fix(3, 31.232, 121.471));
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(2);
  });

  it("keeps a reroute answer that lands inside the timeout window", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    await vi.advanceTimersByTimeAsync(6_999);
    h.controller.handleRoute(route("prompt-2", { destinationName: "新路线" }));
    expect(h.states.at(-1)).toMatchObject({ phase: "guiding", destinationName: "新路线" });

    // The abandon timer must not fire against the route it already answered.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.states.at(-1)).toMatchObject({ phase: "guiding", destinationName: "新路线" });
  });

  it("installs a reroute answer paused when the source no longer has a current fix", async () => {
    let current: PhoneFix | undefined = ORIGIN_FIX;
    const h = await startGuiding(harness({ latest: () => current }));
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    current = undefined;
    h.controller.handleRoute(route("prompt-2", { destinationName: "新路线" }));
    expect(h.states.at(-1)).toMatchObject({ phase: "paused", destinationName: "新路线" });
    expect(h.events.at(-1)).toEqual({
      type: "nav.prompt",
      promptId: "prompt-3",
      routeCommandId: "prompt-2",
      kind: "locationLost"
    });
  });

  it("sends rerouteFailed before clearing only for the matching reroute", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    h.controller.handleError({ type: "nav.error", commandId: "prompt-2", code: "route.unavailable" });
    expect(h.events.at(-1)).toEqual({
      type: "nav.prompt",
      promptId: "prompt-3",
      routeCommandId: "nav-1",
      kind: "rerouteFailed"
    });
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("sends arrived before clearing the route", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.2398));
    expect(h.events).toEqual([{ type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "arrived" }]);
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("synchronous stop reentrancy from prompt sending cannot send a reroute or resurrect state", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    const events: Array<NavRequestEvent | NavPromptEvent> = [];
    const h = harness({
      sendEvent: (event) => {
        events.push(event);
        if (event.type === "nav.prompt" && event.kind === "offRoute") {
          void owner.controller?.handleCommand({ commandId: "device-stop", action: "navigation.stop", args: {} });
        }
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    expect(events).toEqual([{ type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "offRoute" }]);
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("synchronous stop reentrancy from the now interrupt prevents the stale prompt send", async () => {
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    let stop: Promise<import("../shared/agent").DeviceResultEvent> | undefined;
    const h = harness({
      interrupt: () => {
        stop = owner.controller?.handleCommand({ commandId: "device-stop", action: "navigation.stop", args: {} });
      }
    });
    owner.controller = h.controller;
    await startGuiding(h);
    h.controller.handleFix(fix(2, 31.232));
    h.controller.handleFix(fix(3, 31.234));
    h.events.length = 0;
    h.controller.handleFix(fix(4, 31.2348));
    expect(h.events).toEqual([]);
    await expect(stop).resolves.toEqual({ type: "device.result", commandId: "device-stop", status: "ok" });
    expect(h.states.at(-1)).toEqual({ phase: "idle", position: ORIGIN_POSITION });
  });

  it("a throwing clock callback cannot abort guidance after consuming the off-route one-shot", async () => {
    const h = await startGuiding(
      harness({
        now: () => {
          throw new Error("clock unavailable");
        }
      })
    );
    h.events.length = 0;
    expect(() => h.controller.handleFix(fix(2, 31.232, 121.471))).not.toThrow();
    expect(h.events).toEqual([{ type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "offRoute" }]);
    expect(h.states.at(-1)).toMatchObject({ phase: "guiding", offRoute: true });
  });

  describe("rider position on the snapshot", () => {
    it("stamps every published snapshot with the newest fix", async () => {
      let current: PhoneFix | undefined = ORIGIN_FIX;
      const h = harness({ latest: () => current });
      await startGuiding(h);

      current = fix(2, 31.238);
      h.controller.handleFix(fix(2, 31.238));

      expect(h.states.at(-1)?.position).toEqual({ lat: 31.238, lon: 121.47 });
    });

    it("omits the position entirely when there is no fix", async () => {
      const h = harness({ latest: () => undefined, waitForFix: () => Promise.resolve(ORIGIN_FIX) });
      await startGuiding(h);

      expect(h.states.at(-1)).not.toHaveProperty("position");
    });

    it("survives a throwing location source rather than failing the publish", async () => {
      const h = harness({
        latest: () => {
          throw new Error("location source closed");
        },
        waitForFix: () => Promise.resolve(ORIGIN_FIX)
      });

      await expect(startGuiding(h)).resolves.toBeDefined();
      expect(h.states.at(-1)).not.toHaveProperty("position");
    });

    it("clears the position when location becomes unavailable via location state change", async () => {
      let current: PhoneFix | undefined = ORIGIN_FIX;
      const h = harness({ latest: () => current });
      await startGuiding(h);

      expect(h.states.at(-1)?.position).toEqual({ lat: 31.23, lon: 121.47 });

      // The source stops holding a fix, so latest() returns undefined. (A
      // latest() that *throws* is a different test — see the throwing
      // location-source case above.)
      current = undefined;
      h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });

      // Position should be cleared, not frozen
      expect(h.states.at(-1)).not.toHaveProperty("position");
      expect(h.states.at(-1)).toMatchObject({ phase: "paused", location: { usable: false, reason: "stale" } });
    });
  });
});

describe("RDK location pause and resume", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("freezes displayed route values, retains the route, and emits locationLost once", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232));
    const before = h.states.at(-1)!;
    h.events.length = 0;
    const inaccurate: PhoneLocationState = {
      connection: "sharing",
      usable: false,
      horizontalAccuracyMeters: 80,
      ageMs: 0,
      reason: "inaccurate"
    };
    h.controller.handleLocationState(inaccurate);
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    const paused = h.states.at(-1)!;
    expect(paused).toEqual({
      ...before,
      phase: "paused",
      location: { connection: "stale", usable: false, reason: "stale" }
    });
    expect(h.events).toEqual([
      { type: "nav.prompt", promptId: "prompt-2", routeCommandId: "nav-1", kind: "locationLost" }
    ]);
  });

  it("does not call an inaccurate heartbeat disconnected and rate-limits repeated loss announcements", async () => {
    let time = 10_000;
    const h = await startGuiding(harness({ now: () => time }));
    h.events.length = 0;

    h.controller.handleLocationState({
      connection: "sharing",
      usable: false,
      horizontalAccuracyMeters: 80,
      ageMs: 0,
      reason: "inaccurate"
    });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(0);

    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(1);

    h.controller.handleLocationState(USABLE_LOCATION);
    h.controller.handleFix(fix(2, 31.231));
    time += 30_000;
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(1);

    h.controller.handleLocationState(USABLE_LOCATION);
    h.controller.handleFix(fix(3, 31.232));
    time += 30_001;
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "locationLost")).toHaveLength(2);
  });

  it.each([
    {
      label: "inaccurate",
      state: {
        connection: "sharing",
        usable: false,
        horizontalAccuracyMeters: 80,
        ageMs: 0,
        reason: "inaccurate"
      } satisfies PhoneLocationState
    },
    {
      label: "stale",
      state: { connection: "stale", usable: false, reason: "stale" } satisfies PhoneLocationState
    },
    {
      label: "disconnected",
      state: { connection: "connected", usable: false, reason: "disconnected" } satisfies PhoneLocationState
    },
    {
      label: "stopped",
      state: { connection: "stopped", usable: false, reason: "stopped" } satisfies PhoneLocationState
    },
    {
      label: "unpaired",
      state: { connection: "unpaired", usable: false, reason: "unpaired" } satisfies PhoneLocationState
    }
  ])("freezes every fix and one-shot while $label until a usable state plus fresh fix", async ({ state }) => {
    const h = await startGuiding();
    h.controller.handleFix(fix(2, 31.232));
    h.controller.handleLocationState(state);
    const paused = h.states.at(-1)!;
    h.events.length = 0;
    h.order.length = 0;

    h.controller.handleFix(fix(3, 31.2348));
    h.controller.handleFix(fix(4, 31.232, 121.471));
    h.controller.handleFix(fix(5, 31.2398));
    h.controller.handleLocationState(state);

    expect(h.states.at(-1)).toEqual(paused);
    expect(h.events).toEqual([]);
    expect(h.order).toEqual([]);

    h.controller.handleLocationState(USABLE_LOCATION);
    expect(h.states.at(-1)?.phase).toBe("paused");
    h.controller.handleFix(fix(6, 31.234));
    expect(h.states.at(-1)).toMatchObject({ phase: "guiding", instruction: "右转" });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: "maneuver", maneuverIndex: 0, threshold: "near" });
  });

  it("does not replay an already-consumed off-route one-shot after ignored paused fixes", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.232, 121.471));
    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "offRoute")).toHaveLength(1);
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(1);

    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    h.controller.handleFix(fix(3, 31.234));
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    h.controller.handleLocationState(USABLE_LOCATION);
    h.controller.handleFix(fix(4, 31.2321, 121.471));

    expect(h.events.filter((event) => event.type === "nav.prompt" && event.kind === "offRoute")).toHaveLength(1);
    expect(h.events.filter((event) => event.type === "nav.request")).toHaveLength(1);
  });

  it("resumes in the real PhoneLocationSource usable-state-before-fix callback order", async () => {
    const events: Array<NavRequestEvent | NavPromptEvent> = [];
    const states: RdkNavigationSnapshot[] = [];
    const owner: { controller?: ReturnType<typeof createRdkNavigationController> } = {};
    const source = createPhoneLocationSource({
      now: () => Date.now(),
      onState: (state) => owner.controller?.handleLocationState(state),
      onFix: (accepted) => owner.controller?.handleFix(accepted)
    });
    const ids = ["nav-real", "lost-real"];
    const controller = createRdkNavigationController({
      location: source,
      sendEvent: (event) => events.push(event),
      onState: (state) => states.push(state),
      canPrompt: () => true,
      interruptOrdinaryPlayback: () => undefined,
      now: () => Date.now(),
      randomId: () => ids.shift() ?? "extra-real"
    });
    owner.controller = controller;
    source.acceptStatus({ type: "phone.location.status", state: "sharing" });
    source.acceptLocation({
      type: "phone.location",
      sequence: 1,
      lat: 31.23,
      lon: 121.47,
      horizontalAccuracyMeters: 5,
      timestamp: Date.now()
    });
    const accepted = source.latest()!;
    const start = controller.handleCommand({
      commandId: "device-real",
      action: "navigation.start",
      args: { query: "真实定位" }
    });
    await flush();
    controller.handleRoute(
      route("nav-real", {
        destinationName: "真实定位",
        destination: { lat: accepted.position.lat + 0.01, lon: accepted.position.lon },
        polyline: [
          accepted.position,
          { lat: accepted.position.lat + 0.005, lon: accepted.position.lon },
          { lat: accepted.position.lat + 0.01, lon: accepted.position.lon }
        ],
        steps: [
          {
            instruction: "右转",
            lat: accepted.position.lat + 0.005,
            lon: accepted.position.lon,
            alongRouteMeters: 555
          },
          {
            instruction: "到达终点",
            lat: accepted.position.lat + 0.01,
            lon: accepted.position.lon,
            alongRouteMeters: 1_109
          }
        ]
      })
    );
    await expect(start).resolves.toMatchObject({ status: "ok" });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(states.at(-1)).toMatchObject({ phase: "paused", location: { usable: false, reason: "stale" } });
    source.acceptLocation({
      type: "phone.location",
      sequence: 2,
      lat: 31.23,
      lon: 121.47,
      horizontalAccuracyMeters: 5,
      timestamp: Date.now()
    });
    expect(states.at(-1)).toMatchObject({ phase: "guiding", location: { usable: true } });
    source.close();
    controller.close();
  });

  it("a fresh fix resumes, clears the loss latch, and can immediately trigger ordinary off-route logic", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleLocationState({ connection: "stopped", usable: false, reason: "stopped" });
    h.controller.handleLocationState(USABLE_LOCATION);
    h.controller.handleFix(fix(2, 31.232, 121.471));
    expect(h.events).toEqual([
      { type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "locationLost" },
      { type: "nav.prompt", promptId: "prompt-2", routeCommandId: "nav-1", kind: "offRoute" },
      {
        type: "nav.request",
        commandId: "prompt-3",
        reason: "reroute",
        origin: { lat: 31.232, lon: 121.471 },
        destination: { lat: 31.24, lon: 121.47 },
        destinationName: "人民广场"
      }
    ]);
    expect(h.states.at(-1)?.phase).toBe("rerouting");
  });

  it("consumes location-loss and off-route one-shots even while ADAS suppresses prompts", async () => {
    const h = await startGuiding(harness({ canPrompt: false }));
    h.events.length = 0;
    h.controller.handleLocationState({ connection: "unpaired", usable: false, reason: "unpaired" });
    h.setCanPrompt(true);
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    h.controller.handleLocationState(USABLE_LOCATION);
    h.setCanPrompt(false);
    h.controller.handleFix(fix(2, 31.232, 121.471));
    h.setCanPrompt(true);
    h.controller.handleFix(fix(3, 31.2321, 121.471));
    expect(h.events.filter((event) => event.type === "nav.prompt")).toEqual([]);
  });

  it("publishes defensive snapshot copies even if a callback mutates its argument", async () => {
    const seen: RdkNavigationSnapshot[] = [];
    const h = harness({
      onState: (state) => {
        if (state.location) state.location.reason = "unpaired";
        seen.push(state);
      }
    });
    await startGuiding(h);
    h.controller.handleLocationState({ connection: "stale", usable: false, reason: "stale" });
    h.controller.handleLocationState({ connection: "stopped", usable: false, reason: "stopped" });
    expect(seen.at(-1)?.location).toEqual({ connection: "stopped", usable: false, reason: "unpaired" });
    expect(h.states.at(-1)?.location).toEqual({ connection: "stopped", usable: false, reason: "stopped" });
  });
});

describe("route geometry for the HUD", () => {
  it("emits the installed route's polyline and maneuver coordinates", async () => {
    const h = harness();
    await startGuiding(h);

    expect(h.routes.at(-1)).toEqual({
      destinationName: "人民广场",
      polyline: [
        { lat: 31.23, lon: 121.47 },
        { lat: 31.235, lon: 121.47 },
        { lat: 31.24, lon: 121.47 }
      ],
      steps: [
        { lat: 31.235, lon: 121.47 },
        { lat: 31.24, lon: 121.47 }
      ]
    });
  });

  it("drops maneuver instructions rather than forwarding them twice", async () => {
    const h = harness();
    await startGuiding(h);

    expect(JSON.stringify(h.routes.at(-1))).not.toContain("右转");
  });

  it("emits null when navigation closes", async () => {
    const h = harness();
    await startGuiding(h);
    h.controller.close();

    expect(h.routes.at(-1)).toBeNull();
  });

  it("does not retain the caller's arrays", async () => {
    const event = route("nav-1");
    const h = harness();
    // handleRoute only installs a route once it matches a pending start (or
    // an active reroute) — a bare handleRoute call on a fresh controller is
    // a no-op, so the started state has to exist first to actually reach
    // installRoute and give this test something to check.
    h.controller.handleCommand({ commandId: "device-1", action: "navigation.start", args: { query: "人民广场" } });
    await flush();
    h.controller.handleRoute(event);
    await flush();
    event.polyline[0]!.lat = 0;

    expect(h.routes.at(-1)?.polyline[0]).toEqual({ lat: 31.23, lon: 121.47 });
  });
});

// The whole `HudState` — route included — is re-serialised to every socket on
// every publish, and the page re-renders the schematic from scratch on every
// message. A full-resolution Amap polyline is thousands of points, so the
// board pays for all of them on every frame unless the geometry is thinned
// once, at the boundary that emits it.
describe("route polyline decimation for the HUD", () => {
  // Deliberately not imported from the controller: the cap is a promise to the
  // wire and the DOM, so the test states the number independently.
  const CAP = 150;

  function line(count: number): Array<{ lat: number; lon: number }> {
    return Array.from({ length: count }, (_, index) => ({
      lat: 31.23 + index * 0.0001,
      lon: 121.47 + index * 0.0002
    }));
  }

  async function installPolyline(overrides: Partial<NavRouteEvent>) {
    const h = harness();
    const result = h.controller.handleCommand({
      commandId: "device-1",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await flush();
    h.controller.handleRoute(route("nav-1", overrides));
    await result;
    return h;
  }

  it("emits a polyline at or under the cap unchanged", async () => {
    const polyline = line(CAP);
    const h = await installPolyline({ polyline });

    expect(h.routes.at(-1)?.polyline).toEqual(polyline);
  });

  it("reduces a polyline over the cap to at most the cap", async () => {
    const h = await installPolyline({ polyline: line(4_000) });

    expect(h.routes.at(-1)?.polyline.length).toBeLessThanOrEqual(CAP);
  });

  it("keeps the exact first and last points of a decimated polyline", async () => {
    const polyline = line(4_000);
    const h = await installPolyline({ polyline });
    const emitted = h.routes.at(-1)!.polyline;

    expect(emitted.at(0)).toEqual(polyline.at(0));
    expect(emitted.at(-1)).toEqual(polyline.at(-1));
  });

  it("keeps every maneuver marker, however long the route", async () => {
    const steps = Array.from({ length: CAP * 2 }, (_, index) => ({
      instruction: `右转 ${index}`,
      lat: 31.23 + index * 0.0001,
      lon: 121.47 + index * 0.0002,
      alongRouteMeters: index * 10
    }));
    const h = await installPolyline({ polyline: line(4_000), steps });

    expect(h.routes.at(-1)?.steps).toEqual(steps.map((maneuver) => ({ lat: maneuver.lat, lon: maneuver.lon })));
  });
});
