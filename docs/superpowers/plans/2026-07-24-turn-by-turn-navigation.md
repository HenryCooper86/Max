# In-App Turn-by-Turn Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Spec 1's static destination card into live guidance — "导航去X" auto-starts route matching, distance-timed spoken maneuver prompts, one debounced reroute per wrong turn, and arrival, all in-app so the device-action layer keeps working.

**Architecture:** A pure `GuidanceEngine` holds all route math and prompt-timing decisions (unit-tested from lat/lon literals). A `NavigationController` (a `DeviceActionHandler`) owns a continuous `CLLocationManager` stream, the active `NavigationRoute`, reroute/arrival lifecycle, and speech, driving the engine on each fix and publishing a `GuidanceState` that the `GuidanceCard` renders. New `navigation.start`/`navigation.stop` grammar replaces `destination.show` in the relay grammar.

**Tech Stack:** TypeScript + Express + `ws` + Vitest (relay); Swift + SwiftUI + CoreLocation + MapKit + XCTest (iOS). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-24-turn-by-turn-navigation-design.md`

## Global Constraints

- New branch `feat/turn-by-turn-nav`, cut from `main`.
- No new npm or SwiftPM dependencies. The iOS target keeps zero third-party deps.
- Every command resolves to exactly one `device.result`. Silence is a bug.
- `navigation.start` and `navigation.stop` are **low tier** (execute immediately with a spoken confirmation).
- Guidance is a **foreground-session** feature using the existing **WhenInUse** authorization — no `location` background mode, no new Info.plist key.
- Engine thresholds are fixed: off-route **50 m**, arrival **30 m**, maneuver-reached **25 m**, prompt distances **far 400 m / near 150 m / now 40 m**.
- Reroute is debounced — one per off-route excursion, cooldown **15 s**.
- MapKit is **automobile-only**; the spoken summary must not imply a motorcycle-validated route.
- Benign `navigation.stop` with nothing active returns `failed("navigation.notActive")`, so Spec 1's reconciliation speaks the benign line.
- Chinese is the default spoken language; every rider-facing string added here is Chinese.
- New Swift files go in `ios/MaxHelmet/Navigation/`. `AgentSession.swift` only forwards and wires.
- `protocol/agent-events.schema.json` is the source of truth; never hand-edit the three generated files.
- Run `npm run check` before the final commit of any server task.

**Server test:** `npx vitest run tests/<file>` · **Full gate:** `npm run check`

**iOS test:**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

If the run aborts with a spurious `xcrun: error: unable to find utility "simctl"`, boot the simulator first (`xcrun simctl bootstatus "iPhone 17 Pro" -b`) and re-run against `-destination 'platform=iOS Simulator,id=<booted-udid>'`.

---

### Task 1: Server — navigation grammar

**Files:**

- Modify: `server/device-actions.ts`
- Modify: `server/providers/mock.ts`
- Modify: `tests/device-actions.test.ts`

**Interfaces:**

- Consumes: the existing `DeviceCommand` union, `DeviceActionName`, `DEVICE_ACTION_TIERS`, `ACTION_LABELS`, `FAILURE_SPEECH`, `extractDeviceCommand`, and `matchDestination` in `server/device-actions.ts`.
- Produces: `navigation.start` (`{ query: string }`) and `navigation.stop` recognized by `extractDeviceCommand`, tiered `low`, labelled, with `navigation.notActive` and `permission.location` failure-speech keys. `matchDestination` is replaced by `matchNavigation`.

- [ ] **Step 1: Write the failing test**

Append to `tests/device-actions.test.ts`:

```ts
describe("extractDeviceCommand — navigation", () => {
  it("starts guidance in Chinese and English", () => {
    expect(extractDeviceCommand("Max 导航去天安门")).toEqual({ action: "navigation.start", args: { query: "天安门" } });
    expect(extractDeviceCommand("Max 带我去公司")).toEqual({ action: "navigation.start", args: { query: "公司" } });
    expect(extractDeviceCommand("Max navigate to the airport")).toEqual({
      action: "navigation.start",
      args: { query: "the airport" }
    });
  });

  it("stops guidance, checked before start so 停止导航 is not a destination", () => {
    expect(extractDeviceCommand("Max 停止导航")).toEqual({ action: "navigation.stop", args: {} });
    expect(extractDeviceCommand("Max 取消导航")).toEqual({ action: "navigation.stop", args: {} });
    expect(extractDeviceCommand("Max stop navigation")).toEqual({ action: "navigation.stop", args: {} });
  });

  it("no longer emits destination.show for navigation phrasing", () => {
    expect(extractDeviceCommand("Max 导航去天安门")?.action).not.toBe("destination.show");
  });
});
```

Extend the `DEVICE_ACTION_TIERS` test's expected object to include the two new keys:

```ts
      "gallery.open": "low",
      "navigation.start": "low",
      "navigation.stop": "low"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: FAIL — navigation utterances return `null` or `destination.show`.

- [ ] **Step 3: Extend the types and tables**

In `server/device-actions.ts`, add to the `DeviceActionName` union:

```ts
  | "navigation.start"
  | "navigation.stop"
```

Add to the `DeviceCommand` union:

```ts
  | { action: "navigation.start"; args: { query: string } }
  | { action: "navigation.stop"; args: Record<string, never> }
```

Add to `DEVICE_ACTION_TIERS`:

```ts
  "navigation.start": "low",
  "navigation.stop": "low"
```

Add to `ACTION_LABELS`:

```ts
  "navigation.start": "导航",
  "navigation.stop": "导航"
```

Add to `FAILURE_SPEECH`:

```ts
  "navigation.notActive": "现在没有在导航。",
  "permission.location": "我没有定位权限，去设置里开启后我再帮你导航。"
```

- [ ] **Step 4: Replace the destination matcher with a navigation matcher**

In `server/device-actions.ts`, replace the call site — change:

```ts
const destination = matchDestination(raw);
if (destination) return destination;
```

to:

```ts
const navigation = matchNavigation(raw);
if (navigation) return navigation;
```

Replace the whole `matchDestination` function with:

```ts
function matchNavigation(raw: string): DeviceCommand | null {
  // Stop is checked before start so "停止导航" is never read as a destination.
  if (/(停止|结束|取消|退出)\s*导航/.test(raw) || /stop\s+(the\s+)?navigation/i.test(raw)) {
    return { action: "navigation.stop", args: {} };
  }
  const zh = /(?:导航|带我|我要)\s*(?:去|到|回)\s*(?<query>.+)/.exec(raw);
  if (zh?.groups?.query) {
    const query = clean(zh.groups.query);
    if (query) return { action: "navigation.start", args: { query } };
  }
  const en = /(?:navigate|directions|take me|route)\s+to\s+(?<query>.+)/i.exec(raw);
  if (en?.groups?.query) {
    const query = clean(en.groups.query);
    if (query) return { action: "navigation.start", args: { query } };
  }
  return null;
}
```

