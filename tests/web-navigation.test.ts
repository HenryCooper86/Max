// tests/web-navigation.test.ts
import { describe, expect, it, vi } from "vitest";
import { createNavigationController, type NavPhase } from "../src/lib/navigation";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import type { NavRouteEvent } from "../shared/agent";

const routeEvent: NavRouteEvent = {
  type: "nav.route",
  commandId: "c1",
  destinationName: "外滩",
  destination: MOCK_ROUTE.polyline.at(-1)!,
  distanceMeters: MOCK_ROUTE.distanceMeters,
  etaSeconds: MOCK_ROUTE.etaSeconds,
  polyline: MOCK_ROUTE.polyline,
  steps: MOCK_ROUTE.steps
};

function harness(nowRef = { t: 0 }) {
  const sent: Array<Record<string, unknown>> = [];
  const states: string[] = [];
  const controller = createNavigationController({
    sendJson: (p) => sent.push(p as Record<string, unknown>),
    onState: (s) => states.push(s.phase),
    now: () => nowRef.t
  });
  return { controller, sent, states };
}

describe("createNavigationController", () => {
  it("consumes navigation.start without a position fix, without denying it instantly", () => {
    const { controller, sent } = harness();
    const consumed = controller.handleDeviceCommand({
      commandId: "c1",
      action: "navigation.start",
      args: { query: "外滩" }
    });
    expect(consumed).toBe(true);
    // No fix yet: the command waits rather than blaming a permission that
    // may well be granted. See the "before a fix has arrived" describe block
    // below for the wait/announce/timeout behavior.
    expect(sent).toEqual([]);
  });

  it("requests, then acks ok only after nav.route arrives", () => {
    const { controller, sent } = harness();
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    expect(sent[0]).toMatchObject({ type: "nav.request", reason: "start", query: "外滩" });
    expect(sent.find((p) => p.type === "device.result")).toBeUndefined(); // held
    controller.handleAgentEvent(routeEvent as never);
    expect(sent.at(-1)).toMatchObject({ type: "device.result", commandId: "c1", status: "ok" });
  });

  it("origin is GCJ-02, not the raw WGS fix", () => {
    const { controller, sent } = harness();
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    const req = sent[0] as { origin: { lat: number; lon: number } };
    expect(Math.abs(req.origin.lat - 31.2304)).toBeGreaterThan(0.0005); // shifted
  });

  it("fails the command honestly on nav.error", () => {
    const { controller, sent } = harness();
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "不存在的地方" } });
    controller.handleAgentEvent({ type: "nav.error", commandId: "c1", code: "destination.notFound" });
    expect(sent.at(-1)).toMatchObject({ type: "device.result", status: "failed", reason: "destination.notFound" });
  });

  it("sends one reroute per excursion with a cooldown", () => {
    const nowRef = { t: 0 };
    const { controller, sent } = harness(nowRef);
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    controller.handleAgentEvent(routeEvent as never);
    // ~190 m east of the route — off-route on every fix.
    const off = { lat: 31.232, lon: 121.4757 };
    controller.updatePosition(off);
    controller.updatePosition(off);
    nowRef.t = 5_000;
    controller.updatePosition(off);
    const reroutes = sent.filter((p) => p.type === "nav.request" && p.reason === "reroute");
    expect(reroutes.length).toBe(1);
  });

  it("stops on navigation.stop and guards the inactive case", () => {
    const { controller, sent, states } = harness();
    controller.handleDeviceCommand({ commandId: "s1", action: "navigation.stop", args: {} });
    expect(sent.at(-1)).toMatchObject({ status: "failed", reason: "navigation.notActive" });
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    controller.handleAgentEvent(routeEvent as never);
    controller.handleDeviceCommand({ commandId: "s2", action: "navigation.stop", args: {} });
    expect(sent.at(-1)).toMatchObject({ commandId: "s2", status: "ok" });
    expect(states.at(-1)).toBe("idle");
  });

  it("ignores non-navigation commands", () => {
    const { controller } = harness();
    expect(controller.handleDeviceCommand({ commandId: "x", action: "torch.set", args: { on: true } })).toBe(false);
  });

  it("a superseding start resolves the held command before requesting anew", () => {
    const { controller, sent } = harness();
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    controller.handleDeviceCommand({ commandId: "c2", action: "navigation.start", args: { query: "人民广场" } });
    const cancelIndex = sent.findIndex(
      (p) =>
        p.type === "device.result" &&
        p.commandId === "c1" &&
        p.status === "failed" &&
        p.reason === "navigation.cancelled"
    );
    const c2RequestIndex = sent.findIndex((p) => p.type === "nav.request" && p.commandId === "c2");
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(c2RequestIndex).toBeGreaterThan(cancelIndex);
    controller.handleAgentEvent({ ...routeEvent, commandId: "c2" } as never);
    expect(sent.at(-1)).toMatchObject({ type: "device.result", commandId: "c2", status: "ok" });
  });

  it("stops cleanly with a spoken line when a reroute fails, instead of retrying on the stale route", () => {
    const nowRef = { t: 0 };
    const { controller, sent, states } = harness(nowRef);
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    controller.handleAgentEvent(routeEvent as never);
    // ~190 m east of the route — off-route, triggers a reroute request.
    const off = { lat: 31.232, lon: 121.4757 };
    controller.updatePosition(off);
    const rerouteReq = sent.find((p) => p.type === "nav.request" && p.reason === "reroute");
    expect(rerouteReq).toBeDefined();

    controller.handleAgentEvent({
      type: "nav.error",
      commandId: rerouteReq!.commandId as string,
      code: "route.unavailable"
    } as never);

    expect(sent.filter((p) => p.type === "nav.prompt").map((p) => p.kind)).toEqual(["offRoute", "rerouteFailed"]);
    expect(states.at(-1)).toBe("unavailable");

    const requestCountAfterFailure = sent.filter((p) => p.type === "nav.request").length;
    const promptsAfterFailure = sent.filter((p) => p.type === "nav.prompt").length;
    controller.updatePosition(off);
    expect(sent.filter((p) => p.type === "nav.request").length).toBe(requestCountAfterFailure);
    expect(sent.filter((p) => p.type === "nav.prompt")).toHaveLength(promptsAfterFailure);
  });

  it("stop during requesting resolves the held start then acks the stop", () => {
    const { controller, sent, states } = harness();
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    controller.handleDeviceCommand({ commandId: "s1", action: "navigation.stop", args: {} });
    const results = sent.filter((p) => p.type === "device.result");
    expect(results).toEqual([
      {
        type: "device.result",
        commandId: "c1",
        status: "failed",
        reason: "navigation.cancelled",
        detail: "已取消导航请求。"
      },
      { type: "device.result", commandId: "s1", status: "ok" }
    ]);
    expect(states.at(-1)).toBe("idle");
    const requestCountBefore = sent.filter((p) => p.type === "nav.request").length;
    controller.handleAgentEvent(routeEvent as never); // late answer for the cancelled c1 — must be ignored
    expect(sent.filter((p) => p.type === "nav.request").length).toBe(requestCountBefore);
    expect(sent.filter((p) => p.type === "device.result").length).toBe(2);
  });

  it("reroute success announces off-route only (relay speaks the reroute confirmation)", () => {
    const nowRef = { t: 0 };
    const { controller, sent, states } = harness(nowRef);
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    controller.handleAgentEvent(routeEvent as never);
    // ~190 m east of the route — off-route, triggers a reroute request.
    const off = { lat: 31.232, lon: 121.4757 };
    controller.updatePosition(off);
    const rerouteReq = sent.find((p) => p.type === "nav.request" && p.reason === "reroute");
    expect(rerouteReq).toBeDefined();

    // Simulate a successful reroute response from the relay
    controller.handleAgentEvent({
      type: "nav.route",
      commandId: rerouteReq!.commandId as string,
      destinationName: "外滩",
      destination: MOCK_ROUTE.polyline.at(-1)!,
      distanceMeters: MOCK_ROUTE.distanceMeters,
      etaSeconds: MOCK_ROUTE.etaSeconds,
      polyline: MOCK_ROUTE.polyline,
      steps: MOCK_ROUTE.steps
    } as never);

    // Should announce off-route only; relay speaks the reroute confirmation
    expect(sent.filter((p) => p.type === "nav.prompt").map((p) => p.kind)).toEqual(["offRoute"]);
    expect(states.at(-1)).toBe("guiding");
  });
});

