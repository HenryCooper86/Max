# iOS AMap Transient-Load Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an eligible native AMap route mounted through transient SDK load failures, show an unavailable overlay while failure is current, and reveal the same recovered map after a later success callback.

**Architecture:** Split structural map eligibility from transient load presentation. `GuidanceMapHostPresentation` keeps consent, key, geometry, and physical-device gates fail-closed while representing load failure only as an overlay flag; a generic, production-consumed `GuidanceMapLoadContainer` keeps its map child structurally stable while adding or removing that overlay. The opt-in device test starts from the production `false` load state, uses the same container, and waits for an actual SDK success write.

**Tech Stack:** Swift 6, SwiftUI, UIKit, XCTest, AMap 3D Map SDK 11.2.x, CocoaPods 1.16.2, `xcodebuild`, `devicectl`.

## Global Constraints

- Preserve the existing consent, configured-key, route-geometry, and physical-device gates before constructing AMap.
- Preserve display-only map behavior, route rendering, rider marker, fitted viewport, visible attribution, and disabled interactions.
- Do not add a timer, retry button, SDK reconstruction loop, simulator map, or second map implementation.
- Unknown or declined consent, missing key, invalid geometry, and simulator execution must never construct AMap.
- Keep AMap imports and symbols excluded from simulator products.
- Do not change relay behavior, route ownership, signing settings, key storage, Debug harness arguments, helmet controls, or Release behavior.
- Do not print, commit, hash, snapshot, or interpolate the ignored local AMap key in commands or reports.
- Start recovery tests from the production state `loadFailed == false`; the prior direct device probe's initial `true` state is forbidden.
- Stop and request action-time confirmation before granting any unexpected microphone or location permission.
- Follow RED → GREEN → mutation → restore for every production behavior change; finish each task with fresh focused and proportional broader verification.

---

## File Map

- Modify `ios/MaxHelmet/Navigation/AMapMapPresentation.swift`: make map eligibility independent of transient load failure.
- Modify `ios/MaxHelmet/Navigation/GuidanceMapHost.swift`: add the combined presentation contract, keep the native child mounted, and render the failure overlay through the generic container.
- Modify `ios/MaxHelmetTests/AMapMapPresentationTests.swift`: pin consent/key/geometry structural eligibility without a load input.
- Modify `ios/MaxHelmetTests/GuidanceMapHostPresentationTests.swift`: pin structural eligibility and the observed repeated-failure-then-success overlay sequence.
- Create `ios/MaxHelmetTests/GuidanceMapLoadContainerRenderingTests.swift`: host the production container with UIKit probes and verify stable map identity plus overlay lifetime.
- Complete `ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift`: replace the blocked draft's false-positive probe with a production-state observer and the shared load container.
- Update ignored `.superpowers/sdd/2026-08-14-ios-amap-load-recovery/task-1-report.md` and `task-2-report.md`: sanitized RED/GREEN/mutation/build/device evidence only.
- Update `.superpowers/sdd/2026-08-14-ios-amap-device-validation-harness/progress.md`: record that its blocked Task 2 resumes through this recovery plan.

---

### Task 1: Stable Production Map Container and Recovery Presentation

**Files:**

- Modify: `ios/MaxHelmet/Navigation/AMapMapPresentation.swift`
- Modify: `ios/MaxHelmet/Navigation/GuidanceMapHost.swift`
- Modify: `ios/MaxHelmetTests/AMapMapPresentationTests.swift`
- Modify: `ios/MaxHelmetTests/GuidanceMapHostPresentationTests.swift`
- Create: `ios/MaxHelmetTests/GuidanceMapLoadContainerRenderingTests.swift`

**Interfaces:**

- Consumes: `AMapConsentDecision`, `AMapAcceptedConsent`, `AMapConfiguration`, `AMapRouteDisplayModel`, `AMapRouteMap`, and the existing Chinese placeholder view.
- Produces: `amapMapPresentation(decision:hasAPIKey:hasGeometry:) -> AMapMapPresentation`, `guidanceMapHostViewState(decision:hasAPIKey:hasGeometry:requiresDevice:) -> GuidanceMapHostViewState`, `GuidanceMapHostPresentation`, `guidanceMapHostPresentation(decision:hasAPIKey:hasGeometry:loadFailed:requiresDevice:) -> GuidanceMapHostPresentation`, and `GuidanceMapLoadContainer<MapContent, FailureOverlay>`.

