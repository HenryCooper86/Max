import CoreLocation
import Combine
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

    func testPairOnlyRealClientReconnectsWithCurrentAccountBeforeUnpairing() throws {
        var events: [String] = []
        var voiceEvents: [String] = []
        var requests: [URLRequest] = []
        let sockets = [ViewModelRecordingSocket(), ViewModelRecordingSocket()]
        let client = RDKCompanionClient(
            socketFactory: { request, _ in
                let socket = sockets[requests.count]
                requests.append(request)
                socket.eventSink = { events.append($0) }
                events.append("socket.create")
                return socket
            },
            schedule: { _, _ in XCTFail("Pair-only and explicit unpair must not reconnect on a timer") }
        )
        let stream = FakeLocationStream()
        stream.eventSink = { events.append($0) }
        let defaults = companionDefaults()
        let viewModel = MainViewModel(
            defaults: defaults,
            initialAuthToken: "manual-operator-token",
            initialSessionToken: " account-session-token ",
            companionClient: client,
            locationStream: stream,
            authLogout: { _, _, _ in XCTFail("Unpair must not log out the account") },
            persistSecret: { _, _ in },
            monotonicNow: { 0 },
            wallClock: { Date(timeIntervalSince1970: 0) },
            schedule: { _, _ in XCTFail("Pair-only and explicit unpair must not schedule a fix") },
            voiceActions: MainViewModelVoiceActions(
                acknowledgeAuthRequired: { voiceEvents.append("auth") },
                selectTranscriptOwner: { _ in },
                isHandsFree: { true },
                stop: { voiceEvents.append("stop") }
            )
        )
        voiceEvents.removeAll()

        viewModel.pairCode = "123456"
        viewModel.pairHelmet()
        XCTAssertEqual(try viewModelMessageTypes(sockets[0].sentMessages), ["companion.pair"])
        sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk-1\"}"))
        XCTAssertEqual(sockets[0].cancelCount, 1, "the real pair-only client closes after the paired status")
        XCTAssertEqual(viewModel.companionState, .paired(deviceId: "rdk-1", label: nil))
        events.removeAll()

        viewModel.unpairHelmet()

        XCTAssertEqual(events, ["location.stop", "socket.create", "socket.resume", "socket.send:companion.unpair"])
        XCTAssertEqual(requests.count, 2)
        let unpairRequest = try XCTUnwrap(requests.dropFirst().first)
        XCTAssertEqual(companionToken(in: unpairRequest), "account-session-token")
        XCTAssertEqual(try viewModelMessageTypes(sockets[1].sentMessages), ["companion.unpair"])
        XCTAssertEqual(viewModel.pairCode, "")
        XCTAssertTrue(voiceEvents.isEmpty)
    }

    func testReplacingSessionTokenTerminatesOldRideBeforePersistingAndRejectsEveryStaleOwner() throws {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        let oldState = try XCTUnwrap(harness.client.onState)
        let oldFix = try XCTUnwrap(harness.stream.onFix)
        let oldPermission = try XCTUnwrap(harness.stream.onPermission)
        harness.monotonicNow = 10
        oldFix(location(latitude: 30))
        harness.monotonicNow = 10.2
        oldFix(location(latitude: 31))
        let oldFlush = try XCTUnwrap(harness.scheduled.first?.callback)
        harness.events.removeAll()
        harness.client.fixes.removeAll()

        harness.viewModel.sessionToken = " replacement-account-token "

        XCTAssertEqual(harness.events, [
            "location.stop",
            "companion.stop",
            "companion.disconnect",
            "secret.persist: replacement-account-token "
        ])
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)

        oldState(.sharing(deviceId: "old-rdk", label: nil))
        oldPermission(.precise)
        oldFix(location(latitude: 88))
        harness.monotonicNow = 20
        oldFlush()
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertTrue(harness.client.fixes.isEmpty)
    }

    func testClearingSessionTokenSynchronouslyStopsAndDisconnectsTheOwnedRide() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.events.removeAll()

        harness.viewModel.sessionToken = " \n "

        XCTAssertEqual(harness.events, [
            "location.stop",
            "companion.stop",
            "companion.disconnect",
            "secret.persist: \n "
        ])
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
    }

    func testEquivalentTrimmedSessionTokenDoesNotInterruptAnOwnedRide() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.events.removeAll()

        harness.viewModel.sessionToken = "  account-session-token  "

        XCTAssertEqual(harness.events, ["secret.persist:  account-session-token  "])
        XCTAssertTrue(harness.viewModel.helmetRideActive)
        XCTAssertNotEqual(harness.viewModel.companionState, .signedOut)
    }

    func testSessionTokenReplacementReenteredFromFixDeliveryLeavesNoForwardedTimestamp() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.client.onSend = { harness.viewModel.sessionToken = "account-b" }
        harness.events.removeAll()
        harness.monotonicNow = 1

        harness.stream.publishFix(location(latitude: 31))

        XCTAssertEqual(Array(harness.events.suffix(4)), [
            "location.stop", "companion.stop", "companion.disconnect", "secret.persist:account-b"
        ])
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertNil(harness.viewModel.lastForwardedAt)
    }

    func testObsoleteDelayedFlushCannotStrandFixPendingAfterNewImmediateEmission() throws {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()

        harness.monotonicNow = 10
        harness.stream.publishFix(location(latitude: 10))
        harness.monotonicNow = 10.2
        harness.stream.publishFix(location(latitude: 20))
        let obsoleteFlush = try XCTUnwrap(harness.scheduled.first?.callback)
        harness.monotonicNow = 11.1
        harness.stream.publishFix(location(latitude: 30))
        harness.monotonicNow = 11.2
        harness.stream.publishFix(location(latitude: 40))

        XCTAssertEqual(harness.scheduled.count, 2, "the new pending fix owns a new deadline")
        let currentFlush = try XCTUnwrap(harness.scheduled.dropFirst().first?.callback)
        obsoleteFlush()
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [10, 30])
        harness.monotonicNow = 12.1
        currentFlush()
        XCTAssertEqual(harness.client.fixes.map(\.sequence), [1, 2, 3])
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [10, 30, 40])
    }

    func testEarlyCurrentFlushReschedulesTheSameNewestFixExactlyOnce() throws {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.monotonicNow = 10
        harness.stream.publishFix(location(latitude: 10))
        harness.monotonicNow = 10.2
        harness.stream.publishFix(location(latitude: 20))
        let earlyFlush = try XCTUnwrap(harness.scheduled.first?.callback)

        harness.monotonicNow = 10.5
        earlyFlush()

        XCTAssertEqual(harness.client.fixes.map(\.latitude), [10])
        XCTAssertEqual(harness.scheduled.count, 2)
        let replacement = try XCTUnwrap(harness.scheduled.dropFirst().first)
        XCTAssertEqual(replacement.delay, 0.5, accuracy: 0.0001)
        harness.monotonicNow = 11
        replacement.callback()
        XCTAssertEqual(harness.client.fixes.map(\.sequence), [1, 2])
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [10, 20])
        replacement.callback()
        XCTAssertEqual(harness.client.fixes.map(\.latitude), [10, 20], "a consumed deadline is idempotent")
    }

    func testAuthFailureRemainsTerminalWhenStopSynchronouslyPublishesReady() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.client.onStop = { harness.client.publish(.ready(deviceId: "stale-rdk", label: nil)) }

        harness.client.publish(.failed(code: "auth", detail: "expired"))

        XCTAssertEqual(harness.viewModel.companionState, .failed(code: "auth", detail: "expired"))
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.client.stopCount, 1)
    }

    func testUnpairedRemainsTerminalWhenStopSynchronouslyPublishesReady() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.client.onStop = { harness.client.publish(.ready(deviceId: "stale-rdk", label: nil)) }

        harness.client.publish(.unpaired)

        XCTAssertEqual(harness.viewModel.companionState, .unpaired)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.client.stopCount, 1)
    }

    func testNewAccountIntentDuringAuthTeardownWinsWithoutRepeatingLocationOrRideStop() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var replacedAccount = false
        harness.client.onStop = {
            guard !replacedAccount else { return }
            replacedAccount = true
            harness.client.publish(.ready(deviceId: "stale-rdk", label: nil))
            harness.viewModel.sessionToken = "account-b"
        }
        harness.events.removeAll()

        harness.client.publish(.failed(code: "auth", detail: "expired"))

        XCTAssertEqual(harness.events, [
            "location.stop", "companion.stop", "companion.disconnect", "secret.persist:account-b"
        ])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testNestedChangedTokenFromStopMakesNewestIntentAuthoritativeWithOneAccountTeardown() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var suppliedNewestIntent = false
        harness.client.onStop = {
            guard !suppliedNewestIntent else { return }
            suppliedNewestIntent = true
            harness.client.publish(.ready(deviceId: "stale-rdk", label: nil))
            harness.viewModel.sessionToken = "account-c"
        }
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.sessionToken = "account-b"

        XCTAssertEqual(harness.viewModel.sessionToken, "account-c")
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.events, [
            "location.stop", "companion.stop", "companion.disconnect", "secret.persist:account-c"
        ])
        XCTAssertEqual(harness.secretWrites.map(\.value), ["account-c"])
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testNestedClearFromDisconnectCancelsOuterReplacementWithoutRepeatingTeardown() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var clearedAccount = false
        harness.client.onDisconnect = {
            guard !clearedAccount else { return }
            clearedAccount = true
            harness.viewModel.sessionToken = " \n "
        }
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.sessionToken = "account-b"

        XCTAssertEqual(harness.viewModel.sessionToken, " \n ")
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.events, [
            "location.stop", "companion.stop", "companion.disconnect", "secret.persist: \n "
        ])
        XCTAssertEqual(harness.secretWrites.map(\.value), [" \n "])
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
    }

    func testNestedSameTrimmedTokenFromStopCancelsOuterReplacementWithoutSecondTeardown() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var restoredOriginalAccount = false
        harness.client.onStop = {
            guard !restoredOriginalAccount else { return }
            restoredOriginalAccount = true
            harness.viewModel.sessionToken = " account-session-token "
        }
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.sessionToken = "account-b"

        XCTAssertEqual(harness.viewModel.sessionToken, " account-session-token ")
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.secretWrites.map(\.value), [" account-session-token "])
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
    }

    func testPersistenceCallbackNewestTokenWinsWithoutRepeatingCompletedAccountTeardown() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var suppliedNewestIntent = false
        harness.onPersistSecret = { account, value in
            guard account == "auth_session_token", value == "account-b", !suppliedNewestIntent else { return }
            suppliedNewestIntent = true
            harness.viewModel.sessionToken = "account-c"
        }
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.sessionToken = "account-b"

        XCTAssertEqual(harness.viewModel.sessionToken, "account-c")
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.secretWrites.map(\.value), ["account-b", "account-c"])
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
    }

    func testStopReenteredFromLocationStopIsExactOnce() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var reenteredStop = false
        harness.stream.onStop = {
            guard !reenteredStop else { return }
            reenteredStop = true
            harness.viewModel.stopHelmetRide()
        }
        harness.events.removeAll()

        harness.viewModel.stopHelmetRide()

        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testStopPublishingUnpairedIsExactOnceAndPreservesTerminalState() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var publishedTerminalState = false
        harness.client.onStop = {
            guard !publishedTerminalState else { return }
            publishedTerminalState = true
            harness.client.publish(.unpaired)
        }
        harness.events.removeAll()

        harness.viewModel.stopHelmetRide()

        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.viewModel.companionState, .unpaired)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testStopPublishingAuthFailureIsExactOnceAndPreservesTerminalState() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var publishedTerminalState = false
        harness.client.onStop = {
            guard !publishedTerminalState else { return }
            publishedTerminalState = true
            harness.client.publish(.failed(code: "auth", detail: "expired"))
        }
        harness.events.removeAll()

        harness.viewModel.stopHelmetRide()

        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.viewModel.companionState, .failed(code: "auth", detail: "expired"))
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testStopPublishingOrdinaryReadyIsExactOnce() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.client.onStop = { harness.client.publish(.ready(deviceId: "rdk", label: nil)) }
        harness.events.removeAll()

        harness.viewModel.stopHelmetRide()

        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.viewModel.companionState, .ready(deviceId: "rdk", label: nil))
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testNewestStartRequestedFromLocationStopRunsAfterOldTeardownUnwinds() {
        let harness = Harness()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var requestedNewStart = false
        harness.stream.onStop = {
            guard !requestedNewStart else { return }
            requestedNewStart = true
            harness.viewModel.startHelmetRide()
        }
        harness.events.removeAll()

        harness.viewModel.stopHelmetRide()

        XCTAssertEqual(harness.events, [
            "location.stop", "companion.stop",
            "companion.connect:ws://relay.example/agent:account-session-token:false",
            "companion.start", "location.start"
        ])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.startCount, 2)
        XCTAssertTrue(harness.viewModel.helmetRideActive)
    }

    func testPairOnlyInvalidConfigurationReconnectRetainsCodeAndDoesNotClaimUnpair() throws {
        var requests: [URLRequest] = []
        let socket = ViewModelRecordingSocket()
        let client = RDKCompanionClient(
            socketFactory: { request, _ in
                requests.append(request)
                return socket
            },
            schedule: { _, _ in XCTFail("Pair-only unpair must not schedule reconnect") }
        )
        let stream = FakeLocationStream()
        let defaults = companionDefaults()
        let viewModel = MainViewModel(
            defaults: defaults,
            initialAuthToken: "manual-operator-token",
            initialSessionToken: "account-session-token",
            companionClient: client,
            locationStream: stream,
            authLogout: { _, _, _ in XCTFail("Unpair must not log out") },
            persistSecret: { _, _ in },
            monotonicNow: { 0 },
            wallClock: { .distantPast },
            schedule: { _, _ in XCTFail("Unpair must not schedule fixes") },
            voiceActions: .init(acknowledgeAuthRequired: {}, selectTranscriptOwner: { _ in }, isHandsFree: { false }, stop: {})
        )
        viewModel.pairCode = "123456"
        viewModel.pairHelmet()
        socket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}"))
        viewModel.relayURL = "not a relay url"

        viewModel.unpairHelmet()

        XCTAssertEqual(requests.count, 1, "invalid reconnect configuration creates no transport")
        XCTAssertEqual(try viewModelMessageTypes(socket.sentMessages), ["companion.pair"])
        XCTAssertEqual(viewModel.pairCode, "123456")
        XCTAssertEqual(viewModel.companionState, .failed(code: "configuration", detail: "Invalid relay URL or session token."))
    }

    func testPairOnlySynchronousConnectionFailureRetainsCodeAndDoesNotClaimUnpair() throws {
        var requests: [URLRequest] = []
        let pairSocket = ViewModelRecordingSocket()
        let failedReconnectSocket = ViewModelRecordingSocket()
        failedReconnectSocket.receiveResultOnRegistration = .failure(ViewModelTestError.transport)
        let sockets = [pairSocket, failedReconnectSocket]
        let client = RDKCompanionClient(
            socketFactory: { request, _ in
                let socket = sockets[requests.count]
                requests.append(request)
                return socket
            },
            schedule: { _, _ in XCTFail("Pair-only unpair must not schedule reconnect") }
        )
        let defaults = companionDefaults()
        let viewModel = MainViewModel(
            defaults: defaults,
            initialAuthToken: "manual-operator-token",
            initialSessionToken: "account-session-token",
            companionClient: client,
            locationStream: FakeLocationStream(),
            authLogout: { _, _, _ in XCTFail("Unpair must not log out") },
            persistSecret: { _, _ in },
            monotonicNow: { 0 },
            wallClock: { .distantPast },
            schedule: { _, _ in XCTFail("Unpair must not schedule fixes") },
            voiceActions: .init(acknowledgeAuthRequired: {}, selectTranscriptOwner: { _ in }, isHandsFree: { false }, stop: {})
        )
        viewModel.pairCode = "123456"
        viewModel.pairHelmet()
        pairSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}"))

        viewModel.unpairHelmet()

        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(failedReconnectSocket.sentMessages.isEmpty)
        XCTAssertEqual(viewModel.pairCode, "123456")
        XCTAssertEqual(viewModel.companionState, .failed(code: "connection", detail: "Companion connection closed."))
    }

    func testActiveRideStopFailureBeforeUnpairRetainsCodeAndDoesNotSendUnpair() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.viewModel.pairCode = "123456"
        harness.client.onStop = { harness.client.publish(.failed(code: "connection", detail: "send failed")) }
        harness.events.removeAll()

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(harness.events, ["location.stop", "companion.stop"])
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        XCTAssertEqual(harness.viewModel.companionState, .failed(code: "connection", detail: "send failed"))
    }

    func testPairOnlyDelayedUnpairFailureRetainsCodeAndTruthfulFailure() throws {
        let pairSocket = ViewModelRecordingSocket()
        let unpairSocket = ViewModelRecordingSocket()
        unpairSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, unpairSocket])
        harness.completePairOnly()

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(try viewModelMessageTypes(unpairSocket.sentMessages), ["companion.unpair"])
        XCTAssertEqual(harness.viewModel.pairCode, "123456", "submission is not asynchronous acceptance")
        unpairSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}"))
        XCTAssertEqual(unpairSocket.cancelCount, 0, "normal reconnect status must wait for Unpair completion")
        unpairSocket.completeSend(at: 0, error: ViewModelTestError.transport)
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        XCTAssertEqual(
            harness.viewModel.companionState,
            .failed(code: "connection", detail: "Companion connection closed.")
        )
    }

    func testPairOnlyRepeatedUnpairJoinsPendingSendAndSuccessClearsExactlyOnce() throws {
        let pairSocket = ViewModelRecordingSocket()
        let unpairSocket = ViewModelRecordingSocket()
        unpairSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, unpairSocket])
        harness.completePairOnly()

        harness.viewModel.unpairHelmet()
        harness.viewModel.unpairHelmet()

        XCTAssertEqual(try viewModelMessageTypes(unpairSocket.sentMessages), ["companion.unpair"])
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        unpairSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}"))
        XCTAssertEqual(unpairSocket.cancelCount, 0)
        unpairSocket.completeSend(at: 0)
        XCTAssertEqual(harness.viewModel.pairCode, "")
        XCTAssertEqual(unpairSocket.cancelCount, 1)

        harness.viewModel.pairCode = "654321"
        unpairSocket.completeSend(at: 0)
        XCTAssertEqual(harness.viewModel.pairCode, "654321", "a consumed completion cannot clear newer UI input")
    }

    func testActiveRideDelayedStopFailurePreventsUnpairAndRetainsCode() throws {
        let pairSocket = ViewModelRecordingSocket()
        let rideSocket = ViewModelRecordingSocket()
        rideSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
        harness.completePairOnly()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.viewModel.startHelmetRide()
        rideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))
        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages), ["companion.start"])
        rideSocket.completeSend(at: 0)

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages), ["companion.start", "companion.stop"])
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages), ["companion.start", "companion.stop"])
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        XCTAssertEqual(
            harness.viewModel.companionState,
            .failed(code: "connection", detail: "Companion connection closed.")
        )
    }

    func testUnpairedStatusDuringPendingStopRetainsCodeAndRetiresOldCompletion() throws {
        let pairSocket = ViewModelRecordingSocket()
        let rideSocket = ViewModelRecordingSocket()
        rideSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
        harness.completePairOnly()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.viewModel.startHelmetRide()
        rideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))
        rideSocket.completeSend(at: 0)

        harness.viewModel.unpairHelmet()
        rideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"unpaired\"}"))

        XCTAssertEqual(harness.viewModel.pairCode, "123456", "Stop-stage state cannot acknowledge Unpair")
        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages), ["companion.start", "companion.stop"])
        XCTAssertEqual(harness.viewModel.companionState, .unpaired)

        rideSocket.completeSend(at: 1)
        rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages), ["companion.start", "companion.stop"])
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        XCTAssertEqual(harness.viewModel.companionState, .unpaired)
    }

    func testActiveRideRepeatedUnpairWaitsForStopThenUnpairSuccessAndClearsOnce() throws {
        let pairSocket = ViewModelRecordingSocket()
        let rideSocket = ViewModelRecordingSocket()
        rideSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
        harness.completePairOnly()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.viewModel.startHelmetRide()
        rideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))
        rideSocket.completeSend(at: 0)

        harness.viewModel.unpairHelmet()
        harness.viewModel.unpairHelmet()
        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages), ["companion.start", "companion.stop"])
        rideSocket.completeSend(at: 1)
        XCTAssertEqual(
            try viewModelMessageTypes(rideSocket.sentMessages),
            ["companion.start", "companion.stop", "companion.unpair"]
        )
        XCTAssertEqual(harness.viewModel.pairCode, "123456")

        harness.viewModel.unpairHelmet()
        XCTAssertEqual(try viewModelMessageTypes(rideSocket.sentMessages).filter { $0 == "companion.unpair" }.count, 1)
        rideSocket.completeSend(at: 2)
        XCTAssertEqual(harness.viewModel.pairCode, "")
        harness.viewModel.pairCode = "654321"
        rideSocket.completeSend(at: 2)
        XCTAssertEqual(harness.viewModel.pairCode, "654321")
    }

    func testAccountReplacementCancelsDelayedUnpairCompletionWithoutClearingNewInput() throws {
        let pairSocket = ViewModelRecordingSocket()
        let unpairSocket = ViewModelRecordingSocket()
        unpairSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, unpairSocket])
        harness.completePairOnly()
        harness.viewModel.unpairHelmet()
        XCTAssertEqual(try viewModelMessageTypes(unpairSocket.sentMessages), ["companion.unpair"])

        harness.viewModel.sessionToken = "account-b"
        harness.viewModel.pairCode = "654321"
        unpairSocket.completeSend(at: 0)

        XCTAssertEqual(harness.viewModel.sessionToken, "account-b")
        XCTAssertEqual(harness.viewModel.pairCode, "654321")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
    }

    func testAuthTerminalCancelsDelayedUnpairCompletionWithoutClearingNewInput() throws {
        let pairSocket = ViewModelRecordingSocket()
        let unpairSocket = ViewModelRecordingSocket()
        unpairSocket.automaticallyCompletesSends = false
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, unpairSocket])
        harness.completePairOnly()
        harness.viewModel.unpairHelmet()
        XCTAssertEqual(try viewModelMessageTypes(unpairSocket.sentMessages), ["companion.unpair"])

        unpairSocket.deliver(.string("{\"type\":\"companion.error\",\"code\":\"auth\",\"detail\":\"expired\"}"))
        harness.viewModel.pairCode = "654321"
        unpairSocket.completeSend(at: 0)

        XCTAssertEqual(harness.viewModel.pairCode, "654321")
        XCTAssertEqual(harness.viewModel.companionState, .failed(code: "auth", detail: "expired"))
    }

    func testActiveUnpairTerminalAuthAndUnpairedRetireDelayedStopFailure() throws {
        let terminalCases: [(message: String, expected: CompanionConnectionState)] = [
            (
                "{\"type\":\"companion.error\",\"code\":\"auth\",\"detail\":\"expired\"}",
                .failed(code: "auth", detail: "expired")
            ),
            (
                "{\"type\":\"companion.status\",\"state\":\"unpaired\"}",
                .unpaired
            )
        ]

        for terminal in terminalCases {
            let pairSocket = ViewModelRecordingSocket()
            let rideSocket = ViewModelRecordingSocket()
            rideSocket.automaticallyCompletesSends = false
            let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
            harness.completePairOnly()
            harness.stream.startResults = [true]
            harness.stream.permissionOnStart = .precise
            harness.viewModel.startHelmetRide()
            rideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))
            rideSocket.completeSend(at: 0)

            harness.viewModel.unpairHelmet()
            rideSocket.deliver(.string(terminal.message))
            XCTAssertEqual(harness.viewModel.companionState, terminal.expected)
            XCTAssertEqual(harness.viewModel.pairCode, "123456")

            rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
            XCTAssertEqual(harness.viewModel.companionState, terminal.expected)
            XCTAssertEqual(harness.viewModel.pairCode, "123456")
        }
    }

    func testLogoutReenteredFromUnpairLocationStopJoinsRequiredStopBeforeDisconnect() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.viewModel.pairCode = "123456"
        var didRequestLogout = false
        harness.stream.onStop = {
            guard !didRequestLogout else { return }
            didRequestLogout = true
            harness.viewModel.startHelmetRide()
            harness.viewModel.logout()
        }
        harness.events.removeAll()

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(
            harness.events.filter { $0 == "location.stop" || $0.hasPrefix("companion.") || $0.hasPrefix("auth.logout:") },
            ["location.stop", "companion.stop", "companion.disconnect", "auth.logout:account-session-token"]
        )
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testAuthRequiredReenteredFromUnpairLocationStopJoinsRequiredStopBeforeIdentityClear() {
        let harness = Harness()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.viewModel.pairCode = "123456"
        var didRequireAuth = false
        harness.stream.onStop = {
            guard !didRequireAuth else { return }
            didRequireAuth = true
            harness.viewModel.handleAuthRequired()
        }
        harness.events.removeAll()
        harness.voiceEvents.removeAll()

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(
            harness.events.filter { $0 == "location.stop" || $0.hasPrefix("companion.") },
            ["location.stop", "companion.stop", "companion.disconnect"]
        )
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        XCTAssertEqual(harness.voiceEvents, ["voice.auth.ack", "voice.owner:nil"])
    }

    func testAccountReplacementReenteredFromUnpairLocationStopJoinsOneTeardown() {
        let harness = Harness()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var replacedAccount = false
        harness.stream.onStop = {
            guard !replacedAccount else { return }
            replacedAccount = true
            harness.viewModel.startHelmetRide()
            harness.viewModel.sessionToken = "account-b"
        }
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.unpairHelmet()

        XCTAssertEqual(
            harness.events.filter { $0 == "location.stop" || $0.hasPrefix("companion.") },
            ["location.stop", "companion.stop", "companion.disconnect"]
        )
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.sessionToken, "account-b")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertEqual(harness.secretWrites.map(\.value), ["account-b"])
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testDelayedUnpairStopAccountReplacementWaitsWithoutRepeatingLocationAndNewestTokenWins() {
        let harness = Harness()
        harness.client.automaticallyCompletesStopActions = false
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.unpairHelmet()
        harness.viewModel.sessionToken = "account-b"
        harness.viewModel.startHelmetRide()
        harness.viewModel.sessionToken = "account-c"

        XCTAssertEqual(harness.events.filter { $0 == "location.stop" }, ["location.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 0, "account disconnect waits for owned Stop resolution")
        XCTAssertEqual(harness.client.unpairCount, 0)

        harness.client.completeStopAction(.accepted)

        XCTAssertEqual(harness.events.filter { $0 == "location.stop" }, ["location.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.sessionToken, "account-c")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertFalse(
            harness.events.contains("companion.connect:ws://relay.example/agent:account-session-token:false")
        )
    }

    func testRepeatedLogoutDuringDelayedUnpairStopWaitsAndFinishesExactlyOnce() {
        let harness = Harness(voiceHandsFree: true)
        harness.client.automaticallyCompletesStopActions = false
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.events.removeAll()
        harness.voiceEvents.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.unpairHelmet()
        harness.viewModel.logout()
        harness.viewModel.logout()

        XCTAssertEqual(harness.events.filter { $0 == "location.stop" }, ["location.stop"])
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 0)
        XCTAssertFalse(harness.events.contains(where: { $0.hasPrefix("auth.logout:") }))
        XCTAssertEqual(harness.viewModel.sessionToken, "account-session-token")

        harness.client.completeStopAction(.accepted)

        XCTAssertEqual(
            harness.events.filter { $0 == "location.stop" || $0.hasPrefix("companion.") || $0.hasPrefix("auth.logout:") },
            ["location.stop", "companion.stop", "companion.disconnect", "auth.logout:account-session-token"]
        )
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertEqual(harness.voiceEvents, ["voice.owner:nil", "voice.stop"])
    }

    func testJoinedUnpairLogoutStopFailureFinalizesBoundaryExactlyOnce() {
        let harness = Harness(voiceHandsFree: true)
        harness.client.automaticallyCompletesStopActions = false
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        harness.viewModel.pairCode = "123456"
        harness.events.removeAll()
        harness.voiceEvents.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.unpairHelmet()
        harness.viewModel.logout()
        harness.viewModel.logout()
        harness.client.publish(.failed(code: "connection", detail: "stop send failed"))
        harness.client.completeStopAction(.failed)
        harness.client.completeStopAction(.accepted)

        XCTAssertEqual(
            harness.events.filter { $0 == "location.stop" || $0.hasPrefix("companion.") || $0.hasPrefix("auth.logout:") },
            ["location.stop", "companion.stop", "companion.disconnect", "auth.logout:account-session-token"]
        )
        XCTAssertEqual(harness.stream.stopCount, 1)
        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.unpairCount, 0)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertEqual(harness.viewModel.pairCode, "123456")
        XCTAssertEqual(harness.voiceEvents, ["voice.owner:nil", "voice.stop"])
    }

    func testUnpairStoppingLocationTerminalFinalizesNewestAccountBoundaryMatrix() {
        let terminals: [CompanionConnectionState] = [
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]
        for terminal in terminals {
            for newestToken in ["account-c", " \n "] {
                let harness = Harness()
                harness.stream.startResults = [true, true]
                harness.stream.permissionOnStart = .precise
                harness.client.publish(.paired(deviceId: "rdk", label: nil))
                harness.viewModel.startHelmetRide()
                harness.viewModel.pairCode = "123456"
                var suppliedBoundary = false
                harness.stream.onStop = {
                    guard !suppliedBoundary else { return }
                    suppliedBoundary = true
                    harness.viewModel.sessionToken = "account-b"
                    harness.viewModel.startHelmetRide()
                    harness.viewModel.sessionToken = newestToken
                    harness.client.publish(terminal)
                }
                harness.events.removeAll()
                harness.secretWrites.removeAll()

                harness.viewModel.unpairHelmet()

                XCTAssertEqual(
                    harness.events.filter { $0 == "location.stop" || $0.hasPrefix("companion.") },
                    ["location.stop", "companion.stop", "companion.disconnect"],
                    "terminal \(terminal), newest token \(newestToken.debugDescription)"
                )
                XCTAssertEqual(harness.stream.stopCount, 1)
                XCTAssertEqual(harness.client.stopCount, 1)
                XCTAssertEqual(harness.client.disconnectCount, 1)
                XCTAssertEqual(harness.client.unpairCount, 0)
                XCTAssertEqual(harness.client.startCount, 1, "the old account is the only account that started")
                XCTAssertEqual(harness.viewModel.sessionToken, newestToken)
                XCTAssertEqual(harness.secretWrites.map(\.value), [newestToken])
                XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                XCTAssertFalse(harness.viewModel.helmetRideActive)
                XCTAssertEqual(harness.viewModel.pairCode, "123456")
            }
        }
    }

    func testStartReenteredFromOrdinaryLocationStopSettlesOldPhaseBeforeLogout() throws {
        let pairSocket = ViewModelRecordingSocket()
        let oldRideSocket = ViewModelRecordingSocket()
        let newRideSocket = ViewModelRecordingSocket()
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, oldRideSocket, newRideSocket])
        harness.completePairOnly()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.viewModel.startHelmetRide()
        oldRideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))
        oldRideSocket.automaticallyCompletesSends = false
        var requestedNewestStart = false
        harness.stream.onStop = {
            guard !requestedNewestStart else { return }
            requestedNewestStart = true
            harness.viewModel.startHelmetRide()
        }

        harness.viewModel.stopHelmetRide()

        XCTAssertTrue(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.requests.count, 3)
        XCTAssertEqual(try viewModelMessageTypes(oldRideSocket.sentMessages), ["companion.start", "companion.stop"])

        harness.viewModel.logout()
        oldRideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
        oldRideSocket.completeSend(at: 1)

        XCTAssertEqual(harness.stream.stopCount, 2, "logout must stop the newest ride after the old phase settles")
        XCTAssertEqual(try viewModelMessageTypes(newRideSocket.sentMessages), ["companion.stop"])
        XCTAssertEqual(newRideSocket.cancelCount, 1)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
    }

    func testStartWhileOrdinaryStopCompletionPendingSettlesPhaseBeforeNestedAccountReplacement() throws {
        let pairSocket = ViewModelRecordingSocket()
        let oldRideSocket = ViewModelRecordingSocket()
        let newRideSocket = ViewModelRecordingSocket()
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket, oldRideSocket, newRideSocket])
        harness.completePairOnly()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.viewModel.startHelmetRide()
        oldRideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))
        oldRideSocket.automaticallyCompletesSends = false

        harness.viewModel.stopHelmetRide()
        harness.viewModel.startHelmetRide()
        newRideSocket.automaticallyCompletesSends = false
        harness.viewModel.sessionToken = "account-b"
        harness.viewModel.sessionToken = "account-c"

        XCTAssertEqual(harness.stream.stopCount, 2)
        XCTAssertEqual(try viewModelMessageTypes(newRideSocket.sentMessages), ["companion.stop"])
        guard newRideSocket.sentMessages.count == 1 else { return }
        newRideSocket.completeSend(at: 0)
        oldRideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
        oldRideSocket.completeSend(at: 1)

        XCTAssertEqual(harness.viewModel.sessionToken, "account-c")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(newRideSocket.cancelCount, 1)
        XCTAssertEqual(harness.requests.count, 3, "no old-account socket may reopen")
    }

    func testReceiveFailureFinalizesEveryAccountStopOwnershipAndNewestIntent() {
        let ownerships = ["account-stop", "joined-user-stop"]
        let boundaries = ["logout", "replace-c", "replace-clear"]

        for ownership in ownerships {
            for boundary in boundaries {
                XCTContext.runActivity(named: "\(ownership)-\(boundary)") { _ in
                    let pairSocket = ViewModelRecordingSocket()
                    let rideSocket = ViewModelRecordingSocket()
                    let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
                    harness.completePairOnly()
                    harness.stream.startResults = [true, true]
                    harness.stream.permissionOnStart = .precise
                    harness.viewModel.startHelmetRide()
                    rideSocket.deliver(
                        .string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}")
                    )
                    rideSocket.automaticallyCompletesSends = false

                    var suppliedReentrantIntent = false
                    let cancellable = harness.viewModel.$companionState.sink { state in
                        guard !suppliedReentrantIntent,
                              state == .failed(code: "connection", detail: "Companion connection closed.") else {
                            return
                        }
                        suppliedReentrantIntent = true
                        harness.viewModel.startHelmetRide()
                        switch boundary {
                        case "logout": harness.viewModel.logout()
                        case "replace-c": harness.viewModel.sessionToken = "account-c"
                        default: harness.viewModel.sessionToken = " \n "
                        }
                    }

                    if ownership == "joined-user-stop" {
                        harness.viewModel.stopHelmetRide()
                    }
                    switch boundary {
                    case "logout": harness.viewModel.logout()
                    default: harness.viewModel.sessionToken = "account-b"
                    }

                    XCTAssertEqual(
                        try? viewModelMessageTypes(rideSocket.sentMessages),
                        ["companion.start", "companion.stop"]
                    )
                    XCTAssertEqual(harness.stream.stopCount, 1)
                    XCTAssertEqual(harness.client.stopCount, 1)
                    XCTAssertEqual(harness.client.disconnectCount, 0)

                    rideSocket.failReceive(ViewModelTestError.transport)
                    if (ownership == "account-stop") == (boundary == "logout") {
                        rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
                        rideSocket.completeSend(at: 1)
                    } else {
                        rideSocket.completeSend(at: 1)
                        rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
                    }

                    let expectedToken: String
                    switch boundary {
                    case "logout": expectedToken = ""
                    case "replace-c": expectedToken = "account-c"
                    default: expectedToken = " \n "
                    }
                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertNotEqual(harness.viewModel.sessionToken, "account-session-token")
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertEqual(harness.stream.stopCount, 1)
                    XCTAssertEqual(harness.client.stopCount, 1)
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(rideSocket.cancelCount, 1)
                    XCTAssertEqual(harness.requests.count, 2, "no account-A reconnect or reentrant Start may escape")
                    if boundary == "logout" {
                        XCTAssertEqual(harness.authLogoutTokens, ["account-session-token"])
                        XCTAssertEqual(harness.secretWrites.map(\.value), [""])
                    } else {
                        XCTAssertTrue(harness.authLogoutTokens.isEmpty)
                        XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    }
                    withExtendedLifetime(cancellable) {}
                }
            }
        }
    }

    func testUserStopInterruptionBeforeAccountBoundarySettlesEveryNewestIntent() {
        let interruptions = ["receive", "stop-send", "configuration"]
        let boundaries = ["logout", "replace-c", "replace-clear"]

        for interruption in interruptions {
            for boundary in boundaries {
                XCTContext.runActivity(named: "\(interruption)-then-\(boundary)") { _ in
                    let pairSocket = ViewModelRecordingSocket()
                    let rideSocket = ViewModelRecordingSocket()
                    let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
                    harness.completePairOnly()
                    harness.stream.startResults = [true]
                    harness.stream.permissionOnStart = .precise
                    harness.viewModel.startHelmetRide()
                    rideSocket.deliver(
                        .string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}")
                    )
                    rideSocket.automaticallyCompletesSends = false

                    harness.viewModel.stopHelmetRide()
                    XCTAssertEqual(
                        try? viewModelMessageTypes(rideSocket.sentMessages),
                        ["companion.start", "companion.stop"]
                    )
                    XCTAssertEqual(harness.stream.stopCount, 1)
                    XCTAssertEqual(harness.client.stopCount, 1)

                    let interruptedState: CompanionConnectionState
                    switch interruption {
                    case "receive":
                        interruptedState = .failed(
                            code: "connection",
                            detail: "Companion connection closed."
                        )
                        rideSocket.failReceive(ViewModelTestError.transport)
                    case "stop-send":
                        interruptedState = .failed(
                            code: "connection",
                            detail: "Companion connection closed."
                        )
                        rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)
                    default:
                        interruptedState = .failed(
                            code: "configuration",
                            detail: "Invalid relay URL or session token."
                        )
                        harness.client.connect(
                            relayURL: "not a relay url",
                            sessionToken: "account-session-token",
                            allowSelfSignedTLS: false
                        )
                    }
                    XCTAssertEqual(harness.viewModel.companionState, interruptedState)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertEqual(harness.client.disconnectCount, 0)

                    var suppliesNestedIntent = false
                    let cancellable = harness.viewModel.$companionState.sink { state in
                        guard suppliesNestedIntent, state == .signedOut else { return }
                        suppliesNestedIntent = false
                        if boundary == "replace-c" {
                            harness.viewModel.sessionToken = "account-c"
                        } else if boundary == "replace-clear" {
                            harness.viewModel.sessionToken = " \n "
                        }
                    }
                    switch boundary {
                    case "logout":
                        harness.viewModel.logout()
                        harness.viewModel.logout()
                    case "replace-c":
                        suppliesNestedIntent = true
                        harness.viewModel.sessionToken = "account-b"
                    default:
                        suppliesNestedIntent = true
                        harness.viewModel.sessionToken = "account-b"
                    }

                    rideSocket.completeSend(at: 1)
                    rideSocket.completeSend(at: 1, error: ViewModelTestError.transport)

                    let expectedToken: String
                    switch boundary {
                    case "logout": expectedToken = ""
                    case "replace-c": expectedToken = "account-c"
                    default: expectedToken = " \n "
                    }
                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertNotEqual(harness.viewModel.sessionToken, "account-session-token")
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertEqual(harness.stream.stopCount, 2)
                    XCTAssertEqual(harness.client.stopCount, 1)
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(rideSocket.cancelCount, 1)
                    XCTAssertEqual(harness.requests.count, 2, "account A must not reconnect")
                    if boundary == "logout" {
                        XCTAssertEqual(harness.authLogoutTokens, ["account-session-token"])
                        XCTAssertEqual(harness.secretWrites.map(\.value), [""])
                    } else {
                        XCTAssertTrue(harness.authLogoutTokens.isEmpty)
                        XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    }
                    withExtendedLifetime(cancellable) {}
                }
            }
        }
    }

    func testActiveRideReceiveFailureStillOwnsOneReconnectAndOneLocationSession() throws {
        let pairSocket = ViewModelRecordingSocket()
        let rideSocket = ViewModelRecordingSocket()
        let reconnectSocket = ViewModelRecordingSocket()
        let harness = RealCompanionViewModelHarness(
            sockets: [pairSocket, rideSocket, reconnectSocket],
            allowsReconnectScheduling: true
        )
        harness.completePairOnly()
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise
        harness.viewModel.startHelmetRide()
        rideSocket.deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}"))

        rideSocket.failReceive(ViewModelTestError.transport)

        XCTAssertTrue(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.stream.startCount, 1)
        XCTAssertEqual(harness.stream.stopCount, 0)
        XCTAssertEqual(harness.scheduledReconnectCount, 1)
        harness.runNextReconnect()
        reconnectSocket.deliver(
            .string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}")
        )
        XCTAssertEqual(try viewModelMessageTypes(reconnectSocket.sentMessages), ["companion.start"])
        XCTAssertTrue(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.stream.startCount, 1)
        XCTAssertEqual(harness.requests.count, 3)
    }

    func testPairOnlyInvalidRelayStartNeverClaimsClientOrLocationRide() {
        let pairSocket = ViewModelRecordingSocket()
        let harness = RealCompanionViewModelHarness(sockets: [pairSocket])
        harness.completePairOnly()
        harness.viewModel.relayURL = "not a relay url"
        harness.stream.startResults = [true]
        harness.stream.permissionOnStart = .precise

        harness.viewModel.startHelmetRide()
        harness.stream.publishFix(location(latitude: 31.2))

        XCTAssertEqual(harness.requests.count, 1, "invalid Start configuration creates no ride socket")
        XCTAssertEqual(harness.client.startCount, 0)
        XCTAssertEqual(harness.stream.startCount, 0)
        XCTAssertEqual(harness.client.fixCount, 0)
        XCTAssertNil(harness.viewModel.lastForwardedAt)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(
            harness.viewModel.companionState,
            .failed(code: "configuration", detail: "Invalid relay URL or session token.")
        )
    }

    func testSynchronousNonviableConnectAndStartStatesCannotBeginLocation() {
        let states: [CompanionConnectionState] = [
            .failed(code: "connection", detail: "closed"),
            .failed(code: "configuration", detail: "invalid"),
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]

        for boundary in ["connect", "start"] {
            for state in states {
                XCTContext.runActivity(named: "\(boundary)-\(state)") { _ in
                    let harness = Harness()
                    harness.stream.startResults = [true]
                    harness.stream.permissionOnStart = .precise
                    harness.client.publish(.paired(deviceId: "rdk", label: nil))
                    if boundary == "connect" {
                        harness.client.onConnect = { harness.client.publish(state) }
                    } else {
                        harness.client.onStart = { harness.client.publish(state) }
                    }

                    harness.viewModel.startHelmetRide()
                    harness.stream.publishFix(location(latitude: 31.2))

                    XCTAssertEqual(harness.stream.startCount, 0)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertTrue(harness.client.fixes.isEmpty)
                    XCTAssertNil(harness.viewModel.lastForwardedAt)
                    XCTAssertEqual(harness.viewModel.companionState, state)
                    XCTAssertEqual(harness.client.startCount, boundary == "connect" ? 0 : 1)
                }
            }
        }
    }

    func testPublishedStateReentrancyCommitsNewestAccountAcrossInjectedStartMatrix() {
        let boundaries = ["connect", "client-start", "location-start"]
        let states: [CompanionConnectionState] = [
            .failed(code: "connection", detail: "closed"),
            .failed(code: "configuration", detail: "invalid"),
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]
        let accountIntents = ["logout", "replace-c", "replace-clear"]
        var activityCount = 0

        for boundary in boundaries {
            for state in states {
                for accountIntent in accountIntents {
                    XCTContext.runActivity(named: "\(boundary)-\(state)-\(accountIntent)") { _ in
                        activityCount += 1
                        let harness = Harness()
                        harness.stream.startResults = [true, true]
                        harness.stream.permissionOnStart = .precise
                        harness.client.publish(.paired(deviceId: "rdk", label: nil))
                        harness.events.removeAll()
                        harness.secretWrites.removeAll()

                        var interruptedCallback: ((CompanionConnectionState) -> Void)?
                        var suppliedAccountIntent = false
                        var suppliedNestedIntent = false
                        var publishedStates: [CompanionConnectionState] = []
                        let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                            publishedStates.append(publishedState)
                            if !suppliedAccountIntent, publishedState == state {
                                suppliedAccountIntent = true
                                harness.viewModel.startHelmetRide()
                                if accountIntent == "logout" {
                                    harness.viewModel.logout()
                                } else {
                                    harness.viewModel.sessionToken = "account-b"
                                }
                            } else if suppliedAccountIntent,
                                      !suppliedNestedIntent,
                                      accountIntent != "logout",
                                      publishedState == .signedOut {
                                suppliedNestedIntent = true
                                harness.viewModel.startHelmetRide()
                                harness.viewModel.sessionToken = accountIntent == "replace-c" ? "account-c" : " \n "
                            }
                        }

                        let publishInterruption = {
                            let callback = harness.client.onState
                            interruptedCallback = callback
                            callback?(state)
                        }
                        switch boundary {
                        case "connect": harness.client.onConnect = publishInterruption
                        case "client-start": harness.client.onStart = publishInterruption
                        default: harness.stream.onStart = publishInterruption
                        }

                        harness.viewModel.startHelmetRide()
                        interruptedCallback?(state)
                        harness.stream.publishFix(self.location(latitude: 31.2))

                        let expectedToken: String
                        switch accountIntent {
                        case "logout": expectedToken = ""
                        case "replace-c": expectedToken = "account-c"
                        default: expectedToken = " \n "
                        }
                        XCTAssertTrue(suppliedAccountIntent)
                        XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                        XCTAssertFalse(harness.viewModel.helmetRideActive)
                        XCTAssertEqual(harness.stream.stopCount, 1)
                        XCTAssertEqual(harness.client.stopCount, 1)
                        XCTAssertEqual(harness.client.disconnectCount, 1)
                        XCTAssertEqual(harness.client.startCount, boundary == "connect" ? 0 : 1)
                        XCTAssertEqual(harness.stream.startCount, boundary == "location-start" ? 1 : 0)
                        XCTAssertTrue(harness.client.fixes.isEmpty)
                        XCTAssertNil(harness.viewModel.lastForwardedAt)
                        XCTAssertEqual(publishedStates.filter { $0 == state }.count, 1, "late old-generation duplicate must be stale")
                        XCTAssertEqual(publishedStates.filter { $0 == .signedOut }.count, 1, "one account boundary publishes one final state")
                        XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                        withExtendedLifetime(cancellable) {}
                    }
                }
            }
        }

        XCTAssertEqual(activityCount, 36)
    }

    func testRealClientStatePublicationReentrancyCommitsNewestAccountMatrix() {
        let publications = ["connecting", "ready", "configuration"]
        let accountIntents = ["logout", "replace-c", "replace-clear"]
        var activityCount = 0

        for publication in publications {
            for accountIntent in accountIntents {
                XCTContext.runActivity(named: "\(publication)-\(accountIntent)") { _ in
                    activityCount += 1
                    let pairSocket = ViewModelRecordingSocket()
                    let rideSocket = ViewModelRecordingSocket()
                    let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
                    harness.completePairOnly()
                    harness.stream.startResults = [true, true]
                    harness.stream.permissionOnStart = .precise
                    if publication == "configuration" {
                        harness.viewModel.relayURL = "not a relay url"
                    }

                    let targetState: CompanionConnectionState
                    switch publication {
                    case "connecting": targetState = .connecting
                    case "ready": targetState = .ready(deviceId: "rdk", label: nil)
                    default:
                        targetState = .failed(
                            code: "configuration",
                            detail: "Invalid relay URL or session token."
                        )
                    }
                    var suppliedAccountIntent = false
                    var suppliedNestedIntent = false
                    var publishedStates: [CompanionConnectionState] = []
                    let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                        publishedStates.append(publishedState)
                        if !suppliedAccountIntent, publishedState == targetState {
                            suppliedAccountIntent = true
                            harness.viewModel.startHelmetRide()
                            if accountIntent == "logout" {
                                harness.viewModel.logout()
                            } else {
                                harness.viewModel.sessionToken = "account-b"
                            }
                        } else if suppliedAccountIntent,
                                  !suppliedNestedIntent,
                                  accountIntent != "logout",
                                  publishedState == .signedOut {
                            suppliedNestedIntent = true
                            harness.viewModel.startHelmetRide()
                            harness.viewModel.sessionToken = accountIntent == "replace-c" ? "account-c" : " \n "
                        }
                    }

                    harness.viewModel.startHelmetRide()
                    if publication == "ready" {
                        rideSocket.deliver(
                            .string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk\"}")
                        )
                    }
                    harness.stream.publishFix(self.location(latitude: 31.2))

                    let expectedToken: String
                    switch accountIntent {
                    case "logout": expectedToken = ""
                    case "replace-c": expectedToken = "account-c"
                    default: expectedToken = " \n "
                    }
                    XCTAssertTrue(suppliedAccountIntent)
                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertEqual(harness.stream.stopCount, 1)
                    XCTAssertEqual(harness.client.stopCount, 1)
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(harness.client.startCount, publication == "ready" ? 1 : 0)
                    XCTAssertEqual(harness.stream.startCount, publication == "ready" ? 1 : 0)
                    XCTAssertEqual(harness.client.fixCount, 0)
                    XCTAssertNil(harness.viewModel.lastForwardedAt)
                    XCTAssertEqual(harness.requests.count, publication == "configuration" ? 1 : 2)
                    XCTAssertEqual(rideSocket.cancelCount, publication == "configuration" ? 0 : 1)
                    XCTAssertEqual(publishedStates.filter { $0 == targetState }.count, 1)
                    XCTAssertEqual(publishedStates.filter { $0 == .signedOut }.count, 1)
                    XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    if accountIntent == "logout" {
                        XCTAssertEqual(harness.authLogoutTokens, ["account-session-token"])
                    } else {
                        XCTAssertTrue(harness.authLogoutTokens.isEmpty)
                    }
                    withExtendedLifetime(cancellable) {}
                }
            }
        }

        XCTAssertEqual(activityCount, 9)
    }

    func testOrdinaryAndDuplicateStatePublicationsEmitExactlyOncePerEvent() {
        let states: [CompanionConnectionState] = [
            .signedOut,
            .connecting,
            .unpaired,
            .paired(deviceId: "rdk", label: "Helmet"),
            .helmetOffline(deviceId: "rdk", label: "Helmet"),
            .ready(deviceId: "rdk", label: "Helmet"),
            .sharing(deviceId: "rdk", label: "Helmet"),
            .failed(code: "connection", detail: "closed")
        ]

        for state in states {
            XCTContext.runActivity(named: "\(state)") { _ in
                let harness = Harness()
                var publishedStates: [CompanionConnectionState] = []
                let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedStates.append($0) }

                harness.client.publish(state)
                harness.client.publish(state)

                XCTAssertEqual(publishedStates, [state, state])
                XCTAssertEqual(harness.viewModel.companionState, state)
                XCTAssertEqual(harness.client.disconnectCount, 0)
                withExtendedLifetime(cancellable) {}
            }
        }
    }

    func testEveryPublishedStateIsAuthoritativeForReentrantAccountIntent() {
        let states: [CompanionConnectionState] = [
            .signedOut,
            .connecting,
            .unpaired,
            .paired(deviceId: "rdk", label: "Helmet"),
            .helmetOffline(deviceId: "rdk", label: "Helmet"),
            .ready(deviceId: "rdk", label: "Helmet"),
            .sharing(deviceId: "rdk", label: "Helmet"),
            .failed(code: "connection", detail: "closed")
        ]

        for state in states {
            for accountIntent in ["logout", "replace-c", "replace-clear"] {
                XCTContext.runActivity(named: "\(state)-\(accountIntent)") { _ in
                    let harness = Harness()
                    harness.secretWrites.removeAll()
                    var suppliedAccountIntent = false
                    var suppliedNestedIntent = false
                    var publishedStates: [CompanionConnectionState] = []
                    let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                        publishedStates.append(publishedState)
                        if !suppliedAccountIntent, publishedState == state {
                            suppliedAccountIntent = true
                            if accountIntent == "logout" {
                                harness.viewModel.logout()
                            } else {
                                harness.viewModel.sessionToken = "account-b"
                                if state == .signedOut {
                                    suppliedNestedIntent = true
                                    harness.viewModel.sessionToken = accountIntent == "replace-c" ? "account-c" : " \n "
                                }
                            }
                        } else if suppliedAccountIntent,
                                  !suppliedNestedIntent,
                                  accountIntent != "logout",
                                  publishedState == .signedOut {
                            suppliedNestedIntent = true
                            harness.viewModel.sessionToken = accountIntent == "replace-c" ? "account-c" : " \n "
                        }
                    }

                    harness.client.publish(state)

                    let expectedToken: String
                    switch accountIntent {
                    case "logout": expectedToken = ""
                    case "replace-c": expectedToken = "account-c"
                    default: expectedToken = " \n "
                    }
                    let expectsAccountTeardown = accountIntent == "logout" || state != .signedOut
                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertEqual(harness.client.disconnectCount, expectsAccountTeardown ? 1 : 0)
                    XCTAssertEqual(harness.client.stopCount, 0)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertTrue(harness.client.fixes.isEmpty)
                    if expectsAccountTeardown {
                        XCTAssertEqual(publishedStates.filter { $0 == .signedOut }.count, 1)
                        XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    } else {
                        XCTAssertEqual(publishedStates, [.signedOut])
                        XCTAssertEqual(harness.secretWrites.map(\.value), ["account-b", expectedToken])
                    }
                    withExtendedLifetime(cancellable) {}
                }
            }
        }
    }

    func testQueuedDuplicateBeforeReentrantLogoutCannotSuppressOwnedSignedOutCommit() {
        let harness = Harness()
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        var suppliedLogout = false
        var publishedStates: [CompanionConnectionState] = []
        let interruption = CompanionConnectionState.failed(code: "connection", detail: "closed")
        let cancellable = harness.viewModel.$companionState.dropFirst().sink { state in
            publishedStates.append(state)
            guard !suppliedLogout, state == interruption else { return }
            suppliedLogout = true
            harness.client.publish(.signedOut)
            harness.viewModel.logout()
        }

        harness.client.publish(interruption)

        XCTAssertEqual(publishedStates, [interruption, .signedOut])
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        withExtendedLifetime(cancellable) {}
    }

    func testAcceptedSynchronousStartFailurePublishesAcrossRideRollbackStress() {
        let states: [CompanionConnectionState] = [
            .failed(code: "connection", detail: "closed"),
            .failed(code: "configuration", detail: "invalid"),
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        var activityCount = 0

        for repetition in 0..<10 {
            for state in states {
                XCTContext.runActivity(named: "\(repetition)-\(state)") { _ in
                    activityCount += 1
                    let harness = Harness()
                    harness.stream.startResults = [true]
                    harness.stream.permissionOnStart = .precise
                    harness.client.onConnect = { harness.client.publish(state) }
                    var startsOnPaired = true
                    var nestedAccountToken: String?
                    var publishedStates: [CompanionConnectionState] = []
                    let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                        publishedStates.append(publishedState)
                        if startsOnPaired, publishedState == paired {
                            startsOnPaired = false
                            harness.viewModel.startHelmetRide()
                        } else if publishedState == .signedOut, let token = nestedAccountToken {
                            nestedAccountToken = nil
                            harness.viewModel.sessionToken = token
                        }
                    }

                    harness.client.publish(paired)

                    XCTAssertEqual(publishedStates, [paired, state])
                    XCTAssertEqual(harness.viewModel.companionState, state)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertFalse(harness.viewModel.helmetRideOwned)
                    XCTAssertEqual(
                        harness.events.filter { $0.hasPrefix("companion.connect:") }.count,
                        1
                    )
                    XCTAssertEqual(harness.client.startCount, 0)
                    XCTAssertEqual(harness.client.stopCount, 0)
                    XCTAssertEqual(harness.client.disconnectCount, 0)
                    XCTAssertEqual(harness.stream.startCount, 0)
                    XCTAssertEqual(harness.stream.stopCount, 0)
                    XCTAssertTrue(harness.client.fixes.isEmpty)

                    harness.viewModel.startHelmetRide()

                    XCTAssertEqual(
                        harness.events.filter { $0.hasPrefix("companion.connect:") }.count,
                        1,
                        "the published failure must agree with Start eligibility"
                    )
                    let staleCallback = harness.client.onState
                    let publicationCountBeforeAccount = publishedStates.count
                    let expectedToken = repetition.isMultiple(of: 2) ? "account-c" : " \n "
                    nestedAccountToken = expectedToken
                    harness.viewModel.sessionToken = "account-b"
                    staleCallback?(state)
                    staleCallback?(state)

                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(
                        Array(publishedStates.dropFirst(publicationCountBeforeAccount)),
                        [.signedOut],
                        "old-client duplicate states must be stale after B to C/clear"
                    )
                    XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    withExtendedLifetime(cancellable) {}
                }
            }
        }

        XCTAssertEqual(activityCount, 40)
    }

    func testRealClientInvalidRelayFailurePublishesAcrossRideRollbackStress() {
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        let failure = CompanionConnectionState.failed(
            code: "configuration",
            detail: "Invalid relay URL or session token."
        )
        var activityCount = 0

        for repetition in 0..<10 {
            XCTContext.runActivity(named: "\(repetition)-invalid-relay") { _ in
                activityCount += 1
                let pairSocket = ViewModelRecordingSocket()
                let harness = RealCompanionViewModelHarness(sockets: [pairSocket])
                harness.viewModel.pairCode = "123456"
                harness.viewModel.pairHelmet()
                harness.viewModel.relayURL = "not a relay url"
                harness.stream.startResults = [true]
                harness.stream.permissionOnStart = .precise
                var startsOnPaired = true
                var nestedAccountToken: String?
                var publishedStates: [CompanionConnectionState] = []
                let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                    publishedStates.append(publishedState)
                    if startsOnPaired, publishedState == paired {
                        startsOnPaired = false
                        harness.viewModel.startHelmetRide()
                    } else if publishedState == .signedOut, let token = nestedAccountToken {
                        nestedAccountToken = nil
                        harness.viewModel.sessionToken = token
                    }
                }

                pairSocket.deliver(
                    .string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}")
                )

                XCTAssertEqual(publishedStates, [paired, failure])
                XCTAssertEqual(harness.viewModel.companionState, failure)
                XCTAssertFalse(harness.viewModel.helmetRideActive)
                XCTAssertFalse(harness.viewModel.helmetRideOwned)
                XCTAssertEqual(harness.requests.count, 1)
                XCTAssertEqual(harness.client.startCount, 0)
                XCTAssertEqual(harness.client.stopCount, 0)
                XCTAssertEqual(harness.client.disconnectCount, 0)
                XCTAssertEqual(harness.stream.startCount, 0)
                XCTAssertEqual(harness.stream.stopCount, 0)
                XCTAssertEqual(harness.client.fixCount, 0)
                XCTAssertEqual(pairSocket.cancelCount, 1)

                harness.viewModel.startHelmetRide()

                XCTAssertEqual(harness.requests.count, 1, "failed configuration must remain ineligible")
                let staleCallback = harness.client.onState
                let publicationCountBeforeAccount = publishedStates.count
                let expectedToken = repetition.isMultiple(of: 2) ? "account-c" : " \n "
                nestedAccountToken = expectedToken
                harness.viewModel.sessionToken = "account-b"
                staleCallback?(failure)
                staleCallback?(failure)

                XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                XCTAssertEqual(harness.client.disconnectCount, 1)
                XCTAssertEqual(
                    Array(publishedStates.dropFirst(publicationCountBeforeAccount)),
                    [.signedOut]
                )
                XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                withExtendedLifetime(cancellable) {}
            }
        }

        XCTAssertEqual(activityCount, 10)
    }

    func testAcceptedStartStatePublishesAcrossOrdinaryStopStress() {
        let states: [CompanionConnectionState] = [
            .connecting,
            .ready(deviceId: "rdk", label: nil)
        ]
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        var activityCount = 0

        for repetition in 0..<10 {
            for state in states {
                XCTContext.runActivity(named: "\(repetition)-\(state)") { _ in
                    activityCount += 1
                    let harness = Harness()
                    harness.stream.startResults = [true, true]
                    harness.stream.permissionOnStart = .precise
                    harness.client.onConnect = { harness.client.publish(state) }
                    var startsAndStopsOnPaired = true
                    var nestedAccountToken: String?
                    var publishedStates: [CompanionConnectionState] = []
                    let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                        publishedStates.append(publishedState)
                        if startsAndStopsOnPaired, publishedState == paired {
                            startsAndStopsOnPaired = false
                            harness.viewModel.startHelmetRide()
                            harness.viewModel.stopHelmetRide()
                        } else if publishedState == .signedOut, let token = nestedAccountToken {
                            nestedAccountToken = nil
                            harness.viewModel.sessionToken = token
                        }
                    }

                    harness.client.publish(paired)

                    XCTAssertEqual(publishedStates, [paired, state])
                    XCTAssertEqual(harness.viewModel.companionState, state)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertFalse(harness.viewModel.helmetRideOwned)
                    XCTAssertEqual(
                        harness.events.filter { $0.hasPrefix("companion.connect:") }.count,
                        1
                    )
                    XCTAssertEqual(harness.client.startCount, 1)
                    XCTAssertEqual(harness.client.stopCount, 1)
                    XCTAssertEqual(harness.client.disconnectCount, 0)
                    XCTAssertEqual(harness.stream.startCount, 1)
                    XCTAssertEqual(harness.stream.stopCount, 1)

                    harness.viewModel.startHelmetRide()
                    if case .ready = state {
                        XCTAssertTrue(harness.viewModel.helmetRideActive)
                        XCTAssertEqual(harness.client.startCount, 2)
                        XCTAssertEqual(harness.stream.startCount, 2)
                        harness.viewModel.stopHelmetRide()
                        XCTAssertEqual(harness.client.stopCount, 2)
                        XCTAssertEqual(harness.stream.stopCount, 2)
                    } else {
                        XCTAssertFalse(harness.viewModel.helmetRideActive)
                        XCTAssertEqual(harness.client.startCount, 1)
                        XCTAssertEqual(harness.stream.startCount, 1)
                    }

                    let staleCallback = harness.client.onState
                    let publicationCountBeforeAccount = publishedStates.count
                    let expectedToken = repetition.isMultiple(of: 2) ? "account-c" : " \n "
                    nestedAccountToken = expectedToken
                    harness.viewModel.sessionToken = "account-b"
                    staleCallback?(state)
                    staleCallback?(state)

                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(
                        Array(publishedStates.dropFirst(publicationCountBeforeAccount)),
                        [.signedOut]
                    )
                    XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    withExtendedLifetime(cancellable) {}
                }
            }
        }

        XCTAssertEqual(activityCount, 20)
    }

    func testRealClientConnectingPublishesAcrossOrdinaryStopStress() throws {
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        var activityCount = 0

        for repetition in 0..<10 {
            try XCTContext.runActivity(named: "\(repetition)-real-connecting") { _ in
                activityCount += 1
                let pairSocket = ViewModelRecordingSocket()
                let rideSocket = ViewModelRecordingSocket()
                let harness = RealCompanionViewModelHarness(sockets: [pairSocket, rideSocket])
                harness.viewModel.pairCode = "123456"
                harness.viewModel.pairHelmet()
                harness.stream.startResults = [true]
                harness.stream.permissionOnStart = .precise
                var startsAndStopsOnPaired = true
                var nestedAccountToken: String?
                var publishedStates: [CompanionConnectionState] = []
                let cancellable = harness.viewModel.$companionState.dropFirst().sink { publishedState in
                    publishedStates.append(publishedState)
                    if startsAndStopsOnPaired, publishedState == paired {
                        startsAndStopsOnPaired = false
                        harness.viewModel.startHelmetRide()
                        harness.viewModel.stopHelmetRide()
                    } else if publishedState == .signedOut, let token = nestedAccountToken {
                        nestedAccountToken = nil
                        harness.viewModel.sessionToken = token
                    }
                }

                pairSocket.deliver(
                    .string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}")
                )

                XCTAssertEqual(publishedStates, [paired, .connecting])
                XCTAssertEqual(harness.viewModel.companionState, .connecting)
                XCTAssertFalse(harness.viewModel.helmetRideActive)
                XCTAssertFalse(harness.viewModel.helmetRideOwned)
                XCTAssertEqual(harness.requests.count, 2)
                XCTAssertEqual(harness.client.startCount, 1)
                XCTAssertEqual(harness.client.stopCount, 1)
                XCTAssertEqual(harness.client.disconnectCount, 0)
                XCTAssertEqual(harness.stream.startCount, 1)
                XCTAssertEqual(harness.stream.stopCount, 1)
                XCTAssertEqual(try self.viewModelMessageTypes(rideSocket.sentMessages), ["companion.stop"])
                XCTAssertEqual(pairSocket.cancelCount, 1)
                XCTAssertEqual(rideSocket.cancelCount, 0)

                harness.viewModel.startHelmetRide()

                XCTAssertEqual(harness.requests.count, 2, "connecting presentation must remain ineligible")
                XCTAssertEqual(harness.client.startCount, 1)
                XCTAssertEqual(harness.stream.startCount, 1)
                let staleCallback = harness.client.onState
                let publicationCountBeforeAccount = publishedStates.count
                let expectedToken = repetition.isMultiple(of: 2) ? "account-c" : " \n "
                nestedAccountToken = expectedToken
                harness.viewModel.sessionToken = "account-b"
                staleCallback?(.connecting)
                staleCallback?(.connecting)

                XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                XCTAssertEqual(harness.client.disconnectCount, 1)
                XCTAssertEqual(rideSocket.cancelCount, 1)
                XCTAssertEqual(
                    Array(publishedStates.dropFirst(publicationCountBeforeAccount)),
                    [.signedOut]
                )
                XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                withExtendedLifetime(cancellable) {}
            }
        }

        XCTAssertEqual(activityCount, 10)
    }

    func testQueuedStartTerminalOutranksRollbackReadyStress() {
        let terminals: [CompanionConnectionState] = [
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        let staleReady = CompanionConnectionState.ready(deviceId: "stale-rdk", label: nil)
        var activityCount = 0

        for repetition in 0..<20 {
            for terminal in terminals {
                XCTContext.runActivity(named: "\(repetition)-\(terminal)") { _ in
                    activityCount += 1
                    let harness = Harness()
                    harness.stream.startResults = [true]
                    harness.stream.permissionOnStart = .precise
                    harness.client.onStart = { harness.client.publish(terminal) }
                    harness.client.onStop = { harness.client.publish(staleReady) }
                    var startsOnPaired = true
                    var nestedAccountToken: String?
                    var publishedStates: [CompanionConnectionState] = []
                    let cancellable = harness.viewModel.$companionState.dropFirst().sink { state in
                        publishedStates.append(state)
                        if startsOnPaired, state == paired {
                            startsOnPaired = false
                            harness.viewModel.startHelmetRide()
                        } else if state == .signedOut, let token = nestedAccountToken {
                            nestedAccountToken = nil
                            harness.viewModel.sessionToken = token
                        }
                    }

                    harness.client.publish(paired)

                    XCTAssertEqual(publishedStates, [paired, terminal])
                    XCTAssertEqual(harness.viewModel.companionState, terminal)
                    XCTAssertFalse(harness.viewModel.helmetRideActive)
                    XCTAssertFalse(harness.viewModel.helmetRideOwned)
                    XCTAssertEqual(harness.client.startCount, 1)
                    XCTAssertEqual(harness.client.stopCount, 1)
                    XCTAssertEqual(harness.client.disconnectCount, 0)
                    XCTAssertEqual(harness.stream.startCount, 0)
                    XCTAssertEqual(harness.stream.stopCount, 1)
                    XCTAssertTrue(harness.client.fixes.isEmpty)
                    XCTAssertNil(harness.viewModel.lastForwardedAt)

                    let staleCallback = harness.client.onState
                    let publicationCountBeforeAccount = publishedStates.count
                    let expectedToken: String
                    switch repetition % 3 {
                    case 0:
                        expectedToken = ""
                        harness.viewModel.logout()
                    case 1:
                        expectedToken = "account-c"
                        nestedAccountToken = expectedToken
                        harness.viewModel.sessionToken = "account-b"
                    default:
                        expectedToken = " \n "
                        nestedAccountToken = expectedToken
                        harness.viewModel.sessionToken = "account-b"
                    }
                    staleCallback?(terminal)
                    staleCallback?(staleReady)

                    XCTAssertEqual(harness.viewModel.sessionToken, expectedToken)
                    XCTAssertEqual(harness.viewModel.companionState, .signedOut)
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(
                        Array(publishedStates.dropFirst(publicationCountBeforeAccount)),
                        [.signedOut],
                        "logout and B to nested C/clear own the only final publication"
                    )
                    XCTAssertEqual(harness.secretWrites.map(\.value), [expectedToken])
                    withExtendedLifetime(cancellable) {}
                }
            }
        }

        XCTAssertEqual(activityCount, 40)
    }

    func testQueuedOrdinaryThenDuplicateTerminalLeavesLatestTerminalAuthoritative() {
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        let ordinary = CompanionConnectionState.ready(deviceId: "rdk", label: nil)
        let terminals: [CompanionConnectionState] = [
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]

        for terminal in terminals {
            XCTContext.runActivity(named: "\(terminal)") { _ in
                let harness = Harness()
                var queuesNestedStates = true
                var publishedStates: [CompanionConnectionState] = []
                let cancellable = harness.viewModel.$companionState.dropFirst().sink { state in
                    publishedStates.append(state)
                    guard queuesNestedStates, state == paired else { return }
                    queuesNestedStates = false
                    harness.client.publish(ordinary)
                    harness.client.publish(terminal)
                    harness.client.publish(terminal)
                }

                harness.client.publish(paired)

                XCTAssertEqual(publishedStates, [paired, ordinary, terminal, terminal])
                XCTAssertEqual(harness.viewModel.companionState, terminal)
                XCTAssertFalse(harness.viewModel.helmetRideActive)
                XCTAssertEqual(harness.client.startCount, 0)
                XCTAssertEqual(harness.client.stopCount, 0)
                XCTAssertEqual(harness.client.disconnectCount, 0)
                XCTAssertEqual(harness.stream.startCount, 0)
                XCTAssertEqual(harness.stream.stopCount, 0)
                withExtendedLifetime(cancellable) {}
            }
        }
    }

    func testTerminalSubscriberExplicitReplacementAndFreshStartOwnNewEpoch() {
        let terminals: [CompanionConnectionState] = [
            .failed(code: "auth", detail: "expired"),
            .unpaired
        ]
        let paired = CompanionConnectionState.paired(deviceId: "rdk", label: nil)
        let ready = CompanionConnectionState.ready(deviceId: "rdk", label: nil)

        for terminal in terminals {
            XCTContext.runActivity(named: "\(terminal)") { _ in
                let harness = Harness()
                harness.viewModel.pairCode = "123456"
                harness.stream.startResults = [true]
                harness.stream.permissionOnStart = .precise
                var connectCount = 0
                harness.client.onConnect = {
                    connectCount += 1
                    harness.client.publish(connectCount == 1 ? .connecting : ready)
                }
                var replacesTerminal = true
                var publishedStates: [CompanionConnectionState] = []
                let cancellable = harness.viewModel.$companionState.dropFirst().sink { state in
                    publishedStates.append(state)
                    guard replacesTerminal, state == terminal else { return }
                    replacesTerminal = false
                    if terminal == .unpaired {
                        harness.viewModel.pairHelmet()
                    } else {
                        harness.viewModel.sessionToken = "account-b"
                    }
                }

                harness.client.publish(terminal)

                if terminal == .unpaired {
                    XCTAssertEqual(publishedStates, [terminal, .connecting])
                    XCTAssertEqual(harness.viewModel.sessionToken, "account-session-token")
                    XCTAssertEqual(harness.client.disconnectCount, 0)
                    XCTAssertEqual(harness.stream.stopCount, 0)
                } else {
                    XCTAssertEqual(publishedStates, [terminal, .signedOut])
                    XCTAssertEqual(harness.viewModel.sessionToken, "account-b")
                    XCTAssertEqual(harness.client.disconnectCount, 1)
                    XCTAssertEqual(harness.stream.stopCount, 1)
                    harness.viewModel.pairHelmet()
                }
                XCTAssertEqual(harness.viewModel.companionState, .connecting)
                XCTAssertEqual(harness.client.pairCodes, ["123456"])
                XCTAssertEqual(connectCount, 1)

                harness.client.publish(paired)
                harness.viewModel.startHelmetRide()

                XCTAssertEqual(harness.viewModel.companionState, ready)
                XCTAssertTrue(harness.viewModel.helmetRideActive)
                XCTAssertEqual(connectCount, 2)
                XCTAssertEqual(harness.client.startCount, 1)
                XCTAssertEqual(harness.stream.startCount, 1)
                harness.viewModel.stopHelmetRide()
                XCTAssertFalse(harness.viewModel.helmetRideActive)
                XCTAssertEqual(harness.client.stopCount, 1)
                withExtendedLifetime(cancellable) {}
            }
        }
    }

    func testAccountBoundaryDefersDisconnectStartAcrossNestedNewestTokenMatrix() {
        for nestedToken in ["account-c", " \n ", " account-session-token "] {
            let harness = Harness()
            harness.stream.startResults = [true, true]
            harness.stream.permissionOnStart = .precise
            harness.client.publish(.paired(deviceId: "rdk", label: nil))
            harness.viewModel.startHelmetRide()
            var suppliedNestedIntent = false
            harness.client.onDisconnect = {
                guard !suppliedNestedIntent else { return }
                suppliedNestedIntent = true
                harness.viewModel.startHelmetRide()
                harness.viewModel.sessionToken = nestedToken
            }
            harness.events.removeAll()
            harness.secretWrites.removeAll()

            harness.viewModel.sessionToken = "account-b"

            XCTAssertEqual(harness.viewModel.sessionToken, nestedToken, "nested token \(nestedToken.debugDescription)")
            XCTAssertEqual(harness.client.stopCount, 1)
            XCTAssertEqual(harness.client.disconnectCount, 1)
            XCTAssertEqual(harness.client.startCount, 1, "old account A must not own a replacement ride")
            XCTAssertFalse(harness.viewModel.helmetRideActive)
            XCTAssertEqual(harness.viewModel.companionState, .signedOut)
            XCTAssertEqual(harness.secretWrites.map(\.value), [nestedToken])
            XCTAssertFalse(
                harness.events.contains("companion.connect:ws://relay.example/agent:account-session-token:false")
            )
        }
    }

    func testPublishedSignedOutStartCannotEscapeAccountBoundaryOnOldToken() {
        let harness = Harness()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var armed = false
        let cancellable = harness.viewModel.$companionState.sink { state in
            guard armed, state == .signedOut else { return }
            harness.viewModel.startHelmetRide()
        }
        harness.events.removeAll()
        armed = true

        harness.viewModel.sessionToken = "account-b"

        XCTAssertEqual(harness.viewModel.sessionToken, "account-b")
        XCTAssertEqual(harness.client.startCount, 1)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(
            harness.events.contains("companion.connect:ws://relay.example/agent:account-session-token:false")
        )
        withExtendedLifetime(cancellable) {}
    }

    func testLogoutReenteredFromDisconnectJoinsBoundaryAndCancelsQueuedStartExactlyOnce() {
        let harness = Harness()
        harness.stream.startResults = [true, true]
        harness.stream.permissionOnStart = .precise
        harness.client.publish(.paired(deviceId: "rdk", label: nil))
        harness.viewModel.startHelmetRide()
        var reenteredLogout = false
        harness.client.onDisconnect = {
            guard !reenteredLogout else { return }
            reenteredLogout = true
            harness.viewModel.startHelmetRide()
            harness.viewModel.stopHelmetRide()
            harness.viewModel.logout()
        }
        harness.events.removeAll()
        harness.secretWrites.removeAll()

        harness.viewModel.sessionToken = "account-b"

        XCTAssertEqual(harness.client.stopCount, 1)
        XCTAssertEqual(harness.client.disconnectCount, 1)
        XCTAssertEqual(harness.client.startCount, 1)
        XCTAssertEqual(harness.viewModel.sessionToken, "")
        XCTAssertEqual(harness.viewModel.companionState, .signedOut)
        XCTAssertFalse(harness.viewModel.helmetRideActive)
        XCTAssertEqual(harness.secretWrites.map(\.value), [""])
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

    private func companionDefaults() -> UserDefaults {
        let defaults = UserDefaults(suiteName: "CompanionViewModelCompositionTests.\(UUID().uuidString)")!
        defaults.set("ws://relay.example/agent", forKey: "relay_url")
        defaults.set("user-1", forKey: "auth_user_id")
        defaults.set("rider", forKey: "auth_username")
        defaults.set("Rider", forKey: "auth_display_name")
        defaults.set("tester", forKey: "auth_role")
        return defaults
    }

    private func companionToken(in request: URLRequest) -> String? {
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "token" })?
            .value
    }

    private func viewModelMessageTypes(_ messages: [URLSessionWebSocketTask.Message]) throws -> [String] {
        try messages.map { message in
            guard case let .string(text) = message,
                  let data = text.data(using: .utf8),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else {
                throw ViewModelTestError.invalidMessage
            }
            return type
        }
    }
}

