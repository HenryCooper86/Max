# iOS AMap Physical-Device Validation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Debug-only deterministic route launch path and opt-in physical-device test that validate the production AMap consent and renderer flow without relay credentials.

**Architecture:** A focused Debug-only harness parses two exact launch arguments, optionally clears only the persisted AMap consent decision, and installs a fixed Shanghai `GuidanceState` through `AgentSession`. The ordinary `AgentScreen` and map views remain unchanged. A separate device-only XCTest hosts the production `AMapRouteMap`, waits for the real SDK renderer, and inspects its public map state and snapshot output.

**Tech Stack:** Swift 6, SwiftUI, UIKit, XCTest, AMap 3D Map SDK 11.2.x, CocoaPods 1.16.2, `xcodebuild`, `devicectl`.

## Global Constraints

- Compile all harness entry points and fixture data only in Debug builds.
- Do not change Release behavior, production routing, relay protocols, signing settings, or the app bundle identifier `com.horizon.maxhelmet`.
- Do not auto-accept AMap consent or construct an AMap object before the existing disclosure records acceptance.
- Do not commit, print, snapshot, or otherwise expose the local AMap key.
- Do not add a second map implementation, UI-test target, AMap Location SDK, or simulator map fallback.
- The fixture is WGS-84; the existing `AMapRouteDisplayModel` remains the only WGS-84-to-GCJ-02 display boundary.
- Device tests use the existing project development team only as a command-line override for `MaxHelmetTests`; do not edit test-target signing settings.
- Every production behavior change follows RED → GREEN → mutation → restore, and every task receives fresh spec and quality review.

---

## File Map

- Create `ios/MaxHelmet/Navigation/AMapDeviceValidationHarness.swift`: Debug-only argument parsing, deterministic guidance fixture, scoped consent reset, and fixture installation callback.
- Modify `ios/MaxHelmet/Agent/AgentSession.swift`: Debug-only method that publishes the fixture through the existing state update path.
- Modify `ios/MaxHelmet/MaxHelmetApp.swift`: invoke the harness once from the existing app-appearance lifecycle.
- Create `ios/MaxHelmetTests/AMapDeviceValidationHarnessTests.swift`: pure request/reset/fixture tests plus the `AgentSession` publication contract.
- Create `ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift`: opt-in, device-only hosted renderer test and test-only UIKit helpers.
- Modify `ios/README.md`: exact Debug device-harness, consent-reset, integration-test, and cleanup commands.
- Update ignored `.superpowers/sdd/2026-08-13-ios-amap-helmet-toggle/task-8-report.md`: sanitized verification evidence only.

---

### Task 1: Debug-Only Route Injection Through the Production HUD

**Files:**

- Create: `ios/MaxHelmet/Navigation/AMapDeviceValidationHarness.swift`
- Modify: `ios/MaxHelmet/Agent/AgentSession.swift` near `@Published private(set) var state`
- Modify: `ios/MaxHelmet/MaxHelmetApp.swift` in the root view's `.onAppear`
- Create: `ios/MaxHelmetTests/AMapDeviceValidationHarnessTests.swift`

**Interfaces:**

- Consumes: `AMapConsentStore.defaultsKey`, `GuidanceState`, `AgentSession.update(_:)`, `ProcessInfo.processInfo.arguments`.
- Produces: Debug-only `AMapDeviceValidationRequest.init(arguments:)`, `AMapDeviceValidationHarness.guidanceFixture`, `AMapDeviceValidationHarness.apply(arguments:defaults:installGuidance:)`, and `AgentSession.installAMapDeviceValidationGuidance(_:)`.

- [ ] **Step 1: Write the failing harness contract tests**

Create `ios/MaxHelmetTests/AMapDeviceValidationHarnessTests.swift` under `#if DEBUG`. Use literal expected values rather than deriving them from the harness:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