`destination.show` stays in the `DeviceActionName`/`DeviceCommand`/`DEVICE_ACTION_TIERS`/`ACTION_LABELS` for back-compat; the grammar simply no longer emits it.

- [ ] **Step 5: Update the mock demo line**

In `server/providers/mock.ts`, the `commute` scenario's first turn is a navigation-flavored line. Replace:

```ts
      { rider: "帮我找最快回家路线。", agent: "已设置最快回家路线。3.2 公里后靠右下出口。", latencyBase: 96 },
```

with:

```ts
      { rider: "Max，导航去公司", agent: "好的，开始导航，全程约 3 公里。", latencyBase: 96 },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/device-actions.ts server/providers/mock.ts tests/device-actions.test.ts
git commit -m "feat(actions): add navigation grammar"
```

---

### Task 2: Server — protocol schema and grounding prompt

**Files:**

- Modify: `protocol/agent-events.schema.json`
- Modify: `server/providers/doubao.ts` (`buildToolGroundingPrompt`)
- Modify: `tests/device-grounding.test.ts`
- Regenerated (do not hand-edit): `shared/generated/agent-protocol.ts`, `android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`

**Interfaces:**

- Consumes: the `device.command` `action` enum in the schema; `buildToolGroundingPrompt` in `doubao.ts`.
- Produces: `navigation.start`, `navigation.stop` as valid wire actions; a grounding prompt naming 导航.

- [ ] **Step 1: Write the failing test**

Append to `tests/device-grounding.test.ts`, inside the `buildToolGroundingPrompt` describe block:

```ts
it("declares live navigation", () => {
  expect(prompt).toContain("导航");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-grounding.test.ts`
Expected: FAIL — prompt lacks 导航.

- [ ] **Step 3: Extend the schema action enum**

In `protocol/agent-events.schema.json`, change the `DeviceCommand` `action` enum to include the two new actions at the end of the array:

```json
              "enum": ["torch.set", "volume.set", "music.control", "sms.compose", "call.dial", "destination.show", "camera.photo", "camera.record", "gallery.open", "navigation.start", "navigation.stop"]
```

- [ ] **Step 4: Regenerate the contracts**

Run: `npm run generate:protocol`
Expected: three `Generated …` lines.

- [ ] **Step 5: Update the grounding prompt**

In `server/providers/doubao.ts`, in `buildToolGroundingPrompt`, replace:

```ts
    "控制 Apple Music 和本机音乐的播放、准备短信、拨打电话、查询目的地并显示路线卡片、拍照和录像（录像无声音）。" +
```

with:

```ts
    "控制 Apple Music 和本机音乐的播放、准备短信、拨打电话、语音导航（实时路线指引，仅汽车路线）、拍照和录像（录像无声音）。" +
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/device-grounding.test.ts tests/device-protocol.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add protocol/agent-events.schema.json shared/generated/agent-protocol.ts \
  android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt \
  ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift server/providers/doubao.ts tests/device-grounding.test.ts
git commit -m "feat(protocol): add navigation actions and declare them to Max"
```

---

### Task 3: iOS — decode navigation actions

**Files:**

- Modify: `ios/MaxHelmet/Agent/AgentProtocol.swift` (`DeviceAction`, `parseDeviceAction`)
- Modify: `ios/MaxHelmet/Actions/DeviceActionHandler.swift` (`DeviceActionRoute`)
- Modify: `ios/MaxHelmetTests/AgentProtocolTests.swift`

**Interfaces:**

- Consumes: `DeviceAction`, `parseDeviceAction`, `DeviceActionRoute` from Spec 1.
- Produces: `DeviceAction.navigationStart(query: String)`, `.navigationStop`; a `.navigation` route to which `navigationStart` and `navigationStop` map. `destinationShow` keeps its existing `.destination` route for now (consolidated in Task 10).

- [ ] **Step 1: Write the failing test**

Append to `ios/MaxHelmetTests/AgentProtocolTests.swift`:

```swift
    func testParsesNavigationStartCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"n1","action":"navigation.start","args":{"query":"天安门"},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .navigationStart(query: "天安门"))
    }

    func testParsesNavigationStopCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"n2","action":"navigation.stop","args":{},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .navigationStop)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `type 'DeviceAction' has no member 'navigationStart'`.

- [ ] **Step 3: Add the enum cases and decoding**

In `ios/MaxHelmet/Agent/AgentProtocol.swift`, add to `enum DeviceAction` (after `destinationShow`):

```swift
    case navigationStart(query: String)
    case navigationStop
```

Add to `parseDeviceAction`, before `default:`:

```swift
    case "navigation.start":
        guard let query = args["query"] as? String, !query.isEmpty else { return nil }
        return .navigationStart(query: query)
    case "navigation.stop":
        return .navigationStop
```

- [ ] **Step 4: Add the route**

In `ios/MaxHelmet/Actions/DeviceActionHandler.swift`, add `case navigation` to `DeviceActionRoute`, and to its `init(_:)` switch add:

```swift
        case .navigationStart, .navigationStop: self = .navigation
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentProtocol.swift ios/MaxHelmet/Actions/DeviceActionHandler.swift \
  ios/MaxHelmetTests/AgentProtocolTests.swift
git commit -m "feat(ios): decode navigation actions"
```

---

### Task 4: iOS — route and guidance-state models

**Files:**

- Create: `ios/MaxHelmet/Navigation/NavigationRoute.swift`
- Create: `ios/MaxHelmetTests/NavigationRouteTests.swift`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ManeuverStep`, `NavigationRoute`, `GuidanceState` (all `Equatable`), and `coordinatesEqual(_:_:)`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/NavigationRouteTests.swift`:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

final class NavigationRouteTests: XCTestCase {

    func testCoordinatesEqualityTolerance() {
        let a = CLLocationCoordinate2D(latitude: 39.9, longitude: 116.4)
        let b = CLLocationCoordinate2D(latitude: 39.9, longitude: 116.4)
        let c = CLLocationCoordinate2D(latitude: 39.9, longitude: 116.5)
        XCTAssertTrue(coordinatesEqual(a, b))
        XCTAssertFalse(coordinatesEqual(a, c))
    }

    func testRouteAndStepAreEquatable() {
        let step = ManeuverStep(instruction: "右转", coordinate: .init(latitude: 39.9, longitude: 116.4), distanceMeters: 200)
        let route = NavigationRoute(
            destinationName: "天安门",
            destinationCoordinate: .init(latitude: 39.9087, longitude: 116.3975),
            polyline: [.init(latitude: 39.90, longitude: 116.40), .init(latitude: 39.91, longitude: 116.40)],
            steps: [step],
            totalDistanceMeters: 1200,
            totalEtaSeconds: 300
        )
        XCTAssertEqual(route, route)
        XCTAssertEqual(step, step)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'NavigationRoute' in scope`.