- [ ] **Step 1: Rewrite the pure tests around structural eligibility and recovery**

In `AMapMapPresentationTests`, remove the `loadFailed` arguments and replace the accepted-state test with this exact structural contract:

```swift
func testAcceptedRequiresOnlyKeyAndGeometryForStructuralMapEligibility() {
    XCTAssertEqual(
        amapMapPresentation(
            decision: .accepted,
            hasAPIKey: true,
            hasGeometry: true
        ),
        .map
    )

    for inputs in [(false, true), (true, false), (false, false)] {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .accepted,
                hasAPIKey: inputs.0,
                hasGeometry: inputs.1
            ),
            .unavailable
        )
    }
}
```

Keep the existing unknown and declined assertions, but call the new three-argument function.

In `GuidanceMapHostPresentationTests`, remove `loadFailed` from all direct `guidanceMapHostViewState` calls. Split the old combined unavailable test so only missing key, invalid geometry, and simulator execution are structurally unavailable. Add this recovery sequence test:

```swift
func testAcceptedMapStaysStructuralNativeThroughRepeatedFailuresAndRecovery() throws {
    let accepted = try XCTUnwrap(AMapAcceptedConsent(decision: .accepted))

    let healthy = guidanceMapHostPresentation(
        decision: .accepted,
        hasAPIKey: true,
        hasGeometry: true,
        loadFailed: false,
        requiresDevice: false
    )
    let failures = (0..<10).map { _ in
        guidanceMapHostPresentation(
            decision: .accepted,
            hasAPIKey: true,
            hasGeometry: true,
            loadFailed: true,
            requiresDevice: false
        )
    }
    let recovered = guidanceMapHostPresentation(
        decision: .accepted,
        hasAPIKey: true,
        hasGeometry: true,
        loadFailed: false,
        requiresDevice: false
    )

    XCTAssertEqual(healthy, .init(viewState: .nativeMap(accepted), showsUnavailableOverlay: false))
    XCTAssertTrue(failures.allSatisfy {
        $0 == .init(viewState: .nativeMap(accepted), showsUnavailableOverlay: true)
    })
    XCTAssertEqual(recovered, .init(viewState: .nativeMap(accepted), showsUnavailableOverlay: false))
}
```

Add a matrix test proving `showsUnavailableOverlay` is `false` for unknown, declined, missing-key, invalid-geometry, and simulator states even when `loadFailed` is `true`, because those states have no mounted native map to cover.

```swift
func testStatesWithoutNativeMapNeverShowLoadFailureOverlay() {
    let cases: [(
        decision: AMapConsentDecision,
        hasAPIKey: Bool,
        hasGeometry: Bool,
        requiresDevice: Bool,
        expected: GuidanceMapHostViewState
    )] = [
        (.unknown, true, true, false, .consentRequired),
        (.declined, true, true, false, .notEnabled),
        (.accepted, false, true, false, .unavailable),
        (.accepted, true, false, false, .unavailable),
        (.accepted, true, true, true, .unavailable),
    ]

    for item in cases {
        let presentation = guidanceMapHostPresentation(
            decision: item.decision,
            hasAPIKey: item.hasAPIKey,
            hasGeometry: item.hasGeometry,
            loadFailed: true,
            requiresDevice: item.requiresDevice
        )

        XCTAssertEqual(presentation.viewState, item.expected)
        XCTAssertFalse(presentation.showsUnavailableOverlay)
    }
}
```

- [ ] **Step 2: Add the failing mounted-identity renderer test**

Create `GuidanceMapLoadContainerRenderingTests.swift` with a production-container harness and UIKit probes:

```swift
import SwiftUI
import UIKit
import XCTest
@testable import MaxHelmet

@MainActor
final class GuidanceMapLoadContainerRenderingTests: XCTestCase {
    func testFailureSequenceKeepsSameMapMountedAndSuccessRemovesOnlyOverlay() throws {
        let state = LoadState()
        let mapTracker = ViewTracker(identifier: "test.guidance.map")
        let overlayTracker = ViewTracker(identifier: "test.guidance.unavailable")
        let root = LoadContainerHarness(
            state: state,
            mapTracker: mapTracker,
            overlayTracker: overlayTracker
        )
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 240))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        settle(controller)

        let originalMap = try XCTUnwrap(
            findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(mapTracker.makeCount, 1)
        XCTAssertEqual(mapTracker.dismantleCount, 0)

        for _ in 0..<10 {
            state.loadFailed = true
            settle(controller)
            XCTAssertTrue(
                originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
            )
            XCTAssertNotNil(
                findSubview(identifier: "test.guidance.unavailable", in: controller.view)
            )
            XCTAssertEqual(mapTracker.makeCount, 1)
            XCTAssertEqual(mapTracker.dismantleCount, 0)
        }

        state.loadFailed = false
        settle(controller)

        XCTAssertTrue(
            originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(mapTracker.makeCount, 1)
        XCTAssertEqual(mapTracker.dismantleCount, 0)
        XCTAssertEqual(overlayTracker.makeCount, 1)
        XCTAssertEqual(overlayTracker.dismantleCount, 1)

        state.loadFailed = true
        settle(controller)
        XCTAssertTrue(
            originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNotNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(mapTracker.makeCount, 1)
        XCTAssertEqual(mapTracker.dismantleCount, 0)

        state.loadFailed = false
        settle(controller)
        XCTAssertTrue(
            originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(overlayTracker.makeCount, 2)
        XCTAssertEqual(overlayTracker.dismantleCount, 2)

        withExtendedLifetime((window, controller)) {}
    }
}

@MainActor
private final class LoadState: ObservableObject {
    @Published var loadFailed = false
}

private struct LoadContainerHarness: View {
    @ObservedObject var state: LoadState
    let mapTracker: ViewTracker
    let overlayTracker: ViewTracker

    var body: some View {
        GuidanceMapLoadContainer(
            showsUnavailableOverlay: state.loadFailed,
            mapContent: { TrackedUIKitView(tracker: mapTracker) },
            failureOverlay: { TrackedUIKitView(tracker: overlayTracker) }
        )
    }
}

@MainActor
private final class ViewTracker {
    let identifier: String
    var makeCount = 0
    var dismantleCount = 0

    init(identifier: String) {
        self.identifier = identifier
    }
}

private struct TrackedUIKitView: UIViewRepresentable {
    let tracker: ViewTracker

    func makeCoordinator() -> Coordinator {
        Coordinator(tracker: tracker)
    }

    func makeUIView(context: Context) -> UIView {
        tracker.makeCount += 1
        let view = UIView()
        view.accessibilityIdentifier = tracker.identifier
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.tracker.dismantleCount += 1
    }

    final class Coordinator {
        let tracker: ViewTracker

        init(tracker: ViewTracker) {
            self.tracker = tracker
        }
    }
}
```

Add these exact renderer helpers:

```swift
@MainActor
private func settle(_ controller: UIViewController) {
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    controller.view.layoutIfNeeded()
}

private func findSubview(identifier: String, in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == identifier { return root }
    for child in root.subviews {
        if let match = findSubview(identifier: identifier, in: child) { return match }
    }
    return nil
}
```

Do not import or instantiate AMap in this simulator renderer test.

- [ ] **Step 3: Run the focused tests and verify RED**

Run from the repository root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapMapPresentationTests \
  -only-testing:MaxHelmetTests/GuidanceMapHostPresentationTests \
  -only-testing:MaxHelmetTests/GuidanceMapLoadContainerRenderingTests
```

Expected: compilation fails because the revised presentation signatures, `GuidanceMapHostPresentation`, and `GuidanceMapLoadContainer` do not exist. Record the sanitized failing symbol categories in the task report.

- [ ] **Step 4: Remove transient failure from structural AMap eligibility**

Change `AMapMapPresentation.swift` to:

```swift
enum AMapMapPresentation: Equatable {
    case consentRequired
    case map
    case notEnabled
    case unavailable
}

func amapMapPresentation(
    decision: AMapConsentDecision,
    hasAPIKey: Bool,
    hasGeometry: Bool
) -> AMapMapPresentation {
    switch decision {
    case .unknown:
        return .consentRequired
    case .declined:
        return .notEnabled
    case .accepted:
        return hasAPIKey && hasGeometry ? .map : .unavailable
    }
}
```

No overload may retain `loadFailed` as a structural input.

- [ ] **Step 5: Add the production presentation and stable container**

In `GuidanceMapHost.swift`, remove `loadFailed` from `guidanceMapHostViewState` and from its call to `amapMapPresentation`. Add:

```swift
struct GuidanceMapHostPresentation: Equatable {
    let viewState: GuidanceMapHostViewState
    let showsUnavailableOverlay: Bool
}

