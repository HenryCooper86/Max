# iOS AMap Route Display and Helmet-Only Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the iOS guidance card's MapKit surface with a consent-gated native AMap route display and make the helmet the only hands-free start/stop control.

**Architecture:** Keep relay routing, `NavigationController`, `GuidanceEngine`, and `GuidanceState` in their current WGS-84 pipeline. Add pure consent/configuration and WGS-84-to-GCJ-02 display models, then place a display-only `MAMapView` behind a SwiftUI gate that cannot construct it before consent. Remove the microphone dock and its model while preserving the helmet toggle and the separate in-session mute utility.

**Tech Stack:** Swift 5, SwiftUI, UIKit interoperability, Core Location, AMap 3D Map SDK 11.2 no-IDFA, CocoaPods 1.16, XCTest, Xcode 26.6 / iOS 26.5 simulator.

## Global Constraints

- Minimum deployment target remains iOS 17.0.
- Use `pod 'AMap3DMap-NO-IDFA', '~> 11.2'`; commit the exact resolved version in `Podfile.lock`.
- After CocoaPods integration, all app builds and XCTest runs use `ios/MaxHelmet.xcworkspace`, never the project directly.
- The registered AMap iOS key is supplied only through ignored `ios/Config/Secrets.xcconfig` or the `AMAP_IOS_KEY` build setting. Never commit, print, assert, snapshot, or log it.
- Do not call any AMap SDK method or instantiate any AMap SDK object before the rider accepts the AMap disclosure.
- Consent appears just in time when the first route card needs a map. A recorded decline does not prompt again unless the rider explicitly taps “启用地图”.
- `GuidanceState`, Core Location, `NavigationController`, and `GuidanceEngine` remain WGS-84. Only the AMap display model converts to GCJ-02.
- Do not change relay routing, voice navigation grammar, prompt thresholds, reroute behavior, arrival behavior, or device-result truthfulness.
- Do not add AMap Search, Location, or Navigation SDKs; the map SDK is display-only.
- Do not retain or add a MapKit fallback.
- Disable map interaction and AMap user-location acquisition; render the route and existing `GuidanceState.currentLocation` only.
- The helmet remains a two-way toggle: tap to start, tap again to stop or cancel connection.
- Keep `MuteUtilityPill` as a distinct active-session action with a minimum 44-point target.
- Run scoped tests while iterating and the complete `MaxHelmetTests` suite plus a no-key app build before completion.

---

## File Structure

### New files

- `ios/Gemfile` — reproducible CocoaPods tool dependency.
- `ios/Gemfile.lock` — exact Ruby dependency resolution.
- `ios/Podfile` — AMap no-IDFA map dependency and test search-path inheritance.
- `ios/Podfile.lock` — exact native SDK resolution.
- `ios/Config/Debug.xcconfig` — Debug build defaults, Pods settings, optional local secret include.
- `ios/Config/Release.xcconfig` — Release build defaults, Pods settings, optional local secret include.
- `ios/Config/Secrets.xcconfig.example` — checked-in empty key template.
- `ios/Config/Secrets.xcconfig` — ignored local key value; never stage or commit.
- `ios/MaxHelmet/MaxHelmet-Bridging-Header.h` — AMap Foundation and Map headers for Swift.
- `ios/MaxHelmet/Navigation/AMapConfiguration.swift` — sanitized bundle key lookup.
- `ios/MaxHelmet/Navigation/AMapConsentStore.swift` — persisted consent decision and prompt lifecycle.
- `ios/MaxHelmet/Navigation/AMapMapPresentation.swift` — pure map-state gate.
- `ios/MaxHelmet/Navigation/AMapRouteDisplayModel.swift` — pure validated WGS-84-to-GCJ-02 display geometry.
- `ios/MaxHelmet/Navigation/AMapSDKBootstrapper.swift` — exactly-once SDK privacy/key setup.
- `ios/MaxHelmet/Navigation/AMapRouteMap.swift` — display-only `MAMapView` bridge and coordinator.
- `ios/MaxHelmet/Navigation/AMapConsentSheet.swift` — Chinese just-in-time disclosure UI.
- `ios/MaxHelmet/Navigation/GuidanceMapHost.swift` — consent/configuration/error gate around the native map.
- `ios/MaxHelmet/UI/VoiceUtilityPill.swift` — retained mute-only utility extracted from the deleted dock.
- `ios/MaxHelmetTests/AMapConfigurationTests.swift` — bundle-key sanitation tests.
- `ios/MaxHelmetTests/AMapConsentStoreTests.swift` — consent persistence and reconsideration tests.
- `ios/MaxHelmetTests/AMapMapPresentationTests.swift` — no-SDK-before-consent state-selection tests.
- `ios/MaxHelmetTests/AMapRouteDisplayModelTests.swift` — conversion, validation, bounds, and immutability tests.
- `ios/MaxHelmetTests/AMapSDKBootstrapperTests.swift` — empty-key and exactly-once configuration tests.
- `ios/MaxHelmetTests/VoiceUtilityPillTests.swift` — retained mute target test.

### Modified files

- `.gitignore` — ignore CocoaPods/Ruby output and the local key file.
- `ios/MaxHelmet.xcodeproj/project.pbxproj` — attach Debug/Release xcconfigs and the bridging header.
- `ios/MaxHelmet/Info.plist` — inject `HorizonAMapKey` from `AMAP_IOS_KEY`.
- `ios/MaxHelmet/Info-Debug.plist` — same Debug key injection.
- `ios/MaxHelmet/Navigation/GuidanceCard.swift` — replace MapKit with `GuidanceMapHost`.
- `ios/MaxHelmet/UI/AgentScreen.swift` — remove dock instances, pass session state to helmet accessibility.
- `ios/MaxHelmet/UI/AgentScreenLayout.swift` — reclaim dock height.
- `ios/MaxHelmetTests/AgentScreenLayoutTests.swift` — pin new chrome reservations.
- `ios/MaxHelmetTests/HelmetPresentationTests.swift` — pin helmet toggle label semantics.
- `README.md` — document helmet-only toggle and native AMap display.
- `ios/README.md` — document CocoaPods/workspace setup, key injection, consent, and interaction.
- `docs/live-agent-testing.md` — update active iOS build commands to the workspace.

### Deleted files

- `ios/MaxHelmet/UI/VoiceMicDock.swift` — duplicate session control and input meter.
- `ios/MaxHelmet/UI/VoiceMicDockModel.swift` — dead dock presentation, meter curve, and transitions.
- `ios/MaxHelmetTests/VoiceMicDockTests.swift` — tests for deleted behavior; the mute target assertion moves.

---

### Task 1: CocoaPods, Workspace, and Sanitized Key Plumbing