- [ ] **Step 3: Write the models**

Create `ios/MaxHelmet/Navigation/NavigationRoute.swift`:

```swift
import CoreLocation

/// Two coordinates are equal within ~1 m — CLLocationCoordinate2D is not
/// Equatable and exact float comparison is fragile.
func coordinatesEqual(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Bool {
    abs(a.latitude - b.latitude) < 1e-5 && abs(a.longitude - b.longitude) < 1e-5
}

/// One turn on the route: what to do, where, and how long this step runs.
struct ManeuverStep: Equatable {
    let instruction: String
    let coordinate: CLLocationCoordinate2D
    let distanceMeters: Double

    static func == (lhs: ManeuverStep, rhs: ManeuverStep) -> Bool {
        lhs.instruction == rhs.instruction
            && coordinatesEqual(lhs.coordinate, rhs.coordinate)
            && lhs.distanceMeters == rhs.distanceMeters
    }
}

/// The full route the engine needs — the geometry and turn list MapKit hands us
/// and Spec 1 threw away.
struct NavigationRoute: Equatable {
    let destinationName: String
    let destinationCoordinate: CLLocationCoordinate2D
    let polyline: [CLLocationCoordinate2D]
    let steps: [ManeuverStep]
    let totalDistanceMeters: Double
    let totalEtaSeconds: Double

    static func == (lhs: NavigationRoute, rhs: NavigationRoute) -> Bool {
        lhs.destinationName == rhs.destinationName
            && coordinatesEqual(lhs.destinationCoordinate, rhs.destinationCoordinate)
            && lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy { coordinatesEqual($0, $1) }
            && lhs.steps == rhs.steps
            && lhs.totalDistanceMeters == rhs.totalDistanceMeters
            && lhs.totalEtaSeconds == rhs.totalEtaSeconds
    }
}

/// What the guidance card renders. Published on the session state.
struct GuidanceState: Equatable {
    let destinationName: String
    let polyline: [CLLocationCoordinate2D]
    var currentLocation: CLLocationCoordinate2D?
    var maneuverInstruction: String?
    var distanceToManeuverMeters: Double
    var remainingDistanceMeters: Double
    var remainingSeconds: Double
    var offRoute: Bool

    static func == (lhs: GuidanceState, rhs: GuidanceState) -> Bool {
        lhs.destinationName == rhs.destinationName
            && lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy { coordinatesEqual($0, $1) }
            && optionalCoordinatesEqual(lhs.currentLocation, rhs.currentLocation)
            && lhs.maneuverInstruction == rhs.maneuverInstruction
            && lhs.distanceToManeuverMeters == rhs.distanceToManeuverMeters
            && lhs.remainingDistanceMeters == rhs.remainingDistanceMeters
            && lhs.remainingSeconds == rhs.remainingSeconds
            && lhs.offRoute == rhs.offRoute
    }
}

private func optionalCoordinatesEqual(_ a: CLLocationCoordinate2D?, _ b: CLLocationCoordinate2D?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case let (l?, r?): return coordinatesEqual(l, r)
    default: return false
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Navigation/NavigationRoute.swift ios/MaxHelmetTests/NavigationRouteTests.swift
git commit -m "feat(ios): add navigation route and guidance-state models"
```

---

### Task 5: iOS — geometry helpers

**Files:**

- Create: `ios/MaxHelmet/Navigation/Geo.swift`
- Create: `ios/MaxHelmetTests/GeoTests.swift`

**Interfaces:**

- Consumes: `CLLocationCoordinate2D`.
- Produces: `enum Geo` with `haversineMeters(_:_:)`, `crossTrackMeters(point:segStart:segEnd:)`, `nearestSegmentDistance(_:_:)`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/GeoTests.swift`:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

final class GeoTests: XCTestCase {

    func testHaversineKnownDistance() {
        // ~111 km per degree of latitude.
        let a = CLLocationCoordinate2D(latitude: 39.0, longitude: 116.0)
        let b = CLLocationCoordinate2D(latitude: 40.0, longitude: 116.0)
        XCTAssertEqual(Geo.haversineMeters(a, b), 111_195, accuracy: 500)
    }

    func testCrossTrackDistanceToSegment() {
        // A point due east of the midpoint of a north-south segment.
        let start = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)
        let end = CLLocationCoordinate2D(latitude: 39.92, longitude: 116.40)
        let point = CLLocationCoordinate2D(latitude: 39.91, longitude: 116.401) // ~85 m east
        let d = Geo.crossTrackMeters(point: point, segStart: start, segEnd: end)
        XCTAssertEqual(d, 85, accuracy: 25)
    }

    func testCrossTrackClampsToSegmentEnds() {
        // A point beyond the segment end measures to the endpoint, not the line.
        let start = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)
        let end = CLLocationCoordinate2D(latitude: 39.91, longitude: 116.40)
        let beyond = CLLocationCoordinate2D(latitude: 39.93, longitude: 116.40)
        let d = Geo.crossTrackMeters(point: beyond, segStart: start, segEnd: end)
        XCTAssertEqual(d, Geo.haversineMeters(beyond, end), accuracy: 5)
    }

    func testNearestSegmentDistanceOverPolyline() {
        let polyline = [
            CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40),
            CLLocationCoordinate2D(latitude: 39.90, longitude: 116.42),
            CLLocationCoordinate2D(latitude: 39.92, longitude: 116.42)
        ]
        let near = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.41) // on first segment
        XCTAssertLessThan(Geo.nearestSegmentDistance(near, polyline), 20)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'Geo' in scope`.

- [ ] **Step 3: Write the geometry**

Create `ios/MaxHelmet/Navigation/Geo.swift`:

```swift
import CoreLocation
import Foundation

/// Pure geodesy for the guidance engine. Small distances only (a route), so a
/// local equirectangular projection is accurate enough and much cheaper than
/// full spherical trig for the cross-track case.
enum Geo {
    private static let earthRadius = 6_371_000.0

    static func haversineMeters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * earthRadius * asin(min(1, sqrt(h)))
    }

    /// Shortest distance from `point` to the segment [segStart, segEnd], clamped
    /// to the endpoints (so a point beyond the segment measures to the endpoint).
    static func crossTrackMeters(
        point p: CLLocationCoordinate2D,
        segStart a: CLLocationCoordinate2D,
        segEnd b: CLLocationCoordinate2D
    ) -> Double {
        let latRef = a.latitude * .pi / 180
        func xy(_ c: CLLocationCoordinate2D) -> (Double, Double) {
            let x = (c.longitude - a.longitude) * .pi / 180 * cos(latRef) * earthRadius
            let y = (c.latitude - a.latitude) * .pi / 180 * earthRadius
            return (x, y)
        }
        let (px, py) = xy(p)
        let (bx, by) = xy(b) // a is the origin
        let segLenSq = bx * bx + by * by
        if segLenSq == 0 { return sqrt(px * px + py * py) }
        var t = (px * bx + py * by) / segLenSq
        t = max(0, min(1, t))
        let dx = px - t * bx
        let dy = py - t * by
        return sqrt(dx * dx + dy * dy)
    }

    /// Nearest distance from `point` to any segment of the polyline.
    static func nearestSegmentDistance(_ point: CLLocationCoordinate2D, _ polyline: [CLLocationCoordinate2D]) -> Double {
        guard polyline.count >= 2 else {
            return polyline.first.map { haversineMeters(point, $0) } ?? .infinity
        }
        var best = Double.infinity
        for i in 0..<(polyline.count - 1) {
            best = min(best, crossTrackMeters(point: point, segStart: polyline[i], segEnd: polyline[i + 1]))
        }
        return best
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Navigation/Geo.swift ios/MaxHelmetTests/GeoTests.swift
git commit -m "feat(ios): add navigation geometry helpers"
```

