import { describe, expect, it } from "vitest";
import { createMockRouteProvider, selectRouteProvider } from "../server/routing";
import { MOCK_ROUTE } from "../shared/nav-fixtures";

const origin = { lat: 31.2304, lon: 121.4737 };

describe("MockRouteProvider", () => {
  it("resolves any query to a named destination", async () => {
    const provider = createMockRouteProvider();
    const resolved = await provider.resolveDestination("外滩", origin);
    expect(resolved?.name).toBe("外滩");
    expect(resolved?.location.lat).toBeCloseTo(MOCK_ROUTE.polyline.at(-1)!.lat, 5);
  });

  it("always plans the fixture route", async () => {
    const provider = createMockRouteProvider();
    const route = await provider.planRoute(origin, { lat: 0, lon: 0 });
    expect(route).toEqual(MOCK_ROUTE);
    expect(route!.steps.length).toBeGreaterThanOrEqual(2);
    expect(route!.polyline.length).toBeGreaterThanOrEqual(6);
  });
});

describe("selectRouteProvider", () => {
  it("selects amap when a key exists, mock otherwise, warning once", () => {
    const warnings: string[] = [];
    const log = { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} };
    expect(selectRouteProvider("real-key", log).mode).toBe("amap");
    expect(warnings.length).toBe(0);
    expect(selectRouteProvider("", log).mode).toBe("mock");
    expect(warnings.length).toBe(1);
    // The once-per-process latch is intentional: sessions re-select on every
    // connection, so a per-session warn would spam the log. The latch implements
    // startup semantics — the warning surfaces once per process, not per selection.
    expect(selectRouteProvider("", log).mode).toBe("mock");
    expect(warnings.length).toBe(1);
  });
});
