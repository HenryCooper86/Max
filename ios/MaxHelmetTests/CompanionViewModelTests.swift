import CoreLocation
import XCTest
@testable import MaxHelmet

final class CompanionViewModelTests: XCTestCase {
    func testRelaunchWithRestoredAccountDoesNotConnectStartLocationOrResumeRide() {
        let harness = Harness(accountToken: " restored-account-token ")

        XCTAssertTrue(harness.viewModel.isLoggedIn)
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionPermission, .notDetermined)
        XCTAssertNil(harness.viewModel.lastForwardedAt)
        XCTAssertTrue(harness.events.isEmpty)
        XCTAssertTrue(harness.scheduled.isEmpty)
    }

    func testPairRequiresAccountAndExactlySixASCIIDigitsThenUsesOnlyTrimmedSessionToken() {
        let harness = Harness(accountToken: "  account-session-token  ", manualToken: "manual-operator-token")
        for invalid in ["", "12345", "1234567", "１２３４５６", "12345a", "12 3456"] {
            harness.viewModel.pairCode = invalid
            harness.viewModel.pairHelmet()
        }
        XCTAssertTrue(harness.events.isEmpty)

        harness.viewModel.pairCode = " \n123456\t "
        harness.viewModel.pairHelmet()

        XCTAssertEqual(harness.events, [
            "companion.connect:ws://relay.example/agent:account-session-token:false",
            "companion.pair:123456"
        ])
        XCTAssertTrue(harness.stream.startResults.isEmpty)
        XCTAssertTrue(harness.voiceEvents.isEmpty)
        XCTAssertFalse(harness.viewModel.helmetRideActive)

        harness.client.publish(.connecting)
        harness.viewModel.pairHelmet()
        XCTAssertEqual(harness.client.pairCodes, ["123456"], "a busy connection must not start another pair attempt")

        let signedOut = Harness(accountToken: "", manualToken: "manual-operator-token")
        signedOut.viewModel.pairCode = "123456"
        signedOut.viewModel.pairHelmet()
        XCTAssertTrue(signedOut.events.isEmpty, "the manual voice/operator token must never authenticate /companion")
    }

    func testStartOrdersConnectStartAndForegroundLocationThenForwardsImmediateAndNewestTimedFix() throws {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk-1", label: "Helmet"))
        harness.events.removeAll()

        harness.viewModel.startHelmetRide()

        XCTAssertEqual(harness.events, [
            "companion.connect:ws://relay.example/agent:account-session-token:false",
            "companion.start",
            "location.start"
        ])
        XCTAssertTrue(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionPermission, .precise)

        harness.monotonicNow = 10
        harness.wallNow = Date(timeIntervalSince1970: 500)
        harness.stream.publishFix(location(latitude: 31.1))
        XCTAssertEqual(harness.client.fixes.map(\.sequence), [1])
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [31.1])
        XCTAssertEqual(harness.viewModel.lastForwardedAt, Date(timeIntervalSince1970: 500))

        harness.monotonicNow = 10.2
        harness.stream.publishFix(location(latitude: 31.2))
        harness.monotonicNow = 10.8
        harness.stream.publishFix(location(latitude: 31.3))
        XCTAssertEqual(harness.scheduled.count, 1, "one newest-only throttle callback is owned by the ride")
        XCTAssertEqual(harness.scheduled[0].delay, 0.8, accuracy: 0.0001)

        harness.monotonicNow = 11
        harness.wallNow = Date(timeIntervalSince1970: 501)
        harness.scheduled[0].callback()
        XCTAssertEqual(harness.client.fixes.map(\.sequence), [1, 2])
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [31.1, 31.3])
        XCTAssertEqual(harness.viewModel.lastForwardedAt, Date(timeIntervalSince1970: 501))

        harness.client.publish(.connecting)
        harness.client.publish(.sharing(deviceId: "rdk-1", label: "Helmet"))
        harness.monotonicNow = 12
        harness.stream.publishFix(location(latitude: 31.4))
        XCTAssertEqual(harness.client.fixes.map(\.sequence), [1, 2, 3], "same-ride reconnect must not reset sequence")
    }

    func testDeniedReducedAndForegroundRefusalRollbackInLocationThenCompanionOrderExactlyOnce() {
        for deniedPermission in [CompanionLocationPermission.denied, .reduced] {
            let harness = Harness()
            harness.stream.startResults = [false]
            harness.stream.permissionOnStart = deniedPermission
            harness.client.publish(.paired(deviceId: "rdk", label: nil))
            harness.events.removeAll()

            harness.viewModel.startHelmetRide()

            XCTAssertEqual(harness.events, [
                "companion.connect:ws://relay.example/agent:account-session-token:false",
                "companion.start",
                "location.start",
                "location.stop",
                "companion.stop"
            ], "permission \(deniedPermission)")
            XCTAssertFalse(harness.viewModel.helmetRideActive)
            XCTAssertEqual(harness.viewModel.companionPermission, deniedPermission)

            harness.stream.publishPermission(deniedPermission)
            XCTAssertEqual(harness.client.stopCount, 1, "stale/duplicate denial must not repeat teardown")
        }

        let refused = Harness()
        refused.stream.startResults = [false]
        refused.client.publish(.paired(deviceId: "rdk", label: nil))
        refused.events.removeAll()
        refused.viewModel.startHelmetRide()
        XCTAssertEqual(Array(refused.events.suffix(2)), ["location.stop", "companion.stop"])
        XCTAssertFalse(refused.viewModel.helmetRideActive)
    }

    func testStopThenNewRideResetsSequenceAndRejectsOldFixPermissionAndFlushOwners() throws {
        let harness = Harness()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        let oldFixCallback = try XCTUnwrap(harness.stream.onFix)
        let oldPermissionCallback = try XCTUnwrap(harness.stream.onPermission)
        harness.monotonicNow = 1
        oldFixCallback(location(latitude: 10))
        harness.monotonicNow = 1.2
        oldFixCallback(location(latitude: 11))
        let oldFlush = try XCTUnwrap(harness.scheduled.first?.callback)

        harness.events.removeAll()
        harness.viewModel.stopHelmetRide()
        harness.viewModel.stopHelmetRide()
        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertFalse(harness.viewModel.helmetRideActive)

        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.monotonicNow = 20
        harness.stream.publishFix(location(latitude: 20))
        XCTAssertEqual(harness.client.fixes.map(\.sequence), [1, 1])

        oldFixCallback(location(latitude: 88))
        oldPermissionCallback(.denied)
        harness.monotonicNow = 21
        oldFlush()
        XCTAssertTrue(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionPermission, .precise)
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [10, 20])
    }

    func testUnpairStopsOwnedRideBeforeSocketActionClearsCodeAndNeverTouchesVoice() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.viewModel.pairCode = "123456"
        harness.events.removeAll()

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(harness.events, ["location.stop", "companion.stop", "companion.unpair"])
        XCTAssertEqual(harness.viewModel.pairCode, "")
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertTrue(harness.voiceEvents.isEmpty)
    }

    func testLogoutStopsAndDisconnectsBeforeBestEffortLogoutTokenClearingAndVoiceTeardown() {
        let harness = Harness(voiceHandsFree: true)
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.logout()

        XCTAssertEqual(harness.events.prefix(4), [
            "location.stop", "companion.stop", "companion.disconnect", "auth.logout:account-session-token"
        ])
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertTrue(harness.secretWrites.contains(where: { $0.value.isEmpty }))
        XCTAssertEqual(harness.voiceEvents, ["voice.owner:nil", "voice.stop"])
    }

    func testVoiceAuthRequiredAndCompanionAuthFailureBothStopRideBeforeIdentityOrFurtherFixes() {
        let voiceAuth = Harness()
        voiceAuth.stream.startResults = [true]
        voiceAuth.stream.permissionOnStart = .precise
        voiceAuth.client.publish(.paired(deviceId: "rdk", label: nil))
        voiceAuth.viewModel.startHelmetRide()
        voiceAuth.events.removeAll()

        voiceAuth.viewModel.handleAuthRequired()

        XCTAssertEqual(Array(voiceAuth.events.prefix(3)), ["location.stop", "companion.stop", "companion.disconnect"])
        XCTAssertEqual(voiceAuth.voiceEvents, ["voice.auth.ack", "voice.owner:nil"])
        XCTAssertEqual(voiceAuth.viewModel.companionState, .signedOut)
        XCTAssertEqual(voiceAuth.viewModel.sessionToken, "")

        let companionAuth = Harness()
        companionAuth.stream.startResults = [true]
        companionAuth.stream.permissionOnStart = .precise
        companionAuth.client.publish(.paired(deviceId: "rdk", label: nil))
        companionAuth.viewModel.startHelmetRide()
        companionAuth.events.removeAll()
        companionAuth.client.publish(.failed(code: "auth", detail: "hostile account-token 31.2,121.4"))

        XCTAssertEqual(companionAuth.events, ["location.stop", "companion.stop"])
        XCTAssertEqual(companionAuth.viewModel.companionState, .failed(code: "auth", detail: "hostile account-token 31.2,121.4"))
        XCTAssertFalse(companionAuth.viewModel.helmetRideActive)
        companionAuth.stream.publishFix(location(latitude: 99))
        XCTAssertTrue(companionAuth.client.fixes.isEmpty)
    }

    func testSynchronousAuthAtConnectStartAndSendBoundariesLeavesNewestIntentAuthoritative() {
        let duringConnect = Harness()
        duringConnect.client.publish(.paired(deviceId: "rdk", label: nil))
        duringConnect.client.onConnect = { duringConnect.client.publish(.failed(code: "auth", detail: "expired")) }
        duringConnect.viewModel.startHelmetRide()
        XCTAssertEqual(duringConnect.client.startCount, 0)
        XCTAssertEqual(duringConnect.stream.startResults.count, 0)
        XCTAssertEqual(duringConnect.viewModel.companionState, .failed(code: "auth", detail: "expired"))

        let duringStart = Harness()
        duringStart.client.publish(.paired(deviceId: "rdk", label: nil))
        duringStart.client.onStart = { duringStart.client.publish(.failed(code: "auth", detail: "expired")) }
        duringStart.viewModel.startHelmetRide()
        XCTAssertTrue(duringStart.stream.startResults.isEmpty)
        XCTAssertFalse(duringStart.viewModel.helmetRideActive)

        let duringSend = Harness()
        duringSend.stream.startResults = [true]
        duringSend.stream.permissionOnStart = .precise
        duringSend.client.publish(.paired(deviceId: "rdk", label: nil))
        duringSend.viewModel.startHelmetRide()
        duringSend.client.onSend = { duringSend.viewModel.stopHelmetRide() }
        duringSend.monotonicNow = 1
        duringSend.wallNow = Date(timeIntervalSince1970: 123)
        duringSend.stream.publishFix(location(latitude: 31))
        XCTAssertFalse(duringSend.viewModel.helmetRideActive)
        XCTAssertNil(duringSend.viewModel.lastForwardedAt, "a reentrant stop means the fix was not truthfully forwarded by the owned ride")
    }

    func testUnpairedStatusCannotLeaveAnOwnedRideActiveAndTimeRollbackCannotForward() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.monotonicNow = 10
        harness.stream.publishFix(location(latitude: 1))

        harness.monotonicNow = 9
        harness.stream.publishFix(location(latitude: 2))
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [1])

        harness.events.removeAll()
        harness.client.publish(.unpaired)
        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionState, .unpaired)
    }

    private func location(latitude: Double) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: 121.4),
            altitude: 0,
            horizontalAccuracy: 4,
            verticalAccuracy: 1,
            course: 90,
            speed: 8,
            timestamp: Date(timeIntervalSince1970: 1_700_000_000)
        )
    }
}

