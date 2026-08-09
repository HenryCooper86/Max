import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavPromptEvent, NavRequestEvent, NavRouteEvent } from "../shared/agent";
import { createRdkNavigationController, type RdkNavigationSnapshot } from "../rdk/agent/src/navigation/controller";
import type { PhoneFix, PhoneLocationSource, PhoneLocationState } from "../rdk/agent/src/navigation/phone-location";

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
  interrupt?: () => void;
  now?: () => number;
};

function harness(options: HarnessOptions = {}) {
  const events: Array<NavRequestEvent | NavPromptEvent> = [];
  const states: RdkNavigationSnapshot[] = [];
  const order: string[] = [];
  const ids = ["nav-1", "prompt-1", "prompt-2", "prompt-3", "reroute-1", "prompt-4", "prompt-5"];
  let canPrompt = options.canPrompt ?? true;
  const waitForUsableFix = vi.fn(
    options.waitForFix ?? (() => Promise.resolve(options.initialFix === undefined ? ORIGIN_FIX : options.initialFix))
  );
  const location: Pick<PhoneLocationSource, "waitForUsableFix" | "latest"> = {
    waitForUsableFix,
    latest: () => options.initialFix
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
    canPrompt: () => canPrompt,
    interruptOrdinaryPlayback: () => {
      order.push("interrupt");
      options.interrupt?.();
    },
    now: options.now ?? (() => Date.now()),
    randomId: () => ids.shift() ?? "extra-id"
  });
  return {
    controller,
    events,
    states,
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
      offRoute: false
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
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
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
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
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
      location: { connection: "stale", usable: false, reason: "stale" }
    });
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
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
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
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
  });

  it("sends arrived before clearing the route", async () => {
    const h = await startGuiding();
    h.events.length = 0;
    h.controller.handleFix(fix(2, 31.2398));
    expect(h.events).toEqual([{ type: "nav.prompt", promptId: "prompt-1", routeCommandId: "nav-1", kind: "arrived" }]);
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
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
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
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
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
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
