// tests/web-navigation.test.ts
import { describe, expect, it } from "vitest";
import { createNavigationController } from "../src/lib/navigation";
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
  const spoken: string[] = [];
  const states: string[] = [];
  const controller = createNavigationController({
    sendJson: (p) => sent.push(p as Record<string, unknown>),
    speak: (t) => spoken.push(t),
    onState: (s) => states.push(s.phase),
    now: () => nowRef.t
  });
  return { controller, sent, spoken, states };
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
    const { controller, sent, spoken, states } = harness(nowRef);
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

    expect(spoken).toEqual(["已偏离路线，正在重新规划", "无法重新规划路线，已停止导航"]);
    expect(states.at(-1)).toBe("idle");

    const requestCountAfterFailure = sent.filter((p) => p.type === "nav.request").length;
    const spokenCountAfterFailure = spoken.length;
    controller.updatePosition(off);
    expect(sent.filter((p) => p.type === "nav.request").length).toBe(requestCountAfterFailure);
    expect(spoken.length).toBe(spokenCountAfterFailure);
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
    const { controller, sent, spoken, states } = harness(nowRef);
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
    expect(spoken).toEqual(["已偏离路线，正在重新规划"]);
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

  it("announces 正在定位 and starts once a fix arrives", () => {
    const sent: unknown[] = [];
    const spoken: string[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p),
      speak: (t) => spoken.push(t),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(1_500);
    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });

    expect(spoken).toContain("正在定位…");
    expect(sent.some((p) => (p as { type?: string }).type === "nav.request")).toBe(true);
  });

  it("no longer blames a permission that was granted", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      speak: () => {},
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

  it("stays silent when a fix is already in hand", () => {
    const spoken: string[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: () => {},
      speak: (t) => spoken.push(t),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });
    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(5_000);

    expect(spoken).not.toContain("正在定位…");
  });

  it("navigation.stop while awaiting a fix cancels the wait for good", () => {
    const sent: Record<string, unknown>[] = [];
    const spoken: string[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      speak: (t) => spoken.push(t),
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

    expect(spoken).not.toContain("正在定位…");
    expect(sent.some((p) => p.type === "nav.request")).toBe(false);
    expect(sent.length).toBe(2);
  });

  it("a second start while awaiting a fix resolves the first command instead of dropping it", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      speak: () => {},
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
