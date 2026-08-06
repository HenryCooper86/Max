# Amap Navigation — Plan A: Relay Routing + Web HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay-side Amap routing behind a provider-neutral interface, new `nav.*` protocol events, a shared TypeScript guidance engine, and web-HUD turn-by-turn — the foundation the iOS swap (Plan B) and Android port (Plan C) build on.

**Architecture:** The relay resolves "导航去X" destinations (Amap place search) and plans routes (Amap `v5/direction/driving`) server-side, publishing `nav.route` to clients; a `MockRouteProvider` serves fixture routes when no key is configured. The web HUD becomes the first client of the new path: it handles `device.command navigation.start/stop`, runs the shared guidance engine on position fixes, speaks prompts, and renders a route panel (SVG schematic always; Amap JS map when a JS key exists, with the 安全密钥 kept server-side behind an `/_AMapService` proxy).

**Tech Stack:** TypeScript (Node 22, ES modules), Express 5, ws, vitest, React 19 + Vite. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-amap-navigation-design.md`

## Global Constraints

- Node >= 22.13.0; `"type": "module"`; run tests with `npx vitest run <file>`.
- Code style: 2-space indent, double quotes, semicolons (prettier enforces; run `npx prettier --write <files>` before each commit).
- Every coordinate in `nav.*` protocol events is **GCJ-02**. The relay never converts datums; the web client converts WGS-84 GPS fixes at the source with `wgs84ToGcj02`.
- Fail honest: route providers return `null` on every failure (missing key, HTTP error, timeout, empty result) — never a guessed route. Comment style follows `server/vision.ts`.
- No foreign CDN or bundled map assets: the Amap JS API loads at runtime from `webapi.amap.com` only, and only when a key is configured. The app must remain fully usable (guidance card + SVG schematic) with no Amap keys at all.
- After editing `protocol/agent-events.schema.json`, run `npm run generate:protocol` and commit the regenerated `shared/generated/agent-protocol.ts` in the same commit.
- `npm run check` (protocol sync, prettier, eslint, knip dead-code, vitest, fault matrix, build) must be green at the end of the final task. Do not export anything no task consumes — knip fails the build on dead exports.
- Existing behavior of iOS/Android/RDK clients must not change: they neither send `nav.request` nor receive `nav.route` until Plans B/C, and unknown server events are already ignored by all clients.

---

### Task 1: GCJ-02 conversion (`shared/geo.ts`)

**Files:**

- Create: `shared/geo.ts`
- Test: `tests/geo.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type GeoPoint = { lat: number; lon: number }`; `wgs84ToGcj02(p: GeoPoint): GeoPoint`. (No inverse in TS — no TS platform ever converts GCJ→WGS; the inverse lives in Swift in Plan B. Do not add it; knip would flag it dead.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/geo.test.ts
import { describe, expect, it } from "vitest";
import { wgs84ToGcj02 } from "../shared/geo";

describe("wgs84ToGcj02", () => {
  it("leaves points outside China untouched", () => {
    const tokyo = { lat: 35.683861, lon: 139.77492 };
    expect(wgs84ToGcj02(tokyo)).toEqual(tokyo);
  });

  it("matches the published Shanghai vector to ~10 m", () => {
    // Vector from the eviltransform reference test suite.
    const gcj = wgs84ToGcj02({ lat: 31.1774276, lon: 121.5272106 });
    expect(Math.abs(gcj.lat - 31.17530398)).toBeLessThan(1e-4);
    expect(Math.abs(gcj.lon - 121.53146073)).toBeLessThan(1e-4);
  });

  it("shifts China points by a plausible offset (100–700 m)", () => {
    // ~1 deg lat ≈ 111 km, so 100–700 m ≈ 0.0009–0.0063 deg.
    for (const p of [
      { lat: 39.911954, lon: 116.377817 }, // Beijing
      { lat: 22.543847, lon: 113.912316 }, // Shenzhen
      { lat: 31.2304, lon: 121.4737 } // Shanghai
    ]) {
      const gcj = wgs84ToGcj02(p);
      const offsetDeg = Math.hypot(gcj.lat - p.lat, gcj.lon - p.lon);
      expect(offsetDeg).toBeGreaterThan(0.0009);
      expect(offsetDeg).toBeLessThan(0.0063);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/geo.test.ts`
Expected: FAIL — cannot resolve `../shared/geo`.

- [ ] **Step 3: Implement the standard transform**

```ts
// shared/geo.ts
/**
 * WGS-84 → GCJ-02, the standard published transform (a = 6378245,
 * ee = 0.00669342162296594323). One conversion, at the location source:
 * everything downstream of this call — guidance math, nav.* events, map
 * rendering on GCJ-02 surfaces — speaks GCJ-02. There is deliberately no
 * inverse here: no TypeScript platform converts GCJ→WGS (iOS does, in Swift).
 */

export type GeoPoint = { lat: number; lon: number };

const A = 6378245;
const EE = 0.00669342162296594323;

function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

export function wgs84ToGcj02({ lat, lon }: GeoPoint): GeoPoint {
  if (outOfChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/geo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write shared/geo.ts tests/geo.test.ts
git add shared/geo.ts tests/geo.test.ts
git commit -m "feat(nav): add wgs84ToGcj02 with golden-vector tests"
```

---

### Task 2: `nav.*` protocol events

**Files:**

- Modify: `protocol/agent-events.schema.json` (add NavRequest to `ClientEvent.oneOf`, NavRoute + NavError to `AgentEvent.oneOf`)
- Modify: `shared/generated/agent-protocol.ts` (via `npm run generate:protocol` — never by hand)
- Modify: `shared/agent.ts` (`ClientEvent` union at ~line 232, `AgentEvent` union at ~line 302)
- Modify: `server/session-controller.ts` (`parseClientEvent`)
- Test: `tests/nav-protocol.test.ts`

**Interfaces:**

- Consumes: `parseClientEvent` (session-controller), existing union patterns in `shared/agent.ts`.
- Produces (used by every later task):

