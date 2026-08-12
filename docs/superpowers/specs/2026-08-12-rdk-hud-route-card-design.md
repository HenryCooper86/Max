# RDK HUD Route Card (Bench Route Schematic)

## Summary

The board HUD at `:8080` renders navigation as text only — instruction, distance,
and a summary line. There is no way to see whether the route the relay sent is
shaped the way the instructions claim, or whether the rider is tracking along it.
This adds a **route card**: an offline SVG schematic showing the route polyline,
one marker per maneuver, and the rider's position.

It is a **bench instrument**, not a rider surface. It exists so a developer can
confirm at a glance that a real route arrived, has plausible geometry, and that
the rider dot advances along it.

No map tiles. `AMAP_JS_KEY`/`AMAP_JS_SECRET` are not available, and a
China-facing kiosk must not depend on a foreign CDN in any case (see the web
app's identical constraint). The schematic needs no key and no network.

## Context

The geometry is **already on the board**. `nav.route` carries the full
`polyline` and `steps` (`shared/agent.ts:364-373`), and
`createRdkNavigationController` stores them in `activeRoute` during
`installRoute`. They are simply never published to the HUD.

Two facts shape the design:

- **`RdkNavigationSnapshot` has no geometry and no rider position.** It carries
  `phase`, `destinationName`, `instruction`, distances, `offRoute`, and
  `location` — and `location` is a `PhoneLocationState`
  (`connection`/`usable`/`accuracy`/`ageMs`), which holds **no coordinates**.
  Only `PhoneFix` has `position`.
- **Every HUD frame carries the whole `HudState`.** `createHudServer`'s
  `publish` (`rdk/agent/src/hud/server.ts`) serialises the entire state to every
  connected socket, and `publishHud` runs on every relay agent event — streaming
  transcript partials included — not only on navigation ones. So anything stored
  on `HudState` crosses the socket on every frame no matter which event
  delivered it, and the page re-renders the schematic from each message. A
  full-resolution Amap polyline is thousands of points, which is more than that
  budget can carry.

## Design

Split the two payloads by what they are, and bound the larger one.

### Route geometry — `rdk.route`

The controller gains an `onRoute` option, called with the active route's
geometry when a route installs (including reroutes) and with `null` when
navigation ends or the controller closes. `main.ts` forwards it as a HUD event,
matching the existing `rdk.navigation` / `rdk.companion` / `rdk.discovery`
pattern:

```ts
type RdkHudRoute = {
  destinationName?: string;
  polyline: Array<{ lat: number; lon: number }>;
  steps: Array<{ lat: number; lon: number }>;
};

| { type: "rdk.route"; route: RdkHudRoute | null }
```

`HudState` gains `route: RdkHudRoute | null`, defaulting to `null` in
`initialHudState()`, with a reducer case that deep-copies like the existing
ones.

The separate event does **not** mean the geometry crosses the socket once per
route. It rides every frame, like everything else on `HudState`; the split buys
a clean snapshot type, not a smaller wire. **Decimation is what bounds the
cost.** `emitRoute` caps the emitted polyline at `HUD_POLYLINE_MAX_POINTS`
(150), always keeping the first and last point and sampling the interior at a
uniform stride over the point _index_. **This is lossy**: at 280×160 the
average discarded point is sub-pixel, but the stride follows Amap's shape-point
density rather than screen distance, so a hairpin falling between two sampled
indices draws as a chord. That is an acceptable trade for a bench instrument
confirming a route arrived and the rider tracks along it, and an unacceptable
one for a rider-facing map — which this card must not become without revisiting
this decision. Guidance never sees the thinned line: `activeRoute` keeps the
full-resolution polyline, so off-route detection and maneuver distances are
unaffected. Capping at the emit boundary bounds the wire payload and the
page's SVG rebuild in one place, and keeps `computeBounds`' `Math.min(...lats)`
off a multi-thousand-element spread. `steps` is never decimated: the markers
are few, and each one is a turn.

`steps` is reduced to bare coordinates at the boundary. The HUD needs marker
positions, not maneuver semantics, and the narrower type keeps instruction text
out of a second place.

### Rider position — `position` on the snapshot

`RdkNavigationSnapshot` gains `position?: { lat: number; lon: number }`, taken
from the fix the controller already reads via `options.location.latest()`. Two
numbers is a cost the frame carries without help, whatever the frame rate turns
out to be — which is precisely why the polyline needs the cap and this does not.

It is optional throughout: before the first fix there is a route but no dot.

**Both inputs are GCJ-02** — every `nav.*` coordinate is, and
`PhoneLocationSource`'s public boundary is too. They are therefore plotted in a
single datum. This matters more than it looks: mixing WGS-84 and GCJ-02 here
would offset the rider dot from the route by roughly 100 m in China while every
number on the card still read as correct, which is exactly the kind of fault a
bench instrument exists to catch rather than introduce.

### Rendering

A new `#route-card` section, hidden whenever `route === null`, so a finished
route never lingers on screen. This is the same visibility discipline the
navigation card uses.

The schematic matches the web app's `RouteSchematic`
(`src/components/NavigationPanel.tsx`) so the two surfaces stay comparable:

- `280 × 160` viewBox, `18` padding
- bounds over the polyline; a degenerate (empty or single-point) route falls
  back to a 1-unit span so the scale stays finite instead of dividing by zero
- north-up projection — SVG y grows downward, so higher latitude maps to a
  smaller y
- `<polyline>` for the route, `r=4` circle per maneuver, `r=5` circle for the
  rider

**The projection math is reimplemented in the page's inline JavaScript rather
than shared.** The HUD is deliberately a single dependency-free file assembled
by string substitution in `renderHudPage`; it cannot import from `shared/`, and
it already duplicates `formatDistance`/`formatEta` for this reason. A test pins
both implementations against one fixture so they cannot drift silently.

### Redaction

`remoteHudSnapshot` (`rdk/agent/src/hud/server.ts`) already strips
`pairingCode` and `pairingExpiresAt` for any peer that is not the board's own
loopback. Rider position joins them. Exact route coordinates also remain
loopback-only, but an authenticated direct-LAN peer receives a normalized
schematic: the minimum latitude/longitude are translated to zero and one shared
span scales both axes. This preserves route shape and maneuver placement while
removing the route's location and absolute scale. Values are rounded to six
decimal places for a deterministic topology-only payload.

This preserves the existing distinction, which the token does not blur: the
**token** decides whether a peer is served at all; the **peer address** decides
how much a served peer sees. A token-bearing LAN browser can verify that a route
arrived and render its shape, but it cannot read the rider position or raw Amap
coordinates. The HDMI kiosk and SSH local forward remain loopback and receive
the full route plus rider dot.

## Error handling and edge cases

- **No route** — card hidden; no stale geometry retained.
- **Route with no fix yet** — route and maneuvers draw, rider dot omitted.
- **Empty or single-point polyline** — 1-unit span fallback keeps the scale
  finite; no NaN coordinates reach the DOM.
- **Reroute** — a fresh `rdk.route` replaces the geometry wholesale rather than
  merging, so an abandoned excursion cannot persist.
- **Navigation ends / controller closes** — `rdk.route` with `null`, alongside
  the existing `rdk.navigation` null.
- **Authenticated non-loopback viewer** — normalized route schematic, but no
  rider `position` or raw route coordinates; the card renders without becoming
  a raw location feed.

## Testing

`tests/rdk-hud-render.test.ts` already evaluates the page as served, through a
DOM fake. New cases:

- card hidden when `route === null`; visible with a route
- polyline points, maneuver markers, and rider dot render from a fixture at the
  expected projected coordinates
- rider dot omitted when `position` is absent
- geometry cleared when a route ends
- degenerate polylines produce finite coordinates
- **projection parity** — the page's inline math and the web app's
  `computeBounds`/`project` agree on one shared fixture

`tests/rdk-hud-state.test.ts`: the `rdk.route` reducer case, including deep-copy
isolation and the `null` clear.

`tests/rdk-hud-server-security.test.ts`: a non-loopback snapshot carries a
normalized route but neither raw geometry nor `navigation.position`, while a
loopback snapshot carries the full route and position.

Board-side wiring (`onRoute` firing on install, reroute, and close) is covered
in the navigation controller's existing tests.

`tests/rdk-navigation-controller.test.ts` also pins decimation: a polyline at or
under the cap passes through unchanged, one over it is reduced to at most the
cap, the first and last points survive exactly, and `steps` is never thinned
however long the route.

## Out of scope

- Map tiles of any kind, and any Amap runtime dependency on this page.
- Rider heading, speed, or a north arrow.
- Panning, zooming, or any interaction — the card is a fixed overview.
- Off-route or rerouting visual treatment. The navigation card already states
  both in text; revisit only if the bench proves it insufficient.
- Any equivalent on the iOS or Android clients.