describe("navigation.start before a fix has arrived", () => {
  function fakeScheduler() {
    const pending: { at: number; fn: () => void }[] = [];
    let clock = 0;
    return {
      schedule: (ms: number, fn: () => void) => {
        const entry = { at: clock + ms, fn };
        pending.push(entry);
        return () => {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
        };
      },
      advance(ms: number) {
        clock += ms;
        for (const entry of [...pending]) {
          if (entry.at <= clock) {
            pending.splice(pending.indexOf(entry), 1);
            entry.fn();
          }
        }
      }
    };
  }

  it("shows locating state and starts once a fix arrives", () => {
    const onState = vi.fn();
    const sent: unknown[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p),
      onState,
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(1_500);
    expect(onState).toHaveBeenCalledWith({ phase: "locating", query: "外滩" });
    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });

    expect(sent.some((p) => (p as { type?: string }).type === "nav.request")).toBe(true);
  });

  it("no longer blames a permission that was granted", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(8_000);

    const result = sent.find((p) => p.type === "device.result");
    expect(result?.reason).toBe("route.unavailable");
    expect(result?.detail).toBe("还没定位到，到室外或空旷处再说一次。");
    expect(result?.reason).not.toBe("permission.location");
  });

  it("navigation.stop while awaiting a fix cancels the wait for good", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } } as never);
    nav.handleDeviceCommand({ commandId: "s1", action: "navigation.stop", args: {} } as never);

    // The stop must see the awaiting start as active, resolve it (not
    // navigation.notActive), then ack itself.
    expect(sent).toEqual([
      {
        type: "device.result",
        commandId: "c1",
        status: "failed",
        reason: "navigation.cancelled",
        detail: "已取消导航请求。"
      },
      { type: "device.result", commandId: "s1", status: "ok" }
    ]);

    // The interim line must never be heard after a stop, and a fix that
    // lands later must not resurrect the stopped start.
    timers.advance(8_000);
    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });

    expect(sent.some((p) => p.type === "nav.request")).toBe(false);
    expect(sent.length).toBe(2);
  });

  it("a genuinely denied permission fails immediately, without waiting for a fix", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      onState: () => {},
      schedule: timers.schedule,
      hasLocationPermission: () => false
    });

    nav.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } } as never);

    // Immediate — no 8s wait, no interim "正在定位…" line, and the unchanged
    // permission-denial reason (spec: "If permission is genuinely denied →
    // denied(permission.location) (unchanged)").
    expect(sent).toEqual([{ type: "device.result", commandId: "c1", status: "denied", reason: "permission.location" }]);

    // Advancing the clock (and a fix arriving late) must not retroactively
    // start anything — the denial was terminal, not a wait.
    timers.advance(8_000);
    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });
    expect(sent.length).toBe(1);
  });

  it("no permission signal at all preserves today's wait-for-fix behavior", () => {
    // Every other test in this file omits `hasLocationPermission` entirely —
    // this pins the default so a future change to it can't silently regress
    // every one of them from "waits for a fix" to "denies instantly".
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } } as never);
    expect(sent).toEqual([]); // waiting, not an instant denial

    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });
    expect(sent.some((p) => p.type === "nav.request")).toBe(true);
  });

  it("a second start while awaiting a fix resolves the first command instead of dropping it", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } } as never);
    nav.handleDeviceCommand({
      commandId: "c2",
      action: "navigation.start",
      args: { query: "人民广场" }
    } as never);

    // c1 must get its result now, not silence.
    expect(sent).toEqual([
      {
        type: "device.result",
        commandId: "c1",
        status: "failed",
        reason: "navigation.cancelled",
        detail: "已取消导航请求。"
      }
    ]);

    // Only c2's wait should still be live.
    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });

    expect(sent.some((p) => p.type === "nav.request" && p.commandId === "c2")).toBe(true);
    expect(sent.filter((p) => p.type === "device.result" && p.commandId === "c1").length).toBe(1);
  });
});

