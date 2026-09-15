import { describe, expect, it } from "vitest";
import { createAmapRouteProvider } from "../server/routing";
import { haversineMeters } from "../shared/guidance";

const PLACE_OK = JSON.stringify({
  status: "1",
  pois: [{ name: "人民广场", location: "121.475097,31.228917" }]
});
const DRIVING_OK = JSON.stringify({
  status: "1",
  route: {
    paths: [
      {
        distance: "1200",
        cost: { duration: "300" },
        steps: [
          { instruction: "向北行驶", step_distance: "700", polyline: "121.4737,31.2304;121.4737,31.2360" },
          { instruction: "右转进入南京东路", step_distance: "500", polyline: "121.4737,31.2360;121.4751,31.2360" }
        ]
      }
    ]
  }
});

function fetchReturning(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

const origin = { lat: 31.2304, lon: 121.4737 };
const destination = { lat: 31.228917, lon: 121.475097 };

describe("AmapRouteProvider.resolveDestination", () => {
  it("maps the top poi to name + GCJ-02 location", async () => {
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(PLACE_OK) });
    const resolved = await provider.resolveDestination("人民广场", origin);
    expect(resolved).toEqual({ name: "人民广场", location: { lat: 31.228917, lon: 121.475097 } });
  });

  it("distinguishes empty search from service failures", async () => {
    const empty = createAmapRouteProvider({
      apiKey: "k",
      fetchImpl: fetchReturning(JSON.stringify({ status: "1", pois: [] }))
    });
    expect(await empty.resolveDestination("x", origin)).toBeNull();
    for (const [body, status] of [
      [JSON.stringify({ status: "0", infocode: "10005" }), 200],
      ["oops", 500],
      ["null", 200]
    ] as const) {
      const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(body, status) });
      await expect(provider.resolveDestination("x", origin)).rejects.toThrow("Amap failure:");
    }
  });
});

describe("AmapRouteProvider.planRoute", () => {
  it("maps eta, concatenated polyline, and step-end maneuvers", async () => {
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(DRIVING_OK) });
    const route = await provider.planRoute(origin, destination);
    expect(route).not.toBeNull();
    expect(route!.etaSeconds).toBe(300);
    expect(route!.polyline[0]).toEqual({ lat: 31.2304, lon: 121.4737 });
    expect(route!.polyline.at(-1)).toEqual({ lat: 31.236, lon: 121.4751 });
    expect(route!.steps.map((s) => ({ instruction: s.instruction, lat: s.lat, lon: s.lon }))).toEqual([
      { instruction: "向北行驶", lat: 31.236, lon: 121.4737 },
      { instruction: "右转进入南京东路", lat: 31.236, lon: 121.4751 }
    ]);
  });

  it("derives alongRouteMeters and distanceMeters from the polyline, not step_distance", async () => {
    // The fixture's step_distance values (700/500) deliberately disagree with
    // the polyline's real haversine lengths (~623/~133 m): live Amap responses
    // drift the same way (126 m measured on a 2.8 km route), and the guidance
    // engine measures the rider on the polyline — the maneuvers must share
    // that base or prompts and advancement fire early.
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(DRIVING_OK) });
    const route = await provider.planRoute(origin, destination);
    expect(route).not.toBeNull();
    expect(route!.steps[0].alongRouteMeters).toBeGreaterThan(615);
    expect(route!.steps[0].alongRouteMeters).toBeLessThan(630);
    expect(route!.distanceMeters).toBeGreaterThan(748);
    expect(route!.distanceMeters).toBeLessThan(764);
    expect(route!.steps.at(-1)!.alongRouteMeters).toBe(route!.distanceMeters);
    // Exact contract: each maneuver's alongRouteMeters equals the cumulative
    // haversine length of the polyline up to that maneuver's coordinate.
    let cumulative = 0;
    let index = 0;
    for (const step of route!.steps) {
      while (
        index < route!.polyline.length - 1 &&
        (route!.polyline[index].lat !== step.lat || route!.polyline[index].lon !== step.lon)
      ) {
        cumulative += haversineMeters(route!.polyline[index], route!.polyline[index + 1]);
        index += 1;
      }
      expect(Math.abs(step.alongRouteMeters - cumulative)).toBeLessThanOrEqual(1);
    }
  });

  it("rejects malformed numbers and reports the failure", async () => {
    const bad = JSON.stringify({ status: "1", route: { paths: [{ distance: "abc", cost: {}, steps: [] }] } });
    const reasons: string[] = [];
    const provider = createAmapRouteProvider({
      apiKey: "k",
      fetchImpl: fetchReturning(bad),
      onFailure: (r) => reasons.push(r)
    });
    await expect(provider.planRoute(origin, destination)).rejects.toThrow("Amap failure:");
    expect(reasons.length).toBe(1);
  });

  it("rejects on timeout", async () => {
    const never: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: never, timeoutMs: 10 });
    await expect(provider.planRoute(origin, destination)).rejects.toThrow("Amap failure:");
  });
});

describe("Amap malformed upstream data", () => {
  it.each([",", " ,31", "121,", "181,31", "121,91"])("rejects invalid POI coordinate %s", async (location) => {
    const provider = createAmapRouteProvider({
      apiKey: "k",
      fetchImpl: fetchReturning(
        JSON.stringify({
          status: "1",
          pois: [{ name: "destination", location }]
        })
      )
    });
    await expect(provider.resolveDestination("x", origin)).rejects.toThrow("place.location");
  });

  it.each([null, "", " ", -1, true, []])("rejects invalid route duration %j", async (duration) => {
    const body = JSON.parse(DRIVING_OK);
    body.route.paths[0].cost.duration = duration;
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(JSON.stringify(body)) });
    await expect(provider.planRoute(origin, destination)).rejects.toThrow("driving.shape");
  });

  it("reports malformed null steps through the failure callback", async () => {
    const body = JSON.parse(DRIVING_OK);
    body.route.paths[0].steps = [null];
    const reasons: string[] = [];
    const provider = createAmapRouteProvider({
      apiKey: "k",
      fetchImpl: fetchReturning(JSON.stringify(body)),
      onFailure: (reason) => reasons.push(reason)
    });
    await expect(provider.planRoute(origin, destination)).rejects.toThrow("driving.step");
    expect(reasons).toEqual(["driving.step"]);
  });

  it("rejects a route with no traversable geometry", async () => {
    const body = JSON.parse(DRIVING_OK);
    body.route.paths[0].steps = [{ instruction: "arrive", step_distance: "0", polyline: "121,31;121,31" }];
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(JSON.stringify(body)) });
    await expect(provider.planRoute(origin, destination)).rejects.toThrow("driving.polyline");
  });
});