#if DEBUG
@MainActor
final class AMapDeviceValidationHarnessTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "AMapDeviceValidationHarnessTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testRequestRecognizesOnlyExactDebugArguments() {
        XCTAssertEqual(
            AMapDeviceValidationRequest(arguments: ["app", "--debug-amap-route", "--debug-reset-amap-consent"]),
            AMapDeviceValidationRequest(routeEnabled: true, resetConsent: true)
        )
        XCTAssertEqual(
            AMapDeviceValidationRequest(arguments: ["app", "prefix--debug-amap-route", "--debug-amap-route=1"]),
            AMapDeviceValidationRequest(routeEnabled: false, resetConsent: false)
        )
    }

    func testApplyResetsOnlyAMapConsentAndInstallsFixtureWhenRequested() throws {
        defaults.set(AMapConsentDecision.accepted.rawValue, forKey: AMapConsentStore.defaultsKey)
        defaults.set("preserve-me", forKey: "unrelated-setting")
        var installed: GuidanceState?

        AMapDeviceValidationHarness.apply(
            arguments: ["app", "--debug-amap-route", "--debug-reset-amap-consent"],
            defaults: defaults,
            installGuidance: { installed = $0 }
        )

        XCTAssertNil(defaults.object(forKey: AMapConsentStore.defaultsKey))
        XCTAssertEqual(defaults.string(forKey: "unrelated-setting"), "preserve-me")
        let guidance = try XCTUnwrap(installed)
        let current = try XCTUnwrap(guidance.currentLocation)
        XCTAssertEqual(guidance.destinationName, "上海外滩验证路线")
        XCTAssertEqual(guidance.polyline.count, 3)
        XCTAssertEqual(current.latitude, 31.2304, accuracy: 0.0000001)
        XCTAssertEqual(current.longitude, 121.4737, accuracy: 0.0000001)
        XCTAssertEqual(guidance.maneuverInstruction, "沿中山东一路向北")
    }

    func testApplyWithoutFlagsLeavesConsentAndGuidanceUntouched() {
        defaults.set(AMapConsentDecision.declined.rawValue, forKey: AMapConsentStore.defaultsKey)
        var installCount = 0

        AMapDeviceValidationHarness.apply(
            arguments: ["app"],
            defaults: defaults,
            installGuidance: { _ in installCount += 1 }
        )

        XCTAssertEqual(defaults.string(forKey: AMapConsentStore.defaultsKey), AMapConsentDecision.declined.rawValue)
        XCTAssertEqual(installCount, 0)
    }

    func testFixturePassesTheProductionDisplayModelGate() throws {
        let guidance = AMapDeviceValidationHarness.guidanceFixture
        let display = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: guidance))

        XCTAssertEqual(guidance.polyline.map(\.latitude), [31.2304, 31.2311, 31.2320])
        XCTAssertEqual(guidance.polyline.map(\.longitude), [121.4737, 121.4744, 121.4753])
        XCTAssertEqual(display.polyline.count, 3)
        XCTAssertNotEqual(display.polyline[0].longitude, guidance.polyline[0].longitude)
        XCTAssertTrue(display.bounds.latitudeSpan.isFinite)
        XCTAssertTrue(display.bounds.longitudeSpan.isFinite)
    }

    func testAgentSessionPublishesDebugGuidanceThroughItsState() {
        let session = AgentSession()
        let guidance = AMapDeviceValidationHarness.guidanceFixture

        session.installAMapDeviceValidationGuidance(guidance)

        XCTAssertEqual(session.state.guidance, guidance)
    }
}
#endif
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run from the repository root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapDeviceValidationHarnessTests
```

Expected: compile failure because `AMapDeviceValidationRequest`, `AMapDeviceValidationHarness`, and `installAMapDeviceValidationGuidance` do not exist.

- [ ] **Step 3: Implement the minimal Debug-only harness**

Create `ios/MaxHelmet/Navigation/AMapDeviceValidationHarness.swift`:

```swift
#if DEBUG
import CoreLocation
import Foundation

struct AMapDeviceValidationRequest: Equatable {
    let routeEnabled: Bool
    let resetConsent: Bool

    init(routeEnabled: Bool, resetConsent: Bool) {
        self.routeEnabled = routeEnabled
        self.resetConsent = resetConsent
    }

    init(arguments: [String]) {
        routeEnabled = arguments.contains("--debug-amap-route")
        resetConsent = arguments.contains("--debug-reset-amap-consent")
    }
}

enum AMapDeviceValidationHarness {
    static let guidanceFixture = GuidanceState(
        destinationName: "上海外滩验证路线",
        polyline: [
            CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
            CLLocationCoordinate2D(latitude: 31.2311, longitude: 121.4744),
            CLLocationCoordinate2D(latitude: 31.2320, longitude: 121.4753),
        ],
        currentLocation: CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
        maneuverInstruction: "沿中山东一路向北",
        distanceToManeuverMeters: 180,
        remainingDistanceMeters: 1_400,
        remainingSeconds: 360,
        offRoute: false
    )