**Files:**
- Create: `ios/Gemfile`
- Create: `ios/Gemfile.lock` (generated)
- Create: `ios/Podfile`
- Create: `ios/Podfile.lock` (generated)
- Create: `ios/Config/Debug.xcconfig`
- Create: `ios/Config/Release.xcconfig`
- Create: `ios/Config/Secrets.xcconfig.example`
- Create locally, never commit: `ios/Config/Secrets.xcconfig`
- Create: `ios/MaxHelmet/MaxHelmet-Bridging-Header.h`
- Create: `ios/MaxHelmet/Navigation/AMapConfiguration.swift`
- Create: `ios/MaxHelmetTests/AMapConfigurationTests.swift`
- Modify: `.gitignore`
- Modify: `ios/MaxHelmet.xcodeproj/project.pbxproj`
- Modify: `ios/MaxHelmet/Info.plist`
- Modify: `ios/MaxHelmet/Info-Debug.plist`

**Interfaces:**
- Produces: `AMapConfiguration.init(infoDictionary: [String: Any])`
- Produces: `AMapConfiguration.apiKey: String?`
- Produces: `AMapConfiguration.hasAPIKey: Bool`
- Produces: `ios/MaxHelmet.xcworkspace` for every later build/test command.

- [ ] **Step 1: Write the failing configuration tests**

Create `ios/MaxHelmetTests/AMapConfigurationTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class AMapConfigurationTests: XCTestCase {
    func testTrimsAConfiguredKey() {
        let configuration = AMapConfiguration(
            infoDictionary: [AMapConfiguration.plistKey: "  bundle-restricted-value  "]
        )
        XCTAssertEqual(configuration.apiKey, "bundle-restricted-value")
        XCTAssertTrue(configuration.hasAPIKey)
    }

    func testMissingEmptyAndUnexpandedBuildSettingsAreUnavailable() {
        for value in [nil, "", "   ", "$(AMAP_IOS_KEY)"] {
            var dictionary: [String: Any] = [:]
            if let value { dictionary[AMapConfiguration.plistKey] = value }
            let configuration = AMapConfiguration(infoDictionary: dictionary)
            XCTAssertNil(configuration.apiKey)
            XCTAssertFalse(configuration.hasAPIKey)
        }
    }
}
```

- [ ] **Step 2: Run the new test to verify RED**

Run from the repository root before CocoaPods changes:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -project ios/MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapConfigurationTests
```

Expected: build failure because `AMapConfiguration` does not exist.

- [ ] **Step 3: Add the pure configuration reader**

Create `ios/MaxHelmet/Navigation/AMapConfiguration.swift`:

```swift
import Foundation

struct AMapConfiguration: Equatable {
    static let plistKey = "HorizonAMapKey"

    let apiKey: String?

