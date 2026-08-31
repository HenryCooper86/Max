# Amap Server-Side Routing & Cross-Platform Navigation Design

## Summary

Move routing off the phone and onto the relay. Today "导航去X" works only on
iOS, resolved by MKLocalSearch and routed by MKDirections on the device
(`docs/superpowers/specs/2026-07-24-turn-by-turn-navigation-design.md`). This
spec replaces that routing source with a relay-side service backed by 高德
(Amap) Web 服务 APIs, and extends live guidance to Android and the web HUD by
porting the already-proven `GuidanceEngine` pattern — not by integrating a map
SDK three times.

What stays exactly as the 07-24 spec built it: the voice grammar, the
`device.command`/`device.result` spine and its truthful-speech reconciliation,
the pure guidance engine with far/near/now prompt thresholds, one debounced
reroute per excursion, arrival detection, and the glanceable card. What changes:
where the route comes from, and how many platforms can guide.

Routing uses Amap's **driving** profile. This keeps the 07-24 spec's honest
limitation — no motorcycle profile, 摩托车禁行 roads are not respected — but on
Amap's China road data, consistently across all three clients. Amap's true
摩托车路径规划 exists only in their native Navi SDKs behind a paid 商务合作
approval; the provider seam in this design is its future home, not this spec's
scope.

First half of the current project split; the second half (Doubao vision
expansion: gallery photo/video understanding, proactive scene watching) gets its
own spec after this cycle completes.

## Scope

### Goals

- A relay-side routing service behind a provider-neutral `RouteProvider`
  interface: destination resolution (Amap 地点搜索) and route planning (Amap
  `v5/direction/driving`), with a mock implementation so every client, test,
  and demo scenario works with no key.
- New protocol events (`nav.request`, `nav.route`, `nav.error`) carrying route
  geometry, maneuver steps, distance, and ETA — GCJ-02 by contract.
- iOS: swap `RouteSearch` (MKLocalSearch + MKDirections) for the relay round
  trip. `GuidanceEngine`, `NavigationController`, `GuidanceCard` survive.
- Android: live guidance for the first time — a Kotlin port of the pure
  guidance engine, a Compose guidance card, Amap Android Map SDK for display.
- Web HUD: an Amap JS API route map plus the same guidance logic in shared
  TypeScript, driven by scenario-injected positions, so the whole nav flow is
  desk-testable.
- One datum per platform, converted at a single golden-vector-tested edge.
- Truthful confirmations and spoken failures, exactly as the device-action
  specs established.

### Non-goals

- Motorcycle routing (paid Amap 商务 approval; future work behind the provider
  seam). The spoken summary must not imply a motorcycle-validated route.
- Lane guidance, junction views, traffic, speed limits.
- Background/screen-off navigation. Foreground-session-only, as 07-24 argued.
- Handing off to the 高德/百度 apps. Still ruled out — the device-action layer
  must keep working mid-ride.
- An Amap iOS SDK. MapKit's China tiles are Amap-derived; iOS renders without
  a new SDK or key.
- The vision sub-project. Separate spec, next cycle.

## Architecture

```text
"Max，导航去人民广场"
  └─ relay grammar → device.command { navigation.start, query }   (unchanged)
        │
        ▼ client (iOS / Android / web)
     location permission ok? → nav.request { commandId, query, origin(GCJ-02) }
        │                                        │
        │                                        ▼ relay
        │                    RouteProvider.resolveDestination(query, near)
        │                    RouteProvider.planRoute(origin, destination)
        │                                        │
        ▼                                        ▼
     guidance starts ◄──────────── nav.route { commandId, destinationName,
        │                                      polyline, steps, distance, eta }
        └─ device.result ok → Max speaks the truthful summary
                              ("已找到人民广场，全程12公里，预计25分钟")

off-route (engine, >50 m) → nav.request { reason: "reroute", origin } → nav.route
failure at any relay step  → nav.error { commandId, code } → device.result failed
                              → Max speaks the truth ("没找到这个地方" / "路线规划失败")
```

The client initiates `nav.request` because only the client knows its position
and its permission state. The relay stays stateless per request: it does not
track rider location for routing. Location leaves the device only inside a
`nav.request` the rider's own voice command caused — the same posture as
weather and crash alerts.

`device.result` is held until `nav.route`/`nav.error` resolves, so "已开始导航"
is never claimed before a real route exists. Amap answers well inside the
relay's existing 8 s device-result timeout; the timeout stays the backstop.

### Units