func guidanceMapHostPresentation(
    decision: AMapConsentDecision,
    hasAPIKey: Bool,
    hasGeometry: Bool,
    loadFailed: Bool,
    requiresDevice: Bool
) -> GuidanceMapHostPresentation {
    let viewState = guidanceMapHostViewState(
        decision: decision,
        hasAPIKey: hasAPIKey,
        hasGeometry: hasGeometry,
        requiresDevice: requiresDevice
    )
    let hasNativeMap: Bool
    if case .nativeMap = viewState {
        hasNativeMap = true
    } else {
        hasNativeMap = false
    }
    return GuidanceMapHostPresentation(
        viewState: viewState,
        showsUnavailableOverlay: hasNativeMap && loadFailed
    )
}

struct GuidanceMapLoadContainer<MapContent: View, FailureOverlay: View>: View {
    let showsUnavailableOverlay: Bool
    private let mapContent: MapContent
    private let failureOverlay: FailureOverlay

    init(
        showsUnavailableOverlay: Bool,
        @ViewBuilder mapContent: () -> MapContent,
        @ViewBuilder failureOverlay: () -> FailureOverlay
    ) {
        self.showsUnavailableOverlay = showsUnavailableOverlay
        self.mapContent = mapContent()
        self.failureOverlay = failureOverlay()
    }

    var body: some View {
        ZStack {
            mapContent
            if showsUnavailableOverlay {
                failureOverlay
            }
        }
    }
}
```

Replace the host's private `viewState` property with a `presentation` property that calls `guidanceMapHostPresentation`. Switch the body on `presentation.viewState`.

For `.nativeMap`, keep the existing key/model unwrap but render:

```swift
GuidanceMapLoadContainer(
    showsUnavailableOverlay: presentation.showsUnavailableOverlay,
    mapContent: {
        AMapRouteMap(
            model: model,
            consent: consent,
            apiKey: apiKey,
            loadFailed: $loadFailed
        )
    },
    failureOverlay: {
        placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
    }
)
```

Do not branch around `GuidanceMapLoadContainer` based on `loadFailed`. Missing model or key still uses the existing unavailable placeholder without constructing AMap.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run the Step 3 command again.

Expected: all presentation and renderer tests pass; the renderer observes one stable map view, one overlay lifetime, and no AMap/MAMap simulator linkage error.

- [ ] **Step 7: Prove the tests catch all three regressions**

Perform each mutation independently, run the Step 3 command, record the intended failure, and restore before the next mutation:

1. In `guidanceMapHostPresentation`, change the native `viewState` to `.unavailable` when `loadFailed` is true. The repeated-failure presentation test must fail.
2. Remove `failureOverlay` from `GuidanceMapLoadContainer.body`. The renderer test must fail because the overlay probe never appears.
3. Change the container condition so the overlay remains present when `showsUnavailableOverlay` becomes false. The renderer test must fail after the recovery transition.

After restoring all mutations, rerun the focused tests and `git diff --check`.

- [ ] **Step 8: Run proportional workspace verification**

Run the full no-key simulator suite:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  AMAP_IOS_KEY=
```

Run no-key simulator and generic-device builds in both configurations:

```bash
for configuration in Debug Release; do
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild build \
    -workspace ios/MaxHelmet.xcworkspace \
    -scheme MaxHelmet \
    -configuration "$configuration" \
    -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
    AMAP_IOS_KEY=

  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild build \
    -workspace ios/MaxHelmet.xcworkspace \
    -scheme MaxHelmet \
    -configuration "$configuration" \
    -destination 'generic/platform=iOS' \
    AMAP_IOS_KEY= \
    CODE_SIGNING_ALLOWED=NO
done
```

Expected: all commands exit zero; the ordinary physical-device integration test remains skipped on simulator; simulator logs contain no AMap/MAMap undefined symbols. Keep complete output in local temporary logs and report only sanitized summaries.

- [ ] **Step 9: Commit Task 1**

```bash
git add ios/MaxHelmet/Navigation/AMapMapPresentation.swift \
  ios/MaxHelmet/Navigation/GuidanceMapHost.swift \
  ios/MaxHelmetTests/AMapMapPresentationTests.swift \
  ios/MaxHelmetTests/GuidanceMapHostPresentationTests.swift \
  ios/MaxHelmetTests/GuidanceMapLoadContainerRenderingTests.swift
git diff --cached --check
git commit -m "fix(ios): recover transient AMap loads"
```