```ts
// shared/agent.ts additions — exact shapes
export type NavManeuver = { instruction: string; lat: number; lon: number; alongRouteMeters: number };

export type NavRequestEvent = {
  type: "nav.request";
  commandId: string;
  reason: "start" | "reroute";
  /** GCJ-02, like every nav.* coordinate. */
  origin: { lat: number; lon: number };
  /** reason "start": the spoken destination phrase. */
  query?: string;
  /** reason "reroute": the destination nav.route previously announced. */
  destination?: { lat: number; lon: number };
  destinationName?: string;
};

export type NavRouteEvent = {
  type: "nav.route";
  commandId: string;
  destinationName: string;
  destination: { lat: number; lon: number };
  distanceMeters: number;
  etaSeconds: number;
  polyline: Array<{ lat: number; lon: number }>;
  steps: NavManeuver[];
};

export type NavErrorEvent = {
  type: "nav.error";
  commandId: string;
  code: "destination.notFound" | "route.unavailable";
};
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/nav-protocol.test.ts
import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { parseClientEvent } from "../server/session-controller";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const origin = { lat: 31.2304, lon: 121.4737 };

describe("generated protocol", () => {
  it("includes the nav events", () => {
    expect(CLIENT_EVENT_TYPES).toContain("nav.request");
    expect(SERVER_EVENT_TYPES).toContain("nav.route");
    expect(SERVER_EVENT_TYPES).toContain("nav.error");
  });
});

describe("parseClientEvent nav.request", () => {
  it("accepts a start request", () => {
    const event = parseClientEvent(
      encode({ type: "nav.request", commandId: "c1", reason: "start", origin, query: "人民广场" })
    );
    expect(event).toMatchObject({ type: "nav.request", commandId: "c1", reason: "start", query: "人民广场" });
  });

  it("accepts a reroute request with destination", () => {
    const event = parseClientEvent(
      encode({
        type: "nav.request",
        commandId: "c2",
        reason: "reroute",
        origin,
        destination: { lat: 31.24, lon: 121.49 },
        destinationName: "人民广场"
      })
    );
    expect(event).toMatchObject({ type: "nav.request", reason: "reroute", destinationName: "人民广场" });
  });

  it("rejects a start request without a query", () => {
    expect(() => parseClientEvent(encode({ type: "nav.request", commandId: "c3", reason: "start", origin }))).toThrow(
      /query/
    );
  });

  it("rejects a reroute request without a destination", () => {
    expect(() => parseClientEvent(encode({ type: "nav.request", commandId: "c4", reason: "reroute", origin }))).toThrow(
      /destination/
    );
  });

  it("rejects an out-of-range origin", () => {
    expect(() =>
      parseClientEvent(
        encode({ type: "nav.request", commandId: "c5", reason: "start", origin: { lat: 91, lon: 0 }, query: "x" })
      )
    ).toThrow(/lat/);
  });

  it("rejects an oversized query", () => {
    expect(() =>
      parseClientEvent(
        encode({ type: "nav.request", commandId: "c6", reason: "start", origin, query: "深".repeat(200) })
      )
    ).toThrow(/query/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav-protocol.test.ts`
Expected: FAIL — `CLIENT_EVENT_TYPES` lacks "nav.request".

- [ ] **Step 3: Add the three events to the schema**

In `protocol/agent-events.schema.json`, append to `$defs.ClientEvent.oneOf` (after CrashCancel):

```json
{
  "title": "NavRequest",
  "type": "object",
  "properties": {
    "type": { "const": "nav.request" },
    "commandId": { "type": "string", "minLength": 1 },
    "reason": { "enum": ["start", "reroute"] },
    "origin": {
      "description": "GCJ-02, like every nav.* coordinate.",
      "type": "object",
      "properties": { "lat": { "type": "number" }, "lon": { "type": "number" } },
      "required": ["lat", "lon"]
    },
    "query": { "type": "string" },
    "destination": {
      "type": "object",
      "properties": { "lat": { "type": "number" }, "lon": { "type": "number" } },
      "required": ["lat", "lon"]
    },
    "destinationName": { "type": "string" }
  },
  "required": ["type", "commandId", "reason", "origin"]
}
```

Append to `$defs.AgentEvent.oneOf` (after CrashSimulate):

```json
{
  "title": "NavRoute",
  "type": "object",
  "properties": {
    "type": { "const": "nav.route" },
    "commandId": { "type": "string", "minLength": 1 },
    "destinationName": { "type": "string" },
    "destination": {
      "description": "GCJ-02, like every nav.* coordinate.",
      "type": "object",
      "properties": { "lat": { "type": "number" }, "lon": { "type": "number" } },
      "required": ["lat", "lon"]
    },
    "distanceMeters": { "type": "number" },
    "etaSeconds": { "type": "number" },
    "polyline": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "lat": { "type": "number" }, "lon": { "type": "number" } },
        "required": ["lat", "lon"]
      }
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "instruction": { "type": "string" },
          "lat": { "type": "number" },
          "lon": { "type": "number" },
          "alongRouteMeters": { "type": "number" }
        },
        "required": ["instruction", "lat", "lon", "alongRouteMeters"]
      }
    }
  },
  "required": ["type", "commandId", "destinationName", "destination", "distanceMeters", "etaSeconds", "polyline", "steps"]
},
{
  "title": "NavError",
  "type": "object",
  "properties": {
    "type": { "const": "nav.error" },
    "commandId": { "type": "string", "minLength": 1 },
    "code": { "enum": ["destination.notFound", "route.unavailable"] }
  },
  "required": ["type", "commandId", "code"]
}
```

Run: `npm run generate:protocol`

- [ ] **Step 4: Add the TS types and validation**

In `shared/agent.ts`: add the three event types plus `NavManeuver` exactly as in **Interfaces** above; add `| NavRequestEvent` to the `ClientEvent` union and `| NavRouteEvent | NavErrorEvent` to the `AgentEvent` union, following how `crash.alert`/`crash.ack` entries are placed.

In `server/session-controller.ts`, add to `parseClientEvent` (next to the `camera.frame` branch):

```ts
if (value.type === "nav.request") {
  if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
    throw new Error("Invalid nav.request commandId");
  }
  if (value.reason !== "start" && value.reason !== "reroute") throw new Error("Invalid nav.request reason");
  const origin = value.origin as Record<string, unknown> | undefined;
  if (!origin || typeof origin !== "object") throw new Error("Invalid nav.request origin");
  assertCoordinate(origin.lat, -90, 90, "lat");
  assertCoordinate(origin.lon, -180, 180, "lon");
  if (value.reason === "start") {
    if (typeof value.query !== "string" || !value.query.trim() || Buffer.byteLength(value.query) > 256) {
      throw new Error("Invalid nav.request query");
    }
  } else {
    const destination = value.destination as Record<string, unknown> | undefined;
    if (!destination || typeof destination !== "object") throw new Error("Invalid nav.request destination");
    assertCoordinate(destination.lat, -90, 90, "lat");
    assertCoordinate(destination.lon, -180, 180, "lon");
    if (
      typeof value.destinationName !== "string" ||
      !value.destinationName.trim() ||
      Buffer.byteLength(value.destinationName) > 256
    ) {
      throw new Error("Invalid nav.request destinationName");
    }
  }
  return value as ClientEvent;
}
```

