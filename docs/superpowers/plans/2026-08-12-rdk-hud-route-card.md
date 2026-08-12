# RDK HUD Route Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the active route as an offline SVG schematic on the board's bench HUD — route line, maneuver markers, rider dot — so a developer can see that a real route arrived and that the rider tracks along it.

**Architecture:** Route geometry crosses the HUD socket once per route as a new `rdk.route` event; the rider's position rides on the existing ~1 Hz navigation snapshot as two numbers. The page renders both into a fixed 280×160 SVG. Both new payloads are stripped for non-loopback viewers, exactly as pairing codes already are.

**Tech Stack:** TypeScript (Node 22, `tsx`) on the board, vanilla JS inside a single self-contained `index.html`, Vitest.

## Global Constraints

- **No map tiles, no Amap runtime, no external CDN on this page.** `tests/rdk-hud-render.test.ts` pins this with `expect(page).not.toMatch(/<iframe|<canvas|webapi\.amap|restapi\.amap|amap\.com/i)`. That assertion must keep passing — the card is inline `<svg>`, which the regex deliberately permits.
- **All coordinates are GCJ-02.** Every `nav.*` coordinate and `PhoneLocationSource`'s public boundary are GCJ-02, so route and rider plot in one datum. Never convert, and never mix in a WGS-84 value.
- **The HUD page cannot import anything.** It is served by string substitution in `renderHudPage`. Code it needs lives inline in its single `<script>` block.
- **Optional fields are omitted, never `undefined`.** Follow the existing `...(x === undefined ? {} : { x })` spread style in `hud/state.ts` and `controller.ts`.
- **Run tests with** `npx vitest run <file>` from the repo root.

---

### Task 1: HUD state carries a route

**Files:**

- Modify: `rdk/agent/src/hud/state.ts`
- Test: `tests/rdk-hud-state.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `RdkHudRoute` (exported type), `HudState.route: RdkHudRoute | null`, and the `{ type: "rdk.route"; route: RdkHudRoute | null }` HUD event. Tasks 4, 5 and 6 all depend on these names.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rdk-hud-state.test.ts`, inside the existing top-level `describe`:

```ts
describe("rdk.route", () => {
  const geometry = () => ({
    destinationName: "人民广场",
    polyline: [
      { lat: 31.23, lon: 121.47 },
      { lat: 31.235, lon: 121.47 },
      { lat: 31.24, lon: 121.47 }
    ],
    steps: [{ lat: 31.235, lon: 121.47 }]
  });

  it("starts with no route", () => {
    expect(initialHudState().route).toBeNull();
  });

  it("holds the route and deep-copies its geometry from the caller", () => {
    const route = geometry();
    const state = reduceHud(initialHudState(), { type: "rdk.route", route });
    route.polyline[0]!.lat = 0;
    route.steps[0]!.lon = 0;
    route.destinationName = "changed";

    expect(state.route).toEqual(geometry());
  });

  it("clears the route when navigation ends", () => {
    const active = reduceHud(initialHudState(), { type: "rdk.route", route: geometry() });

    expect(reduceHud(active, { type: "rdk.route", route: null }).route).toBeNull();
  });

  it("replaces geometry wholesale on a reroute rather than merging", () => {
    const active = reduceHud(initialHudState(), { type: "rdk.route", route: geometry() });
    const rerouted = reduceHud(active, {
      type: "rdk.route",
      route: { polyline: [{ lat: 31.3, lon: 121.5 }], steps: [] }
    });

    expect(rerouted.route).toEqual({ polyline: [{ lat: 31.3, lon: 121.5 }], steps: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-hud-state.test.ts`
Expected: FAIL — TypeScript rejects `"rdk.route"` as an unknown event type, and `initialHudState().route` does not exist.

- [ ] **Step 3: Implement**

In `rdk/agent/src/hud/state.ts`, add the type after `HudCompanion`:

```ts
/** Route geometry for the bench schematic. Maneuvers are reduced to bare
 *  coordinates: the card needs marker positions, not maneuver semantics, and
 *  the narrower type keeps instruction text out of a second place. */
export type RdkHudRoute = {
  destinationName?: string;
  polyline: Array<{ lat: number; lon: number }>;
  steps: Array<{ lat: number; lon: number }>;
};
```

Add `route: RdkHudRoute | null;` to `HudState` after `navigation`.

Add to the `HudEvent` union:

```ts
  | { type: "rdk.route"; route: RdkHudRoute | null }
```

Add `route: null` to `initialHudState()` after `navigation: null`.

Add the copy helper next to `copyNavigation`:

```ts
function copyRoute(route: RdkHudRoute): RdkHudRoute {
  return {
    ...(route.destinationName === undefined ? {} : { destinationName: route.destinationName }),
    polyline: route.polyline.map((point) => ({ lat: point.lat, lon: point.lon })),
    steps: route.steps.map((point) => ({ lat: point.lat, lon: point.lon }))
  };
}
```

Add the reducer case after `case "rdk.navigation":`:

```ts
    case "rdk.route":
      return { ...state, route: event.route === null ? null : copyRoute(event.route) };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-hud-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/hud/state.ts tests/rdk-hud-state.test.ts
git commit -m "feat(rdk-hud): carry route geometry in HUD state"
```

---

### Task 2: The navigation snapshot carries the rider position

**Files:**