    init(infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:]) {
        let raw = (infoDictionary[Self.plistKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        apiKey = raw.isEmpty || raw.hasPrefix("$(") ? nil : raw
    }

    var hasAPIKey: Bool { apiKey != nil }
}
```

- [ ] **Step 4: Add reproducible CocoaPods inputs**

Create `ios/Gemfile`:

```ruby
source "https://rubygems.org"

gem "cocoapods", "~> 1.16"
```

Create `ios/Podfile`:

```ruby
platform :ios, "17.0"
project "MaxHelmet.xcodeproj"

target "MaxHelmet" do
  pod "AMap3DMap-NO-IDFA", "~> 11.2"

  target "MaxHelmetTests" do
    inherit! :search_paths
  end
end
```

Create `ios/MaxHelmet/MaxHelmet-Bridging-Header.h`:

```objc
#import <AMapFoundationKit/AMapFoundationKit.h>
#import <MAMapKit/MAMapKit.h>
```

- [ ] **Step 5: Add build configurations that preserve Pods settings and optionally include the local key**

Create `ios/Config/Debug.xcconfig`:

```xcconfig
AMAP_IOS_KEY =
#include? "../Pods/Target Support Files/Pods-MaxHelmet/Pods-MaxHelmet.debug.xcconfig"
#include? "Secrets.xcconfig"
```

Create `ios/Config/Release.xcconfig`:

```xcconfig
AMAP_IOS_KEY =
#include? "../Pods/Target Support Files/Pods-MaxHelmet/Pods-MaxHelmet.release.xcconfig"
#include? "Secrets.xcconfig"
```

Create `ios/Config/Secrets.xcconfig.example`:

```xcconfig
AMAP_IOS_KEY =
```

Add these objects to `project.pbxproj`:

```text
/* PBXFileReference */
7D0000000000000000000001 /* Debug.xcconfig */ = {
    isa = PBXFileReference;
    lastKnownFileType = text.xcconfig;
    path = Debug.xcconfig;
    sourceTree = "<group>";
};
7D0000000000000000000002 /* Release.xcconfig */ = {
    isa = PBXFileReference;
    lastKnownFileType = text.xcconfig;
    path = Release.xcconfig;
    sourceTree = "<group>";
};

/* PBXGroup */
7D0000000000000000000003 /* Configuration */ = {
    isa = PBXGroup;
    children = (
        7D0000000000000000000001 /* Debug.xcconfig */,
        7D0000000000000000000002 /* Release.xcconfig */,
    );
    path = Config;
    sourceTree = "<group>";
};
```

Add `7D0000000000000000000003 /* Configuration */` to the main group's
`children` before `Products`. Set the app target build configurations:

```text
7A000000000000000000000C /* Debug */:
    baseConfigurationReference = 7D0000000000000000000001 /* Debug.xcconfig */;

7A000000000000000000000D /* Release */:
    baseConfigurationReference = 7D0000000000000000000002 /* Release.xcconfig */;
```

Add this build setting to both app target configurations:

```text
SWIFT_OBJC_BRIDGING_HEADER = "MaxHelmet/MaxHelmet-Bridging-Header.h";
```

Do not replace the test target's CocoaPods-generated base configurations.

- [ ] **Step 6: Inject the build setting into both app plists and ignore local/generated files**

Add to both `Info.plist` and `Info-Debug.plist` immediately after `HorizonGitCommit`:

```xml
<key>HorizonAMapKey</key>
<string>$(AMAP_IOS_KEY)</string>
```

Append to `.gitignore`:

```gitignore
# iOS dependency output and local AMap credential
ios/Pods/
ios/vendor/bundle/
ios/.bundle/
ios/Config/Secrets.xcconfig
```

Create `ios/Config/Secrets.xcconfig` from the example and set its right-hand side to the already-provided bundle-restricted key without echoing the value in terminal output. Confirm `git status --short` never lists this file.

- [ ] **Step 7: Install the tool and SDK dependencies**

Run:

```bash
cd ios
bundle config set --local path vendor/bundle
bundle install
bundle exec pod install --repo-update
```

Expected: `Gemfile.lock`, `Podfile.lock`, and `MaxHelmet.xcworkspace` exist; the resolved pod is `AMap3DMap-NO-IDFA` 11.2.x; CocoaPods may note the custom app xcconfigs, but both custom files explicitly include the matching Pods xcconfig.

- [ ] **Step 8: Run the configuration test and a no-key build through the workspace**

Run:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapConfigurationTests

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  AMAP_IOS_KEY= \
  CODE_SIGNING_ALLOWED=NO
```

Expected: test PASS and build succeeds with an intentionally empty key.

- [ ] **Step 9: Commit dependency and key plumbing without the secret**

```bash
git add .gitignore ios/Gemfile ios/Gemfile.lock ios/Podfile ios/Podfile.lock \
  ios/Config/Debug.xcconfig ios/Config/Release.xcconfig \
  ios/Config/Secrets.xcconfig.example ios/MaxHelmet/MaxHelmet-Bridging-Header.h \
  ios/MaxHelmet.xcodeproj/project.pbxproj ios/MaxHelmet/Info.plist \
  ios/MaxHelmet/Info-Debug.plist ios/MaxHelmet/Navigation/AMapConfiguration.swift \
  ios/MaxHelmetTests/AMapConfigurationTests.swift
git diff --cached --check
git diff --cached | rg -n 'AMAP_IOS_KEY = .+' && exit 1 || true
git commit -m "build(ios): add AMap map SDK configuration"
```

Expected: the staged-key scan finds no non-empty assignment.

---

### Task 2: Persisted Consent and the Pure Map Gate

**Files:**
- Create: `ios/MaxHelmet/Navigation/AMapConsentStore.swift`
- Create: `ios/MaxHelmet/Navigation/AMapMapPresentation.swift`
- Create: `ios/MaxHelmetTests/AMapConsentStoreTests.swift`
- Create: `ios/MaxHelmetTests/AMapMapPresentationTests.swift`

**Interfaces:**
- Consumes: `AMapConfiguration.hasAPIKey`
- Produces: `AMapConsentDecision { unknown, accepted, declined }`
- Produces: `AMapConsentStore.requestIfNeeded()`, `accept()`, `decline()`, `reconsider()`
- Produces: `AMapMapPresentation { consentRequired, map, notEnabled, unavailable }`
- Produces: `amapMapPresentation(decision:hasAPIKey:hasGeometry:loadFailed:)`

- [ ] **Step 1: Write failing consent-store tests**

Create `ios/MaxHelmetTests/AMapConsentStoreTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

@MainActor
final class AMapConsentStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "AMapConsentStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testUnknownPromptsExactlyWhenRequested() {
        let store = AMapConsentStore(defaults: defaults)
        XCTAssertEqual(store.decision, .unknown)
        XCTAssertFalse(store.isPromptPresented)
        store.requestIfNeeded()
        XCTAssertTrue(store.isPromptPresented)
    }

    func testAcceptanceAndDeclinePersistWithoutAutomaticReprompt() {
        let accepted = AMapConsentStore(defaults: defaults)
        accepted.accept()
        XCTAssertEqual(AMapConsentStore(defaults: defaults).decision, .accepted)

        let secondDefaults = UserDefaults(suiteName: "AMapConsentStoreTests.\(UUID().uuidString)")!
        let declined = AMapConsentStore(defaults: secondDefaults)
        declined.decline()
        let relaunched = AMapConsentStore(defaults: secondDefaults)
        relaunched.requestIfNeeded()
        XCTAssertEqual(relaunched.decision, .declined)
        XCTAssertFalse(relaunched.isPromptPresented)
    }

    func testDeclinedRiderCanExplicitlyReconsiderAndAccept() {
        let store = AMapConsentStore(defaults: defaults)
        store.decline()
        store.reconsider()
        XCTAssertTrue(store.isPromptPresented)
        store.accept()
        XCTAssertEqual(store.decision, .accepted)
        XCTAssertFalse(store.isPromptPresented)
    }
}
```

- [ ] **Step 2: Write failing presentation-gate tests**

Create `ios/MaxHelmetTests/AMapMapPresentationTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class AMapMapPresentationTests: XCTestCase {
    func testUnknownAlwaysRequiresConsentBeforeAnyMapState() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .unknown, hasAPIKey: true, hasGeometry: true, loadFailed: false
            ),
            .consentRequired
        )
    }

    func testDeclineWinsWithoutConstructingAMap() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .declined, hasAPIKey: true, hasGeometry: true, loadFailed: false
            ),
            .notEnabled
        )
    }

    func testAcceptedRequiresKeyGeometryAndHealthyLoad() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .accepted, hasAPIKey: true, hasGeometry: true, loadFailed: false
            ),
            .map
        )
        for inputs in [(false, true, false), (true, false, false), (true, true, true)] {
            XCTAssertEqual(
                amapMapPresentation(
                    decision: .accepted,
                    hasAPIKey: inputs.0,
                    hasGeometry: inputs.1,
                    loadFailed: inputs.2
                ),
                .unavailable
            )
        }
    }
}
```

- [ ] **Step 3: Run both test classes to verify RED**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapConsentStoreTests \
  -only-testing:MaxHelmetTests/AMapMapPresentationTests
```

Expected: build failure because the consent and presentation types do not exist.

- [ ] **Step 4: Implement the persisted consent store**

Create `ios/MaxHelmet/Navigation/AMapConsentStore.swift`:

```swift
import Combine
import Foundation

enum AMapConsentDecision: String, Equatable {
    case unknown
    case accepted
    case declined
}

@MainActor
final class AMapConsentStore: ObservableObject {
    static let defaultsKey = "amap_map_consent"

    @Published private(set) var decision: AMapConsentDecision
    @Published var isPromptPresented = false

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        decision = defaults.string(forKey: Self.defaultsKey)
            .flatMap(AMapConsentDecision.init(rawValue:)) ?? .unknown
    }

    func requestIfNeeded() {
        if decision == .unknown { isPromptPresented = true }
    }

    func accept() {
        setDecision(.accepted)
    }

    func decline() {
        setDecision(.declined)
    }

    func reconsider() {
        isPromptPresented = true
    }

    private func setDecision(_ next: AMapConsentDecision) {
        decision = next
        defaults.set(next.rawValue, forKey: Self.defaultsKey)
        isPromptPresented = false
    }
}
```

- [ ] **Step 5: Implement the pure state gate**

Create `ios/MaxHelmet/Navigation/AMapMapPresentation.swift`:

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
    hasGeometry: Bool,
    loadFailed: Bool
) -> AMapMapPresentation {
    switch decision {
    case .unknown:
        return .consentRequired
    case .declined:
        return .notEnabled
    case .accepted:
        return hasAPIKey && hasGeometry && !loadFailed ? .map : .unavailable
    }
}
```