describe("web navigation uses MAX relay prompts", () => {
  const origin = { lat: 0, lon: 0 };
  const route: NavRouteEvent = {
    type: "nav.route",
    commandId: "route",
    destinationName: "Finish",
    destination: { lat: 0, lon: 0.01 },
    distanceMeters: 1112,
    etaSeconds: 300,
    polyline: [origin, { lat: 0, lon: 0.01 }],
    steps: [
      { instruction: "Turn right", lat: 0, lon: 0.00018, alongRouteMeters: 20 },
      { instruction: "Continue", lat: 0, lon: 0.01, alongRouteMeters: 1112 }
    ]
  };
  function start() {
    const h = harness();
    h.controller.updatePosition(origin);
    h.controller.handleDeviceCommand({ commandId: "route", action: "navigation.start", args: { query: "Finish" } });
    h.controller.handleAgentEvent(route as never);
    return h;
  }
  it("does not consume the first instruction silently and preserves the pre-advance maneuver index", () => {
    const { controller, sent } = start();
    controller.updatePosition(origin);
    expect(sent.filter((p) => p.type === "nav.prompt")).toEqual([
      expect.objectContaining({
        kind: "maneuver",
        routeCommandId: "route",
        maneuverIndex: 0,
        threshold: "now",
        distanceMeters: 20
      })
    ]);
    controller.updatePosition(origin);
    expect(sent.filter((p) => p.type === "nav.prompt")).toHaveLength(1);
  });
  it("arrival emits exactly one prompt and clears navigation", () => {
    const { controller, sent, states } = start();
    controller.updatePosition(route.destination);
    controller.updatePosition(route.destination);
    expect(sent.filter((p) => p.type === "nav.prompt")).toEqual([
      expect.objectContaining({ kind: "arrived", routeCommandId: "route" })
    ]);
    expect(states.at(-1)).toBe("idle");
  });
  it("ignores stale route and error responses while waiting for a reroute", () => {
    const { controller, sent, states } = start();
    controller.updatePosition({ lat: 0.01, lon: 0 });
    controller.handleAgentEvent({ ...route, commandId: "stale" } as never);
    controller.handleAgentEvent({ type: "nav.error", commandId: "stale", code: "route.unavailable" });
    expect(states.at(-1)).toBe("guiding");
    expect(sent.filter((p) => p.type === "nav.prompt").map((p) => p.kind)).toEqual(["offRoute"]);
  });
});