---

### Task 6: iOS — the guidance engine

**Files:**

- Create: `ios/MaxHelmet/Navigation/GuidanceEngine.swift`
- Create: `ios/MaxHelmetTests/GuidanceEngineTests.swift`

**Interfaces:**

- Consumes: `NavigationRoute`, `ManeuverStep` (Task 4); `Geo` (Task 5).
- Produces: `enum PromptThreshold`, `struct GuidanceProgress`, `struct GuidanceUpdate`, `enum GuidanceEngine` with `static func step(location:route:progress:) -> GuidanceUpdate` and the threshold/arrival/off-route constants.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/GuidanceEngineTests.swift`:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

final class GuidanceEngineTests: XCTestCase {

    // A straight north-bound route with one right turn ~1 km north.
    private func route() -> NavigationRoute {
        let turn = CLLocationCoordinate2D(latitude: 39.9090, longitude: 116.40)
        return NavigationRoute(
            destinationName: "终点",
            destinationCoordinate: CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40),
            polyline: [
                CLLocationCoordinate2D(latitude: 39.9000, longitude: 116.40),
                turn,
                CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
            ],
            steps: [
                ManeuverStep(instruction: "右转", coordinate: turn, distanceMeters: 1000),
                ManeuverStep(instruction: "到达终点", coordinate: CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40), distanceMeters: 1000)
            ],
            totalDistanceMeters: 2000,
            totalEtaSeconds: 400
        )
    }

    private func fresh() -> GuidanceProgress {
        GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    }

    // ~0.001 deg latitude ≈ 111 m.
    private func lat(_ metersNorthOf: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: 39.9090 - metersNorthOf / 111_000, longitude: 116.40)
    }

    func testNoPromptWhenFarFromManeuver() {
        let update = GuidanceEngine.step(location: lat(800), route: route(), progress: fresh())
        XCTAssertNil(update.spokenPrompt)
        XCTAssertFalse(update.offRoute)
        XCTAssertFalse(update.progress.arrived)
    }

    func testFarPromptFiresOnceWhenCrossing400() {
        let first = GuidanceEngine.step(location: lat(390), route: route(), progress: fresh())
        XCTAssertEqual(first.spokenPrompt, "前方400米，右转")
        XCTAssertTrue(first.progress.firedThresholds.contains(.far))

        let second = GuidanceEngine.step(location: lat(380), route: route(), progress: first.progress)
        XCTAssertNil(second.spokenPrompt, "far must not re-fire")
    }

    func testNearAndNowPromptsFire() {
        var progress = fresh()
        progress.firedThresholds = [.far]
        let near = GuidanceEngine.step(location: lat(140), route: route(), progress: progress)
        XCTAssertEqual(near.spokenPrompt, "150米后，右转")

        let now = GuidanceEngine.step(location: lat(30), route: route(), progress: near.progress)
        XCTAssertEqual(now.spokenPrompt, "现在，右转")
    }

    func testAdvancesPastAManeuver() {
        // At the turn coordinate, index advances to the next maneuver.
        let update = GuidanceEngine.step(location: lat(0), route: route(), progress: fresh())
        XCTAssertEqual(update.progress.maneuverIndex, 1)
        XCTAssertEqual(update.progress.firedThresholds, [])
    }

    func testDetectsOffRoute() {
        // ~120 m east of the route line.
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4014)
        let update = GuidanceEngine.step(location: off, route: route(), progress: fresh())
        XCTAssertTrue(update.offRoute)
    }

    func testDetectsArrival() {
        let atDest = CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
        let update = GuidanceEngine.step(location: atDest, route: route(), progress: GuidanceProgress(maneuverIndex: 1, firedThresholds: [], arrived: false))
        XCTAssertTrue(update.progress.arrived)
        XCTAssertEqual(update.spokenPrompt, "已到达目的地。")
    }

    func testRemainingEtaScalesWithDistance() {
        let far = GuidanceEngine.step(location: lat(900), route: route(), progress: fresh())
        let near = GuidanceEngine.step(location: lat(100), route: route(), progress: fresh())
        XCTAssertGreaterThan(far.remainingSeconds, near.remainingSeconds)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'GuidanceEngine' in scope`.

- [ ] **Step 3: Write the engine**

Create `ios/MaxHelmet/Navigation/GuidanceEngine.swift`:

```swift
import CoreLocation
import Foundation

/// Distance bands at which a maneuver is announced. Each fires once per maneuver.
enum PromptThreshold: CaseIterable {
    case far, near, now

    var distanceMeters: Double {
        switch self {
        case .far: return 400
        case .near: return 150
        case .now: return 40
        }
    }
}

/// The mutable state the engine advances across fixes.
struct GuidanceProgress: Equatable {
    var maneuverIndex: Int
    var firedThresholds: Set<PromptThreshold>
    var arrived: Bool
}

/// The engine's output for one fix.
struct GuidanceUpdate: Equatable {
    var progress: GuidanceProgress
    var distanceToManeuverMeters: Double
    var remainingDistanceMeters: Double
    var remainingSeconds: Double
    var offRoute: Bool
    var spokenPrompt: String?
}

/// Pure route math and prompt timing — no I/O, no CoreLocation manager. Every
/// decision the rider's safety depends on lives here, so it can be table-tested.
enum GuidanceEngine {
    static let offRouteThresholdMeters = 50.0
    static let arrivalRadiusMeters = 30.0
    static let maneuverReachedMeters = 25.0

    static func step(
        location: CLLocationCoordinate2D,
        route: NavigationRoute,
        progress: GuidanceProgress
    ) -> GuidanceUpdate {
        var progress = progress
        let offRoute = Geo.nearestSegmentDistance(location, route.polyline) > offRouteThresholdMeters
        let distanceToDest = Geo.haversineMeters(location, route.destinationCoordinate)

        if distanceToDest <= arrivalRadiusMeters {
            progress.arrived = true
            return GuidanceUpdate(
                progress: progress, distanceToManeuverMeters: 0,
                remainingDistanceMeters: 0, remainingSeconds: 0,
                offRoute: offRoute, spokenPrompt: "已到达目的地。"
            )
        }

        guard progress.maneuverIndex < route.steps.count else {
            return GuidanceUpdate(
                progress: progress, distanceToManeuverMeters: distanceToDest,
                remainingDistanceMeters: distanceToDest,
                remainingSeconds: eta(route, distanceToDest),
                offRoute: offRoute, spokenPrompt: nil
            )
        }

        let maneuver = route.steps[progress.maneuverIndex]
        let distToManeuver = Geo.haversineMeters(location, maneuver.coordinate)

        // Reached this maneuver: advance to the next and announce nothing this tick.
        if distToManeuver <= maneuverReachedMeters, progress.maneuverIndex + 1 < route.steps.count {
            progress.maneuverIndex += 1
            progress.firedThresholds = []
            let next = route.steps[progress.maneuverIndex]
            let d = Geo.haversineMeters(location, next.coordinate)
            return GuidanceUpdate(
                progress: progress, distanceToManeuverMeters: d,
                remainingDistanceMeters: remaining(route, progress, d),
                remainingSeconds: eta(route, remaining(route, progress, d)),
                offRoute: offRoute, spokenPrompt: nil
            )
        }

        // Fire the most urgent unfired threshold the rider has crossed; mark all
        // crossed thresholds fired so a skipped-over one cannot fire later.
        var prompt: String?
        let due = PromptThreshold.allCases.filter { distToManeuver <= $0.distanceMeters && !progress.firedThresholds.contains($0) }
        if let urgent = due.min(by: { $0.distanceMeters < $1.distanceMeters }) {
            due.forEach { progress.firedThresholds.insert($0) }
            prompt = phrase(urgent, maneuver.instruction)
        }

        let remain = remaining(route, progress, distToManeuver)
        return GuidanceUpdate(
            progress: progress, distanceToManeuverMeters: distToManeuver,
            remainingDistanceMeters: remain, remainingSeconds: eta(route, remain),
            offRoute: offRoute, spokenPrompt: prompt
        )
    }

    private static func remaining(_ route: NavigationRoute, _ progress: GuidanceProgress, _ distToManeuver: Double) -> Double {
        let rest = route.steps.dropFirst(progress.maneuverIndex + 1).reduce(0.0) { $0 + $1.distanceMeters }
        return distToManeuver + rest
    }

    private static func eta(_ route: NavigationRoute, _ remaining: Double) -> Double {
        guard route.totalDistanceMeters > 0 else { return 0 }
        return route.totalEtaSeconds * min(1, remaining / route.totalDistanceMeters)
    }

    private static func phrase(_ threshold: PromptThreshold, _ instruction: String) -> String {
        switch threshold {
        case .far: return "前方400米，\(instruction)"
        case .near: return "150米后，\(instruction)"
        case .now: return "现在，\(instruction)"
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Navigation/GuidanceEngine.swift ios/MaxHelmetTests/GuidanceEngineTests.swift
git commit -m "feat(ios): add pure guidance engine"
```

---

### Task 7: iOS — route search

**Files:**

- Create: `ios/MaxHelmet/Navigation/RouteSearch.swift`
- Create: `ios/MaxHelmetTests/RouteSearchTests.swift`

**Interfaces:**

- Consumes: `NavigationRoute`, `ManeuverStep` (Task 4).
- Produces: `protocol NavigationRouteSearching { func route(to query: String) async -> NavigationRoute?; func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? }` and `struct MapKitNavigationSearch` (device implementation), plus `navigationRoute(from:name:destination:)` that maps an `MKRoute` to a `NavigationRoute` (pure, tested).

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/RouteSearchTests.swift`:

```swift
import CoreLocation
import MapKit
import XCTest
@testable import MaxHelmet

final class RouteSearchTests: XCTestCase {

    func testMapsAnMKRouteIntoANavigationRoute() {
        // MKRoute can't be constructed in a test, so we verify the mapping helper
        // against a hand-built polyline + steps stand-in via the pure entry point.
        let dest = CLLocationCoordinate2D(latitude: 39.9087, longitude: 116.3975)
        let polyline = [
            CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40),
            CLLocationCoordinate2D(latitude: 39.91, longitude: 116.40)
        ]
        let steps = [ManeuverStep(instruction: "右转", coordinate: dest, distanceMeters: 500)]
        let route = makeNavigationRoute(
            name: "天安门", destination: dest, polyline: polyline, steps: steps,
            totalDistanceMeters: 1200, totalEtaSeconds: 300
        )
        XCTAssertEqual(route.destinationName, "天安门")
        XCTAssertEqual(route.steps.count, 1)
        XCTAssertEqual(route.polyline.count, 2)
        XCTAssertEqual(route.totalDistanceMeters, 1200)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'makeNavigationRoute' in scope`.

- [ ] **Step 3: Write the route search**

Create `ios/MaxHelmet/Navigation/RouteSearch.swift`:

```swift
import CoreLocation
import MapKit

/// Resolves a spoken place to a full route, and re-resolves from a moved origin.
protocol NavigationRouteSearching {
    func route(to query: String) async -> NavigationRoute?
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
}

/// Pure assembler, extracted so the MKRoute→NavigationRoute shape is testable
/// without constructing MapKit objects.
func makeNavigationRoute(
    name: String,
    destination: CLLocationCoordinate2D,
    polyline: [CLLocationCoordinate2D],
    steps: [ManeuverStep],
    totalDistanceMeters: Double,
    totalEtaSeconds: Double
) -> NavigationRoute {
    NavigationRoute(
        destinationName: name,
        destinationCoordinate: destination,
        polyline: polyline,
        steps: steps,
        totalDistanceMeters: totalDistanceMeters,
        totalEtaSeconds: totalEtaSeconds
    )
}

/// MapKit-backed search. Automobile transport only — no motorcycle profile, so
/// routes follow car rules and will not respect 摩托车禁行 roads. Cross-border
/// requests from a China-region device return nil.
struct MapKitNavigationSearch: NavigationRouteSearching {
    func route(to query: String) async -> NavigationRoute? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { return nil }
        let directions = MKDirections.Request()
        directions.destination = item
        directions.transportType = .automobile
        guard let mkRoute = try? await MKDirections(request: directions).calculate().routes.first else { return nil }
        return convert(mkRoute, name: item.name ?? query, destination: item.placemark.coordinate)
    }

    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        let directions = MKDirections.Request()
        directions.source = MKMapItem(placemark: MKPlacemark(coordinate: origin))
        directions.destination = MKMapItem(placemark: MKPlacemark(coordinate: destination))
        directions.transportType = .automobile
        guard let mkRoute = try? await MKDirections(request: directions).calculate().routes.first else { return nil }
        return convert(mkRoute, name: "目的地", destination: destination)
    }

    private func convert(_ mkRoute: MKRoute, name: String, destination: CLLocationCoordinate2D) -> NavigationRoute {
        let pointCount = mkRoute.polyline.pointCount
        var coords = [CLLocationCoordinate2D](repeating: .init(), count: pointCount)
        mkRoute.polyline.getCoordinates(&coords, range: NSRange(location: 0, length: pointCount))
        let steps = mkRoute.steps
            .filter { !$0.instructions.isEmpty }
            .map { ManeuverStep(instruction: $0.instructions, coordinate: $0.polyline.coordinate, distanceMeters: $0.distance) }
        return makeNavigationRoute(
            name: name, destination: destination, polyline: coords, steps: steps,
            totalDistanceMeters: mkRoute.distance, totalEtaSeconds: mkRoute.expectedTravelTime
        )
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Navigation/RouteSearch.swift ios/MaxHelmetTests/RouteSearchTests.swift
git commit -m "feat(ios): add navigation route search"
```

---

### Task 8: iOS — the navigation controller

**Files:**

- Create: `ios/MaxHelmet/Navigation/NavigationController.swift`
- Create: `ios/MaxHelmetTests/NavigationControllerTests.swift`

**Interfaces:**

- Consumes: `DeviceActionHandler`, `DeviceAction`, `DeviceActionResult` (Spec 1); `GuidanceEngine`, `GuidanceProgress` (Task 6); `NavigationRoute`, `GuidanceState` (Task 4); `NavigationRouteSearching` (Task 7).
- Produces: `enum LocationAuthorization { case authorized, denied, notDetermined }`; `protocol LocationStreaming` with `var onUpdate: ((CLLocationCoordinate2D) -> Void)?`, `authorization() -> LocationAuthorization`, `requestAccess()`, `start()`, `stop()`; `final class NavigationController: DeviceActionHandler` with `init(search:stream:onGuidance:speak:interruptPlayback:now:)`; `SystemLocationStream` (device implementation). `now` is an injected clock (`() -> TimeInterval`) for deterministic reroute-debounce tests.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/NavigationControllerTests.swift`:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

private final class FakeStream: LocationStreaming, @unchecked Sendable {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    var auth: LocationAuthorization = .authorized
    var granted = true
    var started = false
    func authorization() -> LocationAuthorization { auth }
    func requestAccess() async -> Bool { granted }
    func start() { started = true }
    func stop() { started = false }
    func feed(_ c: CLLocationCoordinate2D) { onUpdate?(c) }
}

private final class FakeSearch: NavigationRouteSearching, @unchecked Sendable {
    var route: NavigationRoute?
    var rerouteResult: NavigationRoute?
    var rerouteCalls = 0
    func route(to query: String) async -> NavigationRoute? { route }
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        rerouteCalls += 1
        return rerouteResult
    }
}