private enum ViewModelTestError: Error {
    case invalidMessage
    case transport
}

private final class ViewModelRecordingSocket: CompanionSocketTask {
    var eventSink: ((String) -> Void)?
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private(set) var cancelCount = 0
    var receiveResultOnRegistration: Result<URLSessionWebSocketTask.Message, Error>?
    var automaticallyCompletesSends = true
    private var sendCompletions: [(Error?) -> Void] = []
    private var receiveCompletions: [(Result<URLSessionWebSocketTask.Message, Error>) -> Void] = []

    func resume() { eventSink?("socket.resume") }

    func send(
        _ message: URLSessionWebSocketTask.Message,
        completionHandler: @escaping (Error?) -> Void
    ) {
        sentMessages.append(message)
        let type: String
        if case let .string(text) = message,
           let data = text.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            type = object["type"] as? String ?? "invalid"
        } else {
            type = "invalid"
        }
        eventSink?("socket.send:\(type)")
        sendCompletions.append(completionHandler)
        if automaticallyCompletesSends { completionHandler(nil) }
    }

    func receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        receiveCompletions.append(completionHandler)
        if let result = receiveResultOnRegistration {
            receiveCompletions.removeFirst()(result)
        }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancelCount += 1
        receiveCompletions.removeAll()
    }

    func deliver(_ message: URLSessionWebSocketTask.Message) {
        receiveCompletions.removeFirst()(.success(message))
    }

    func failReceive(_ error: Error) {
        receiveCompletions.removeFirst()(.failure(error))
    }

    func completeSend(at index: Int, error: Error? = nil) {
        sendCompletions[index](error)
    }
}