- [ ] **Step 6: Run GREEN and commit**

Repeat the scoped test command from Step 3. Expected: all tests PASS.

```bash
git add ios/MaxHelmet/Navigation/AMapConsentStore.swift \
  ios/MaxHelmet/Navigation/AMapMapPresentation.swift \
  ios/MaxHelmetTests/AMapConsentStoreTests.swift \
  ios/MaxHelmetTests/AMapMapPresentationTests.swift
git commit -m "feat(ios): add AMap consent gate"
```

---

### Task 3: Validated GCJ-02 Display Geometry

**Files:**
- Create: `ios/MaxHelmet/Navigation/AMapRouteDisplayModel.swift`
- Create: `ios/MaxHelmetTests/AMapRouteDisplayModelTests.swift`

**Interfaces:**
- Consumes: `GuidanceState`
- Consumes: `CoordinateDatum.wgs84ToGcj02(_:)`
- Produces: `AMapCoordinateBounds`
- Produces: `AMapRouteDisplayModel.make(guidance:) -> AMapRouteDisplayModel?`
- Guarantees: every stored coordinate is finite GCJ-02; bounds always have non-zero finite spans.

- [ ] **Step 1: Write the failing geometry tests**

Create `ios/MaxHelmetTests/AMapRouteDisplayModelTests.swift`:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

final class AMapRouteDisplayModelTests: XCTestCase {
    private func guidance(
        polyline: [CLLocationCoordinate2D],
        current: CLLocationCoordinate2D? = nil
    ) -> GuidanceState {
        GuidanceState(
            destinationName: "人民广场",
            polyline: polyline,
            currentLocation: current,
            maneuverInstruction: "右转",
            distanceToManeuverMeters: 120,
            remainingDistanceMeters: 1200,
            remainingSeconds: 300,
            offRoute: false
        )
    }

    func testConvertsRouteAndRiderToGCJ02WithoutMutatingGuidance() throws {
        let start = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        let end = CLLocationCoordinate2D(latitude: 31.2314, longitude: 121.4750)
        let input = guidance(polyline: [start, end], current: start)
        let original = input

        let model = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: input))

        XCTAssertTrue(coordinatesEqual(model.polyline[0], CoordinateDatum.wgs84ToGcj02(start)))
        XCTAssertTrue(coordinatesEqual(try XCTUnwrap(model.currentLocation), CoordinateDatum.wgs84ToGcj02(start)))
        XCTAssertEqual(input, original)
    }

    func testRejectsShortOrNonFiniteGeometry() {
        let valid = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid, .init(latitude: .nan, longitude: 121)])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid, valid], current: .init(latitude: 31, longitude: .infinity))))
    }

    func testDegenerateRouteGetsFiniteNonZeroBounds() throws {
        let point = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        let model = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: guidance(polyline: [point, point])))
        XCTAssertGreaterThan(model.bounds.latitudeSpan, 0)
        XCTAssertGreaterThan(model.bounds.longitudeSpan, 0)
        XCTAssertTrue(model.bounds.latitudeSpan.isFinite)
        XCTAssertTrue(model.bounds.longitudeSpan.isFinite)
    }
}
```

- [ ] **Step 2: Run the geometry test to verify RED**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapRouteDisplayModelTests
```

Expected: build failure because `AMapRouteDisplayModel` does not exist.

- [ ] **Step 3: Implement the pure model and bounds**

Create `ios/MaxHelmet/Navigation/AMapRouteDisplayModel.swift`:

```swift
import CoreLocation

struct AMapCoordinateBounds: Equatable {
    let center: CLLocationCoordinate2D
    let latitudeSpan: Double
    let longitudeSpan: Double

    static func == (lhs: Self, rhs: Self) -> Bool {
        coordinatesEqual(lhs.center, rhs.center)
            && lhs.latitudeSpan == rhs.latitudeSpan
            && lhs.longitudeSpan == rhs.longitudeSpan
    }
}

struct AMapRouteDisplayModel: Equatable {
    let polyline: [CLLocationCoordinate2D]
    let currentLocation: CLLocationCoordinate2D?
    let bounds: AMapCoordinateBounds

    static func make(guidance: GuidanceState) -> Self? {
        guard guidance.polyline.count >= 2,
              guidance.polyline.allSatisfy(isFiniteCoordinate),
              guidance.currentLocation.map(isFiniteCoordinate) ?? true else {
            return nil
        }

        let route = guidance.polyline.map(CoordinateDatum.wgs84ToGcj02)
        let rider = guidance.currentLocation.map(CoordinateDatum.wgs84ToGcj02)
        return Self(polyline: route, currentLocation: rider, bounds: makeBounds(route))
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy(coordinatesEqual)
            && optionalDisplayCoordinatesEqual(lhs.currentLocation, rhs.currentLocation)
            && lhs.bounds == rhs.bounds
    }
}

private func isFiniteCoordinate(_ coordinate: CLLocationCoordinate2D) -> Bool {
    coordinate.latitude.isFinite && coordinate.longitude.isFinite
}

private func makeBounds(_ coordinates: [CLLocationCoordinate2D]) -> AMapCoordinateBounds {
    let latitudes = coordinates.map(\.latitude)
    let longitudes = coordinates.map(\.longitude)
    let minLatitude = latitudes.min()!
    let maxLatitude = latitudes.max()!
    let minLongitude = longitudes.min()!
    let maxLongitude = longitudes.max()!
    let minimumSpan = 0.001
    return AMapCoordinateBounds(
        center: .init(
            latitude: (minLatitude + maxLatitude) / 2,
            longitude: (minLongitude + maxLongitude) / 2
        ),
        latitudeSpan: max(maxLatitude - minLatitude, minimumSpan),
        longitudeSpan: max(maxLongitude - minLongitude, minimumSpan)
    )
}

private func optionalDisplayCoordinatesEqual(
    _ lhs: CLLocationCoordinate2D?,
    _ rhs: CLLocationCoordinate2D?
) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): return true
    case let (left?, right?): return coordinatesEqual(left, right)
    default: return false
    }
}
```

- [ ] **Step 4: Run GREEN and commit**

Repeat Step 2. Expected: PASS.

```bash
git add ios/MaxHelmet/Navigation/AMapRouteDisplayModel.swift \
  ios/MaxHelmetTests/AMapRouteDisplayModelTests.swift
git commit -m "feat(ios): model AMap route display geometry"
```

---

### Task 4: Privacy-First Native AMap Bridge

**Files:**
- Create: `ios/MaxHelmet/Navigation/AMapSDKBootstrapper.swift`
- Create: `ios/MaxHelmet/Navigation/AMapRouteMap.swift`
- Create: `ios/MaxHelmetTests/AMapSDKBootstrapperTests.swift`