- [ ] **Step 5: Run tests, then the protocol check**

Run: `npx vitest run tests/nav-protocol.test.ts` — Expected: PASS.
Run: `npm run check:protocol` — Expected: exit 0 (generated file in sync).

- [ ] **Step 6: Commit**

```bash
npx prettier --write protocol/agent-events.schema.json shared/agent.ts server/session-controller.ts tests/nav-protocol.test.ts
git add protocol/agent-events.schema.json shared/generated/agent-protocol.ts shared/agent.ts server/session-controller.ts tests/nav-protocol.test.ts
git commit -m "feat(nav): add nav.request/nav.route/nav.error protocol events"
```

---

### Task 3: `AmapRouteProvider` (`server/routing.ts`)

**Files:**

- Create: `server/routing.ts`
- Test: `tests/routing-amap.test.ts`

**Interfaces:**

- Consumes: `NavManeuver` from `shared/agent.ts`; `GeoPoint` from `shared/geo.ts`.
- Produces:

```ts
export type ResolvedDestination = { name: string; location: GeoPoint };
export type PlannedRoute = {
  distanceMeters: number;
  etaSeconds: number;
  polyline: GeoPoint[];
  steps: NavManeuver[];
};
export type RouteProvider = {
  mode: "amap" | "mock";
  resolveDestination(query: string, near: GeoPoint): Promise<ResolvedDestination | null>;
  planRoute(origin: GeoPoint, destination: GeoPoint): Promise<PlannedRoute | null>;
};
export function createAmapRouteProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onFailure?: (reason: string) => void;
}): RouteProvider;
```

**Amap request/response contract** (verify field names against https://lbs.amap.com/api/webservice/guide/api/newroute and the place-search 2.0 docs while implementing; the fixtures below follow the documented shape):

- Place: `GET https://restapi.amap.com/v5/place/text?keywords=<query>&location=<lon>,<lat>&page_size=1&key=<key>` → `{ status: "1", pois: [{ name, location: "lon,lat" }] }`.
- Driving: `GET https://restapi.amap.com/v5/direction/driving?origin=<lon>,<lat>&destination=<lon>,<lat>&show_fields=cost,polyline&key=<key>` → `{ status: "1", route: { paths: [{ distance: "5000", cost: { duration: "720" }, steps: [{ instruction, step_distance: "2500", polyline: "lon,lat;lon,lat;..." }] }] } }`.
- All numbers arrive as strings; every coordinate is `"lon,lat"` order and GCJ-02.
- Mapping: full polyline = concatenated step polylines; each maneuver's coordinate = **last** point of its step polyline (the instruction executes at the step's end); `alongRouteMeters` = cumulative `step_distance` through that step; `distanceMeters` = path `distance`; `etaSeconds` = `cost.duration`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/routing-amap.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routing-amap.test.ts`
Expected: FAIL — cannot resolve `../server/routing`.

- [ ] **Step 3: Implement**

Create `server/routing.ts` with a header comment in the `server/vision.ts` style (what it does, why fail-null, why `AMAP_API_KEY` is a separate credential). Implementation outline (write it fully):

```ts
import type { NavManeuver } from "../shared/agent";
import type { GeoPoint } from "../shared/geo";

const PLACE_ENDPOINT = "https://restapi.amap.com/v5/place/text";
const DRIVING_ENDPOINT = "https://restapi.amap.com/v5/direction/driving";
// Must finish well inside the relay's 8 s device-result timeout even when both
// calls (resolve, then plan) run back to back.
const DEFAULT_TIMEOUT_MS = 3500;

// ...types from Interfaces above...