private final class RealCompanionViewModelHarness {
    let sockets: [ViewModelRecordingSocket]
    let allowsReconnectScheduling: Bool
    private(set) var requests: [URLRequest] = []
    private(set) var authLogoutTokens: [String] = []
    private(set) var secretWrites: [(account: String, value: String)] = []
    private var scheduledReconnects: [(callback: () -> Void, delay: TimeInterval)] = []
    let stream = FakeLocationStream()
    private lazy var realClient = RDKCompanionClient(
        socketFactory: { [unowned self] request, _ in
            let socket = self.sockets[self.requests.count]
            self.requests.append(request)
            return socket
        },
        schedule: { [unowned self] callback, delay in
            guard self.allowsReconnectScheduling else {
                XCTFail("Explicit teardown must not schedule reconnect")
                return
            }
            self.scheduledReconnects.append((callback, delay))
        }
    )
    private(set) lazy var client = ObservedCompanionClient(base: realClient)
    private(set) lazy var viewModel: MainViewModel = {
        let defaults = UserDefaults(suiteName: "RealCompanionViewModelHarness.\(UUID().uuidString)")!
        defaults.set("ws://relay.example/agent", forKey: "relay_url")
        defaults.set("user-1", forKey: "auth_user_id")
        defaults.set("rider", forKey: "auth_username")
        defaults.set("Rider", forKey: "auth_display_name")
        defaults.set("tester", forKey: "auth_role")
        return MainViewModel(
            defaults: defaults,
            initialAuthToken: "manual-operator-token",
            initialSessionToken: "account-session-token",
            companionClient: client,
            locationStream: stream,
            authLogout: { [unowned self] _, token, _ in self.authLogoutTokens.append(token) },
            persistSecret: { [unowned self] account, value in self.secretWrites.append((account, value)) },
            monotonicNow: { 0 },
            wallClock: { .distantPast },
            schedule: { _, _ in XCTFail("Explicit unpair must not schedule fixes") },
            voiceActions: .init(
                acknowledgeAuthRequired: {},
                selectTranscriptOwner: { _ in },
                isHandsFree: { false },
                stop: {}
            )
        )
    }()