**Interfaces:**
- Consumes: non-empty `AMapConfiguration.apiKey`
- Consumes: `AMapRouteDisplayModel`
- Produces: `AMapSDKBootstrapper.prepare(apiKey:apply:) -> Bool`
- Produces: `AMapRouteMap(model:apiKey:loadFailed:)`
- Callback: `loadFailed` becomes `true` on `mapViewDidFailLoadingMap` and `false` on `mapViewDidFinishLoadingMap`.

- [ ] **Step 1: Write failing bootstrapper tests**

Create `ios/MaxHelmetTests/AMapSDKBootstrapperTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class AMapSDKBootstrapperTests: XCTestCase {
    func testEmptyKeyNeverInvokesSDKConfiguration() {
        let bootstrapper = AMapSDKBootstrapper()
        var calls = 0
        XCTAssertFalse(bootstrapper.prepare(apiKey: "   ") { _ in calls += 1 })
        XCTAssertEqual(calls, 0)
    }

    func testValidKeyConfiguresExactlyOnceWithoutExposingIt() {
        let bootstrapper = AMapSDKBootstrapper()
        var calls = 0
        let apply: (String) -> Void = { value in
            XCTAssertFalse(value.isEmpty)
            calls += 1
        }
        XCTAssertTrue(bootstrapper.prepare(apiKey: "configured-value", apply: apply))
        XCTAssertTrue(bootstrapper.prepare(apiKey: "configured-value", apply: apply))
        XCTAssertEqual(calls, 1)
        XCTAssertFalse(String(describing: bootstrapper).contains("configured-value"))
    }
}
```

- [ ] **Step 2: Run the test to verify RED**

Run the workspace test command scoped to `AMapSDKBootstrapperTests`. Expected: build failure because the type does not exist.

- [ ] **Step 3: Implement the exactly-once bootstrapper and live SDK setup**

Create `ios/MaxHelmet/Navigation/AMapSDKBootstrapper.swift`:

```swift
import Foundation

final class AMapSDKBootstrapper {
    static let shared = AMapSDKBootstrapper()

    private let lock = NSLock()
    private var prepared = false

    func prepare(apiKey: String, apply: (String) -> Void) -> Bool {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return false }

        lock.lock()
        defer { lock.unlock() }
        guard !prepared else { return true }
        apply(key)
        prepared = true
        return true
    }
}

func applyLiveAMapConfiguration(apiKey: String) {
    MAMapView.updatePrivacyShow(.didShow, privacyInfo: .didContain)
    MAMapView.updatePrivacyAgree(.didAgree)
    AMapServices.shared().enableHTTPS = true
    AMapServices.shared().apiKey = apiKey
}
```

The two `MAMapView` privacy calls must remain before `AMapServices.shared()` and before any `MAMapView` initializer.

- [ ] **Step 4: Run the bootstrapper tests GREEN**

Repeat Step 2. Expected: PASS.

- [ ] **Step 5: Implement the display-only map bridge**

Create `ios/MaxHelmet/Navigation/AMapRouteMap.swift` with this structure:

```swift
import SwiftUI
import UIKit

struct AMapRouteMap: UIViewRepresentable {
    let model: AMapRouteDisplayModel
    let apiKey: String
    @Binding var loadFailed: Bool
    var bootstrapper = AMapSDKBootstrapper.shared

    func makeCoordinator() -> Coordinator {
        Coordinator(loadFailed: $loadFailed)
    }

    func makeUIView(context: Context) -> MAMapView {
        precondition(
            bootstrapper.prepare(apiKey: apiKey, apply: applyLiveAMapConfiguration),
            "AMapRouteMap requires a configured key"
        )
        let mapView = MAMapView(frame: .zero)
        mapView.delegate = context.coordinator
        mapView.isZoomEnabled = false
        mapView.isScrollEnabled = false
        mapView.isRotateEnabled = false
        mapView.isRotateCameraEnabled = false
        mapView.showsUserLocation = false
        context.coordinator.render(model, on: mapView)
        return mapView
    }

    func updateUIView(_ mapView: MAMapView, context: Context) {
        context.coordinator.loadFailed = $loadFailed
        context.coordinator.render(model, on: mapView)
    }

    static func dismantleUIView(_ mapView: MAMapView, coordinator: Coordinator) {
        coordinator.clear(on: mapView)
        mapView.delegate = nil
    }

    final class Coordinator: NSObject, MAMapViewDelegate {
        var loadFailed: Binding<Bool>
        private var routeOverlay: MAPolyline?
        private var riderAnnotation: MAPointAnnotation?
        private var lastPolyline: [CLLocationCoordinate2D] = []
        private var lastRider: CLLocationCoordinate2D?

        init(loadFailed: Binding<Bool>) {
            self.loadFailed = loadFailed
        }

        func render(_ model: AMapRouteDisplayModel, on mapView: MAMapView) {
            if !sameCoordinates(lastPolyline, model.polyline) {
                if let routeOverlay { mapView.remove(routeOverlay) }
                var coordinates = model.polyline
                let overlay = MAPolyline(coordinates: &coordinates, count: UInt(coordinates.count))!
                mapView.add(overlay)
                mapView.setRegion(
                    MACoordinateRegion(
                        center: model.bounds.center,
                        span: MACoordinateSpan(
                            latitudeDelta: model.bounds.latitudeSpan * 1.25,
                            longitudeDelta: model.bounds.longitudeSpan * 1.25
                        )
                    ),
                    animated: false
                )
                routeOverlay = overlay
                lastPolyline = model.polyline
            }

            if !sameOptionalCoordinate(lastRider, model.currentLocation) {
                if let riderAnnotation { mapView.removeAnnotation(riderAnnotation) }
                riderAnnotation = model.currentLocation.map { coordinate in
                    let annotation = MAPointAnnotation()
                    annotation.coordinate = coordinate
                    mapView.addAnnotation(annotation)
                    return annotation
                }
                lastRider = model.currentLocation
            }
        }

        func clear(on mapView: MAMapView) {
            if let routeOverlay { mapView.remove(routeOverlay) }
            if let riderAnnotation { mapView.removeAnnotation(riderAnnotation) }
            routeOverlay = nil
            riderAnnotation = nil
            lastPolyline = []
            lastRider = nil
        }

        func mapView(
            _ mapView: MAMapView!,
            rendererFor overlay: MAOverlay!
        ) -> MAOverlayRenderer! {
            guard let polyline = overlay as? MAPolyline else { return nil }
            let renderer = MAPolylineRenderer(polyline: polyline)
            renderer?.lineWidth = 5
            renderer?.strokeColor = UIColor(red: 71/255, green: 227/255, blue: 155/255, alpha: 1)
            renderer?.lineJoinType = kMALineJoinRound
            renderer?.lineCapType = kMALineCapRound
            return renderer
        }

        func mapView(
            _ mapView: MAMapView!,
            viewFor annotation: MAAnnotation!
        ) -> MAAnnotationView! {
            guard annotation is MAPointAnnotation else { return nil }
            let identifier = "max-rider"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                ?? MAAnnotationView(annotation: annotation, reuseIdentifier: identifier)
            view?.annotation = annotation
            view?.image = UIImage(systemName: "location.fill")?.withTintColor(
                UIColor(red: 255/255, green: 106/255, blue: 61/255, alpha: 1),
                renderingMode: .alwaysOriginal
            )
            view?.canShowCallout = false
            return view
        }

        func mapViewDidFinishLoadingMap(_ mapView: MAMapView!) {
            DispatchQueue.main.async { self.loadFailed.wrappedValue = false }
        }

        func mapViewDidFailLoadingMap(_ mapView: MAMapView!, withError error: Error!) {
            DispatchQueue.main.async { self.loadFailed.wrappedValue = true }
        }
    }
}

private func sameCoordinates(
    _ lhs: [CLLocationCoordinate2D],
    _ rhs: [CLLocationCoordinate2D]
) -> Bool {
    lhs.count == rhs.count && zip(lhs, rhs).allSatisfy(coordinatesEqual)
}

private func sameOptionalCoordinate(
    _ lhs: CLLocationCoordinate2D?,
    _ rhs: CLLocationCoordinate2D?
) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): return true
    case let (left?, right?): return coordinatesEqual(left, right)
    default: return false
    }
}
```