@MainActor
final class NavigationControllerTests: XCTestCase {

    private func straightRoute() -> NavigationRoute {
        let dest = CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
        return NavigationRoute(
            destinationName: "终点", destinationCoordinate: dest,
            polyline: [CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40), dest],
            steps: [ManeuverStep(instruction: "到达终点", coordinate: dest, distanceMeters: 2000)],
            totalDistanceMeters: 2000, totalEtaSeconds: 400
        )
    }

    private func make(_ stream: FakeStream, _ search: FakeSearch, clock: @escaping () -> TimeInterval = { 0 }) -> (NavigationController, Box) {
        let box = Box()
        let controller = NavigationController(
            search: search, stream: stream,
            onGuidance: { box.guidance = $0 },
            speak: { box.spoken.append($0) },
            interruptPlayback: { box.interrupts += 1 },
            now: clock
        )
        return (controller, box)
    }

    final class Box { var guidance: GuidanceState?; var spoken: [String] = []; var interrupts = 0 }

    func testStartResolvesStreamsAndSpeaksSummary() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertEqual(result, .ok)
        XCTAssertTrue(stream.started)
        XCTAssertNotNil(box.guidance)
        XCTAssertFalse(box.spoken.isEmpty, "opening summary is spoken")
    }

    func testStartReportsUnresolvableRoute() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = nil
        let (controller, _) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "火星"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "route.unavailable")
        XCTAssertFalse(stream.started)
    }

    func testStartReportsDeniedLocation() async {
        let stream = FakeStream(); stream.auth = .denied
        let search = FakeSearch(); search.route = straightRoute()
        let (controller, _) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.location")
    }

    func testStopClearsGuidance() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)
        _ = await controller.perform(.navigationStart(query: "终点"))

        let result = await controller.perform(.navigationStop)

        XCTAssertEqual(result, .ok)
        XCTAssertFalse(stream.started)
        XCTAssertNil(box.guidance)
    }

    func testStopWhileIdleIsBenign() async {
        let (controller, _) = make(FakeStream(), FakeSearch())
        let result = await controller.perform(.navigationStop)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "navigation.notActive")
    }

    func testOffRouteTriggersExactlyOneDebouncedReroute() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        search.rerouteResult = straightRoute()
        let (controller, _) = make(stream, search, clock: { 0 })
        _ = await controller.perform(.navigationStart(query: "终点"))

        // Two off-route fixes within the cooldown → one reroute.
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020) // ~170 m east
        stream.feed(off)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(search.rerouteCalls, 1)
    }

    func testArrivalEndsGuidance() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)
        _ = await controller.perform(.navigationStart(query: "终点"))

        stream.feed(CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)) // at destination
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(stream.started, "arrival stops the stream")
        XCTAssertTrue(box.spoken.contains { $0.contains("到达") })
    }

    func testGalleryOpenActionMismatchIsRejected() async {
        let (controller, _) = make(FakeStream(), FakeSearch())
        let result = await controller.perform(.torchSet(on: true))
        XCTAssertEqual(result.status, .unsupported)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'NavigationController' in scope`.

- [ ] **Step 3: Write the controller**

Create `ios/MaxHelmet/Navigation/NavigationController.swift`:

```swift
import CoreLocation
import Foundation

enum LocationAuthorization {
    case authorized
    case denied
    case notDetermined
}

/// The location stream behind a protocol so the controller is testable with
/// synthetic coordinates. The real one is a CLLocationManager configured for
/// driving; it never runs unless navigating.
protocol LocationStreaming: AnyObject {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)? { get set }
    func authorization() -> LocationAuthorization
    func requestAccess() async -> Bool
    func start()
    func stop()
}

/// Owns the active route, the location stream, and the reroute/arrival
/// lifecycle. All the hard math is delegated to `GuidanceEngine`; this class is
/// orchestration and speech. Reference type: it holds live navigation state.
@MainActor
final class NavigationController: DeviceActionHandler {
    private static let rerouteCooldownSeconds: TimeInterval = 15

