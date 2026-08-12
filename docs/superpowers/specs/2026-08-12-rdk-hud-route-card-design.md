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
- **The snapshot re-broadcasts at roughly 1 Hz while guiding.** Every accepted
  fix republishes it. A multi-kilometre Amap polyline is thousands of points, so
  geometry must not ride in that frame.

## Design

Split the two payloads by how often they change.

### Route geometry — `rdk.route`, once per route

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
ones. Geometry crosses the socket once per route rather than once per second.

`steps` is reduced to bare coordinates at the boundary. The HUD needs marker
positions, not maneuver semantics, and the narrower type keeps instruction text
out of a second place.

### Rider position — `position` on the snapshot

`RdkNavigationSnapshot` gains `position?: { lat: number; lon: number }`, taken
from the fix the controller already reads via `options.location.latest()`. Two
numbers per publish is the right cost for a 1 Hz frame.

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
loopback. Route geometry and rider position join them.

This preserves the existing distinction, which the token does not blur: the
**token** decides whether a peer is served at all; the **peer address** decides
how much a served peer sees. Without this, a token-bearing LAN browser becomes a
rider-tracking surface. Both routes actually used at the bench — the HDMI kiosk
and the SSH local forward — are loopback and lose nothing.

## Error handling and edge cases

- **No route** — card hidden; no stale geometry retained.
- **Route with no fix yet** — route and maneuvers draw, rider dot omitted.
- **Empty or single-point polyline** — 1-unit span fallback keeps the scale
  finite; no NaN coordinates reach the DOM.
- **Reroute** — a fresh `rdk.route` replaces the geometry wholesale rather than
  merging, so an abandoned excursion cannot persist.
- **Navigation ends / controller closes** — `rdk.route` with `null`, alongside
  the existing `rdk.navigation` null.
- **Non-loopback viewer** — no `route`, no `position`; the card stays hidden
  rather than rendering an empty frame.

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

`tests/rdk-hud-server-security.test.ts`: a non-loopback snapshot carries neither
`route` nor `navigation.position`, while a loopback snapshot carries both.

Board-side wiring (`onRoute` firing on install, reroute, and close) is covered
in the navigation controller's existing tests.

## Out of scope

- Map tiles of any kind, and any Amap runtime dependency on this page.
- Rider heading, speed, or a north arrow.
- Panning, zooming, or any interaction — the card is a fixed overview.
- Off-route or rerouting visual treatment. The navigation card already states
  both in text; revisit only if the bench proves it insufficient.
- Any equivalent on the iOS or Android clients.