The bridge keeps privacy calls first, disables gestures and location, updates
route and marker state independently, leaves the AMap logo untouched, and
reports failures only as a Boolean.

- [ ] **Step 6: Build the app and run scoped tests**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapSDKBootstrapperTests \
  -only-testing:MaxHelmetTests/AMapRouteDisplayModelTests
```

Expected: build succeeds with the SDK linked and all scoped tests PASS.

- [ ] **Step 7: Commit the native bridge**

```bash
git add ios/MaxHelmet/Navigation/AMapSDKBootstrapper.swift \
  ios/MaxHelmet/Navigation/AMapRouteMap.swift \
  ios/MaxHelmetTests/AMapSDKBootstrapperTests.swift
git commit -m "feat(ios): render routes with native AMap"
```

---

### Task 5: Just-in-Time Consent UI and Guidance Card Integration

**Files:**
- Create: `ios/MaxHelmet/Navigation/AMapConsentSheet.swift`
- Create: `ios/MaxHelmet/Navigation/GuidanceMapHost.swift`
- Modify: `ios/MaxHelmet/Navigation/GuidanceCard.swift`
- Test: `ios/MaxHelmetTests/AMapConsentStoreTests.swift`
- Test: `ios/MaxHelmetTests/AMapMapPresentationTests.swift`

**Interfaces:**
- Consumes: `AMapConsentStore`, `AMapConfiguration`, `AMapRouteDisplayModel`, `AMapRouteMap`
- Produces: `GuidanceMapHost(guidance:)`
- Produces: `AMapConsentSheet(onAccept:onDecline:)`
- Visible copy: “高德地图与隐私”, “同意并启用”, “暂不启用”, “地图未启用”, “启用地图”, “地图暂不可用”.

- [ ] **Step 1: Extend gate tests for the missing-key and reconsideration UI paths**

Add to `AMapMapPresentationTests`:

```swift
func testUnknownStillShowsDisclosureBeforeMissingKeyFailure() {
    XCTAssertEqual(
        amapMapPresentation(
            decision: .unknown, hasAPIKey: false, hasGeometry: true, loadFailed: false
        ),
        .consentRequired
    )
}
```

Add to `AMapConsentStoreTests`:

```swift
func testAcceptedStoreDoesNotPromptAgainOnLaterRoutes() {
    let store = AMapConsentStore(defaults: defaults)
    store.accept()
    store.requestIfNeeded()
    XCTAssertFalse(store.isPromptPresented)
}
```

- [ ] **Step 2: Run scoped tests and confirm they stay GREEN**

Run the workspace test command for `AMapConsentStoreTests` and `AMapMapPresentationTests`. Expected: PASS; these additions pin the UI integration contract before the views are added.

- [ ] **Step 3: Implement the explicit consent sheet**

Create `ios/MaxHelmet/Navigation/AMapConsentSheet.swift`:

```swift
import SwiftUI

struct AMapConsentSheet: View {
    let onAccept: () -> Void
    let onDecline: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Text("高德地图与隐私")
                    .font(.title2.bold())
                Text("导航卡片使用高德地图显示路线。启用后，高德会接收加载地图所需的网络请求；Max 仍使用现有位置与路线数据，不启用高德定位服务。")
                    .foregroundStyle(HudColors.hudDim)
                Link(
                    "查看高德地图隐私政策",
                    destination: URL(string: "https://lbs.amap.com/pages/privacy/")!
                )
                Spacer()
                Button("同意并启用", action: onAccept)
                    .buttonStyle(.borderedProminent)
                    .tint(HudColors.lume)
                Button("暂不启用", action: onDecline)
                    .buttonStyle(.bordered)
            }
            .padding(24)
            .navigationTitle("地图设置")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled()
    }
}
```

- [ ] **Step 4: Implement the map host without constructing AMap in non-map branches**

Create `ios/MaxHelmet/Navigation/GuidanceMapHost.swift`:

```swift
import SwiftUI

struct GuidanceMapHost: View {
    let guidance: GuidanceState

    @StateObject private var consent = AMapConsentStore()
    @State private var loadFailed = false
    private let configuration = AMapConfiguration()

    private var model: AMapRouteDisplayModel? {
        AMapRouteDisplayModel.make(guidance: guidance)
    }

    private var presentation: AMapMapPresentation {
        amapMapPresentation(
            decision: consent.decision,
            hasAPIKey: configuration.hasAPIKey,
            hasGeometry: model != nil,
            loadFailed: loadFailed
        )
    }

    var body: some View {
        Group {
            switch presentation {
            case .consentRequired:
                placeholder(title: "等待启用高德地图", actionTitle: nil, action: nil)
            case .notEnabled:
                placeholder(title: "地图未启用", actionTitle: "启用地图", action: consent.reconsider)
            case .unavailable:
                placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
            case .map:
                if let model, let apiKey = configuration.apiKey {
                    AMapRouteMap(model: model, apiKey: apiKey, loadFailed: $loadFailed)
                }
            }
        }
        .onAppear { consent.requestIfNeeded() }
        .sheet(isPresented: $consent.isPromptPresented) {
            AMapConsentSheet(onAccept: consent.accept, onDecline: consent.decline)
        }
    }