- **`server/routing.ts`** — the routing service. `RouteProvider` interface;
  `AmapRouteProvider` (real) and `MockRouteProvider` (fixture routes). Follows
  `weather.ts`/`vision.ts` structure: pure request/response, injectable
  `fetchImpl`, fail-honest.
- **Protocol events** — `nav.request` (client→relay), `nav.route` / `nav.error`
  (relay→client) in `protocol/agent-events.schema.json`, regenerated into
  `shared/generated`. Every coordinate in `nav.*` events is GCJ-02; the schema
  descriptions say so.
- **`shared/guidance.ts`** — the guidance engine in TypeScript for the web HUD:
  same snap-to-route, thresholds, off-route, and arrival semantics as the Swift
  engine, table-tested in vitest from the same coordinate literals.
- **iOS `RelayRouteSearch`** — replaces `RouteSearch`'s MKLocalSearch +
  MKDirections internals behind the same seam `NavigationController` already
  consumes. Everything downstream of the route is untouched.
- **Android `GuidanceEngine.kt` + `NavigationController.kt` + guidance card** —
  the Kotlin port, mirroring the Swift unit boundaries and tests.
- **Web HUD nav panel** — Amap JS API map + route polyline + the shared engine,
  positions injected by scenarios.

## The routing service

`resolveDestination(query, near)` calls Amap place text search
(`v5/place/text`) biased to the rider's position, returns the top candidate's
name and GCJ-02 location, or null. `planRoute(origin, destination)` calls
`v5/direction/driving` with `show_fields` for polyline, duration, and
navigation actions, and maps the response into the protocol route shape:
ordered polyline coordinates, maneuver steps (instruction text, action,
coordinate, along-route distance), total distance, ETA.

Fail-honest, like `vision.ts`: null on every failure — missing key, HTTP error,
timeout, empty result — never a guessed route. The relay turns null into
`nav.error` with a distinguishing code (`destination.notFound`,
`route.unavailable`), and the existing reconciliation path speaks the matching
truth.

`MockRouteProvider` serves fixture routes (authored in GCJ-02) keyed to the
demo scenarios, including one route with a deliberate off-route/reroute
excursion so the full lifecycle demos keylessly on all three clients.

**Reroute discipline.** The client sends at most one in-flight `nav.request`
and keeps the engine's per-excursion debounce. The relay additionally enforces
a minimum interval per session between reroute-reason requests, so a flapping
GPS cannot burn paid quota. A rejected-by-interval reroute returns the current
route unchanged rather than an error.

## Coordinates: one datum per platform edge

Amap speaks GCJ-02; phone GPS speaks WGS-84. Mixing them puts the rider a
permanent 100–600 m off-route. The conversion functions (`wgs84ToGcj02` exact
forward transform; `gcj02ToWgs84` iterative inverse, sub-meter) are pure, one
implementation per platform, each tested against the same golden vectors.

- **Protocol & relay: GCJ-02 only.** Every coordinate in `nav.*` events and
  every Amap call. The relay never converts; it trusts the contract.
- **iOS: WGS-84 inside.** MapKit in mainland China auto-shifts WGS-84 input to
  align with its GCJ-02 tiles — that is why today's MKDirections routes render
  correctly, and why feeding raw GCJ-02 to MKMapView would double-shift.
  So iOS converts at the protocol edge: outgoing origins WGS-84→GCJ-02,
  incoming routes GCJ-02→WGS-84, once. GuidanceEngine, card, and map all keep
  speaking WGS-84 and are untouched.
- **Android: GCJ-02 inside.** The Amap Map SDK displays GCJ-02 natively, so
  Android converts each GPS fix WGS-84→GCJ-02 at the location source; engine
  and display both speak GCJ-02. No inverse transform on Android.
- **Web: GCJ-02 only.** Scenario positions are authored in GCJ-02; the Amap JS
  map consumes them directly. No conversion.

## Per-client behavior

**iOS.** `NavigationController` lifecycle, prompts, barge-in-cutting "now"
prompts, reroute debounce, arrival, and the card are unchanged from 07-24.
Only the route source changes. If the relay is unreachable when
`navigation.start` arrives, the result is `failed("route.unavailable")` and Max
says so — there is no silent MKDirections fallback, because a fallback would
reintroduce per-platform route divergence and mask a broken relay
(fail-loud, as the RDK work established).