    static func apply(
        arguments: [String],
        defaults: UserDefaults,
        installGuidance: (GuidanceState) -> Void
    ) {
        let request = AMapDeviceValidationRequest(arguments: arguments)
        if request.resetConsent {
            defaults.removeObject(forKey: AMapConsentStore.defaultsKey)
        }
        if request.routeEnabled {
            installGuidance(guidanceFixture)
        }
    }
}
#endif
```

Inside `AgentSession`, beside the existing public state API, add:

```swift
#if DEBUG
    func installAMapDeviceValidationGuidance(_ guidance: GuidanceState) {
        update { $0.guidance = guidance }
    }
#endif
```

In `MaxHelmetApp`, expand the existing `.onAppear` without moving ordinary behavior:

```swift
.onAppear {
    #if DEBUG
    AMapDeviceValidationHarness.apply(
        arguments: ProcessInfo.processInfo.arguments,
        defaults: .standard,
        installGuidance: session.installAMapDeviceValidationGuidance
    )
    #endif
    updateIdleTimer()
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: all `AMapDeviceValidationHarnessTests` pass; no AMap SDK symbol is linked into the simulator app.

- [ ] **Step 5: Prove the tests catch realistic regressions**

Perform each mutation separately, run the focused tests, record the intended failure, and restore before the next mutation:

1. Change `arguments.contains("--debug-amap-route")` to a substring match; `testRequestRecognizesOnlyExactDebugArguments` must fail.
2. Replace the scoped removal with `defaults.dictionaryRepresentation().keys.forEach(defaults.removeObject(forKey:))`; `testApplyResetsOnlyAMapConsentAndInstallsFixtureWhenRequested` must fail because the unrelated setting disappears.
3. Remove the session state assignment; `testAgentSessionPublishesDebugGuidanceThroughItsState` must fail.

After restoring all mutations, rerun the focused tests and `git diff --check`.

- [ ] **Step 6: Verify Release compiles without harness symbols**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  AMAP_IOS_KEY= \
  CODE_SIGNING_ALLOWED=NO
```

Expected: build succeeds. Resolve the concrete no-key Release executable without emitting configured settings, then require the scan to return no match:

```bash
settings_path=/tmp/maxhelmet-release-build-settings.txt
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -showBuildSettings \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  AMAP_IOS_KEY= >"$settings_path"
target_build_dir=$(awk -F ' = ' '$1 ~ /TARGET_BUILD_DIR$/ { print $2; exit }' "$settings_path")
executable_path=$(awk -F ' = ' '$1 ~ /EXECUTABLE_PATH$/ { print $2; exit }' "$settings_path")
release_binary="$target_build_dir/$executable_path"
test -x "$release_binary"

if strings "$release_binary" | \
  rg -q -- '--debug-amap-route|--debug-reset-amap-consent|上海外滩验证路线'; then
  echo 'Debug AMap harness leaked into Release' >&2
  exit 1
fi
```

Do not print the settings file or scan an unresolved wildcard.

- [ ] **Step 7: Commit Task 1**

```bash
git add ios/MaxHelmet/Navigation/AMapDeviceValidationHarness.swift \
  ios/MaxHelmet/Agent/AgentSession.swift \
  ios/MaxHelmet/MaxHelmetApp.swift \
  ios/MaxHelmetTests/AMapDeviceValidationHarnessTests.swift
git diff --cached --check
git commit -m "feat(ios): add debug AMap route harness"
```

Expected: only the four scoped files are committed; the local secrets file is absent.

---

### Task 2: Opt-In Native AMap Renderer Test on a Physical iPhone

**Files:**

- Create: `ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift`

**Interfaces:**

- Consumes: `AMapDeviceValidationHarness.guidanceFixture`, `AMapRouteDisplayModel.make(guidance:)`, `AMapAcceptedConsent`, `AMapConfiguration`, and production `AMapRouteMap`.
- Produces: one opt-in `AMapPhysicalDeviceIntegrationTests.testConfiguredDeviceLoadsNativeRouteMap()` that skips on simulator or unless the explicit `RUN_AMAP_DEVICE_INTEGRATION` Swift compilation condition is supplied by the `RUN_AMAP_DEVICE_INTEGRATION=1` verification command.

- [ ] **Step 1: Add the physical-device integration test**

Create `ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift`. Keep every AMap/UIKit import and helper behind the device compile condition:

```swift
import XCTest
@testable import MaxHelmet

#if targetEnvironment(simulator) || !RUN_AMAP_DEVICE_INTEGRATION
final class AMapPhysicalDeviceIntegrationTests: XCTestCase {
    func testConfiguredDeviceLoadsNativeRouteMap() throws {
        throw XCTSkip("Native AMap rendering requires the explicit physical-device integration run.")
    }
}
#else
import MAMapKit
import SwiftUI
import UIKit

@MainActor
final class AMapPhysicalDeviceIntegrationTests: XCTestCase {
    func testConfiguredDeviceLoadsNativeRouteMap() throws {
        let key = try XCTUnwrap(AMapConfiguration().apiKey, "The configured device test requires the ignored local key.")
        let consent = try XCTUnwrap(AMapAcceptedConsent(decision: .accepted))
        let model = try XCTUnwrap(
            AMapRouteDisplayModel.make(guidance: AMapDeviceValidationHarness.guidanceFixture)
        )
        let loadFinished = expectation(description: "AMap map load finished")
        let probe = DeviceMapLoadProbe(loadFinished: loadFinished)
        let root = AMapRouteMap(
            model: model,
            consent: consent,
            apiKey: key,
            loadFailed: probe.binding
        )
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 240))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()

        wait(for: [loadFinished], timeout: 20)

        let mapView = try XCTUnwrap(findSubview(MAMapView.self, in: controller.view))
        XCTAssertEqual(mapView.overlays.count, 1)
        XCTAssertEqual(mapView.annotations.count, 1)
        XCTAssertFalse(mapView.isUserInteractionEnabled)
        XCTAssertFalse(mapView.isZoomEnabled)
        XCTAssertFalse(mapView.isScrollEnabled)
        XCTAssertFalse(mapView.isRotateEnabled)
        XCTAssertFalse(mapView.isRotateCameraEnabled)
        XCTAssertFalse(mapView.touchPOIEnabled)
        XCTAssertFalse(mapView.showsUserLocation)
        XCTAssertTrue(mapView.region.center.latitude.isFinite)
        XCTAssertTrue(mapView.region.center.longitude.isFinite)
        XCTAssertGreaterThan(mapView.region.span.latitudeDelta, 0)
        XCTAssertGreaterThan(mapView.region.span.longitudeDelta, 0)
        XCTAssertGreaterThan(mapView.logoSize.width, 0)
        XCTAssertGreaterThan(mapView.logoSize.height, 0)

        let logo = try XCTUnwrap(findAccessibilitySubview("malogo", in: mapView))
        XCTAssertFalse(logo.isHidden)
        XCTAssertGreaterThan(logo.alpha, 0)
        XCTAssertTrue(mapView.bounds.intersects(mapView.convert(logo.bounds, from: logo)))

        let snapshotFinished = expectation(description: "AMap complete snapshot")
        mapView.takeSnapshot(in: mapView.bounds, timeoutInterval: 15) { image, state in
            XCTAssertEqual(state, 1)
            XCTAssertNotNil(image)
            XCTAssertGreaterThan(image?.size.width ?? 0, 0)
            XCTAssertGreaterThan(image?.size.height ?? 0, 0)
            snapshotFinished.fulfill()
        }
        wait(for: [snapshotFinished], timeout: 20)

        withExtendedLifetime((window, controller, probe)) {}
    }
}