    @ViewBuilder
    private func placeholder(
        title: String,
        actionTitle: String?,
        action: (() -> Void)?
    ) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "map")
            Text(title).font(.subheadline.weight(.semibold))
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.bordered)
            }
        }
        .foregroundStyle(HudColors.hudDim)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HudColors.void.opacity(0.65))
    }
}
```

The `AMapRouteMap` initializer must appear only inside `.map`; do not precompute it or move SDK configuration into `GuidanceMapHost.init`.

- [ ] **Step 5: Replace MapKit in `GuidanceCard`**

Remove:

```swift
import MapKit
```

Replace the `routeMap` computed property with:

```swift
private var routeMap: some View {
    GuidanceMapHost(guidance: guidance)
}
```

Keep the existing 120-point height and rounded clipping. Remove `.allowsHitTesting(false)` from the host chain because the declined placeholder's “启用地图” button must work; AMap gestures are already disabled inside `AMapRouteMap`.

- [ ] **Step 6: Run scoped tests, the navigation tests, and an app build**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/AMapConsentStoreTests \
  -only-testing:MaxHelmetTests/AMapMapPresentationTests \
  -only-testing:MaxHelmetTests/AMapRouteDisplayModelTests \
  -only-testing:MaxHelmetTests/NavigationControllerTests \
  -only-testing:MaxHelmetTests/GuidanceEngineTests
```

Expected: PASS. Then run a workspace build with `CODE_SIGNING_ALLOWED=NO`; expected: BUILD SUCCEEDED.

- [ ] **Step 7: Commit the guidance integration**

```bash
git add ios/MaxHelmet/Navigation/AMapConsentSheet.swift \
  ios/MaxHelmet/Navigation/GuidanceMapHost.swift \
  ios/MaxHelmet/Navigation/GuidanceCard.swift \
  ios/MaxHelmetTests/AMapConsentStoreTests.swift \
  ios/MaxHelmetTests/AMapMapPresentationTests.swift
git commit -m "feat(ios): gate AMap guidance behind consent"
```

---

### Task 6: Remove the Microphone Dock and Preserve Helmet/Mute Semantics

**Files:**
- Create: `ios/MaxHelmet/UI/VoiceUtilityPill.swift`
- Create: `ios/MaxHelmetTests/VoiceUtilityPillTests.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreenLayout.swift`
- Modify: `ios/MaxHelmetTests/AgentScreenLayoutTests.swift`
- Modify: `ios/MaxHelmetTests/HelmetPresentationTests.swift`
- Delete: `ios/MaxHelmet/UI/VoiceMicDock.swift`
- Delete: `ios/MaxHelmet/UI/VoiceMicDockModel.swift`
- Delete: `ios/MaxHelmetTests/VoiceMicDockTests.swift`

**Interfaces:**
- Produces: `helmetToggleAccessibilityLabel(handsFree: Bool) -> String`
- Preserves: `viewModel.toggleHandsFree` as `HelmetVisual.onTap`
- Preserves: `MuteUtilityPill(muted:action:)`
- Produces: `HudMetrics.portraitChrome = 218`, `HudMetrics.landscapeChrome = 118`.

- [ ] **Step 1: Write failing helmet and reclaimed-layout tests**

Add to `HelmetPresentationTests.swift`:

```swift
func testHelmetToggleAccessibilityUsesSessionStateNotTurnState() {
    XCTAssertEqual(helmetToggleAccessibilityLabel(handsFree: false), "开启免提")
    XCTAssertEqual(helmetToggleAccessibilityLabel(handsFree: true), "结束免提")
}
```

Add to `AgentScreenLayoutTests.swift`:

```swift
func testRemovingTheDockReclaimsItsPortraitAndLandscapeReservations() {
    XCTAssertEqual(HudMetrics.portraitChrome, 218)
    XCTAssertEqual(HudMetrics.landscapeChrome, 118)
}
```

Create `ios/MaxHelmetTests/VoiceUtilityPillTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class VoiceUtilityPillTests: XCTestCase {
    func testMuteUtilityPillUsesMinimumInteractiveHeight() {
        XCTAssertGreaterThanOrEqual(muteUtilityMinimumHitHeight, 44)
    }
}
```

- [ ] **Step 2: Run scoped tests to verify RED**

Run the workspace test command with:

```text
-only-testing:MaxHelmetTests/HelmetPresentationTests
-only-testing:MaxHelmetTests/AgentScreenLayoutTests
-only-testing:MaxHelmetTests/VoiceUtilityPillTests
```

Expected: build/test failure because the helper, landscape metric, and new utility file do not exist and the old portrait reservation is still 296.

- [ ] **Step 3: Extract only the retained mute utility**

Create `ios/MaxHelmet/UI/VoiceUtilityPill.swift`:

```swift
import SwiftUI

let muteUtilityMinimumHitHeight: CGFloat = 44

struct MuteUtilityPill: View {
    let muted: Bool
    let action: () -> Void

    var body: some View {
        let tint = muted ? HudColors.amber : HudColors.hudDim
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text(muted ? "取消静音" : "静音")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(tint)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Capsule().fill(muted ? HudColors.amber.opacity(0.16) : HudColors.panelElevated))
        }
        .buttonStyle(.plain)
        .frame(minHeight: muteUtilityMinimumHitHeight)
        .contentShape(Rectangle())
        .accessibilityLabel(muted ? "取消静音" : "静音")
    }
}
```

Delete `VoiceMicDock.swift`, `VoiceMicDockModel.swift`, and `VoiceMicDockTests.swift` after this extraction; do not retain the meter, noise-floor, presentation, or transition code.

- [ ] **Step 4: Remove both dock instances and make helmet accessibility session-driven**

In `AgentScreen.swift`:

1. Delete `VoiceMicDock(state: state, action: viewModel.toggleHandsFree)` from `portraitStack`.
2. Delete the same call from the landscape right-hand column.
3. Pass `handsFree: state.handsFree` into `HelmetVisual`.
4. Add the pure helper near the other presentation helpers:

```swift
func helmetToggleAccessibilityLabel(handsFree: Bool) -> String {
    handsFree ? "结束免提" : "开启免提"
}
```

5. Add `let handsFree: Bool` to `HelmetVisual` and replace its current turn-state label with:

```swift
.accessibilityLabel(helmetToggleAccessibilityLabel(handsFree: handsFree))
```

Do not change `onTap: viewModel.toggleHandsFree`.

- [ ] **Step 5: Reclaim dock layout space**

In `AgentScreenLayout.swift`:

```swift
enum HudMetrics {
    // existing helmet/banner/caption values stay unchanged
    static let portraitChrome: CGFloat = 218
    static let landscapeChrome: CGFloat = 118
}
```

Replace the landscape caption reservation's `190` literal with `HudMetrics.landscapeChrome`. Update comments to describe top bar, readout, secondary controls, spacing, and screen padding; remove every claim that the dock is the must-hit bottom control.

