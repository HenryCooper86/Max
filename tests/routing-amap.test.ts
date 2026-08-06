import { describe, expect, it } from "vitest";
import { createAmapRouteProvider } from "../server/routing";

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

  it("returns null on empty pois, bad status, and HTTP error", async () => {
    for (const body of [
      JSON.stringify({ status: "1", pois: [] }),
      JSON.stringify({ status: "0", info: "INVALID_USER_KEY" })
    ]) {
      const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(body) });
      expect(await provider.resolveDestination("x", origin)).toBeNull();
    }
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning("oops", 500) });
    expect(await provider.resolveDestination("x", origin)).toBeNull();
  });
});

describe("AmapRouteProvider.planRoute", () => {
  it("maps distance, eta, concatenated polyline, and step-end maneuvers", async () => {
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: fetchReturning(DRIVING_OK) });
    const route = await provider.planRoute(origin, destination);
    expect(route).not.toBeNull();
    expect(route!.distanceMeters).toBe(1200);
    expect(route!.etaSeconds).toBe(300);
    expect(route!.polyline[0]).toEqual({ lat: 31.2304, lon: 121.4737 });
    expect(route!.polyline.at(-1)).toEqual({ lat: 31.236, lon: 121.4751 });
    expect(route!.steps).toEqual([
      { instruction: "向北行驶", lat: 31.236, lon: 121.4737, alongRouteMeters: 700 },
      { instruction: "右转进入南京东路", lat: 31.236, lon: 121.4751, alongRouteMeters: 1200 }
    ]);
  });

  it("returns null on malformed numbers and reports the failure", async () => {
    const bad = JSON.stringify({ status: "1", route: { paths: [{ distance: "abc", cost: {}, steps: [] }] } });
    const reasons: string[] = [];
    const provider = createAmapRouteProvider({
      apiKey: "k",
      fetchImpl: fetchReturning(bad),
      onFailure: (r) => reasons.push(r)
    });
    expect(await provider.planRoute(origin, destination)).toBeNull();
    expect(reasons.length).toBe(1);
  });

  it("returns null on timeout", async () => {
    const never: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const provider = createAmapRouteProvider({ apiKey: "k", fetchImpl: never, timeoutMs: 10 });
    expect(await provider.planRoute(origin, destination)).toBeNull();
  });
});