@MainActor
private final class DeviceMapLoadProbe {
    private var failed = true
    private let loadFinished: XCTestExpectation

    init(loadFinished: XCTestExpectation) {
        self.loadFinished = loadFinished
    }

    var binding: Binding<Bool> {
        Binding(
            get: { self.failed },
            set: { next in
                let wasFailed = self.failed
                self.failed = next
                if wasFailed && !next { self.loadFinished.fulfill() }
            }
        )
    }
}

private func findSubview<T: UIView>(_ type: T.Type, in root: UIView) -> T? {
    if let match = root as? T { return match }
    for child in root.subviews {
        if let match = findSubview(type, in: child) { return match }
    }
    return nil
}

private func findAccessibilitySubview(_ identifier: String, in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == identifier { return root }
    for child in root.subviews {
        if let match = findAccessibilitySubview(identifier, in: child) { return match }
    }
    return nil
}
#endif
```

The test message may say only that a configured key is required; never interpolate the key or the full error object returned by the SDK.

- [ ] **Step 2: Prove ordinary simulator runs skip without SDK linkage**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapPhysicalDeviceIntegrationTests
```

Expected: one skipped test, zero failures, and no AMap/MAMap undefined symbol in the simulator product.

- [ ] **Step 3: Run the opt-in test on the paired iPhone**

