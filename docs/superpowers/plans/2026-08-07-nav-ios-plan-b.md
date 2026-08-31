# Nav Plan B: iOS Relay Routing Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iOS navigation routes through the relay's Amap service ("导航去X" resolves identically on every platform) and the Swift guidance engine is reconciled to the canonical six-rule TS contract, so all clients guide identically.

**Architecture:** A new `RelayNavigationSearch` implements the (origin-widened) `NavigationRouteSearching` seam by sending `nav.request` over the agent socket and suspending on a single stored continuation until `nav.route`/`nav.error` arrives — which, because `NavigationController.perform()` already awaits the search and the dispatch site awaits `perform()`, holds `device.result` truthfully for free. Coordinates convert exactly once at the protocol edge (outgoing origin WGS-84→GCJ-02; every incoming route coordinate GCJ-02→WGS-84 — new Swift forward+inverse transforms, golden-vector tested); everything inside iOS stays WGS-84 and MapKit rendering is untouched. `GuidanceEngine.swift` is rewritten to the TS port contract (single along-route metric via literal-duplicated equirectangular snap, 30 m advance, prompt-before-advance, off-route freeze, sticky last-vertex arrival, TS prompt templates) with the TS test table ported as its proof, and the safety-critical playback interrupt re-keyed from the "现在" substring to threshold identity.

**Tech Stack:** Swift/SwiftUI/XCTest only (no server changes — the relay side shipped in Plan A). No new dependencies; MapKit remains for display, MKLocalSearch/MKDirections are deleted.

**Spec:** `docs/superpowers/specs/2026-08-06-amap-navigation-design.md` (§Architecture, §Coordinates "iOS: WGS-84 inside", §Per-client behavior "iOS").

**Governing ruling (supersedes one spec sentence):** the spec's Plan-A-era verification line "existing `GuidanceEngineTests` untouched and green" is SUPERSEDED by the later pinned ruling from the guidance-engine review cycle: `shared/guidance.ts`'s six-rule port contract is canonical, and the stale Swift engine (25 m straight-line advance, advance-before-prompt, cosmetic off-route, fixed templates) must be reconciled. The old Swift test table is REPLACED by a port of the TS table — that replacement is the new proof.

## Global Constraints