private final class Harness {
    struct Scheduled {
        let callback: () -> Void
        let delay: TimeInterval
    }

    var events: [String] = []
    var voiceEvents: [String] = []
    var secretWrites: [(account: String, value: String)] = []
    var scheduled: [Scheduled] = []
    var monotonicNow: TimeInterval = 0
    var wallNow = Date(timeIntervalSince1970: 100)
    let client = FakeCompanionClient()
    let stream = FakeLocationStream()
    private(set) var viewModel: MainViewModel!

    init(
        accountToken: String = "account-session-token",
        manualToken: String = "manual-operator-token",
        voiceHandsFree: Bool = false
    ) {
        let suite = "CompanionViewModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set("ws://relay.example/agent", forKey: "relay_url")
        defaults.set("user-1", forKey: "auth_user_id")
        defaults.set("rider", forKey: "auth_username")
        defaults.set("Rider", forKey: "auth_display_name")
        defaults.set("tester", forKey: "auth_role")
        client.eventSink = { [weak self] event in self?.events.append(event) }
        stream.eventSink = { [weak self] event in self?.events.append(event) }

        var mutableHandsFree = voiceHandsFree
        viewModel = MainViewModel(
            defaults: defaults,
            initialAuthToken: manualToken,
            initialSessionToken: accountToken,
            companionClient: client,
            locationStream: stream,
            authLogout: { [weak self] _, token, _ in self?.events.append("auth.logout:\(token)") },
            persistSecret: { [weak self] account, value in self?.secretWrites.append((account, value)) },
            monotonicNow: { [weak self] in self?.monotonicNow ?? 0 },
            wallClock: { [weak self] in self?.wallNow ?? .distantPast },
            schedule: { [weak self] callback, delay in self?.scheduled.append(Scheduled(callback: callback, delay: delay)) },
            voiceActions: MainViewModelVoiceActions(
                acknowledgeAuthRequired: { [weak self] in self?.voiceEvents.append("voice.auth.ack") },
                selectTranscriptOwner: { [weak self] owner in self?.voiceEvents.append("voice.owner:\(owner ?? "nil")") },
                isHandsFree: { mutableHandsFree },
                stop: { [weak self] in
                    mutableHandsFree = false
                    self?.voiceEvents.append("voice.stop")
                }
            )
        )
        events.removeAll()
        voiceEvents.removeAll()
        secretWrites.removeAll()
    }
}