Resolve the already paired physical iPhone and existing app team without printing the configured key or committing either identifier:

```bash
destination_output=/tmp/maxhelmet-device-destinations.txt
settings_output=/tmp/maxhelmet-device-settings.txt
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -showdestinations >"$destination_output"
DEVICE_ID=$(sed -nE \
  's/.*platform:iOS, arch:arm64, id:([^,]+), name:.*/\1/p' \
  "$destination_output" | head -1)
test -n "$DEVICE_ID"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -showBuildSettings \
  -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -configuration Debug -destination "id=$DEVICE_ID" \
  AMAP_IOS_KEY= >"$settings_output"
TEAM_ID=$(awk -F ' = ' '$1 ~ /DEVELOPMENT_TEAM$/ { print $2; exit }' "$settings_output")
test -n "$TEAM_ID"

RUN_AMAP_DEVICE_INTEGRATION=1 \
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination "id=$DEVICE_ID" \
  -only-testing:MaxHelmetTests/AMapPhysicalDeviceIntegrationTests \
  -allowProvisioningUpdates \
  SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) RUN_AMAP_DEVICE_INTEGRATION' \
  DEVELOPMENT_TEAM="$TEAM_ID"
```

Expected: exactly one executed test passes rather than skips. A skipped result does not satisfy this step.

- [ ] **Step 4: Mutate the production renderer and prove the device test is meaningful**

Perform one mutation at a time and restore it immediately:

1. Temporarily remove `context.coordinator.render(model, on: mapView)` from `AMapRouteMap.makeUIView`; the device test must fail the overlay/annotation assertions.
2. Temporarily set `mapView.isUserInteractionEnabled = true`; the device test must fail the interaction assertion.
3. Temporarily skip the AMap map-load completion callback assignment; the device test must time out rather than pass from its initial value.

After restoring all mutations, rerun the opt-in device test and simulator skip test.

- [ ] **Step 5: Commit Task 2**

```bash
git add ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift
git diff --cached --check
git commit -m "test(ios): validate native AMap rendering on device"
```

Expected: only the device test is committed; no signing, key, or project-file change is present.

---

### Task 3: Signed-Device Flow, Documentation, and Final Verification

**Files:**

- Modify: `ios/README.md`
- Create or update ignored: `.superpowers/sdd/2026-08-13-ios-amap-helmet-toggle/task-8-report.md`

**Interfaces:**

- Consumes: the two Debug launch arguments and opt-in test from Tasks 1–2.
- Produces: copy-pasteable physical-device validation commands and sanitized final evidence for the whole feature branch.

- [ ] **Step 1: Document the explicit Debug validation workflow**

Add a short `### AMap physical-device validation harness` section under the physical-device quick start in `ios/README.md`. Document:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
destination_output=/tmp/maxhelmet-device-destinations.txt
xcodebuild -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -showdestinations >"$destination_output"
UDID=$(sed -nE 's/.*platform:iOS, arch:arm64, id:([^,]+), name:.*/\1/p' \
  "$destination_output" | head -1)
test -n "$UDID"

xcodebuild -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -configuration Debug -destination "id=$UDID" \
  -derivedDataPath /tmp/MaxHelmetAMapDevice \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device "$UDID" \
  /tmp/MaxHelmetAMapDevice/Build/Products/Debug-iphoneos/MaxHelmet.app
xcrun devicectl device process launch --device "$UDID" --terminate-existing \
  com.horizon.maxhelmet --debug-amap-route --debug-reset-amap-consent