    var scheduledReconnectCount: Int { scheduledReconnects.count }

    init(sockets: [ViewModelRecordingSocket], allowsReconnectScheduling: Bool = false) {
        self.sockets = sockets
        self.allowsReconnectScheduling = allowsReconnectScheduling
        _ = viewModel
    }

    func runNextReconnect() {
        scheduledReconnects.removeFirst().callback()
    }

    func completePairOnly() {
        viewModel.pairCode = "123456"
        viewModel.pairHelmet()
        sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}"))
    }
}

private final class ObservedCompanionClient: CompanionClientControlling {
    private let base: RDKCompanionClient
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var disconnectCount = 0
    private(set) var fixCount = 0

    var onState: ((CompanionConnectionState) -> Void)? {
        get { base.onState }
        set { base.onState = newValue }
    }

    init(base: RDKCompanionClient) {
        self.base = base
    }

    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool) {
        base.connect(
            relayURL: relayURL,
            sessionToken: sessionToken,
            allowSelfSignedTLS: allowSelfSignedTLS
        )
    }

    func pair(code: String) { base.pair(code: code) }
    func startRide() {
        startCount += 1
        base.startRide()
    }

    func stopRide() {
        stopCount += 1
        base.stopRide()
    }

    func stopRide(completion: @escaping (CompanionActionResult) -> Void) {
        stopCount += 1
        base.stopRide(completion: completion)
    }

    func unpair() { base.unpair() }

    func unpair(completion: @escaping (CompanionActionResult) -> Void) {
        base.unpair(completion: completion)
    }

    func sendLatest(_ fix: CompanionFix) {
        fixCount += 1
        base.sendLatest(fix)
    }

    func disconnect() {
        disconnectCount += 1
        base.disconnect()
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
    var onPersistSecret: ((String, String) -> Void)?
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
            persistSecret: { [weak self] account, value in
                self?.secretWrites.append((account, value))
                self?.events.append("secret.persist:\(value)")
                self?.onPersistSecret?(account, value)
            },
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
    var onStop: (() -> Void)?
    var onSend: (() -> Void)?
    var onDisconnect: (() -> Void)?
    var pairCodes: [String] = []
    var fixes: [CompanionFix] = []
    var startCount = 0
    var stopCount = 0
    var disconnectCount = 0
    var unpairCount = 0
    var automaticallyCompletesStopActions = true
    private var stopActionCompletions: [(CompanionActionResult) -> Void] = []

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
        onStop?()
    }

    func stopRide(completion: @escaping (CompanionActionResult) -> Void) {
        stopRide()
        if automaticallyCompletesStopActions {
            completion(.accepted)
        } else {
            stopActionCompletions.append(completion)
        }
    }

    func completeStopAction(_ result: CompanionActionResult, at index: Int = 0) {
        stopActionCompletions[index](result)
    }

    func unpair() {
        unpairCount += 1
        eventSink?("companion.unpair")
    }

    func unpair(completion: @escaping (CompanionActionResult) -> Void) {
        unpair()
        completion(.accepted)
    }

    func sendLatest(_ fix: CompanionFix) {
        fixes.append(fix)
        eventSink?("companion.fix:\(fix.sequence)")
        onSend?()
    }

    func disconnect() {
        disconnectCount += 1
        eventSink?("companion.disconnect")
        onDisconnect?()
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
    var onStart: (() -> Void)?
    var onStop: (() -> Void)?
    private(set) var startCount = 0
    private(set) var stopCount = 0

    func startFromForeground() -> Bool {
        startCount += 1
        eventSink?("location.start")
        onStart?()
        if let permissionOnStart { onPermission?(permissionOnStart) }
        return startResults.isEmpty ? false : startResults.removeFirst()
    }

    func stop() {
        stopCount += 1
        eventSink?("location.stop")
        onStop?()
    }
    func publishFix(_ location: CLLocation) { onFix?(location) }
    func publishPermission(_ permission: CompanionLocationPermission) { onPermission?(permission) }
}
