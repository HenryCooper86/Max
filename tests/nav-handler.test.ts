import { describe, expect, it } from "vitest";
import { navRouteOkSpeech } from "../server/device-actions";
import { createMockRouteProvider, createNavHandler } from "../server/routing";
import type { NavErrorEvent, NavRequestEvent, NavRouteEvent } from "../shared/agent";

const origin = { lat: 31.2304, lon: 121.4737 };
const start: NavRequestEvent = { type: "nav.request", commandId: "c1", reason: "start", origin, query: "外滩" };

function collector() {
  const sent: Array<NavRouteEvent | NavErrorEvent> = [];
  return { sent, send: (p: NavRouteEvent | NavErrorEvent) => sent.push(p) };
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
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

  describe("onRouteAnnounced", () => {
    it("is invoked exactly once, with the composed line, when a start answers with nav.route", async () => {
      const { sent, send } = collector();
      const announced: string[] = [];
      const handle = createNavHandler({
        provider: createMockRouteProvider(),
        send,
        onRouteAnnounced: (speech) => announced.push(speech)
      });
      await handle(start);
      const routed = sent[0] as NavRouteEvent;
      expect(announced).toEqual([navRouteOkSpeech(routed.destinationName, routed.distanceMeters, routed.etaSeconds)]);
    });

    it("is NOT invoked for a reroute answer", async () => {
      const { sent, send } = collector();
      const announced: string[] = [];
      const handle = createNavHandler({
        provider: createMockRouteProvider(),
        send,
        onRouteAnnounced: (speech) => announced.push(speech)
      });
      await handle(start); // one announcement for the start
      expect(announced).toHaveLength(1);
      const routed = sent[0] as NavRouteEvent;
      await handle({
        type: "nav.request",
        commandId: "r1",
        reason: "reroute",
        origin,
        destination: routed.destination,
        destinationName: routed.destinationName
      });
      expect(announced).toHaveLength(1); // unchanged by the reroute
    });

    it("is NOT invoked for a nav.error answer", async () => {
      const failing = {
        mode: "amap" as const,
        resolveDestination: async () => null,
        planRoute: async () => null
      };
      const { sent, send } = collector();
      const announced: string[] = [];
      const handle = createNavHandler({
        provider: failing,
        send,
        onRouteAnnounced: (speech) => announced.push(speech)
      });
      await handle(start);
      expect(sent[0]).toMatchObject({ type: "nav.error" });
      expect(announced).toEqual([]);
    });

    it("omitting the callback changes nothing", async () => {
      const { sent, send } = collector();
      const handle = createNavHandler({ provider: createMockRouteProvider(), send });
      await handle(start);
      expect(sent[0]).toMatchObject({ type: "nav.route", commandId: "c1", destinationName: "外滩" });
    });
  });

  describe("out-of-order start completions", () => {
    it("drops a superseded start's late completion instead of attaching the wrong destination's summary", async () => {
      // session-controller.ts dispatches nav.request fire-and-forget, so two
      // "start" requests can run concurrently in the same handler. The rider
      // re-starts to B before A's (slower) provider round trip returns; B
      // must win — A's late completion must be a total no-op.
      const resolveA = defer<{ name: string; location: typeof origin } | null>();
      const resolveB = defer<{ name: string; location: typeof origin } | null>();
      const planA = defer<{
        distanceMeters: number;
        etaSeconds: number;
        polyline: (typeof origin)[];
        steps: never[];
      } | null>();
      const planB = defer<{
        distanceMeters: number;
        etaSeconds: number;
        polyline: (typeof origin)[];
        steps: never[];
      } | null>();
      const destA = { lat: 1, lon: 1 };
      const destB = { lat: 2, lon: 2 };

      const provider = {
        mode: "amap" as const,
        resolveDestination: async (query: string) => (query === "A地" ? resolveA.promise : resolveB.promise),
        planRoute: async (_origin: typeof origin, destination: typeof origin) =>
          destination === destA ? planA.promise : planB.promise
      };

      const { sent, send } = collector();
      const announced: string[] = [];
      const handle = createNavHandler({ provider, send, onRouteAnnounced: (speech) => announced.push(speech) });

      const startA: NavRequestEvent = { type: "nav.request", commandId: "a1", reason: "start", origin, query: "A地" };
      const startB: NavRequestEvent = { type: "nav.request", commandId: "b1", reason: "start", origin, query: "B地" };

      const doneA = handle(startA); // A's round trip begins first…
      const doneB = handle(startB); // …but the rider immediately re-starts to B

      // B — the rider's actual, current destination — resolves and completes first.
      resolveB.resolve({ name: "B地", location: destB });
      planB.resolve({ distanceMeters: 2_000, etaSeconds: 200, polyline: [], steps: [] });
      await doneB;
      expect(sent).toEqual([expect.objectContaining({ type: "nav.route", commandId: "b1", destinationName: "B地" })]);
      expect(announced).toEqual([navRouteOkSpeech("B地", 2_000, 200)]);

      // A's stale round trip finally lands — it must be dropped silently: no
      // second nav.route, no nav.error for the abandoned request, and no
      // second onRouteAnnounced call carrying A's summary.
      resolveA.resolve({ name: "A地", location: destA });
      planA.resolve({ distanceMeters: 9_000, etaSeconds: 900, polyline: [], steps: [] });
      await doneA;
      expect(sent).toHaveLength(1);
      expect(announced).toHaveLength(1);

      // Sibling hazard: A's late completion must also not have clobbered the
      // cached route a subsequent reroute serves — it must still be B's.
      await handle({
        type: "nav.request",
        commandId: "r1",
        reason: "reroute",
        origin,
        destination: destB,
        destinationName: "B地"
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ type: "nav.route", commandId: "r1", destinationName: "B地" });
    });

    it("also drops a superseded start that resolves to nav.error after being superseded", async () => {
      const resolveA = defer<{ name: string; location: typeof origin } | null>();
      const resolveB = defer<{ name: string; location: typeof origin } | null>();

      const provider = {
        mode: "amap" as const,
        resolveDestination: async (query: string) => (query === "A地" ? resolveA.promise : resolveB.promise),
        planRoute: async () => ({ distanceMeters: 2_000, etaSeconds: 200, polyline: [], steps: [] })
      };

      const { sent, send } = collector();
      const announced: string[] = [];
      const handle = createNavHandler({ provider, send, onRouteAnnounced: (speech) => announced.push(speech) });

      const startA: NavRequestEvent = { type: "nav.request", commandId: "a1", reason: "start", origin, query: "A地" };
      const startB: NavRequestEvent = { type: "nav.request", commandId: "b1", reason: "start", origin, query: "B地" };

      const doneA = handle(startA);
      const doneB = handle(startB);

      resolveB.resolve({ name: "B地", location: { lat: 2, lon: 2 } });
      await doneB;
      expect(sent).toHaveLength(1);
      expect(announced).toHaveLength(1);

      // A's stale destination lookup fails after being superseded — no
      // nav.error for the abandoned request should reach the client.
      resolveA.resolve(null);
      await doneA;
      expect(sent).toHaveLength(1);
      expect(announced).toHaveLength(1);
    });
  });
});