**Android.** The Kotlin engine is a line-for-line semantic port (thresholds,
50 m off-route, 30 m arrival, ETA scaling) with the same table tests, so iOS
and Android guide identically. Maneuver prompts speak through the client's
existing TTS path; ADAS hazard alerts keep absolute priority — a hazard
interrupt always wins over a maneuver prompt, and a suppressed maneuver prompt
is dropped, not queued. The card is Compose, mirroring the iOS layout. Display
uses the Amap Android Map SDK (display-only key in the manifest).

**Web HUD.** The Amap JS API 2.0 loads at runtime from `webapi.amap.com`
(China-hosted — satisfies the no-foreign-CDN rule; runtime loading is also
required by Amap's terms, so it is never bundled and the static-cache layer
must pass it through untouched). Its 安全密钥 never reaches the browser: the
relay hosts the `_AMapService` proxy path Amap documents for production,
appending the secret server-side. The HUD nav panel shows the route, rider
position, and next maneuver, driven by the shared engine and scenario-injected
GCJ-02 positions.

## Error and edge handling

- Every `navigation.start` still resolves to exactly one `device.result`;
  silence is a bug.
- No `AMAP_API_KEY` → `MockRouteProvider`, logged loudly once at startup —
  same posture as the mock voice provider.
- Key present, Amap fails → `nav.error` → spoken truth, distinguishing
  "没找到这个地方" (resolution) from "路线规划失败" (routing).
- Reroute failure mid-ride → guidance stops cleanly with a spoken explanation,
  never a stale route (07-24 rule, unchanged).
- Old clients ignore `nav.*` events without erroring, per the protocol's
  existing unknown-event rule; the relay's 8 s timeout speaks the failure for
  clients that never answer.
- Location permission denied → the client sends no `nav.request`; the existing
  `denied("permission.location")` path speaks which permission is missing.

## Keys & configuration

| Where   | Variable / place                | Amap key type                               |
| ------- | ------------------------------- | ------------------------------------------- |
| Relay   | `AMAP_API_KEY`                  | Web 服务 (routing + place search)           |
| Relay   | `AMAP_JS_SECRET`                | the JS API 安全密钥, used only by the proxy |
| Web HUD | served by relay config endpoint | Web 端 (JS API) key                         |
| Android | manifest meta-data              | Android SDK key                             |

No iOS key. Register all three keys under one Amap console account. Until the
keys exist, everything runs on the mock provider.

## Verification

### Automated

- **Vitest, routing service**: `AmapRouteProvider` against recorded Amap
  response fixtures (resolution, routing, empty results, HTTP errors,
  timeouts); the reroute minimum-interval guard; mock provider serves scenario
  fixtures; missing-key path selects mock and logs once.
- **Vitest, shared engine**: the 07-24 engine table (progress, thresholds
  firing once, off-route >50 m, arrival <30 m, ETA scaling) re-expressed over
  GCJ-02 literals.
- **Golden vectors**: `wgs84ToGcj02`/`gcj02ToWgs84` on all platforms against
  the same known coordinate pairs; inverse round-trips to <1 m.
- **XCTest**: existing `GuidanceEngineTests` untouched and green (proof the
  swap didn't disturb guidance); `RelayRouteSearch` against a fake session
  (route arrives → controller starts; `nav.error` → truthful failure; held
  `device.result` ordering).
- **Android unit tests**: the ported engine passes the same table as XCTest;
  controller lifecycle against fake location + fake session.
- **Relay integration test**: 导航去X → `nav.request` → `nav.route` →
  simulated off-route fix → exactly one reroute round trip, on the mock
  provider.
- **Protocol**: schema additions, regenerated types, protocol-sync check green.

### Manual (physical device)

- A real ride on iOS and Android with a live key: prompts land at the right
  distances, one reroute per missed turn, arrival announces, "停止导航" stops
  cleanly, and the polyline sits on the road (not 100–600 m beside it — the
  datum check).
- Web HUD desk run of the nav demo scenario end to end without a key, then
  with one.

## Acceptance criteria

- "导航去X" starts live guidance on iOS, Android, and the web HUD, all served
  by the same relay route, resolving destinations identically.
- With no Amap key, the full nav lifecycle (start, prompts, off-route, reroute,
  arrival, stop) demos on all three clients via the mock provider.
- With a key, routes come from Amap driving profile; Max's spoken summary and
  every confirmation match reality; no route is claimed without one existing.
- Rider position and route polyline agree on every platform (datum correctness
  verified on-road for iOS and Android).
- The JS API secret is never served to a browser; the web HUD map loads only
  from Amap's China-hosted endpoint.
- Existing repository checks (protocol sync, lint, dead code, build, tests)
  stay green.