function parseLonLat(pair: string): GeoPoint | null {
  const [lon, lat] = pair.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function createAmapRouteProvider(options): RouteProvider {
  const { apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onFailure } = options;
  const fail = (reason: string) => {
    onFailure?.(reason);
    return null;
  };
  async function getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return fail(`http.${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return fail("network");
    }
  }
  return {
    mode: "amap",
    async resolveDestination(query, near) {
      const url =
        `${PLACE_ENDPOINT}?keywords=${encodeURIComponent(query)}` +
        `&location=${near.lon},${near.lat}&page_size=1&key=${apiKey}`;
      const body = await getJson(url);
      if (!body) return null;
      if (body.status !== "1" || !Array.isArray(body.pois)) return fail("place.status");
      const poi = body.pois[0] as { name?: unknown; location?: unknown } | undefined;
      if (!poi || typeof poi.name !== "string" || typeof poi.location !== "string") return fail("place.empty");
      const location = parseLonLat(poi.location);
      if (!location) return fail("place.location");
      return { name: poi.name, location };
    },
    async planRoute(origin, destination) {
      const url =
        `${DRIVING_ENDPOINT}?origin=${origin.lon},${origin.lat}` +
        `&destination=${destination.lon},${destination.lat}&show_fields=cost,polyline&key=${apiKey}`;
      const body = await getJson(url);
      if (!body) return null;
      const route = body.route as { paths?: unknown } | undefined;
      const path = Array.isArray(route?.paths) ? (route.paths[0] as Record<string, unknown> | undefined) : undefined;
      if (body.status !== "1" || !path) return fail("driving.status");
      const distanceMeters = Number(path.distance);
      const etaSeconds = Number((path.cost as { duration?: unknown } | undefined)?.duration);
      const rawSteps = Array.isArray(path.steps) ? (path.steps as Array<Record<string, unknown>>) : [];
      if (!Number.isFinite(distanceMeters) || !Number.isFinite(etaSeconds) || !rawSteps.length) {
        return fail("driving.shape");
      }
      const polyline: GeoPoint[] = [];
      const steps: NavManeuver[] = [];
      let alongRouteMeters = 0;
      for (const rawStep of rawSteps) {
        const stepDistance = Number(rawStep.step_distance);
        if (
          typeof rawStep.instruction !== "string" ||
          typeof rawStep.polyline !== "string" ||
          !Number.isFinite(stepDistance)
        ) {
          return fail("driving.step");
        }
        const points = rawStep.polyline.split(";").map(parseLonLat);
        if (points.some((p) => p === null) || !points.length) return fail("driving.polyline");
        for (const point of points as GeoPoint[]) {
          const last = polyline.at(-1);
          if (!last || last.lat !== point.lat || last.lon !== point.lon) polyline.push(point);
        }
        alongRouteMeters += stepDistance;
        const end = polyline.at(-1)!;
        steps.push({ instruction: rawStep.instruction, lat: end.lat, lon: end.lon, alongRouteMeters });
      }
      return { distanceMeters, etaSeconds, polyline, steps };
    }
  };
}
```

Every failure path goes through `fail(...)` exactly once per call (`getJson` already reported network/HTTP failures — that's why its `null` returns bare).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/routing-amap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/routing.ts tests/routing-amap.test.ts
git add server/routing.ts tests/routing-amap.test.ts
git commit -m "feat(nav): add Amap route provider (place search + v5 driving)"
```

---

### Task 4: `MockRouteProvider` + provider selection + config keys

**Files:**

- Create: `shared/nav-fixtures.ts` (the fixture lives in `shared/`, NOT `server/` — the web simulator in Task 8 imports it, and client code must never import server modules)
- Modify: `server/routing.ts`
- Modify: `server/config.ts` (three new keys on the `config` object, following the existing trimmed-string pattern like `relayAuthToken`)
- Test: `tests/routing-mock.test.ts`

**Interfaces:**

- Consumes: `RouteProvider`, `PlannedRoute` from Task 3; `Logger` type from `server/logger.ts`.
- Produces:
  - `shared/nav-fixtures.ts` exports `MOCK_ROUTE: PlannedRoute` — exact literal below; Tasks 7 and 8 import it from `../shared/nav-fixtures`.
  - `createMockRouteProvider(): RouteProvider` — `mode: "mock"`; `resolveDestination(query)` always resolves `{ name: query, location: MOCK_ROUTE.polyline.at(-1)! }`; `planRoute` always returns `MOCK_ROUTE`.
  - `selectRouteProvider(amapApiKey: string, log?: Logger): RouteProvider` — Amap when the key is non-empty, otherwise mock with **one** `log.warn("AMAP_API_KEY is not set; navigation uses the mock route provider")`.
  - `config.amapApiKey`, `config.amapJsKey`, `config.amapJsSecret` — from `AMAP_API_KEY`, `AMAP_JS_KEY`, `AMAP_JS_SECRET`, trimmed, default `""`.

The fixture (GCJ-02, near 上海人民广场; north on 西藏中路 then east; lat steps of 0.0015° ≈ 166 m, lon steps of 0.0015° at lat 31.236 ≈ 143 m):

```ts
// shared/nav-fixtures.ts
import type { NavManeuver } from "./agent";
import type { GeoPoint } from "./geo";

/** Served by the relay's MockRouteProvider when AMAP_API_KEY is unset, and
 *  walked by the web HUD's demo ride simulator. GCJ-02, like every nav.*
 *  coordinate. alongRouteMeters values are the cumulative haversine distances
 *  of the legs (4 × 166.4 m north, then 3 × 142.8 m east). */
export const MOCK_ROUTE: {
  distanceMeters: number;
  etaSeconds: number;
  polyline: GeoPoint[];
  steps: NavManeuver[];
} = {
  distanceMeters: 1094,
  etaSeconds: 240,
  polyline: [
    { lat: 31.2304, lon: 121.4737 },
    { lat: 31.2319, lon: 121.4737 },
    { lat: 31.2334, lon: 121.4737 },
    { lat: 31.2349, lon: 121.4737 },
    { lat: 31.2364, lon: 121.4737 },
    { lat: 31.2364, lon: 121.4752 },
    { lat: 31.2364, lon: 121.4767 },
    { lat: 31.2364, lon: 121.4782 }
  ],
  steps: [
    { instruction: "右转进入南京东路", lat: 31.2364, lon: 121.4737, alongRouteMeters: 666 },
    { instruction: "到达终点", lat: 31.2364, lon: 121.4782, alongRouteMeters: 1094 }
  ]
};
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/routing-mock.test.ts
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
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routing-mock.test.ts` — Expected: FAIL (exports missing).

- [ ] **Step 3: Implement mock, selection, and config keys**

Create `shared/nav-fixtures.ts` exactly as given in **Interfaces** above; `server/routing.ts` imports `MOCK_ROUTE` from `../shared/nav-fixtures`. `selectRouteProvider` matches the log-once posture of `vision.ts`. In `server/config.ts` add to the `config` object:

```ts
// Amap Web 服务 key for relay-side routing. Empty selects the mock route
// provider, so navigation demos keylessly like the mock voice provider.
amapApiKey: process.env.AMAP_API_KEY?.trim() ?? "",
// Web 端 (JS API) key served to the browser HUD; the map panel hides without it.
amapJsKey: process.env.AMAP_JS_KEY?.trim() ?? "",
// JS API 安全密钥 — used only inside the /_AMapService proxy, never sent to a client.
amapJsSecret: process.env.AMAP_JS_SECRET?.trim() ?? "",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/routing-mock.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write shared/nav-fixtures.ts server/routing.ts server/config.ts tests/routing-mock.test.ts
git add shared/nav-fixtures.ts server/routing.ts server/config.ts tests/routing-mock.test.ts
git commit -m "feat(nav): add mock route provider, provider selection, and AMAP_* config"
```

---

### Task 5: Nav request handler + session wiring + failure speech

**Files:**

- Modify: `server/routing.ts` (add `createNavHandler`)
- Modify: `server/session-controller.ts` (instantiate per session; dispatch `nav.request`)
- Modify: `server/device-actions.ts` (`FAILURE_SPEECH` map at ~line 310)
- Test: `tests/nav-handler.test.ts`

**Interfaces:**

- Consumes: `RouteProvider` (Tasks 3–4), `NavRequestEvent`/`NavRouteEvent`/`NavErrorEvent` (Task 2), `config.amapApiKey`.
- Produces:

```ts
export function createNavHandler(options: {
  provider: RouteProvider;
  send: (payload: NavRouteEvent | NavErrorEvent) => void;
  now?: () => number; // injectable for the interval-guard tests
  minRerouteIntervalMs?: number; // default 10_000
}): (event: NavRequestEvent) => Promise<void>;
```

Behavior:

- `reason: "start"` — `resolveDestination(query, origin)`; null → `nav.error destination.notFound`. Then `planRoute(origin, resolved.location)`; null → `nav.error route.unavailable`. Else send `nav.route` (destinationName/destination from resolution).
- `reason: "reroute"` — if a reroute was answered less than `minRerouteIntervalMs` ago **and** a last route exists, resend the last `nav.route` with the new commandId (quota guard, per spec: "a rejected-by-interval reroute returns the current route unchanged"). Otherwise `planRoute(origin, destination)` with the request's `destination`/`destinationName`; null → `nav.error route.unavailable`.
- The handler keeps `lastRoute` and `lastRerouteAt` per instance (one instance per session).

- [ ] **Step 1: Write the failing test**

```ts
// tests/nav-handler.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav-handler.test.ts` — Expected: FAIL (`createNavHandler` missing).

- [ ] **Step 3: Implement handler, wiring, and speech strings**

Implement `createNavHandler` in `server/routing.ts` per the behavior table. Wire in `server/session-controller.ts` following the `crash.alert` pattern:

- In the constructor: `this.navHandler = createNavHandler({ provider: selectRouteProvider(config.amapApiKey, log), send: (p) => this.send(p) });`
- In `processMessage`, with the other event dispatches: `if (event.type === "nav.request") await this.navHandler(event);`

In `server/device-actions.ts`, add to `FAILURE_SPEECH` (keep the existing entry style, note the trailing 。):

```ts
"destination.notFound": "没找到这个地方。",
"route.unavailable": "路线规划失败。",
```

- [ ] **Step 4: Run the new and neighboring tests**

Run: `npx vitest run tests/nav-handler.test.ts tests/nav-protocol.test.ts tests/device-reconciliation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/routing.ts server/session-controller.ts server/device-actions.ts tests/nav-handler.test.ts
git add server/routing.ts server/session-controller.ts server/device-actions.ts tests/nav-handler.test.ts
git commit -m "feat(nav): handle nav.request on the relay with reroute quota guard"
```

---

### Task 6: Shared guidance engine (`shared/guidance.ts`)

**Files:**

- Create: `shared/guidance.ts`
- Test: `tests/guidance.test.ts`

**Interfaces:**

- Consumes: `GeoPoint` (Task 1), `NavManeuver`/`NavRouteEvent` (Task 2).
- Produces (Task 7 consumes all of this; Plans B/C port these exact semantics):

```ts
export type GuidanceProgress = {
  maneuverIndex: number;
  firedThresholds: Array<"far" | "near" | "now">; // for the current maneuver only
  arrived: boolean;
};
export const INITIAL_PROGRESS: GuidanceProgress;
export type GuidanceUpdate = {
  progress: GuidanceProgress;
  distanceToManeuverMeters: number;
  remainingMeters: number;
  remainingSeconds: number;
  offRoute: boolean;
  arrived: boolean;
  spokenPrompt: string | null;
  currentInstruction: string | null;
};
export function step(position: GeoPoint, route: NavRouteEvent, progress: GuidanceProgress): GuidanceUpdate;
export function haversineMeters(a: GeoPoint, b: GeoPoint): number;
```

Semantics (ported from the 07-24 iOS spec — keep the constants identical so platforms guide identically): snap the position to the nearest polyline segment (point-to-segment cross-track); off-route when cross-track > **50 m**; along-route position from the snap; `distanceToManeuverMeters` = maneuver `alongRouteMeters` − along-route position (min 0); maneuver advances when within **30 m** of its coordinate or the along-route position passes its `alongRouteMeters`, clearing `firedThresholds`; prompts fire once per maneuver per threshold — far ≤ **400 m** (`前方${Math.round(d / 50) * 50}米，${instruction}`), near ≤ **150 m** (same template), now ≤ **40 m** (`${instruction}`); arrival when within **30 m** of the last polyline point; `remainingMeters` = total − along-route position; `remainingSeconds` = etaSeconds × remainingMeters / distanceMeters. The function is pure — no Date, no I/O, caller owns progress.

- [ ] **Step 1: Write the failing test**

The test route runs due north along lon 121.47 from lat 31.23 to 31.24 (≈1109 m; 0.0001° lat ≈ 11.1 m), one mid-route maneuver:

```ts
// tests/guidance.test.ts
import { describe, expect, it } from "vitest";
import { INITIAL_PROGRESS, haversineMeters, step } from "../shared/guidance";
import type { NavRouteEvent } from "../shared/agent";

const route: NavRouteEvent = {
  type: "nav.route",
  commandId: "t",
  destinationName: "测试终点",
  destination: { lat: 31.24, lon: 121.47 },
  distanceMeters: 1109,
  etaSeconds: 240,
  polyline: [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.235, lon: 121.47 },
    { lat: 31.24, lon: 121.47 }
  ],
  steps: [
    { instruction: "右转", lat: 31.235, lon: 121.47, alongRouteMeters: 555 },
    { instruction: "到达终点", lat: 31.24, lon: 121.47, alongRouteMeters: 1109 }
  ]
};

describe("haversineMeters", () => {
  it("measures ~1109 m across the test route", () => {
    expect(haversineMeters({ lat: 31.23, lon: 121.47 }, { lat: 31.24, lon: 121.47 })).toBeCloseTo(1109, -1);
  });
});

describe("step", () => {
  it("reports distance to the first maneuver from the start", () => {
    const u = step({ lat: 31.23, lon: 121.47 }, route, INITIAL_PROGRESS);
    expect(u.distanceToManeuverMeters).toBeGreaterThan(540);
    expect(u.distanceToManeuverMeters).toBeLessThan(570);
    expect(u.offRoute).toBe(false);
    expect(u.spokenPrompt).toBeNull(); // 555 m > far threshold
    expect(u.currentInstruction).toBe("右转");
  });

  it("fires far once, then near once, then now once", () => {
    let progress = INITIAL_PROGRESS;
    const at = (lat: number) => {
      const u = step({ lat, lon: 121.47 }, route, progress);
      progress = u.progress;
      return u;
    };
    expect(at(31.232).spokenPrompt).toMatch(/^前方\d+米，右转$/); // ~333 m → far
    expect(at(31.2325).spokenPrompt).toBeNull(); // far already fired
    expect(at(31.234).spokenPrompt).toMatch(/^前方\d+米，右转$/); // ~111 m → near
    expect(at(31.2348).spokenPrompt).toBe("右转"); // ~22 m → now
    expect(at(31.2349).spokenPrompt).toBeNull();
  });

  it("advances past the maneuver and clears thresholds", () => {
    let progress = INITIAL_PROGRESS;
    for (const lat of [31.232, 31.234, 31.2348, 31.2355]) {
      progress = step({ lat, lon: 121.47 }, route, progress).progress;
    }
    expect(progress.maneuverIndex).toBe(1);
    const u = step({ lat: 31.2355, lon: 121.47 }, route, progress);
    expect(u.currentInstruction).toBe("到达终点");
  });

  it("flags off-route beyond 50 m cross-track", () => {
    // 0.001° lon at lat 31.23 ≈ 95 m east of the line.
    const u = step({ lat: 31.232, lon: 121.471 }, route, INITIAL_PROGRESS);
    expect(u.offRoute).toBe(true);
    expect(u.spokenPrompt).toBeNull(); // no prompts while off-route
  });

  it("arrives within 30 m of the destination", () => {
    let progress = INITIAL_PROGRESS;
    for (const lat of [31.232, 31.234, 31.2348, 31.2355, 31.2398]) {
      progress = step({ lat, lon: 121.47 }, route, progress).progress;
    }
    expect(progress.arrived).toBe(true);
  });

  it("scales remaining time from remaining distance", () => {
    const u = step({ lat: 31.235, lon: 121.47 }, route, INITIAL_PROGRESS);
    expect(u.remainingMeters).toBeGreaterThan(520);
    expect(u.remainingMeters).toBeLessThan(590);
    expect(u.remainingSeconds).toBeGreaterThan(110);
    expect(u.remainingSeconds).toBeLessThan(130);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/guidance.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the engine**

Implement `shared/guidance.ts`: `haversineMeters` (standard formula, R = 6371008.8), a private `nearestOnSegment(p, a, b)` returning the projected point + along-segment fraction, the snap loop over segments tracking best cross-track + cumulative along-route distance, then the update logic per the semantics table. `firedThresholds` is copied, never mutated in place (the caller may re-run a step). While `offRoute` is true, suppress prompts and threshold bookkeeping — reroute policy belongs to the caller.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/guidance.test.ts tests/geo.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write shared/guidance.ts tests/guidance.test.ts
git add shared/guidance.ts tests/guidance.test.ts
git commit -m "feat(nav): add shared guidance engine with table tests"
```

---

### Task 7: Web navigation controller (`src/lib/navigation.ts`)

**Files:**

- Create: `src/lib/navigation.ts`
- Test: `tests/web-navigation.test.ts`

**Interfaces:**

- Consumes: `wgs84ToGcj02` (Task 1), `step`/`INITIAL_PROGRESS`/`GuidanceUpdate` (Task 6), `NavRouteEvent`/`NavErrorEvent`/`NavManeuver` types (Task 2).
- Produces (Task 8 consumes):

```ts
export type NavPhase =
  | { phase: "idle" }
  | { phase: "requesting"; query: string }
  | { phase: "guiding"; route: NavRouteEvent; update: GuidanceUpdate; position: GeoPoint };

export function createNavigationController(deps: {
  sendJson: (payload: unknown) => void; // raw socket JSON send
  speak: (text: string) => void; // browser TTS, src/lib/speech.ts
  onState: (state: NavPhase) => void;
  now?: () => number;
}): {
  /** Returns true when the command was consumed (navigation.start/stop). */
  handleDeviceCommand(command: { commandId: string; action: string; args: Record<string, unknown> }): boolean;
  handleAgentEvent(event: { type: string } & Record<string, unknown>): void; // nav.route / nav.error
  updatePosition(wgs: GeoPoint): void; // raw browser geolocation or simulator, WGS-84
  reset(): void; // socket closed — drop state without sending anything
};
```

Behavior:

- `navigation.start {query}`: no position fix yet → `device.result { status: "denied", reason: "permission.location" }` immediately. Else send `nav.request` (reason `start`, origin = `wgs84ToGcj02(lastFix)`), state `requesting`.
- `nav.route` while requesting: send `device.result { status: "ok" }` for the stored commandId, state `guiding`, run one engine step at the current position.
- `nav.route` while guiding (reroute answer): swap route, reset progress to `INITIAL_PROGRESS`, speak "已重新规划路线".
- `nav.error`: `device.result { status: "failed", reason: code }` (the relay's `FAILURE_SPEECH` speaks the truth), state `idle`.
- `updatePosition` while guiding: convert, run `step`, speak any `spokenPrompt`; on `offRoute` send **one** `nav.request` reroute (in-flight flag + 20 s client cooldown via `now()`), speak "已偏离路线，正在重新规划" the first time; on `arrived` speak "已到达目的地", `device.result` is NOT sent (arrival is not a command), state `idle`.
- `navigation.stop`: state `idle`, `device.result { status: "ok" }`; if nothing active, `device.result { status: "failed", reason: "navigation.notActive" }`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-navigation.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the controller**

Plain TypeScript module (no React imports — testable without a DOM). Hold `lastFix: GeoPoint | null`, `pendingCommandId`, `activeRoute`, `progress`, `rerouteInFlight`, `lastRerouteSentAt`, `offRouteAnnounced`. Follow the behavior table exactly; every `device.result` goes through one private `sendResult(commandId, status, reason?)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/web-navigation.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/lib/navigation.ts tests/web-navigation.test.ts
git add src/lib/navigation.ts tests/web-navigation.test.ts
git commit -m "feat(nav): add web navigation controller (device.command to guidance)"
```

---

### Task 8: Web nav panel, ride simulator, and hook wiring

**Files:**

- Create: `src/components/NavigationPanel.tsx`
- Create: `src/lib/nav-simulator.ts`
- Modify: `src/hooks/useHelmetAgent.ts` (instantiate the controller; route events; expose `navState` + simulator controls)
- Modify: `src/App.tsx` (render the panel while `navState.phase !== "idle"`, plus a settings-adjacent 演示导航 control)
- Test: `tests/navigation-panel.test.tsx`, `tests/nav-simulator.test.ts`

**Interfaces:**

- Consumes: `createNavigationController`/`NavPhase` (Task 7), `MOCK_ROUTE` (Task 4), `speak` from `src/lib/speech.ts`.
- Produces:
  - `NavigationPanel({ state }: { state: NavPhase })` — guidance card (current instruction, `distanceToManeuverMeters` rounded to 10 m, remaining km + ETA minutes, destination name; "已偏离路线，重新规划中…" while off-route) above an SVG schematic: the polyline normalized into a 280×160 viewBox, rider position dot, maneuver markers. **The SVG renders always — with no Amap key the panel is fully functional.** (The optional Amap JS tile map behind it lands in Task 9; this task must not reference it.)
  - `createRideSimulator({ route, tickMs, speedMps, onPosition }): { start(detour: boolean): void; stop(): void }` — walks the polyline at `speedMps` (default 12), interpolating between vertices per tick (default 1000 ms); with `detour: true`, ticks 4–6 shift 0.002° east (≈190 m — beyond the 50 m off-route threshold) then return to the line. Emits **WGS-84-equivalent** positions: since the fixture polyline is GCJ-02 and `updatePosition` converts WGS→GCJ, the simulator must emit positions that _arrive_ on the route after conversion — implement by binary-searching the WGS point whose `wgs84ToGcj02` lands on the target vertex, or more simply subtract the local offset: `wgs ≈ target − (wgs84ToGcj02(target) − target)`. The approximation error (<2 m) is far below every threshold. Uses `setInterval`; `stop()` clears it.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/nav-simulator.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRideSimulator } from "../src/lib/nav-simulator";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { wgs84ToGcj02 } from "../shared/geo";
import { haversineMeters } from "../shared/guidance";

describe("createRideSimulator", () => {
  it("emits positions that land on the GCJ-02 route after conversion", () => {
    vi.useFakeTimers();
    const emitted: Array<{ lat: number; lon: number }> = [];
    const sim = createRideSimulator({
      route: MOCK_ROUTE,
      tickMs: 1000,
      speedMps: 12,
      onPosition: (p) => emitted.push(p)
    });
    sim.start(false);
    vi.advanceTimersByTime(3000);
    sim.stop();
    expect(emitted.length).toBe(3);
    const gcj = wgs84ToGcj02(emitted[0]);
    const start = MOCK_ROUTE.polyline[0];
    expect(haversineMeters(gcj, start)).toBeLessThan(30);
    vi.useRealTimers();
  });

  it("leaves the route during a detour run", () => {
    vi.useFakeTimers();
    const emitted: Array<{ lat: number; lon: number }> = [];
    const sim = createRideSimulator({
      route: MOCK_ROUTE,
      tickMs: 1000,
      speedMps: 12,
      onPosition: (p) => emitted.push(p)
    });
    sim.start(true);
    vi.advanceTimersByTime(6000);
    sim.stop();
    const detourPoint = wgs84ToGcj02(emitted[4]);
    const nearestVertex = Math.min(...MOCK_ROUTE.polyline.map((v) => haversineMeters(detourPoint, v)));
    expect(nearestVertex).toBeGreaterThan(50);
    vi.useRealTimers();
  });
});
```

```tsx
// tests/navigation-panel.test.tsx
import { describe, expect, it } from "vitest";
import { create } from "react-test-renderer";
import { NavigationPanel } from "../src/components/NavigationPanel";
import { INITIAL_PROGRESS, step } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import type { NavRouteEvent } from "../shared/agent";

const route: NavRouteEvent = {
  type: "nav.route",
  commandId: "t",
  destinationName: "外滩",
  destination: MOCK_ROUTE.polyline.at(-1)!,
  distanceMeters: MOCK_ROUTE.distanceMeters,
  etaSeconds: MOCK_ROUTE.etaSeconds,
  polyline: MOCK_ROUTE.polyline,
  steps: MOCK_ROUTE.steps
};

describe("NavigationPanel", () => {
  it("shows instruction, distance, destination, and an svg route", () => {
    const position = MOCK_ROUTE.polyline[0];
    const update = step(position, route, INITIAL_PROGRESS);
    const tree = create(<NavigationPanel state={{ phase: "guiding", route, update, position }} />);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("外滩");
    expect(text).toContain(update.currentInstruction!);
    expect(text).toContain("svg");
  });

  it("renders nothing when idle", () => {
    const tree = create(<NavigationPanel state={{ phase: "idle" }} />);
    expect(tree.toJSON()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/nav-simulator.test.ts tests/navigation-panel.test.tsx` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement simulator and panel**

Match the visual language of the existing HUD (dark instrument styling in `src/styles.css` — reuse existing card classes; check how `VoiceTranscript.tsx` composes them). No new CSS frameworks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/nav-simulator.test.ts tests/navigation-panel.test.tsx` — Expected: PASS.

- [ ] **Step 5: Wire the hook and App**

In `src/hooks/useHelmetAgent.ts`:

- Create the controller once (in the socket-setup effect, where `socket.send` is in scope): `sendJson` = `(p) => socket.send(JSON.stringify(p))`, `speak` from `src/lib/speech.ts` (the same helper the TTS fallback path uses), `onState` = a `setNavState` React state setter.
- In the server-event switch (the `if (event.type === ...)` chain around line 497): pass `device.command` events to `controller.handleDeviceCommand(event)` and `nav.route`/`nav.error` to `controller.handleAgentEvent(event)`.
- Feed `controller.updatePosition({ lat, lon })` from the existing geolocation `watchPosition` callback (~line 1075) and from the simulator.
- On socket close/reconnect: `controller.reset()`.
- Return `navState` and `startNavDemo(detour: boolean)` / `stopNavDemo()` (simulator wrappers using the active route, falling back to `MOCK_ROUTE`) from the hook.

In `src/App.tsx`: render `<NavigationPanel state={navState} />` in the HUD column, and add the 演示导航 / 演示偏航 buttons beside the existing demo controls (they call `startNavDemo(false)` / `startNavDemo(true)`).

Manual verification: `npm run dev`, log in, start a session on the mock voice provider, click 演示导航, then type/say 导航去外滩 — the card and schematic appear and prompts speak; 演示偏航 triggers exactly one 已偏离路线 + reroute.

- [ ] **Step 6: Run the web test suite**

Run: `npx vitest run tests/web-navigation.test.ts tests/nav-simulator.test.ts tests/navigation-panel.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/components/NavigationPanel.tsx src/lib/nav-simulator.ts src/hooks/useHelmetAgent.ts src/App.tsx tests/nav-simulator.test.ts tests/navigation-panel.test.tsx
git add src/components/NavigationPanel.tsx src/lib/nav-simulator.ts src/hooks/useHelmetAgent.ts src/App.tsx tests/nav-simulator.test.ts tests/navigation-panel.test.tsx
git commit -m "feat(nav): web HUD guidance panel, ride simulator, and hook wiring"
```

---

### Task 9: Amap JS map layer — `/nav/js-config` + `/_AMapService` proxy

**Files:**

- Create: `server/amap-proxy.ts`
- Modify: `server/index.ts` (mount both routes before the static handler at ~line 645)
- Modify: `src/components/NavigationPanel.tsx` (optional tile map under the schematic)
- Test: `tests/amap-proxy.test.ts`

**Interfaces:**

- Consumes: `config.amapJsKey`, `config.amapJsSecret` (Task 4).
- Produces:
  - `GET /nav/js-config` → `{ key: string | null }` (null when `amapJsKey` is empty; the client hides the tile map and keeps the schematic).
  - `GET /_AMapService/...` → proxied to Amap with `jscode` appended; 404 when `amapJsSecret` is empty.
  - `export function amapProxyTarget(path: string, search: string, jscode: string): string | null` — pure URL mapper, per Amap's documented production proxy: `/_AMapService/v4/map/styles*` → `https://webapi.amap.com/v4/map/styles*`; `/_AMapService/v3/vectormap*` → `https://fmap01.amap.com/v3/vectormap*`; any other `/_AMapService/*` → `https://restapi.amap.com/*`; **all three** get `jscode=<secret>` appended to the query; non-`/_AMapService` paths → null.

- [ ] **Step 1: Write the failing test**

```ts
// tests/amap-proxy.test.ts
import { describe, expect, it } from "vitest";
import { amapProxyTarget } from "../server/amap-proxy";

describe("amapProxyTarget", () => {
  it("maps styles, vectormap, and restapi hosts with jscode appended", () => {
    expect(amapProxyTarget("/_AMapService/v4/map/styles", "?styleid=1", "s3cret")).toBe(
      "https://webapi.amap.com/v4/map/styles?styleid=1&jscode=s3cret"
    );
    expect(amapProxyTarget("/_AMapService/v3/vectormap", "", "s3cret")).toBe(
      "https://fmap01.amap.com/v3/vectormap?jscode=s3cret"
    );
    expect(amapProxyTarget("/_AMapService/v3/geocode/regeo", "?location=1,2", "s3cret")).toBe(
      "https://restapi.amap.com/v3/geocode/regeo?location=1,2&jscode=s3cret"
    );
  });

  it("refuses paths outside the proxy prefix", () => {
    expect(amapProxyTarget("/etc/passwd", "", "s")).toBeNull();
    expect(amapProxyTarget("/_AMapServiceX/v3/x", "", "s")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/amap-proxy.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement mapper, routes, and client map**

`server/amap-proxy.ts`: the pure mapper plus `registerAmapRoutes(app: express.Express)`:

```ts
app.get("/nav/js-config", (_req, res) => {
  res.json({ key: config.amapJsKey || null });
});
app.get(/^\/_AMapService\//, async (req, res) => {
  if (!config.amapJsSecret) return res.status(404).end();
  const target = amapProxyTarget(
    req.path,
    req.originalUrl.includes("?") ? "?" + req.originalUrl.split("?")[1] : "",
    config.amapJsSecret
  );
  if (!target) return res.status(404).end();
  const upstream = await fetch(target, { signal: AbortSignal.timeout(8000) });
  res.status(upstream.status);
  const type = upstream.headers.get("content-type");
  if (type) res.setHeader("Content-Type", type);
  res.send(Buffer.from(await upstream.arrayBuffer()));
});
```

Call `registerAmapRoutes(app)` in `server/index.ts` **before** the static/express.static block (~line 645). GET only; errors return 502 with an empty body (wrap the fetch in try/catch) — never leak the secret or upstream errors.

`NavigationPanel.tsx`: on mount, fetch `/nav/js-config`; when `key` is non-null, set `window._AMapSecurityConfig = { serviceHost: location.origin + "/_AMapService" }`, inject `<script src="https://webapi.amap.com/maps?v=2.0&key=<key>">` once (module-level promise so repeated mounts reuse it), and render an `AMap.Map` div under the schematic with the route as an `AMap.Polyline` and the rider as a marker (GCJ-02 coordinates go straight in). Script load failure or absent key → schematic only, no error surface beyond a console warning. Guard everything behind `typeof window !== "undefined"` so the react-test-renderer tests stay green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/amap-proxy.test.ts tests/navigation-panel.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/amap-proxy.ts server/index.ts src/components/NavigationPanel.tsx tests/amap-proxy.test.ts
git add server/amap-proxy.ts server/index.ts src/components/NavigationPanel.tsx tests/amap-proxy.test.ts
git commit -m "feat(nav): amap js map layer with server-held security secret"
```

---

### Task 10: Full check, README, and closeout

**Files:**

- Modify: `README.md` (Current Capabilities — replace the iOS-only navigation bullet's claim of exclusivity: note web HUD guidance, relay-side Amap routing, mock keyless mode; keep the honest car-routing limitation sentence)
- Modify: `.env.example` if one exists (`grep -l AMAP .env* 2>/dev/null`; add `AMAP_API_KEY=`, `AMAP_JS_KEY=`, `AMAP_JS_SECRET=` with one-line comments) — skip silently if the repo has no env template.

- [ ] **Step 1: Update the README bullet**

Extend the "Voice-triggered live navigation (iOS)" bullet or add a sibling bullet: routing now runs on the relay (Amap Web 服务, GCJ-02, mock provider when keyless), the web HUD guides with the shared TypeScript engine and a demo ride simulator, and the JS API secret stays server-side behind `/_AMapService`. Keep the 摩托车禁行 honesty sentence.

- [ ] **Step 2: Run the full repository check**

Run: `npm run check`
Expected: exit 0. Likely fallout to fix inline: prettier formatting, knip flagging an export no longer consumed (remove it), eslint hook-dependency warnings in `useHelmetAgent.ts`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(nav): document relay-side amap routing and web guidance"
```

- [ ] **Step 4: Verify the branch state**

Run: `git log --oneline main..HEAD 2>/dev/null || git log --oneline -12`
Expected: the ~10 commits from Tasks 1–10, none touching `ios/`, `android/`, or `rdk/`.

---

## Deferred to Plans B and C (do not implement here)

- **Plan B (iOS):** `RelayRouteSearch` replacing MKLocalSearch/MKDirections behind the existing seam; Swift `wgs84ToGcj02`/`gcj02ToWgs84` with the same golden vectors; GCJ→WGS conversion of incoming routes at the protocol edge; held `device.result` ordering in `AgentSession`.
- **Plan C (Android):** Kotlin `GuidanceEngine` port passing the Task 6 table; `NavigationController.kt`; Compose guidance card; Amap Android Map SDK display key; ADAS-priority prompt suppression.