describe("GPS quality and freshness", () => {
  it("rejects stale, inaccurate, malformed and out-of-order fixes", () => {
    const clock = { t: 20_000 };
    const { controller } = harness(clock);
    const fix = { lat: 31.2304, lon: 121.4737, timestamp: 20_000, accuracy: 10 };
    expect(controller.updatePosition({ ...fix, timestamp: 10_000 })).toBe(false);
    expect(controller.updatePosition({ ...fix, accuracy: 100 })).toBe(false);
    expect(controller.updatePosition({ ...fix, lat: NaN })).toBe(false);
    expect(controller.updatePosition(fix)).toBe(true);
    expect(controller.updatePosition({ ...fix, timestamp: 19_000 })).toBe(false);
    controller.reset();
  });

  it("pauses without advancing guidance, then resumes with an accurate fix", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(20_000);
      const sent: Array<Record<string, unknown>> = [];
      const states: NavPhase[] = [];
      const controller = createNavigationController({
        sendJson: (p) => sent.push(p as Record<string, unknown>),
        onState: (s) => states.push(s)
      });
      const fix = { lat: 31.2304, lon: 121.4737, accuracy: 10 };
      controller.updatePosition(fix);
      controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
      controller.handleAgentEvent(routeEvent as never);
      vi.advanceTimersByTime(10_000);
      expect(states.at(-1)).toMatchObject({ phase: "guiding", locationStale: true, route: routeEvent });
      expect(sent.filter((p) => p.kind === "locationLost")).toHaveLength(1);
      expect(controller.updatePosition({ ...fix, accuracy: 200 })).toBe(false);
      expect(states.at(-1)).toMatchObject({ phase: "guiding", locationStale: true, route: routeEvent });
      expect(controller.updatePosition(fix)).toBe(true);
      expect(states.at(-1)).toMatchObject({ phase: "guiding" });
      expect(states.at(-1)).not.toHaveProperty("locationStale", true);
      controller.reset();
      vi.advanceTimersByTime(10_000);
      expect(sent.filter((p) => p.kind === "locationLost")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a new fix instead of starting from an old cached position", () => {
    const clock = { t: 0 };
    const { controller, sent } = harness(clock);
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    clock.t = 10_000;
    controller.handleDeviceCommand({ commandId: "c1", action: "navigation.start", args: { query: "外滩" } });
    expect(sent).toEqual([]);
    controller.updatePosition({ lat: 31.2304, lon: 121.4737 });
    expect(sent[0]).toMatchObject({ type: "nav.request", commandId: "c1" });
    controller.reset();
  });
});

it("leaves a useful GPS failure visible after the first-fix timeout", () => {
  vi.useFakeTimers();
  try {
    const states: NavPhase[] = [];
    const sent: unknown[] = [];
    const controller = createNavigationController({ sendJson: (p) => sent.push(p), onState: (s) => states.push(s) });
    controller.handleDeviceCommand({ commandId: "gps", action: "navigation.start", args: { query: "外滩" } });
    vi.advanceTimersByTime(8000);
    expect(states.at(-1)).toMatchObject({ phase: "unavailable", message: expect.stringContaining("定位") });
    expect(sent).toEqual([expect.objectContaining({ type: "device.result", commandId: "gps", status: "failed" })]);
    controller.reset();
  } finally {
    vi.useRealTimers();
  }
});