    private let search: NavigationRouteSearching
    private let stream: LocationStreaming
    private let onGuidance: (GuidanceState?) -> Void
    private let speak: (String) -> Void
    private let interruptPlayback: () -> Void
    private let now: () -> TimeInterval

    private var route: NavigationRoute?
    private var progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    private var rerouting = false
    private var lastRerouteAt: TimeInterval = -.greatestFiniteMagnitude

    init(
        search: NavigationRouteSearching,
        stream: LocationStreaming,
        onGuidance: @escaping (GuidanceState?) -> Void,
        speak: @escaping (String) -> Void,
        interruptPlayback: @escaping () -> Void,
        now: @escaping () -> TimeInterval
    ) {
        self.search = search
        self.stream = stream
        self.onGuidance = onGuidance
        self.speak = speak
        self.interruptPlayback = interruptPlayback
        self.now = now
        self.stream.onUpdate = { [weak self] coord in
            Task { @MainActor in self?.handleFix(coord) }
        }
    }

    // The protocol requirement is `async`, so this `@MainActor` witness is legal:
    // an actor-isolated async method may satisfy a nonisolated async requirement.
    // The whole body therefore runs on the main actor without any MainActor.run.
    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        switch action {
        case let .navigationStart(query):
            return await start(query)
        case .navigationStop:
            return stopGuidance()
        case let .destinationShow(query):
            // Legacy Spec 1 action from an older relay — start guidance too.
            return await start(query)
        default:
            return .unsupported("action.mismatch")
        }
    }

    private func start(_ query: String) async -> DeviceActionResult {
        switch stream.authorization() {
        case .denied:
            return .denied("permission.location")
        case .notDetermined:
            let granted = await stream.requestAccess()
            if !granted { return .denied("permission.location") }
        case .authorized:
            break
        }
        guard let resolved = await search.route(to: query) else { return .unsupported("route.unavailable") }
        route = resolved
        progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
        stream.start()
        publish(location: nil)
        speak(openingSummary(resolved))
        return .ok
    }

    private func stopGuidance() -> DeviceActionResult {
        guard route != nil else { return .failed("navigation.notActive") }
        route = nil
        stream.stop()
        onGuidance(nil)
        speak("已停止导航。")
        return .ok
    }

    private func handleFix(_ location: CLLocationCoordinate2D) {
        guard let route else { return }
        let update = GuidanceEngine.step(location: location, route: route, progress: progress)
        progress = update.progress

        if let prompt = update.spokenPrompt {
            if prompt.contains("现在") { interruptPlayback() } // the safety-critical turn
            speak(prompt)
        }

        publish(location: location, update: update)

        if update.progress.arrived {
            self.route = nil
            stream.stop()
            onGuidance(nil)
            return
        }
        if update.offRoute { attemptReroute(from: location, to: route.destinationCoordinate) }
    }

    private func attemptReroute(from origin: CLLocationCoordinate2D, to destination: CLLocationCoordinate2D) {
        guard !rerouting, now() - lastRerouteAt >= Self.rerouteCooldownSeconds else { return }
        rerouting = true
        lastRerouteAt = now()
        speak("已偏离路线，正在重新规划。")
        Task { @MainActor in
            defer { rerouting = false }
            if let fresh = await search.reroute(to: destination, from: origin) {
                route = fresh
                progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
                publish(location: origin)
            } else {
                route = nil
                stream.stop()
                onGuidance(nil)
                speak("无法重新规划路线，已停止导航。")
            }
        }
    }

    private func publish(location: CLLocationCoordinate2D?, update: GuidanceUpdate? = nil) {
        guard let route else { return }
        let maneuver = progress.maneuverIndex < route.steps.count ? route.steps[progress.maneuverIndex].instruction : nil
        onGuidance(GuidanceState(
            destinationName: route.destinationName,
            polyline: route.polyline,
            currentLocation: location,
            maneuverInstruction: maneuver,
            distanceToManeuverMeters: update?.distanceToManeuverMeters ?? route.totalDistanceMeters,
            remainingDistanceMeters: update?.remainingDistanceMeters ?? route.totalDistanceMeters,
            remainingSeconds: update?.remainingSeconds ?? route.totalEtaSeconds,
            offRoute: update?.offRoute ?? false
        ))
    }

    private func openingSummary(_ route: NavigationRoute) -> String {
        let km = String(format: "%.1f", route.totalDistanceMeters / 1000)
        let minutes = Int((route.totalEtaSeconds / 60).rounded())
        let firstTurn = route.steps.first.map { "，" + $0.instruction } ?? ""
        return "开始导航，全程 \(km) 公里，预计 \(minutes) 分钟\(firstTurn)。仅供参考，请注意实际路况。"
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Add the real location stream (device-only, not unit-tested)**

Append `SystemLocationStream` to `ios/MaxHelmet/Navigation/NavigationController.swift`:

```swift
/// Production `LocationStreaming`, a CLLocationManager configured for driving.
/// Runs only while navigating; the app's idle-timer-disabled hands-free session
/// keeps it foregrounded, so WhenInUse authorization is sufficient.
final class SystemLocationStream: NSObject, LocationStreaming, CLLocationManagerDelegate {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    private let manager = CLLocationManager()
    private var accessContinuation: CheckedContinuation<Bool, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .automotiveNavigation
        manager.distanceFilter = 10
    }

    func authorization() -> LocationAuthorization {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            accessContinuation = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    func start() { manager.startUpdatingLocation() }
    func stop() { manager.stopUpdatingLocation() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let coord = locations.last?.coordinate { onUpdate?(coord) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let continuation = accessContinuation else { return }
        accessContinuation = nil
        continuation.resume(returning: authorization() == .authorized)
    }
}
```

- [ ] **Step 6: Run the full iOS suite**

Run the iOS test command.
Expected: PASS — the controller tests plus the app still builds with the real stream.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Navigation/NavigationController.swift ios/MaxHelmetTests/NavigationControllerTests.swift
git commit -m "feat(ios): add navigation controller"
```

---

### Task 9: iOS — the guidance card

**Files:**

- Create: `ios/MaxHelmet/Navigation/GuidanceCard.swift`

**Interfaces:**

- Consumes: `GuidanceState` (Task 4); `HudColors` (`ios/MaxHelmet/UI/HudTheme.swift`).
- Produces: `GuidanceCard(guidance:)` SwiftUI view.

No unit test — a SwiftUI view, verified by the build and manual device testing, following the Spec 1/2 precedent.

- [ ] **Step 1: Write the card**

Create `ios/MaxHelmet/Navigation/GuidanceCard.swift`:

```swift
import MapKit
import SwiftUI

/// The live guidance surface, glanceable-first: the next maneuver and its
/// distance dominate; ETA and remaining distance sit below; the route map is
/// secondary. Replaces Spec 1's DestinationCard.
struct GuidanceCard: View {
    let guidance: GuidanceState

    private var distanceText: String {
        let m = guidance.distanceToManeuverMeters
        return m >= 1000 ? String(format: "%.1f 公里", m / 1000) : "\(Int(m)) 米"
    }

    private var etaText: String {
        "\(Int((guidance.remainingSeconds / 60).rounded())) 分钟 · \(String(format: "%.1f", guidance.remainingDistanceMeters / 1000)) 公里"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if guidance.offRoute {
                Text("重新规划中…")
                    .font(.headline)
                    .foregroundStyle(HudColors.amber)
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "arrow.turn.up.right")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(HudColors.lume)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(guidance.maneuverInstruction ?? guidance.destinationName)
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(HudColors.hudInk)
                        Text(distanceText)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(HudColors.hudDim)
                    }
                }
            }

            Text(etaText)
                .font(.subheadline)
                .foregroundStyle(HudColors.hudDim)

            routeMap
                .frame(height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .allowsHitTesting(false)
        }
        .padding(14)
        .background(HudColors.panelElevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(HudColors.border, lineWidth: 1)
        )
        .frame(maxWidth: 420)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("导航 \(guidance.destinationName)，\(guidance.maneuverInstruction ?? "")，\(distanceText)")
    }

    private var routeMap: some View {
        Map {
            if guidance.polyline.count >= 2 {
                MapPolyline(coordinates: guidance.polyline)
                    .stroke(HudColors.lume, lineWidth: 5)
            }
            if let here = guidance.currentLocation {
                Marker("我", coordinate: here).tint(HudColors.ember)
            }
        }
    }
}
```

- [ ] **Step 2: Build to verify the view compiles**

Run the iOS test command (it builds the app target before testing).
Expected: PASS — build succeeds, existing tests green.

- [ ] **Step 3: Commit**

```bash
git add ios/MaxHelmet/Navigation/GuidanceCard.swift
git commit -m "feat(ios): add live guidance card"
```

---

### Task 10: iOS — wire into the session, replace destination pieces

**Files:**

- Modify: `ios/MaxHelmet/Agent/AgentSession.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift`
- Modify: `ios/MaxHelmet/Actions/DeviceActionHandler.swift`
- Delete: `ios/MaxHelmet/Actions/DestinationResolver.swift`, `ios/MaxHelmet/Actions/DestinationCard.swift`, `ios/MaxHelmetTests/DestinationResolverTests.swift`
- Modify: `ios/README.md`, `README.md`

**Interfaces:**

- Consumes: everything from Tasks 3–9.
- Produces: `NavigationController` on the `.navigation` route (also serving legacy `destinationShow`); `AgentSession.State.guidance: GuidanceState?` replacing `destination`.

- [ ] **Step 1: Consolidate the route so legacy destination.show also navigates**

In `ios/MaxHelmet/Actions/DeviceActionHandler.swift`, change the `DeviceActionRoute.init(_:)` mapping so `destinationShow` routes to `.navigation`, and delete the now-unused `.destination` case. The relevant arms become:

```swift
        case .destinationShow, .navigationStart, .navigationStop: self = .navigation
