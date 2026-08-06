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
  it("denies navigation.start without a position fix", () => {
    const { controller, sent } = harness();
    const consumed = controller.handleDeviceCommand({
      commandId: "c1",
      action: "navigation.start",
      args: { query: "外滩" }
    });
    expect(consumed).toBe(true);
    expect(sent[0]).toMatchObject({ type: "device.result", status: "denied", reason: "permission.location" });
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
});