In `AgentScreen.swift` and `AgentScreenLayoutTests.swift`, update dock-specific historical comments to describe keeping the helmet, captions, and secondary controls within the available space.

- [ ] **Step 6: Run scoped and full layout tests GREEN**

Repeat Step 2. Expected: PASS. Also run:

```bash
rg -n "VoiceMicDock|MicDockPresentation|micDock|micMeterHeights|micDisplayLevel" \
  ios/MaxHelmet ios/MaxHelmetTests
```

Expected: no matches.

- [ ] **Step 7: Commit the interaction simplification**

```bash
git add ios/MaxHelmet/UI/AgentScreen.swift ios/MaxHelmet/UI/AgentScreenLayout.swift \
  ios/MaxHelmet/UI/VoiceUtilityPill.swift ios/MaxHelmetTests/AgentScreenLayoutTests.swift \
  ios/MaxHelmetTests/HelmetPresentationTests.swift \
  ios/MaxHelmetTests/VoiceUtilityPillTests.swift
git add -u ios/MaxHelmet/UI ios/MaxHelmetTests
git commit -m "refactor(ios): make helmet the sole session toggle"
```

---

### Task 7: Documentation, Security Scan, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `ios/README.md`
- Modify: `docs/live-agent-testing.md`
- Verify only: all implementation and test files from Tasks 1–6.

**Interfaces:**
- Documents: workspace-only build path, dependency bootstrap, local key injection, consent behavior, native AMap display, no-key behavior, and helmet-only start/stop.

- [ ] **Step 1: Update root capability documentation**

In `README.md`:

- Replace the iOS microphone-dock bullet with: the helmet is the sole session toggle; tap once to start and again to stop; mute remains separate while active.
- Expand the iOS navigation bullet to say the route card uses the native AMap iOS 3D Map SDK after just-in-time consent, converts its WGS-84 display inputs to GCJ-02, and shows an honest unavailable state with no MapKit fallback.
- Replace active `xcodebuild -project ios/MaxHelmet.xcodeproj` commands with `xcodebuild -workspace ios/MaxHelmet.xcworkspace`.

- [ ] **Step 2: Update iOS setup and run documentation**

In `ios/README.md`:

- Replace “no extra tooling, CocoaPods, or SPM” with the exact bootstrap:

```bash
cd ios
bundle config set --local path vendor/bundle
bundle install
bundle exec pod install --repo-update
cp Config/Secrets.xcconfig.example Config/Secrets.xcconfig
```

- Tell the developer to set `AMAP_IOS_KEY` only in ignored `Config/Secrets.xcconfig`, then open `MaxHelmet.xcworkspace`.
- Replace every active `-project ios/MaxHelmet.xcodeproj` command with `-workspace ios/MaxHelmet.xcworkspace`.
- Change “Tap 开启免提” to “Tap the helmet”.
- Replace the implemented microphone-dock bullet with helmet-only toggle behavior.
- Document the one-time first-route AMap consent sheet, decline/reconsider behavior, no-key placeholder, no AMap Location SDK, and no MapKit fallback.

- [ ] **Step 3: Update the active live-testing command**

In `docs/live-agent-testing.md`, change the current iOS build example from `-project ios/MaxHelmet.xcodeproj` to `-workspace ios/MaxHelmet.xcworkspace`. Do not rewrite historical superpowers plans/specs.

- [ ] **Step 4: Run secret and obsolete-surface scans**

Run:

```bash
git status --short
git ls-files ios/Config/Secrets.xcconfig
git grep -nE 'AMAP_IOS_KEY = .+' -- ':!docs/superpowers/plans/2026-08-13-ios-amap-helmet-toggle.md'
rg -n "VoiceMicDock|Web-parity microphone dock|import MapKit" \
  README.md ios/README.md ios/MaxHelmet ios/MaxHelmetTests
```

Expected:

- `git ls-files` prints nothing for the local secret.
- No tracked non-empty key assignment is found.
- No dock type/copy or `MapKit` import remains in the live iOS app/tests/docs.

- [ ] **Step 5: Run the complete XCTest suite through the workspace**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Expected: `** TEST SUCCEEDED **`, including all existing navigation, companion, crash, camera, gallery, agent, and new AMap/helmet tests.

- [ ] **Step 6: Run both configured-key and explicit no-key builds**

Run the normal local build (which reads ignored `Secrets.xcconfig`):

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO
```

Then run:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  AMAP_IOS_KEY= \
  CODE_SIGNING_ALLOWED=NO
```

Expected: both builds succeed; the second exercises the compiled no-key path.

- [ ] **Step 7: Perform simulator interaction verification**

Install and launch the configured build on `iPhone 17 Pro`, connect to the relay, and verify:

1. The HUD has no microphone dock in portrait or landscape.
2. Helmet tap starts hands-free; the next helmet tap stops it.
3. Mute appears only while active and does not end the session.
4. The first route presents the Chinese AMap disclosure before any map appears.
5. “暂不启用” leaves maneuver text, ETA, prompts, rerouting, and stop-navigation operational and shows “地图未启用”.
6. “启用地图” reopens the disclosure; acceptance shows AMap tiles, lume route, ember rider marker, and visible AMap attribution.
7. A later route does not reprompt.
8. Captions, navigation, hazard, recording, and crash UI do not overlap in either orientation.

Record any inability to obtain live AMap tiles as an external verification limitation; do not substitute MapKit or weaken the automated acceptance gates.

- [ ] **Step 8: Commit documentation and final verification state**

```bash
git add README.md ios/README.md docs/live-agent-testing.md
git diff --cached --check
git commit -m "docs(ios): document AMap and helmet-only controls"
git status --short
```

Expected: clean worktree except ignored dependency output and `ios/Config/Secrets.xcconfig`.

---

## Completion Checklist

- [ ] Native AMap tiles replace the live iOS MapKit surface.
- [ ] AMap receives no API call before accepted consent.
- [ ] Decline and reconsider behavior match the approved copy and persistence rules.
- [ ] Missing key, invalid geometry, and map load failure preserve text/voice guidance.
- [ ] WGS-84 navigation remains unchanged; only display geometry becomes GCJ-02.
- [ ] Route and rider overlays update independently and fit the visible card.
- [ ] No AMap Search, Location, or Navigation SDK is present.
- [ ] No MapKit fallback or `import MapKit` remains in the iOS app.
- [ ] The local AMap key is ignored, untracked, and absent from logs/tests/docs.
- [ ] The microphone dock, its presentation model, and obsolete tests are deleted.
- [ ] Helmet tap starts and stops hands-free; accessibility labels use session state.
- [ ] Mute remains a separate 44-point active-session utility.
- [ ] All workspace XCTest and configured/no-key build gates pass.
- [ ] README and live-testing commands use `MaxHelmet.xcworkspace`.