```

Remove `case destination` from the enum's case list.

- [ ] **Step 2: Swap the session state field**

In `ios/MaxHelmet/Agent/AgentSession.swift`, replace the `destination` field in `State`:

```swift
        /// Live guidance, or nil when not navigating. Cleared on session start.
        var guidance: GuidanceState? = nil
```

At the session-start reset (where `$0.destination = nil` currently is), change it to:

```swift
            $0.guidance = nil
```

- [ ] **Step 3: Swap the router registration**

In `ios/MaxHelmet/Agent/AgentSession.swift`, replace the `.destination: DestinationResolver(...)` entry in the `deviceRouter` handlers with:

```swift
            .navigation: NavigationController(
                search: MapKitNavigationSearch(),
                stream: SystemLocationStream(),
                onGuidance: { [weak self] guidance in
                    self?.update { $0.guidance = guidance }
                },
                speak: { [weak self] line in self?.speak(line) },
                interruptPlayback: { [weak self] in self?.player.stopPlayback() },
                now: { ProcessInfo.processInfo.systemUptime }
            )
```

`NavigationController` is `@MainActor`; the handlers dictionary is built in the `@MainActor` view-model/session context, matching the Spec 2 `GalleryModel` pattern. If the compiler flags isolation, mark the `deviceRouter` construction site the same way the existing handlers are reached.

- [ ] **Step 4: Render the guidance card**

In `ios/MaxHelmet/UI/AgentScreen.swift`, replace the destination-card block:

```swift
                if let guidance = state.guidance {
                    GuidanceCard(guidance: guidance)
                        .padding(.horizontal, 4)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
```

- [ ] **Step 5: Delete the superseded Spec 1 destination files**

```bash
git rm ios/MaxHelmet/Actions/DestinationResolver.swift \
  ios/MaxHelmet/Actions/DestinationCard.swift \
  ios/MaxHelmetTests/DestinationResolverTests.swift
```

- [ ] **Step 6: Build and run the whole iOS suite**

Run the iOS test command.
Expected: PASS — all navigation suites, the app builds, and no references to the deleted `Destination`/`DestinationResolver`/`DestinationCard` remain. If the build reports a lingering reference, it is a real missed call site — fix it (search `Destination` across `ios/MaxHelmet`).

- [ ] **Step 7: Update the documentation**

In `ios/README.md` under "What's implemented", replace the destination-card bullet (from Spec 1) with one describing live turn-by-turn guidance: voice-started, continuous prompts, one debounced reroute per wrong turn, arrival, foreground-session only, and car-routing-only (no motorcycle profile). In the root `README.md` "Current Capabilities", update the corresponding entry the same way.

- [ ] **Step 8: Run the full server gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentSession.swift ios/MaxHelmet/UI/AgentScreen.swift \
  ios/MaxHelmet/Actions/DeviceActionHandler.swift ios/README.md README.md
git commit -m "feat(ios): wire live guidance into the session, replace destination card"
```

---

## Manual verification

Run after Task 10, on a physical iPhone (the simulator has no real GPS motion).

- [ ] Say "Max，导航去〔place〕" → the card appears, Max speaks the opening summary, and guidance begins.
- [ ] Drive or walk the route → maneuver prompts land before each turn (far ≈ 400 m, near ≈ 150 m, "现在" at the turn), and the card's distance/ETA update.
- [ ] Deliberately miss a turn → Max says it is re-planning and the route updates (once, not repeatedly).
- [ ] Reach the destination → Max announces arrival and the card clears.
- [ ] "Max，停止导航" mid-route → guidance stops and the card clears.
- [ ] "Max，停止导航" with nothing active → Max says "现在没有在导航" (benign).
- [ ] Deny location permission, then start navigation → Max says the permission is missing and does not pretend to guide.
- [ ] Confirm an Android client receiving a `navigation.*` command ignores it without erroring.

```

```