- Modify: `rdk/agent/src/navigation/controller.ts`
- Test: `tests/rdk-navigation-controller.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `RdkNavigationSnapshot.position?: { lat: number; lon: number }`. Tasks 5 and 6 depend on this field name.

Populate it inside `publish()`, the single choke point every snapshot passes through, so the dot is never a frame behind the fix that triggered the publish.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `tests/rdk-navigation-controller.test.ts`:

```ts
describe("rider position on the snapshot", () => {
  it("stamps every published snapshot with the newest fix", async () => {
    let current: PhoneFix | undefined = ORIGIN_FIX;
    const h = harness({ latest: () => current });
    await startGuiding(h);

    current = fix(2, 31.238);
    h.controller.handleFix(fix(2, 31.238));

    expect(h.states.at(-1)?.position).toEqual({ lat: 31.238, lon: 121.47 });
  });

  it("omits the position entirely when there is no fix", async () => {
    const h = harness({ latest: () => undefined, waitForFix: () => Promise.resolve(ORIGIN_FIX) });
    await startGuiding(h);

    expect(h.states.at(-1)).not.toHaveProperty("position");
  });

  it("survives a throwing location source rather than failing the publish", async () => {
    const h = harness({
      latest: () => {
        throw new Error("location source closed");
      },
      waitForFix: () => Promise.resolve(ORIGIN_FIX)
    });

    await expect(startGuiding(h)).resolves.toBeDefined();
    expect(h.states.at(-1)).not.toHaveProperty("position");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rdk-navigation-controller.test.ts -t "rider position"`
Expected: FAIL — `position` is `undefined` on every snapshot.

- [ ] **Step 3: Implement**

In `rdk/agent/src/navigation/controller.ts`, add to `RdkNavigationSnapshot` after `offRoute?: boolean;`:

```ts
  /** GCJ-02, like every other coordinate here. Present only once a fix exists. */
  position?: { lat: number; lon: number };
```

Inside `createRdkNavigationController`, add above `function publish`:

```ts
/** The freshest fix, for the HUD's rider dot. Never allowed to break a
 *  publish: a closed or throwing source simply means "no dot yet". */
function latestPosition(): { lat: number; lon: number } | undefined {
  try {
    const fix = options.location.latest();
    return fix === undefined ? undefined : { lat: fix.position.lat, lon: fix.position.lon };
  } catch {
    return undefined;
  }
}
```

Replace the assignment inside `publish` so it stamps the position:

```ts
  function publish(next: RdkNavigationSnapshot, expectedRevision = revision): boolean {
    if (revision !== expectedRevision) return false;
    const position = latestPosition();
    // `next` is frequently `{ ...snapshot, … }` (abandonReroute, and both
    // handleLocationState branches), so it can arrive carrying a stale
    // `position` as an own key. The conditional spread below can ADD a
    // position but never REMOVE one — drop any inherited key first, or a lost
    // fix leaves the rider dot frozen at its last location instead of
    // clearing. A frozen-but-plausible dot is worse than no dot.
    // A rest-destructure (`const { position: _stale, ...rest } = next`) reads
    // well but leaves an unused binding, and this repo's eslint config enables
    // no-unused-vars as an error without ignoreRestSiblings — so it fails
    // `npm run lint`, which `npm run check` and both CI workflows run.
    const nextFiltered = { ...next };
    delete nextFiltered.position;
    snapshot = {
      ...nextFiltered,
      ...(position === undefined ? {} : { position }),
      ...(next.location === undefined ? {} : { location: copyLocation(next.location) })
    };
```

The rest of `publish` is unchanged.

Cover the present-then-lost transition explicitly — the three tests above only
exercise "updates to a newer fix" and "never had one", so neither would catch a
stale key surviving:

```ts
it("clears a stamped position when the fix is later lost", async () => {
  let current: PhoneFix | undefined = ORIGIN_FIX;
  const h = harness({ latest: () => current });
  await startGuiding(h);
  expect(h.states.at(-1)?.position).toEqual({ lat: 31.23, lon: 121.47 });

  current = undefined;
  h.controller.handleLocationState({ connection: "stopped", usable: false, reason: "stopped" });

  expect(h.states.at(-1)).not.toHaveProperty("position");
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-navigation-controller.test.ts`
Expected: PASS — the whole file, not just the new block.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/navigation/controller.ts tests/rdk-navigation-controller.test.ts
git commit -m "feat(rdk-nav): stamp published snapshots with the rider position"
```

---

### Task 3: The controller emits route geometry

**Files:**

- Modify: `rdk/agent/src/navigation/controller.ts`
- Test: `tests/rdk-navigation-controller.test.ts`

**Interfaces:**

- Consumes: `RdkHudRoute` from Task 1 — but do **not** import it here. The controller stays independent of the HUD; it emits a structurally identical shape and `main.ts` passes it through.
- Produces: the optional controller option
  `onRoute?: (route: { destinationName?: string; polyline: Array<{ lat: number; lon: number }>; steps: Array<{ lat: number; lon: number }> } | null) => void`.
  Task 4 wires it.

`installRoute` and `clearRouteState` are the only two places `activeRoute` changes, so they are the only two emit points.

- [ ] **Step 1: Write the failing test**

First extend the harness. In `HarnessOptions` add:

```ts
  onRoute?: (route: RdkRouteGeometry | null) => void;
```

Add this import alongside the existing controller import:

```ts
import {
  createRdkNavigationController,
  type RdkNavigationSnapshot,
  type RdkRouteGeometry
} from "../rdk/agent/src/navigation/controller";
```

In `harness()`, add a collector before `const controller = ...`:

```ts
const routes: Array<RdkRouteGeometry | null> = [];
```

Add to the `createRdkNavigationController({...})` argument object:

```ts
    onRoute: (route) => {
      routes.push(route);
      options.onRoute?.(route);
    },
```

Add `routes` to the returned object, next to `states`.

Then append inside the top-level `describe`:

```ts
describe("route geometry for the HUD", () => {
  it("emits the installed route's polyline and maneuver coordinates", async () => {
    const h = harness();
    await startGuiding(h);

    expect(h.routes.at(-1)).toEqual({
      destinationName: "人民广场",
      polyline: [
        { lat: 31.23, lon: 121.47 },
        { lat: 31.235, lon: 121.47 },
        { lat: 31.24, lon: 121.47 }
      ],
      steps: [
        { lat: 31.235, lon: 121.47 },
        { lat: 31.24, lon: 121.47 }
      ]
    });
  });

  it("drops maneuver instructions rather than forwarding them twice", async () => {
    const h = harness();
    await startGuiding(h);

    expect(JSON.stringify(h.routes.at(-1))).not.toContain("右转");
  });

  it("emits null when navigation closes", async () => {
    const h = harness();
    await startGuiding(h);
    h.controller.close();

    expect(h.routes.at(-1)).toBeNull();
  });

  it("does not retain the caller's arrays", async () => {
    const event = route("nav-1");
    const h = harness();
    h.controller.handleRoute(event);
    await flush();
    event.polyline[0]!.lat = 0;

    expect(h.routes.at(-1)?.polyline[0]).toEqual({ lat: 31.23, lon: 121.47 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rdk-navigation-controller.test.ts -t "route geometry"`
Expected: FAIL — `RdkRouteGeometry` is not exported and `onRoute` is not an option.

- [ ] **Step 3: Implement**

In `rdk/agent/src/navigation/controller.ts`, export the shape next to `RdkNavigationSnapshot`:

```ts
/** What the bench HUD needs to draw a route: the line, and where the turns
 *  are. Deliberately not `NavRouteEvent` — instruction text and
 *  `alongRouteMeters` already reach the HUD through the snapshot. */
export type RdkRouteGeometry = {
  destinationName?: string;
  polyline: Array<{ lat: number; lon: number }>;
  steps: Array<{ lat: number; lon: number }>;
};
```

Add to the options object of `createRdkNavigationController`, after `interruptOrdinaryPlayback`:

```ts
  onRoute?: (route: RdkRouteGeometry | null) => void;
```

Add near `latestPosition`:

```ts
function emitRoute(route: NavRouteEvent | undefined): void {
  if (options.onRoute === undefined) return;
  const geometry: RdkRouteGeometry | null =
    route === undefined
      ? null
      : {
          ...(route.destinationName === undefined ? {} : { destinationName: route.destinationName }),
          polyline: route.polyline.map((point) => ({ lat: point.lat, lon: point.lon })),
          steps: route.steps.map((maneuver) => ({ lat: maneuver.lat, lon: maneuver.lon }))
        };
  try {
    options.onRoute(geometry);
  } catch {
    // A HUD observer cannot own or interrupt the navigation lifecycle,
    // matching how `publish` treats `onState`.
  }
}
```

In `clearRouteState()`, add as the last statement:

```ts
emitRoute(undefined);
```

In `installRoute()`, immediately after `activeRoute = copyRoute(event);`, add:

```ts
emitRoute(activeRoute);
```

Placing it after `copyRoute` is what makes the caller's arrays un-retained.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-navigation-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/navigation/controller.ts tests/rdk-navigation-controller.test.ts
git commit -m "feat(rdk-nav): emit route geometry for the bench HUD"
```

---

### Task 4: Publish the route to the HUD

**Files:**

- Modify: `rdk/agent/src/main.ts:325-347`

**Interfaces:**

- Consumes: `onRoute` (Task 3), the `rdk.route` HUD event (Task 1).
- Produces: nothing new.

**This task adds no unit test, deliberately.** `main.ts` is the process entry point and has no harness — `tests/rdk-navigation-wiring.test.ts` exercises routing logic through `navigationStub`/`locationStub`, never `main.ts` itself. Both halves of this wiring are already pinned: the controller emits (Task 3) and the reducer accepts (Task 1). What is left is a five-line pass-through, and inventing a test that re-asserts the reducer through a fake `published` array would assert nothing about the wiring. It is covered by the typecheck, the end-to-end suite, and the manual bench check at the end of this plan.

- [ ] **Step 1: Implement**

In `rdk/agent/src/main.ts`, inside `createNavigationSession()`, add to the `createRdkNavigationController({...})` argument object, after the `onState` property:

```ts
      onRoute: (route) => {
        if (!ownsCallbacks()) return;
        publishHud({ type: "rdk.route", route });
      },
```

In `closeNavigationSession()`, after the existing `publishHud({ type: "rdk.navigation", navigation: null });`, add:

```ts
publishHud({ type: "rdk.route", route: null });
```

- [ ] **Step 2: Typecheck and run the board suite**

```bash
npm run check
npx vitest run tests/rdk-navigation-wiring.test.ts tests/rdk-hud-state.test.ts tests/rdk-companion-navigation-e2e.test.ts
```

Expected: both pass. The typecheck is the real gate here — it proves the controller's `RdkRouteGeometry` satisfies the HUD event's `RdkHudRoute` without either importing the other.

- [ ] **Step 3: Commit**

```bash
git add rdk/agent/src/main.ts
git commit -m "feat(rdk-hud): publish route geometry from the navigation session"
```

---

### Task 5: Redact route and rider position from non-loopback viewers

**Files:**

- Modify: `rdk/agent/src/hud/server.ts:74-79`
- Test: `tests/rdk-hud-server-security.test.ts`

**Interfaces:**

- Consumes: `HudState.route` (Task 1), `RdkNavigationSnapshot.position` (Task 2).
- Produces: nothing new.

The token decides whether a peer is served at all; the peer address decides how much a served peer sees. Route and position join the pairing code on the loopback-only side of that line.

- [ ] **Step 1: Write the failing test**

In `tests/rdk-hud-server-security.test.ts`, extend the module-level `livePairingState` fixture. Add a `position` inside its `navigation` object, after `offRoute: false,`:

```ts
    position: { lat: 31.2304, lon: 121.4737 },
```

and add a sibling `route` key after the whole `navigation` object:

```ts
  route: {
    destinationName: "人民广场",
    polyline: [
      { lat: 31.23, lon: 121.47 },
      { lat: 31.24, lon: 121.47 }
    ],
    steps: [{ lat: 31.235, lon: 121.47 }]
  }
```

Then append this `describe` at the end of the file:

```ts
describe("RDK HUD rider-location transport boundary", () => {
  it("sends no route geometry and no rider position to a token-bearing non-loopback peer", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    server.publish(cloneState(livePairingState));

    const { initial } = await connectWithInitial(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);

    expect(initial.route).toBeNull();
    expect(initial.navigation).not.toHaveProperty("position");
    // The whole frame, not just the fields we remembered to name: a rider's
    // coordinates must not survive anywhere in it.
    expect(JSON.stringify(initial)).not.toContain("31.2304");
    expect(JSON.stringify(initial)).not.toContain("121.4737");
    expect(JSON.stringify(initial)).not.toContain("121.47");
  });

  it("gives a loopback peer the full route and rider position", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    server.publish(cloneState(livePairingState));

    const { initial } = await connectWithInitial(`ws://127.0.0.1:${port}/`);

    expect(initial.route?.polyline).toHaveLength(2);
    expect(initial.navigation?.position).toEqual({ lat: 31.2304, lon: 121.4737 });
  });

  it("keeps redacting the rider position on later broadcasts, not just the initial replay", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const { socket } = await connectWithInitial(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);

    const update = nextState(socket);
    server.publish(cloneState(livePairingState));

    const received = await update;
    expect(received.route).toBeNull();
    expect(received.navigation).not.toHaveProperty("position");
  });

  it("does not mutate the caller's state while redacting", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const source = cloneState(livePairingState);
    await connectWithInitial(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);

    server.publish(source);

    expect(source.route?.polyline).toHaveLength(2);
    expect(source.navigation?.position).toEqual({ lat: 31.2304, lon: 121.4737 });
  });
});
```

The `"121.47"` assertion is deliberately broader than the rider's own coordinates: it also catches the route polyline leaking through some field nobody thought to check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rdk-hud-server-security.test.ts`
Expected: FAIL — the remote peer receives both the polyline and the coordinates.

- [ ] **Step 3: Implement**

In `rdk/agent/src/hud/server.ts`, replace `remoteHudSnapshot`:

```ts
/**
 * What a served-but-not-local peer sees. The token got them in; it does not
 * make them local. Pairing secrets stay loopback-only, and so does anything
 * that would turn this page into a rider-tracking surface: the route the rider
 * is following and where they are on it.
 */
function remoteHudSnapshot(state: HudState): HudState {
  const companion = { ...state.companion };
  delete companion.pairingCode;
  delete companion.pairingExpiresAt;
  const navigation = state.navigation === null ? null : { ...state.navigation };
  if (navigation !== null) delete navigation.position;
  return { ...state, companion, navigation, route: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rdk-hud-server-security.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/hud/server.ts tests/rdk-hud-server-security.test.ts
git commit -m "fix(rdk-hud): keep route and rider position loopback-only"
```

---

### Task 6: Draw the route card

**Files:**

- Modify: `rdk/agent/src/hud/index.html`
- Test: `tests/rdk-hud-render.test.ts`

**Interfaces:**

- Consumes: `state.route` (Task 1), `state.navigation.position` (Task 2).
- Produces: DOM ids `route-card`, `route-svg` for the render tests.

The existing harness builds its fake elements from `id="..."` matches in the served page, so new ids are picked up automatically.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` to `tests/rdk-hud-render.test.ts`. Note `state()` must gain a `route` key — add `route: null` to the `state()` helper's defaults first, so existing tests keep their current meaning.

```ts
describe("RDK HUD route card", () => {
  const geometry = {
    destinationName: "人民广场",
    polyline: [
      { lat: 31.23, lon: 121.47 },
      { lat: 31.24, lon: 121.48 }
    ],
    steps: [{ lat: 31.235, lon: 121.475 }]
  };

  it("stays hidden until a route exists", () => {
    const harness = renderHarness();
    harness.render(state({ route: null }));

    expect(element(harness, "route-card").hidden).toBe(true);
  });

  it("draws the route line, one marker per maneuver, and the rider dot", () => {
    const harness = renderHarness();
    harness.render(
      state({ route: geometry, navigation: { ...state().navigation!, position: { lat: 31.235, lon: 121.475 } } })
    );

    const svg = element(harness, "route-svg").innerHTML;
    expect(element(harness, "route-card").hidden).toBe(false);
    expect(svg).toContain("<polyline");
    expect((svg.match(/class="maneuver"/g) ?? []).length).toBe(1);
    expect(svg).toContain('class="rider"');
  });

  it("draws the route with no rider dot before the first fix", () => {
    const harness = renderHarness();
    const navigation = { ...state().navigation! };
    delete (navigation as { position?: unknown }).position;
    harness.render(state({ route: geometry, navigation }));

    expect(element(harness, "route-svg").innerHTML).toContain("<polyline");
    expect(element(harness, "route-svg").innerHTML).not.toContain('class="rider"');
  });

  it("hides and empties the card when the route clears", () => {
    const harness = renderHarness();
    harness.render(state({ route: geometry }));
    harness.render(state({ route: null }));

    expect(element(harness, "route-card").hidden).toBe(true);
    expect(element(harness, "route-svg").innerHTML).toBe("");
  });

  it("emits finite coordinates for a degenerate single-point route", () => {
    const harness = renderHarness();
    harness.render(state({ route: { polyline: [{ lat: 31.23, lon: 121.47 }], steps: [] } }));

    expect(element(harness, "route-svg").innerHTML).not.toContain("NaN");
    expect(element(harness, "route-svg").innerHTML).not.toContain("Infinity");
  });

  it("renders nothing remote-looking, keeping the page card-only", () => {
    expect(page).not.toMatch(/<iframe|<canvas|webapi\.amap|restapi\.amap|amap\.com/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-hud-render.test.ts`
Expected: FAIL — `route-card` is undefined, so reading `.hidden` throws.

- [ ] **Step 3: Implement the markup and styles**

In `rdk/agent/src/hud/index.html`, add to the `<style>` block next to `#companion-card`:

```css
#route-card {
  margin-bottom: 16px;
}
#route-svg {
  width: 100%;
  height: 180px;
  display: block;
}
#route-svg .line {
  stroke: #79c0ff;
  stroke-width: 3;
  fill: none;
}
#route-svg .maneuver {
  fill: #d29922;
}
#route-svg .rider {
  fill: #3fb950;
}
```

Add the section immediately after the `</section>` that closes `#navigation-card`:

```html
<section id="route-card" class="card" hidden>
  <svg id="route-svg" viewBox="0 0 280 160" role="img" aria-label="路线示意图"></svg>
</section>
```

- [ ] **Step 4: Implement the renderer**

In the page's `<script>`, add near `formatDistance`:

```js
const routeCardEl = document.getElementById("route-card");
const routeSvgEl = document.getElementById("route-svg");

// Kept deliberately identical to RouteSchematic in
// src/components/NavigationPanel.tsx — this page is a single dependency-free
// file assembled by string substitution and cannot import shared code, the
// same reason formatDistance is duplicated here. tests/rdk-hud-render.test.ts
// pins the two against one fixture so they cannot drift.
const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 160;
const VIEW_PADDING = 18;

const computeBounds = (polyline) => {
  const lats = polyline.map((p) => p.lat);
  const lons = polyline.map((p) => p.lon);
  const minLat = lats.length ? Math.min(...lats) : 0;
  const maxLat = lats.length ? Math.max(...lats) : 0;
  const minLon = lons.length ? Math.min(...lons) : 0;
  const maxLon = lons.length ? Math.max(...lons) : 0;
  // A degenerate route falls back to a 1-unit span so the scale stays finite
  // instead of dividing by zero.
  const latSpan = maxLat - minLat || 1;
  const lonSpan = maxLon - minLon || 1;
  const innerWidth = VIEW_WIDTH - VIEW_PADDING * 2;
  const innerHeight = VIEW_HEIGHT - VIEW_PADDING * 2;
  const scale = Math.min(innerWidth / lonSpan, innerHeight / latSpan);
  return {
    minLat,
    maxLat,
    minLon,
    scale,
    xOffset: VIEW_PADDING + (innerWidth - lonSpan * scale) / 2,
    yOffset: VIEW_PADDING + (innerHeight - latSpan * scale) / 2
  };
};

const project = (bounds, point) => ({
  x: bounds.xOffset + (point.lon - bounds.minLon) * bounds.scale,
  // SVG y grows downward; north must render toward the top.
  y: bounds.yOffset + (bounds.maxLat - point.lat) * bounds.scale
});

const renderRoute = (state) => {
  const route = state.route !== null && typeof state.route === "object" ? state.route : null;
  if (route === null || !Array.isArray(route.polyline)) {
    routeCardEl.hidden = true;
    routeSvgEl.innerHTML = "";
    return;
  }
  const bounds = computeBounds(route.polyline);
  const parts = [];
  if (route.polyline.length > 1) {
    const points = route.polyline
      .map((point) => {
        const projected = project(bounds, point);
        return `${projected.x},${projected.y}`;
      })
      .join(" ");
    parts.push(`<polyline class="line" points="${points}" />`);
  }
  for (const maneuver of Array.isArray(route.steps) ? route.steps : []) {
    const projected = project(bounds, maneuver);
    parts.push(`<circle class="maneuver" cx="${projected.x}" cy="${projected.y}" r="4" />`);
  }
  const position = state.navigation === null ? undefined : state.navigation.position;
  if (position && Number.isFinite(position.lat) && Number.isFinite(position.lon)) {
    const projected = project(bounds, position);
    parts.push(`<circle class="rider" cx="${projected.x}" cy="${projected.y}" r="5" />`);
  }
  routeSvgEl.innerHTML = parts.join("");
  routeCardEl.hidden = false;
};
```

Every value written into that markup is a number computed from `Number` inputs, so no caller-supplied string reaches the DOM — `destinationName` is deliberately not rendered here; the navigation card already shows it.

Call it from `socket.onmessage`, immediately after `renderNavigation(state);`:

```js
renderRoute(state);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-hud-render.test.ts`
Expected: PASS, including the pre-existing card-only assertion.

- [ ] **Step 6: Commit**

```bash
git add rdk/agent/src/hud/index.html tests/rdk-hud-render.test.ts
git commit -m "feat(rdk-hud): draw the bench route schematic"
```

---

### Task 7: Pin the schematic against the web app's projection

**Files:**

- Modify: `src/components/NavigationPanel.tsx` (export two existing pure functions)
- Test: `tests/rdk-hud-render.test.ts`

**Interfaces:**

- Consumes: the page's inline `computeBounds`/`project` (Task 6).
- Produces: exported `computeBounds` and `project` from `NavigationPanel.tsx`.

Duplicated math is only safe while something proves the copies agree.

- [ ] **Step 1: Write the failing test**

Append to the route-card `describe` in `tests/rdk-hud-render.test.ts`:

```ts
it("projects identically to the web app's schematic", () => {
  const polyline = [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.2355, lon: 121.4788 },
    { lat: 31.24, lon: 121.48 }
  ];
  const rider = { lat: 31.2355, lon: 121.4788 };
  const bounds = computeBounds(polyline);
  const expected = project(bounds, rider);

  const harness = renderHarness();
  harness.render(
    state({
      route: { polyline, steps: [] },
      navigation: { ...state().navigation!, position: rider }
    })
  );

  const svg = element(harness, "route-svg").innerHTML;
  expect(svg).toContain(`cx="${expected.x}" cy="${expected.y}"`);
});
```

Add the import at the top of the test file:

```ts
import { computeBounds, project } from "../src/components/NavigationPanel";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rdk-hud-render.test.ts -t "projects identically"`
Expected: FAIL — `computeBounds` and `project` are not exported.

- [ ] **Step 3: Implement**

In `src/components/NavigationPanel.tsx`, add `export` to the two existing pure functions and note why:

```ts
/** Exported so tests can pin the RDK HUD's inline copy of this projection
 *  against it; the board page cannot import shared code. */
export function computeBounds(polyline: readonly GeoPoint[]): SchematicBounds {
```

```ts
export function project(bounds: SchematicBounds, point: GeoPoint): { x: number; y: number } {
```

Also export the `SchematicBounds` type so the signature is usable:

```ts
export type SchematicBounds = {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-hud-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

```bash
npx vitest run
npm run lint
npm run check
```

Expected: all pass. `npm run check:dead-code` may flag the newly exported symbols if they are only used by tests — if so, follow the repo's existing knip configuration rather than un-exporting.

- [ ] **Step 6: Commit**

```bash
git add src/components/NavigationPanel.tsx tests/rdk-hud-render.test.ts
git commit -m "test(rdk-hud): pin the board schematic to the web projection"
```

---

## Manual verification on the board

The card only renders while a route is active, so a live ride is required. After deploying (see `rdk/README.md` "Reviewed RDK rollout"):

1. Pair the phone and start Helmet Ride; confirm the HUD shows `手机 GPS 共享中`.
2. Say `"Max，导航到 <destination>"`.
3. On the HDMI kiosk or an SSH forward (`ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 root@<board>`), confirm the route card appears with a line, markers at the turns, and a dot that advances.
4. From a LAN browser with `?t=<MAX_VISION_TOKEN>`, confirm the route card stays **hidden** — the redaction path.
5. Stop navigation; confirm the card disappears.

A board-local headless screenshot is the quickest evidence:

```bash
chromium --headless --no-sandbox --disable-gpu --window-size=1100,900 \
  --virtual-time-budget=9000 --screenshot=/tmp/hud.png http://127.0.0.1:8080/
```