Expected: the blocked, untracked `AMapPhysicalDeviceIntegrationTests.swift` draft is not included in this commit.

---

### Task 2: Production-State Physical Renderer Validation

**Files:**

- Complete: `ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift`
- Update: `.superpowers/sdd/2026-08-14-ios-amap-device-validation-harness/progress.md`

**Interfaces:**

- Consumes: `GuidanceMapLoadContainer`, `AMapDeviceValidationHarness.guidanceFixture`, `AMapRouteDisplayModel.make(guidance:)`, persisted `AMapConsentStore.decision`, `AMapAcceptedConsent`, `AMapConfiguration`, and production `AMapRouteMap`.
- Produces: one opt-in `AMapPhysicalDeviceIntegrationTests.testConfiguredDeviceLoadsNativeRouteMap()` that starts from `loadFailed == false`, uses the production container, waits for an actual success callback, and keeps all AMap/UIKit code behind the physical opt-in compilation condition.

- [ ] **Step 1: Rewrite the device probe to match production initial state**

Keep the simulator skip branch unchanged. In the physical opt-in branch, replace the direct `AMapRouteMap` root with:

```swift
let loadFinished = expectation(description: "AMap map load finished")
let probe = DeviceMapLoadProbe(loadFinished: loadFinished)
let root = DeviceMapRecoveryHarness(
    model: model,
    consent: consent,
    apiKey: key,
    probe: probe
)
```

Add the production-container harness:

```swift
private struct DeviceMapRecoveryHarness: View {
    let model: AMapRouteDisplayModel
    let consent: AMapAcceptedConsent
    let apiKey: String
    @ObservedObject var probe: DeviceMapLoadProbe

    var body: some View {
        GuidanceMapLoadContainer(
            showsUnavailableOverlay: probe.failed,
            mapContent: {
                AMapRouteMap(
                    model: model,
                    consent: consent,
                    apiKey: apiKey,
                    loadFailed: probe.binding
                )
            },
            failureOverlay: {
                Text("地图暂不可用")
            }
        )
    }
}
```

Replace `DeviceMapLoadProbe` with a production-state observer:

```swift
@MainActor
private final class DeviceMapLoadProbe: ObservableObject {
    @Published private(set) var failed = false
    private(set) var callbacks: [Bool] = []
    private var fulfilledSuccess = false
    private let loadFinished: XCTestExpectation

    init(loadFinished: XCTestExpectation) {
        self.loadFinished = loadFinished
    }

    var binding: Binding<Bool> {
        Binding(
            get: { self.failed },
            set: { next in
                self.callbacks.append(next)
                self.failed = next
                if !next, !self.fulfilledSuccess {
                    self.fulfilledSuccess = true
                    self.loadFinished.fulfill()
                }
            }
        )
    }
}
```

After waiting, assert `probe.callbacks.last == false` and `probe.failed == false`. Do not require at least one failure callback because an immediate SDK success is valid. Keep the existing route overlay, rider annotation, finite viewport, disabled interaction, visible attribution, and completed snapshot assertions.

```swift
wait(for: [loadFinished], timeout: 20)
XCTAssertEqual(probe.callbacks.last, false)
XCTAssertFalse(probe.failed)
```

- [ ] **Step 2: Prove the ordinary simulator path still skips cleanly**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapPhysicalDeviceIntegrationTests
```

Expected: exactly one skipped test, zero failures, and no AMap/MAMap undefined symbol.

- [ ] **Step 3: Re-establish production consent without bypassing the disclosure**

Resolve the already paired physical iPhone and existing app team without printing either value:

```bash
destination_output=/tmp/maxhelmet-recovery-destinations.txt
settings_output=/tmp/maxhelmet-recovery-settings.txt
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
```

Build the configured Debug app with output redirected, resolve its concrete path using a no-key settings query, install it, and launch both harness arguments:

```bash
build_output=/tmp/maxhelmet-recovery-device-build.txt
install_output=/tmp/maxhelmet-recovery-device-install.txt
launch_output=/tmp/maxhelmet-recovery-device-launch.txt
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -configuration Debug \
  -destination "id=$DEVICE_ID" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" >"$build_output" 2>&1