```

Explain that the reset argument deletes only the app's AMap consent decision, never accepts consent, and should be omitted when verifying persistence. Include the Task 2 `RUN_AMAP_DEVICE_INTEGRATION=1 xcodebuild test` command, but tell other developers to substitute their own device and team identifiers. State that both arguments are Debug-only and absent from Release.

- [ ] **Step 2: Validate the visible consent and native-map flow on the paired phone**

Build, install, and launch the configured Debug app with both flags. Use iPhone Mirroring or another inspectable device UI and record only visible state, never the key:

1. Confirm the existing Chinese disclosure appears only after the fixture route enters the production HUD.
2. Tap **暂不启用**; confirm the navigation summary remains and **地图未启用** appears with no native map.
3. Tap **启用地图**, then **同意并启用**; confirm native AMap tiles, the green route line, orange rider marker, fitted Shanghai route, and visible AMap attribution.
4. Relaunch with only `--debug-amap-route`; confirm the disclosure does not recur.
5. Confirm the helmet remains the sole start/stop action, no microphone dock appears in portrait or landscape, and mute remains a separate active-session utility. If iOS presents an unanticipated microphone/location permission, pause at the prompt and obtain action-time user confirmation before granting it.

If the device UI cannot be inspected, report the limitation and do not replace visible evidence with unit-test inference.

- [ ] **Step 3: Run the full simulator test suite**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Expected: all ordinary tests pass; the physical AMap integration test is the only intentional skip.

- [ ] **Step 4: Run no-key simulator and device build matrices**

Run Debug and Release for both platforms:

```bash
for configuration in Debug Release; do
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild build \
    -workspace ios/MaxHelmet.xcworkspace \
    -scheme MaxHelmet \
    -configuration "$configuration" \
    -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
    AMAP_IOS_KEY= CODE_SIGNING_ALLOWED=NO

  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild build \
    -workspace ios/MaxHelmet.xcworkspace \
    -scheme MaxHelmet \
    -configuration "$configuration" \
    -destination 'generic/platform=iOS' \
    AMAP_IOS_KEY= CODE_SIGNING_ALLOWED=NO
done
```

Expected: four successful builds. Evaluated simulator linker flags and `nm -u` contain no AMap/MAMap references; evaluated device flags retain `AMapFoundationKit` and `MAMapKit`.

- [ ] **Step 5: Verify bootstrap, Release isolation, and secret hygiene**

```bash
PATH="/opt/homebrew/opt/ruby/bin:$PATH" ios/scripts/verify-bootstrap.sh
PATH="/opt/homebrew/opt/ruby/bin:$PATH" ios/scripts/test-verify-bootstrap.sh
PATH="/opt/homebrew/opt/ruby/bin:$PATH" \
  bundle _4.0.16_ exec ruby ios/PodfileSupportTests/AMapSimulatorLinkageFixtureTest.rb

git diff --check
git status --short
git check-ignore -q ios/Config/Secrets.xcconfig
test -s ios/Config/Secrets.xcconfig
test -z "$(git ls-files ios/Config/Secrets.xcconfig)"

for commit in $(git rev-list --all); do
  if git grep -I -q -E \
    '^AMAP_IOS_KEY[[:space:]]*=[[:space:]]*[^$[:space:]]' \
    "$commit" -- '*.xcconfig'; then
    echo 'Tracked history contains a non-placeholder AMap key assignment' >&2
    exit 1
  fi
done
```

Repeat the concrete Release executable scan from Task 1. The history scan is boolean-only and never prints matching content. The ignored local key must be nonempty, untracked, and unread.

- [ ] **Step 6: Update the sanitized task report**

Write `.superpowers/sdd/2026-08-13-ios-amap-helmet-toggle/task-8-report.md` with:

- RED/GREEN/mutation evidence;
- test and build counts;
- device model/OS and pass/fail state, without device identifiers;
- visible consent/map/helmet observations;
- Release-string, simulator-symbol, device-linker, bootstrap, and secret-scan booleans;
- any remaining warnings or manual limitations.

Do not include the AMap key, its prefix/suffix, derived hashes, raw build settings, full SDK errors, provisioning identifiers, or device identifiers.

- [ ] **Step 7: Commit Task 3**

```bash
git add ios/README.md
git diff --cached --check
git commit -m "docs(ios): document AMap device validation"
```

Expected: only `ios/README.md` is committed; the report and local key remain ignored.

- [ ] **Step 8: Request final reviews**

Generate a review package from the feature base through the final HEAD. Request:

1. task-level spec and quality review for Tasks 1–3;
2. a fresh whole-branch review against both AMap/helmet design documents and implementation plans;
3. explicit confirmation that no Critical or Important finding remains and that physical-device visible evidence is sufficient.

Address every validated Critical/Important finding with the receiving-code-review workflow and fresh verification before completion.