private final class FakeCompanionClient: CompanionClientControlling {
    var onState: ((CompanionConnectionState) -> Void)?
    var eventSink: ((String) -> Void)?
    var onConnect: (() -> Void)?
    var onStart: (() -> Void)?
    var onSend: (() -> Void)?
    var pairCodes: [String] = []
    var fixes: [CompanionFix] = []
    var startCount = 0
    var stopCount = 0

    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool) {
        eventSink?("companion.connect:\(relayURL):\(sessionToken):\(allowSelfSignedTLS)")
        onConnect?()
    }

    func pair(code: String) {
        pairCodes.append(code)
        eventSink?("companion.pair:\(code)")
    }

    func startRide() {
        startCount += 1
        eventSink?("companion.start")
        onStart?()
    }

    func stopRide() {
        stopCount += 1
        eventSink?("companion.stop")
    }

    func unpair() { eventSink?("companion.unpair") }

    func sendLatest(_ fix: CompanionFix) {
        fixes.append(fix)
        eventSink?("companion.fix:\(fix.sequence)")
        onSend?()
    }

    func disconnect() {
        eventSink?("companion.disconnect")
        onState?(.signedOut)
    }

    func publish(_ state: CompanionConnectionState) { onState?(state) }
}

private final class FakeLocationStream: CompanionLocationStreaming {
    var onFix: ((CLLocation) -> Void)?
    var onPermission: ((CompanionLocationPermission) -> Void)?
    var eventSink: ((String) -> Void)?
    var startResults: [Bool] = []
    var permissionOnStart: CompanionLocationPermission?

    func startFromForeground() -> Bool {
        eventSink?("location.start")
        if let permissionOnStart { onPermission?(permissionOnStart) }
        return startResults.isEmpty ? false : startResults.removeFirst()
    }

    func stop() { eventSink?("location.stop") }
    func publishFix(_ location: CLLocation) { onFix?(location) }
    func publishPermission(_ permission: CompanionLocationPermission) { onPermission?(permission) }
}