TARGET_BUILD_DIR=$(awk -F ' = ' '$1 ~ /TARGET_BUILD_DIR$/ { print $2; exit }' "$settings_output")
WRAPPER_NAME=$(awk -F ' = ' '$1 ~ /WRAPPER_NAME$/ { print $2; exit }' "$settings_output")
APP_PATH="$TARGET_BUILD_DIR/$WRAPPER_NAME"
test -d "$APP_PATH"
xcrun devicectl device install app \
  --device "$DEVICE_ID" "$APP_PATH" >"$install_output" 2>&1
xcrun devicectl device process launch \
  --device "$DEVICE_ID" \
  --terminate-existing \
  io.github.henrycooper86.max \
  -- --debug-amap-route --debug-reset-amap-consent >"$launch_output" 2>&1
```

Through the visible production UI:

1. choose **暂不启用**;
2. choose **启用地图**;
3. choose **同意并启用**; and
4. confirm that transient **地图暂不可用** presentation can recover to native AMap tiles, route, rider marker, fitted viewport, and attribution.

Do not write the consent default from a command or test helper. If the mirrored iPhone surface rejects pointer delivery, ask the user to perform only these physical taps. If a microphone or location prompt appears, stop without granting it and request confirmation.

- [ ] **Step 4: Run the opted-in test on the paired iPhone**

Resolve the paired device and team again in the current shell without printing them, then run the test:

```bash
destination_output=/tmp/maxhelmet-recovery-test-destinations.txt
settings_output=/tmp/maxhelmet-recovery-test-settings.txt
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

Expected: exactly one executed test passes rather than skips. Report only callback Booleans and assertion categories; never report the key, device identifier, team identifier, provisioning profile, or full SDK error object.

- [ ] **Step 5: Prove consent and renderer failures cannot pass falsely**

Perform and restore each mutation independently:

1. Reset the persisted decision through the Debug harness, then run the device test. It must fail the `.accepted` assertion before key lookup or SDK construction. Re-accept only through the production disclosure.
2. Remove `context.coordinator.render(model, on: mapView)` from `AMapRouteMap.makeUIView`. The opted-in test must fail the route overlay or rider annotation assertions.
3. Set `mapView.isUserInteractionEnabled = true`. The opted-in test must fail its display-only assertion.
4. Remove the `false` assignment from `mapViewDidFinishLoadingMap`. Because the probe starts `false` but fulfills only on an actual setter write, the test must time out instead of passing from its initial value.

After every mutation, restore the source before continuing. Finish by rerunning both the opted-in physical test and simulator skip test on the final restored code.

- [ ] **Step 6: Record the recovered visible flow and resume the original ledger**

Update the ignored recovery task report with sanitized callback order, visible recovery result, test/build summaries, and any user-performed physical taps. Update the existing device-validation ledger to state that its Task 2 blocker was resolved by the committed load-recovery task and that the strengthened physical test passed. Do not include identifiers, paths to local secrets, SDK error bodies, or the key.

- [ ] **Step 7: Commit Task 2**

```bash
git add ios/MaxHelmetTests/AMapPhysicalDeviceIntegrationTests.swift
git diff --cached --check
git commit -m "test(ios): validate recoverable AMap rendering"
```

Expected: only the physical-device integration test is committed. The SDD reports and ledger remain ignored execution artifacts; no signing, project, pod, or key file is staged.

---

## Plan Completion Gate

Before declaring this recovery plan complete:

- obtain fresh spec-compliance and code-quality review for each task;
- run the focused recovery tests, full no-key simulator suite, simulator build, and generic iPhoneOS build from the final committed tree;
- run the opted-in physical-device test and visibly confirm recovered native AMap tiles through the production Debug harness;
- scan tracked files and commit history introduced by this plan for AMap-key assignments or literal key material without printing candidate values:

  ```bash
  if git grep -I -q -E \
    'AMAP_IOS_KEY[[:space:]]*=[[:space:]]*[[:xdigit:]]{32}' -- .; then
    exit 1
  fi
  if git log -p 502301f..HEAD -- . | rg -q \
    'AMAP_IOS_KEY[[:space:]]*=[[:space:]]*[[:xdigit:]]{32}'; then
    exit 1
  fi
  ```

- verify `git status --short` contains no unexpected tracked or untracked files; and
- then return to Task 3 of `2026-08-14-ios-amap-device-validation-harness.md` for documentation and final end-to-end verification.