- The six-rule port contract (shared/guidance.ts:128-170) is binding verbatim: (1) single along-route metric for prompts AND advancement — no straight-line-to-coordinate metric anywhere in those paths; (2) prompt-before-advance within one fix; (3) off-route freezes `maneuverIndex`/`firedThresholds` and suppresses prompts; (4) sticky `arrived`, reset only by fresh progress; (5) snap tie-break = first segment in array order (strictly-smaller replacement); (6) arrival = straight-line haversine to the route's LAST POLYLINE VERTEX, evaluated regardless of off-route, sticky.
- Constants identical to TS: EARTH_RADIUS 6371008.8; OFF_ROUTE 50 m; ARRIVAL 30 m; MANEUVER_ADVANCE 30 m (changes from Swift's 25); thresholds far 400 / near 150 / now 40.
- Prompt templates identical to TS: far/near → `"前方\(Int((d / 50).rounded()) * 50)米，\(instruction)"` (live rounded distance, shared template); now → the bare instruction (no "现在，" prefix). Arrival line stays "已到达目的地。" (spoken by the controller, as today).
- The playback interrupt must key on threshold IDENTITY (`firedThreshold == .now` in the engine's update), never on prompt text — the TS templates removed the "现在" substring the current check greps for.
- The snap's cross-track math must literally duplicate `shared/guidance.ts`'s per-segment equirectangular projection (toLocal around the segment origin, clamped t) — sub-meter platform divergence at threshold boundaries is the failure mode.
- Datum edges: `nav.request.origin` = `wgs84ToGcj02(fix)`; EVERY `nav.route` coordinate (destination, every polyline vertex, every step) = `gcj02ToWgs84(...)` before entering `NavigationRoute`. Missing one field reintroduces the 100–600 m datum bug. Transform constants: A = 6378245, EE = 0.006693421622965943, outOfChina bounds identical to shared/geo.ts; inverse is iterative (5 rounds), round-trips < 1 m.
- Truthful results (unchanged semantics): resolution/plan failure → `.unsupported("route.unavailable")`; stop-with-nothing-active → `.failed("navigation.notActive")`; auth denied → `.denied("permission.location")`; exactly one `device.result` per command, held until the relay answers (free via the awaited chain).
- Pending-continuation hygiene (the awaitingReply lesson): the stored nav continuation MUST resolve on every path — answer, error, client-side 7 s timeout (under the relay's 8 s backstop), and session/socket teardown. A suspended-forever `perform()` Task is a leak and holds the device slot.
- Reroute discipline mirrors the web client: one in-flight reroute; 20 s cooldown from send time; reroute `nav.request` echoes the active route's destination + destinationName (GCJ-02 — round-trip the stored WGS values through `wgs84ToGcj02`).
- No MKDirections fallback of any kind — relay unreachable/timeout means an honest spoken failure (spec: fail-loud; a fallback would mask a broken relay and diverge routes across platforms).
- No server/shared/web changes in this plan (the protocol already carries nav.*; iOS's generated constants exist). No android/ or rdk/ changes.
- Build/test from `ios/`: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17'` (+ `-only-testing:MaxHelmetTests/<Class>` for scoped runs). New .swift files compile automatically; SourceKit standalone diagnostics are editor noise. Full iOS suite green at every task boundary; `npm run check` green at closeout (server untouched — it must stay green trivially).

---

### Task 1: Swift coordinate datum transforms (`CoordinateDatum.swift`)

**Files:**

- Create: `ios/MaxHelmet/Navigation/CoordinateDatum.swift`
- Test: `ios/MaxHelmetTests/CoordinateDatumTests.swift`

**Interfaces:**

- Produces (Tasks 3-4 rely on):

```swift
import CoreLocation

enum CoordinateDatum {
    /// WGS-84 → GCJ-02. Literal port of shared/geo.ts (A = 6378245,
    /// EE = 0.006693421622965943, same outOfChina bounds, same transform series).
    static func wgs84ToGcj02(_ coordinate: CLLocationCoordinate2D) -> CLLocationCoordinate2D

    /// GCJ-02 → WGS-84. Iterative inverse (5 rounds of cur -= forward(cur) - target);
    /// no closed form exists. Round-trips to < 1 m. iOS is the only platform that
    /// needs the inverse (routes arrive GCJ-02, everything inside speaks WGS-84).
    static func gcj02ToWgs84(_ coordinate: CLLocationCoordinate2D) -> CLLocationCoordinate2D
}
```

- [ ] **Step 1: Write the failing tests**

```swift
// ios/MaxHelmetTests/CoordinateDatumTests.swift
import CoreLocation
import XCTest
@testable import MaxHelmet

final class CoordinateDatumTests: XCTestCase {
    func testLeavesPointsOutsideChinaUntouched() {
        let tokyo = CLLocationCoordinate2D(latitude: 35.683861, longitude: 139.77492)
        let converted = CoordinateDatum.wgs84ToGcj02(tokyo)
        XCTAssertEqual(converted.latitude, tokyo.latitude)
        XCTAssertEqual(converted.longitude, tokyo.longitude)
        let inverse = CoordinateDatum.gcj02ToWgs84(tokyo)
        XCTAssertEqual(inverse.latitude, tokyo.latitude)
        XCTAssertEqual(inverse.longitude, tokyo.longitude)
    }

    func testMatchesThePublishedShanghaiVector() {
        // Same eviltransform vector tests/geo.test.ts pins for the TS forward transform.
        let gcj = CoordinateDatum.wgs84ToGcj02(CLLocationCoordinate2D(latitude: 31.1774276, longitude: 121.5272106))
        XCTAssertEqual(gcj.latitude, 31.17530398, accuracy: 1e-4)
        XCTAssertEqual(gcj.longitude, 121.53146073, accuracy: 1e-4)
    }

    func testInverseRoundTripsUnderOneMeter() {
        // 1e-5 degrees ≈ 1.1 m of latitude; require better on both axes.
        for wgs in [
            CLLocationCoordinate2D(latitude: 39.911954, longitude: 116.377817), // Beijing
            CLLocationCoordinate2D(latitude: 22.543847, longitude: 113.912316), // Shenzhen
            CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737) // Shanghai
        ] {
            let roundTripped = CoordinateDatum.gcj02ToWgs84(CoordinateDatum.wgs84ToGcj02(wgs))
            XCTAssertEqual(roundTripped.latitude, wgs.latitude, accuracy: 1e-5)
            XCTAssertEqual(roundTripped.longitude, wgs.longitude, accuracy: 1e-5)
        }
    }

    func testChinaOffsetIsPlausible() {
        // Degree-hypot bound matches tests/geo.test.ts (0.0009..0.008 — the upper
        // bound is a degree-hypot proxy, looser than a naive 700 m mapping).
        let wgs = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        let gcj = CoordinateDatum.wgs84ToGcj02(wgs)
        let offset = hypot(gcj.latitude - wgs.latitude, gcj.longitude - wgs.longitude)
        XCTAssertGreaterThan(offset, 0.0009)
        XCTAssertLessThan(offset, 0.008)
    }
}
```

- [ ] **Step 2: RED** — scoped xcodebuild run fails to compile (type missing).
- [ ] **Step 3: Implement** — port shared/geo.ts's `transformLat`/`transformLon`/forward literally; the inverse iterates `current = current - (forward(current) - target)` five times starting from the target. Header comment: why iOS alone owns the inverse (spec §Coordinates), and that the constants must never drift from shared/geo.ts.
- [ ] **Step 4: GREEN** — scoped run passes; then a full app `xcodebuild build`.
- [ ] **Step 5: Commit** — `git add ios/MaxHelmet/Navigation/CoordinateDatum.swift ios/MaxHelmetTests/CoordinateDatumTests.swift && git commit -m "feat(nav-ios): gcj-02 datum transforms with golden vectors"`

---

### Task 2: Guidance engine reconciliation to the six-rule contract

**Files:**

- Modify: `ios/MaxHelmet/Navigation/NavigationRoute.swift` (`ManeuverStep.distanceMeters` per-leg → `alongRouteMeters` cumulative, matching `NavManeuver`)
- Modify: `ios/MaxHelmet/Navigation/GuidanceEngine.swift` (rewrite to the contract)
- Modify: `ios/MaxHelmet/Navigation/Geo.swift` (add the equirectangular snap primitives — literal duplicates of shared/guidance.ts's `toLocal`/`nearestOnSegment`/snap loop)
- Modify: `ios/MaxHelmet/Navigation/NavigationController.swift` (interrupt keyed on `update.firedThreshold == .now`; handleFix consumes the new update shape)
- Modify: `ios/MaxHelmet/Navigation/RouteSearch.swift` (`MapKitNavigationSearch.convert` computes cumulative `alongRouteMeters` from MKRoute's per-leg distances so the app keeps working until Task 4 deletes it; `makeNavigationRoute` signature keeps up)
- Test: `ios/MaxHelmetTests/GuidanceEngineTests.swift` (REPLACED by the ported TS table), `ios/MaxHelmetTests/NavigationControllerTests.swift` (interrupt-identity case updated)

**Interfaces:**

- Produces:

```swift
struct ManeuverStep: Equatable {
    let instruction: String
    let coordinate: CLLocationCoordinate2D
    /// Cumulative along-route distance from the route start to this maneuver,
    /// matching NavManeuver.alongRouteMeters on the wire. NOT a per-leg length.
    let alongRouteMeters: Double
}

enum PromptThreshold: CaseIterable { case far, near, now } // meters 400 / 150 / 40

struct GuidanceUpdate {
    let progress: GuidanceProgress // maneuverIndex, firedThresholds (per current maneuver), arrived
    let distanceToManeuverMeters: Double // along-route
    let remainingMeters: Double // totalDistance − alongRoutePosition, floor 0
    let remainingSeconds: Double // etaSeconds × remaining/total
    let offRoute: Bool // cross-track > 50 m
    let arrived: Bool
    let spokenPrompt: String?
    let firedThreshold: PromptThreshold? // identity for the interrupt decision
    let currentInstruction: String?
}

// GuidanceEngine.step(position:route:progress:) -> GuidanceUpdate — pure; the
// port-contract comment from shared/guidance.ts:128-170 is reproduced (adapted
// wording) atop the function.
```

- `remaining()`/ETA are recomputed from the snapped along-route position (total − position), replacing the per-leg summation — the old summation dies with the per-leg field.
- NavigationController: `if update.firedThreshold == .now { interruptPlayback() }` replaces `prompt.contains("现在")`, with a comment naming the template change that made the substring check a silent-kill hazard.

- [ ] **Step 1: Write the failing tests** — replace GuidanceEngineTests.swift with a Swift port of `tests/guidance.test.ts`'s table, same coordinate literals (route north along lon 121.47 from lat 31.23 to 31.24; maneuver "右转" at 31.235 / alongRouteMeters 555; destination step "到达终点" at 31.24 / 1109; etaSeconds 240):
  - haversine ≈ 1109 m across the route (accuracy −1 digit).
  - first fix at 31.23: distanceToManeuver in (540, 570), no prompt, offRoute false, currentInstruction "右转".
  - far→near→now fire once each at 31.2320 / 31.2340 / 31.2348 with the TS templates (`前方350米，右转` / `前方100米，右转` / bare `右转` — assert via regex `^前方\d+米，右转$` for far/near and equality for now), null between thresholds; `firedThreshold` identity matches (.far/.near/.now/nil).
  - the now-fix at 31.2348 BOTH speaks and advances (prompt-before-advance): spokenPrompt "右转" AND progress.maneuverIndex == 1 in the same update.
  - off-route at (31.2320, 121.4710): offRoute true, no prompt, and — with along-route position past the maneuver at (31.2360, 121.4710) — maneuverIndex stays put and firedThresholds carry through (freeze).
  - arrival within 30 m of the LAST POLYLINE VERTEX (31.2399) sets sticky arrived; a later far-away fix keeps arrived true.
  - remaining/ETA scaling at 31.235: remaining ∈ (520, 590), seconds ∈ (110, 130).
    Update NavigationControllerTests: the interrupt case asserts `interrupts == 1` when the engine reports `.now` identity even though the spoken text is the bare instruction (no 现在 substring).
- [ ] **Step 2: RED** — the new table fails against the old engine (metric, radius, ordering, templates all differ).
- [ ] **Step 3: Implement** — Geo.swift gains `localXY(of:around:)` (equirectangular: x = Δlon·R·cos(originLat), y = Δlat·R — literal port), `nearestOnSegment` (clamped t), and the snap loop (strictly-smaller replacement, cumulative along-route). GuidanceEngine rewritten: snap → cross-track/offRoute → arrival (last vertex, sticky, unconditional) → if !offRoute { prompts (pre-advance distance, once per maneuver) then advancement (along-route ≤ 30 OR position past alongRouteMeters) } → remaining/ETA from position. MapKitNavigationSearch.convert accumulates MKRoute step distances into cumulative alongRouteMeters.
- [ ] **Step 4: GREEN** — GuidanceEngineTests + NavigationControllerTests + RouteSearchTests scoped, then the FULL iOS suite.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav-ios): reconcile the guidance engine to the six-rule contract"`

---

### Task 3: Wire layer — nav.route/nav.error parsing + buildNavRequest

**Files:**

- Modify: `ios/MaxHelmet/Agent/AgentProtocol.swift` (AgentEvent cases, parse cases, builder)
- Test: `ios/MaxHelmetTests/NavProtocolTests.swift` (create)

**Interfaces:**

- Produces (Task 4 relies on):

```swift
struct NavRouteData: Equatable {
    let commandId: String
    let destinationName: String
    let destination: CLLocationCoordinate2D // GCJ-02 as received — conversion is Task 4's edge
    let polyline: [CLLocationCoordinate2D] // GCJ-02
    let steps: [ManeuverStep] // GCJ-02 coordinates, cumulative alongRouteMeters
    let distanceMeters: Double
    let etaSeconds: Double
}
// AgentEvent cases: case navRoute(NavRouteData), case navError(commandId: String, code: String)
// parseAgentEvent: `case ServerEventTypes.navRoute` builds NavRouteData (lat/lon dictionaries →
// CLLocationCoordinate2D; steps' instruction/lat/lon/alongRouteMeters); malformed → .unhandled.
// func buildNavRequest(commandId: String, reason: String, originLat: Double, originLon: Double,
//                      query: String?, destinationLat: Double?, destinationLon: Double?,
//                      destinationName: String?) -> String
//   — JSONSerialization like buildCrashAlert; nil optionals omitted; origin as {lat, lon}.
```

- [ ] **Step 1: Write the failing tests** — NavProtocolTests: parse a full nav.route JSON (2 steps, 3 polyline points) into NavRouteData field-by-field; parse nav.error; malformed nav.route (missing polyline) → .unhandled; buildNavRequest start-shape (no destination keys present) and reroute-shape (destination + destinationName present, no query key) verified via JSONSerialization round-trip, matching the schema's required fields.
- [ ] **Step 2: RED** (cases missing). **Step 3: Implement.** **Step 4: GREEN** scoped + full build.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav-ios): parse nav.route and build nav.request"`

---

### Task 4: RelayNavigationSearch + seam change + AgentSession wiring

**Files:**

- Modify: `ios/MaxHelmet/Navigation/RouteSearch.swift` (protocol gains origin: `route(to query: String, from origin: CLLocationCoordinate2D) async -> NavigationRoute?`; DELETE `MapKitNavigationSearch` + the MKLocalSearch/MKDirections imports; `makeNavigationRoute` stays as the pure assembler)
- Create: `ios/MaxHelmet/Navigation/RelayNavigationSearch.swift`
- Modify: `ios/MaxHelmet/Navigation/NavigationController.swift` (obtain the first fix BEFORE searching: start the stream, await the first fix with a bounded 3 s wait via the existing continuation idiom; no fix in time → `.unsupported("route.unavailable")`; pass the fix as origin; reroute path already has origin)
- Modify: `ios/MaxHelmet/Agent/AgentSession.swift` (construct `RelayNavigationSearch` with the CrashController-style send closure; register it in the deviceRouter's `.navigation` entry replacing `MapKitNavigationSearch()`; forward `.navRoute`/`.navError` events to it; call `relayNavigationSearch.failPending()` from the socket-teardown/disconnect path — the awaitingReply lesson: a dead socket delivers no route)
- Test: `ios/MaxHelmetTests/RelayNavigationSearchTests.swift` (create), `ios/MaxHelmetTests/NavigationControllerTests.swift` (extend: held-ordering + no-fix case)

**Interfaces:**

- Produces:

```swift
final class RelayNavigationSearch: NavigationRouteSearching {
    init(send: @escaping (String) -> Void,
         timeoutSeconds: Double = 7, // under the relay's 8 s device backstop
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime })

    // NavigationRouteSearching:
    func route(to query: String, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute?

    // AgentSession forwards relay answers here:
    func handleNavRoute(_ data: NavRouteData)
    func handleNavError(commandId: String, code: String)
    /// Socket teardown: resolve any suspended request as nil (spoken failure),
    /// never leave perform() hanging.
    func failPending()
}
```

Behavior (binding):

- `route(to:from:)`: synthesize `commandId = "nav-" + UUID().uuidString`; store a single continuation keyed by that id (a second concurrent call fails the first with nil before proceeding — single-outstanding, like the web client); `send(buildNavRequest(commandId:, reason: "start", origin: wgs84ToGcj02(origin), query: query, ...))`; suspend; on `handleNavRoute` with matching id → convert EVERY coordinate `gcj02ToWgs84` (destination, polyline vertices, step coordinates), build `NavigationRoute` via `makeNavigationRoute` (name/destination/polyline/steps with cumulative alongRouteMeters/distanceMeters/etaSeconds) → resume with it; `handleNavError`/timeout/`failPending` → resume nil. The stored destinationName + WGS destination let reroutes echo GCJ values later.
- `reroute(to:from:)` mirrors it with `reason: "reroute"`, converting BOTH origin and the echoed destination WGS→GCJ, carrying the remembered destinationName. NavigationController's existing 20 s reroute debounce is preserved (verify it matches the web's 20 s from-send cooldown; align the constant if it differs, noting the change).
- Timeout via a detached watchdog Task cancelled on resume; every resume path nils the stored continuation exactly once (double-resume is a crash in Swift — guard it).
- Mirror the datum edge in tests with a GCJ fixture: a nav.route whose GCJ coordinates convert to known WGS values (use the Task 1 vectors: feed `wgs84ToGcj02(known)` as the wire payload, assert the built route's coordinates ≈ known within 1e-5°).

- [ ] **Step 1: Write the failing tests.** Contracts (real code against the existing harness idioms — FakeStream/Box from NavigationControllerTests; a captured `send` closure + direct `handleNavRoute` calls for RelayNavigationSearchTests):
  - RelayNavigationSearchTests: start sends a nav.request whose JSON has reason start, GCJ origin (assert shifted vs the WGS input), a query, and no destination keys; a matching handleNavRoute resumes with a route whose every coordinate round-tripped to WGS (≈ known, 1e-5); handleNavError resumes nil; a MISMATCHED commandId is ignored (continuation stays suspended, then times out to nil — use a short injected timeout); failPending resumes nil; a second route() call while one is pending fails the first with nil.
  - NavigationControllerTests additions: (held ordering) a suspended fake search proves no result exists until the fake resolves — mirror the web's "requests, then acks ok only after nav.route arrives"; (no fix) a FakeStream that never feeds a fix → `.unsupported("route.unavailable")` within the bounded wait; (reroute echo) the reroute call passes the stored destination.
- [ ] **Step 2: RED.** **Step 3: Implement** (search class, protocol change + its one NavigationController call site, first-fix flow, AgentSession wiring + teardown hook, MapKit deletion). **Step 4: GREEN** scoped, then the FULL iOS suite.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav-ios): route through the relay with datum-converted edges"`

---

### Task 5: Closeout — gates, README, audit

- [ ] **Step 1: README** — update the iOS navigation bullet: routing now relay-side (Amap driving data, GCJ-02 on the wire, WGS-84 in the app), destinations resolve identically across platforms, keyless mock routes work end-to-end, guidance semantics now shared verbatim with web (the six-rule contract), honest limits kept (car profile; 摩托车禁行 still not respected; no MKDirections fallback — relay down means a spoken failure).
- [ ] **Step 2: Gates** — FULL iOS suite green; `npm run check` exit 0 (server untouched — a failure means an accidental cross-boundary edit).
- [ ] **Step 3: Commit** — `docs(nav-ios): document relay routing and shared guidance semantics`.
- [ ] **Step 4: Audit** — `git log --oneline main..HEAD`: ios/-only (plus this plan doc); no server/, shared/, src/, android/, rdk/ changes; MKLocalSearch/MKDirections imports gone from the tree (`grep -r MKDirections ios/MaxHelmet` → empty).

---

## Deferred (explicit)

- Android navigation (Plan C — the Kotlin engine port consumes the same six-rule contract and this plan's Swift port as its second reference).
- On-road datum verification (rider position sits ON the polyline, not 100–600 m beside it) — the spec's manual-verification section; joins the hardware bench list.
- Amap motorcycle-profile routing (paid 商务 approval; the provider seam is its home).
