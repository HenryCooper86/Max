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

    func completeSend(at index: Int, error: Error? = nil) {
        sendCompletions[index](error)
    }
}

private final class RealCompanionViewModelHarness {
    let sockets: [ViewModelRecordingSocket]
    private(set) var requests: [URLRequest] = []
    let stream = FakeLocationStream()
    private lazy var client = RDKCompanionClient(
        socketFactory: { [unowned self] request, _ in
            let socket = self.sockets[self.requests.count]
            self.requests.append(request)
            return socket
        },
        schedule: { _, _ in XCTFail("Explicit unpair must not schedule reconnect") }
    )
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
            authLogout: { _, _, _ in },
            persistSecret: { _, _ in },
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

    init(sockets: [ViewModelRecordingSocket]) {
        self.sockets = sockets
        _ = viewModel
    }

    func completePairOnly() {
        viewModel.pairCode = "123456"
        viewModel.pairHelmet()
        sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk\"}"))
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
    var onStop: (() -> Void)?
    private(set) var stopCount = 0

    func startFromForeground() -> Bool {
        eventSink?("location.start")
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
