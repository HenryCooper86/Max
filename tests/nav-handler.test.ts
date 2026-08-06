import { describe, expect, it } from "vitest";
import { createMockRouteProvider, createNavHandler } from "../server/routing";
import type { NavErrorEvent, NavRequestEvent, NavRouteEvent } from "../shared/agent";

const origin = { lat: 31.2304, lon: 121.4737 };
const start: NavRequestEvent = { type: "nav.request", commandId: "c1", reason: "start", origin, query: "外滩" };

function collector() {
  const sent: Array<NavRouteEvent | NavErrorEvent> = [];
  return { sent, send: (p: NavRouteEvent | NavErrorEvent) => sent.push(p) };
}

describe("createNavHandler", () => {
  it("answers start with nav.route from the provider", async () => {
    const { sent, send } = collector();
    const handle = createNavHandler({ provider: createMockRouteProvider(), send });
    await handle(start);
    expect(sent[0]).toMatchObject({ type: "nav.route", commandId: "c1", destinationName: "外滩" });
  });

  it("answers with nav.error codes that match the failing stage", async () => {
    const failing = {
      mode: "amap" as const,
      resolveDestination: async () => null,
      planRoute: async () => null
    };
    const { sent, send } = collector();
    const handle = createNavHandler({ provider: failing, send });
    await handle(start);
    expect(sent[0]).toEqual({ type: "nav.error", commandId: "c1", code: "destination.notFound" });

    const resolving = { ...failing, resolveDestination: async () => ({ name: "外滩", location: origin }) };
    const handle2 = createNavHandler({ provider: resolving, send });
    await handle2({ ...start, commandId: "c2" });
    expect(sent[1]).toEqual({ type: "nav.error", commandId: "c2", code: "route.unavailable" });
  });

  it("serves reroutes but guards the minimum interval with the cached route", async () => {
    let clock = 0;
    let planCalls = 0;
    const mock = createMockRouteProvider();
    const counting = {
      ...mock,
      planRoute: (...args: Parameters<typeof mock.planRoute>) => {
        planCalls += 1;
        return mock.planRoute(...args);
      }
    };
    const { sent, send } = collector();
    const handle = createNavHandler({ provider: counting, send, now: () => clock, minRerouteIntervalMs: 10_000 });
    await handle(start);
    const routed = sent[0] as NavRouteEvent;
    const reroute: NavRequestEvent = {
      type: "nav.request",
      commandId: "r1",
      reason: "reroute",
      origin,
      destination: routed.destination,
      destinationName: routed.destinationName
    };
    clock = 1_000;
    await handle(reroute); // inside the interval → cached route, no plan call
    clock = 20_000;
    await handle({ ...reroute, commandId: "r2" }); // outside → fresh plan
    expect(planCalls).toBe(2); // start + second reroute
    expect(sent[1]).toMatchObject({ type: "nav.route", commandId: "r1" });
    expect(sent[2]).toMatchObject({ type: "nav.route", commandId: "r2" });
  });

  it("a failed start clears the cached route", async () => {
    let clock = 0;
    let planCalls = 0;
    const mock = createMockRouteProvider();
    const provider = {
      ...mock,
      resolveDestination: async (query: string, near: typeof origin) => {
        if (query === "不存在的地方") return null;
        return mock.resolveDestination(query, near);
      },
      planRoute: (...args: Parameters<typeof mock.planRoute>) => {
        planCalls += 1;
        return mock.planRoute(...args);
      }
    };
    const { sent, send } = collector();
    const handle = createNavHandler({ provider, send, now: () => clock, minRerouteIntervalMs: 10_000 });
    await handle(start); // succeeds, caches a route for 外滩
    const routed = sent[0] as NavRouteEvent;

    clock = 1_000;
    await handle({ type: "nav.request", commandId: "c2", reason: "start", origin, query: "不存在的地方" });
    expect(sent[1]).toEqual({ type: "nav.error", commandId: "c2", code: "destination.notFound" });

    clock = 2_000; // still inside the 10 s guard window relative to the original cache
    await handle({
      type: "nav.request",
      commandId: "r1",
      reason: "reroute",
      origin,
      destination: routed.destination,
      destinationName: routed.destinationName
    });
    // The failed start must have cleared lastRoute/lastRerouteAt: this reroute
    // gets a fresh plan, never the stale cache from the abandoned session.
    expect(planCalls).toBe(2); // start's plan + this reroute's plan
    expect(sent[2]).toMatchObject({ type: "nav.route", commandId: "r1" });
  });

  it("a guarded reroute for a different destination replans instead of serving the cache", async () => {
    let clock = 0;
    let planCalls = 0;
    const mock = createMockRouteProvider();
    const counting = {
      ...mock,
      planRoute: (...args: Parameters<typeof mock.planRoute>) => {
        planCalls += 1;
        return mock.planRoute(...args);
      }
    };
    const { sent, send } = collector();
    const handle = createNavHandler({ provider: counting, send, now: () => clock, minRerouteIntervalMs: 10_000 });
    await handle(start); // plan call 1, caches a route to 外滩's destination

    clock = 1_000; // inside the interval — but the destination is different
    const otherDestination = { lat: 31.5, lon: 121.9 };
    await handle({
      type: "nav.request",
      commandId: "r1",
      reason: "reroute",
      origin,
      destination: otherDestination,
      destinationName: "别的地方"
    });
    expect(planCalls).toBe(2); // the destination mismatch bypasses the cache guard
    expect(sent[1]).toMatchObject({ type: "nav.route", commandId: "r1" });
    expect((sent[1] as NavRouteEvent).destination).toEqual(otherDestination);
  });
});
