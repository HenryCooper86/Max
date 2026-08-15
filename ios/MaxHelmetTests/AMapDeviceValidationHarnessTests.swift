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
