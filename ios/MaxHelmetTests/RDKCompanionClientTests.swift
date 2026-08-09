import Foundation
import XCTest
@testable import MaxHelmet

final class RDKCompanionClientTests: XCTestCase {
    func testConnectCreatesStandaloneSocketResumesAndStartsOneReceiveLoop() throws {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }

        harness.connect(allowSelfSignedTLS: true)

        XCTAssertEqual(harness.requests.count, 1)
        XCTAssertEqual(harness.requests[0].url?.path, "/companion")
        XCTAssertEqual(harness.tlsFlags, [true])
        XCTAssertEqual(harness.sockets[0].resumeCount, 1)
        XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 1)
        XCTAssertEqual(states, [.connecting])
        XCTAssertTrue(Thread.isMainThread)
    }

    func testServerStatesArriveInOrderOnMainAndReceiveLoopStaysSingle() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        var mainFlags: [Bool] = []
        harness.client.onState = {
            states.append($0)
            mainFlags.append(Thread.isMainThread)
        }
        harness.connect()

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"unpaired\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk-1\",\"deviceLabel\":\"Helmet\"}"))

        XCTAssertEqual(states, [.connecting, .unpaired, .ready(deviceId: "rdk-1", label: "Helmet")])
        XCTAssertEqual(mainFlags, [true, true, true])
        XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 1)
    }

    func testBackgroundReceivePublishesStateOnMainThread() {
        let harness = ClientHarness(socketCount: 1)
        let delivered = expectation(description: "state delivered")
        harness.client.onState = { state in
            guard state == .unpaired else { return }
            XCTAssertTrue(Thread.isMainThread)
            delivered.fulfill()
        }
        harness.connect()

        DispatchQueue.global().async {
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"unpaired\"}"))
        }
        wait(for: [delivered], timeout: 1)
    }

    func testPairStartStopAndUnpairUseExactMessages() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.pair(code: "  S8NM5R ")
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.stopRide()
        harness.client.unpair()

        let objects = try harness.sockets[0].sentMessages.map(jsonObject)
        XCTAssertEqual(objects.count, 4)
        XCTAssertEqual(objects[0] as NSDictionary, ["type": "companion.pair", "code": "S8NM5R"] as NSDictionary)
        XCTAssertEqual(objects[1] as NSDictionary, ["type": "companion.start"] as NSDictionary)
        XCTAssertEqual(objects[2] as NSDictionary, ["type": "companion.stop"] as NSDictionary)
        XCTAssertEqual(objects[3] as NSDictionary, ["type": "companion.unpair"] as NSDictionary)
    }

    func testEmptyPairCodeIsNotSent() {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.pair(code: " \n ")
        XCTAssertTrue(harness.sockets[0].sentMessages.isEmpty)
    }

    func testPairOnlyConnectionClosesAndStartRideOpensFreshSocket() throws {
        let harness = ClientHarness(socketCount: 2)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk-1\"}"))

        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(states.last, .paired(deviceId: "rdk-1", label: nil))
        harness.client.startRide()
        XCTAssertEqual(harness.requests.count, 2)
        XCTAssertEqual(harness.sockets[1].resumeCount, 1)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        XCTAssertEqual(try messageTypes(harness.sockets[1].sentMessages), ["companion.start"])
    }

    func testDesiredRideReconnectsWithExactBoundedBackoffThenFailsStably() {
        let harness = ClientHarness(socketCount: 7)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.startRide()

        for socketIndex in 0..<7 {
            harness.sockets[socketIndex].failReceive(TestError.transport)
            if socketIndex < 6 {
                XCTAssertEqual(harness.scheduled.count, socketIndex + 1)
                harness.runScheduled(at: socketIndex)
            }
        }

        XCTAssertEqual(harness.scheduled.map(\.delay), [1, 2, 4, 8, 16, 30])
        XCTAssertEqual(harness.requests.count, 7)
        XCTAssertEqual(states.last, .failed(code: "connection", detail: "Unable to reconnect after 6 attempts."))
    }

    func testSuccessfulStatusResetsReconnectBackoff() {
        let harness = ClientHarness(socketCount: 3)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].failReceive(TestError.transport)
        harness.runScheduled(at: 0)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[1].failReceive(TestError.transport)

        XCTAssertEqual(harness.scheduled.map(\.delay), [1, 1])
    }

    func testDesiredRideSendsStartExactlyOncePerFreshReadySocket() throws {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.sockets[0].failReceive(TestError.transport)
        harness.runScheduled(at: 0)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), ["companion.start"])
        XCTAssertEqual(try messageTypes(harness.sockets[1].sentMessages), ["companion.start"])
    }

    func testStopUnpairAndDisconnectPreventScheduledReconnect() {
        for action in ["stop", "unpair", "disconnect"] {
            let harness = ClientHarness(socketCount: 2)
            harness.connect()
            harness.client.startRide()
            harness.sockets[0].failReceive(TestError.transport)
            XCTAssertEqual(harness.scheduled.count, 1)
            switch action {
            case "stop": harness.client.stopRide()
            case "unpair": harness.client.unpair()
            default: harness.client.disconnect()
            }
            harness.runScheduled(at: 0)
            XCTAssertEqual(harness.requests.count, 1, "action \(action) must own reconnect cancellation")
        }
    }

    func testHTTP401FailsAsAuthAndNeverReconnects() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].httpStatusCode = 401
        harness.sockets[0].failReceive(TestError.transport)

        guard case let .failed(code, detail) = states.last else { return XCTFail("Expected auth failure") }
        XCTAssertEqual(code, "auth")
        XCTAssertTrue(detail.contains("401"))
        XCTAssertTrue(harness.scheduled.isEmpty)
    }

    func testOtherHTTPUpgradeRejectionFailsWithoutReconnect() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].httpStatusCode = 403
        harness.sockets[0].failReceive(TestError.transport)

        guard case let .failed(code, detail) = states.last else { return XCTFail("Expected connection failure") }
        XCTAssertEqual(code, "connection")
        XCTAssertTrue(detail.contains("403"))
        XCTAssertTrue(harness.scheduled.isEmpty)
    }

    func testNewConnectInvalidatesOldReceiveSendAndScheduledCallbacks() throws {
        let harness = ClientHarness(socketCount: 3)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.pair(code: "ABC123")
        harness.client.startRide()
        harness.sockets[0].failReceive(TestError.transport)
        XCTAssertEqual(harness.scheduled.count, 1)

        harness.connect(token: "new-token")
        harness.sockets[0].completeSend(at: 0, error: TestError.transport)
        harness.runScheduled(at: 0)
        harness.sockets[0].redeliverLast(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

        XCTAssertEqual(harness.requests.count, 2)
        XCTAssertEqual(states.last, .connecting)
        XCTAssertTrue(harness.sockets[1].sentMessages.isEmpty)
    }

    func testEveryExplicitConnectClearsRideAndLocationAcrossSessionBoundary() throws {
        for replacementToken in ["account-b", "account-token"] {
            let harness = ClientHarness(socketCount: 2)
            harness.connect(token: "account-token")
            harness.client.startRide()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            harness.client.sendLatest(fix(sequence: 30))
            harness.client.sendLatest(fix(sequence: 31))

            harness.connect(token: replacementToken)
            harness.sockets[0].completeSend(at: 0, error: TestError.transport)
            harness.sockets[0].completeSend(at: 1, error: TestError.transport)
            harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

            XCTAssertTrue(
                harness.sockets[1].sentMessages.isEmpty,
                "Explicit connect must reset ride authority even for token \(replacementToken)"
            )
            XCTAssertTrue(harness.scheduled.isEmpty)
        }
    }

    func testReentrantExplicitConnectClearsRideAndNewestLocationBeforeNewReady() throws {
        let harness = ClientHarness(socketCount: 2)
        var replacedSession = false
        harness.client.onState = { state in
            guard case .ready = state, !replacedSession else { return }
            replacedSession = true
            harness.client.sendLatest(self.fix(sequence: 32))
            harness.client.sendLatest(self.fix(sequence: 33))
            harness.connect(token: "account-b")
        }
        harness.connect(token: "account-a")
        harness.client.startRide()

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].completeSend(at: 0, error: TestError.transport)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

        XCTAssertEqual(harness.requests.count, 2)
        XCTAssertTrue(harness.sockets[1].sentMessages.isEmpty)
        XCTAssertTrue(harness.scheduled.isEmpty)
    }

    func testReentrantReadyCallbackCanStopBeforeStartIsSent() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.client.onState = { state in
            if case .ready = state {
                harness.client.stopRide()
            }
        }
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), ["companion.stop"])
    }

    func testRideCanRestartOnSameSocketAfterStopAndReady() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.stopRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.startRide()

        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.stop", "companion.start"]
        )
    }

    func testLateStartSendFailureCannotOverrideNewerStopIntent() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.stopRide()

        harness.sockets[0].completeSend(at: 0, error: TestError.transport)

        XCTAssertEqual(harness.sockets[0].cancelCount, 0)
        XCTAssertEqual(states.last, .ready(deviceId: nil, label: nil))
        XCTAssertTrue(harness.scheduled.isEmpty)
    }

    func testRepeatedStartAtConnectingReadyAndSharingPreservesPendingStartFailure() throws {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.startRide()

        XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), ["companion.start"])
        harness.sockets[0].completeSend(at: 0, error: TestError.transport)

        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(harness.scheduled.map(\.delay), [1])
        guard harness.scheduled.count == 1 else { return }
        harness.runScheduled(at: 0)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.startRide()
        XCTAssertEqual(try messageTypes(harness.sockets[1].sentMessages), ["companion.start"])
    }

    func testStartWhilePairSendIsPendingPreservesPairFailureOwnership() {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.pair(code: "ABC123")
        harness.client.startRide()

        harness.sockets[0].completeSend(at: 0, error: TestError.transport)

        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(harness.scheduled.map(\.delay), [1])
    }

    func testFreshStartSendDoesNotDisownPendingPairTransportFailure() {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.pair(code: "ABC123")
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        harness.sockets[0].completeSend(at: 0, error: TestError.transport)

        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(harness.scheduled.map(\.delay), [1])
    }

    func testPairSendDoesNotDisownPendingStartTransportFailure() {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.pair(code: "ABC123")

        harness.sockets[0].completeSend(at: 0, error: TestError.transport)

        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(harness.scheduled.map(\.delay), [1])
    }

    func testStopAndFreshStartInvalidateOldActionsButFreshStartStillOwnsFailure() throws {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.stopRide()
        harness.client.startRide()
        harness.client.startRide()

        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.stop", "companion.start"]
        )
        harness.sockets[0].completeSend(at: 0, error: TestError.transport)
        harness.sockets[0].completeSend(at: 1, error: TestError.transport)
        XCTAssertEqual(harness.sockets[0].cancelCount, 0)
        XCTAssertTrue(harness.scheduled.isEmpty)

        harness.sockets[0].completeSend(at: 2, error: TestError.transport)
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(harness.scheduled.map(\.delay), [1])
    }

    func testStopImmediatelyPreventsNewLocationDrain() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.stopRide()
        harness.client.sendLatest(fix(sequence: 8))

        XCTAssertTrue(try locationSequences(harness.sockets[0].sentMessages).isEmpty)
    }

    func testOnlyNewestReplacementWaitsBehindOneInFlightFix() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.sendLatest(fix(sequence: 1))
        harness.client.sendLatest(fix(sequence: 2))
        harness.client.sendLatest(fix(sequence: 3))

        XCTAssertEqual(try locationSequences(harness.sockets[0].sentMessages), [1])
        harness.sockets[0].completeSend(at: 0)
        XCTAssertEqual(try locationSequences(harness.sockets[0].sentMessages), [1, 3])
        harness.sockets[0].completeSend(at: 1)
        XCTAssertEqual(harness.sockets[0].sentMessages.count, 2)
    }

    func testSendFailureRetainsOnlyNewestFixAcrossReconnectReady() throws {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.sendLatest(fix(sequence: 1))
        harness.client.sendLatest(fix(sequence: 2))
        let locationIndex = try XCTUnwrap(harness.sockets[0].sentMessages.firstIndex { try messageType($0) == "companion.location" })
        harness.sockets[0].completeSend(at: locationIndex, error: TestError.transport)
        harness.runScheduled(at: 0)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        XCTAssertEqual(try locationSequences(harness.sockets[1].sentMessages), [2])
    }

    func testReadyAndSharingCanDrainNewestFixAfterReconnectWithoutBacklog() throws {
        for state in ["ready", "sharing"] {
            let harness = ClientHarness(socketCount: 2)
            harness.connect()
            harness.client.startRide()
            harness.client.sendLatest(fix(sequence: 4))
            harness.client.sendLatest(fix(sequence: 5))
            harness.sockets[0].failReceive(TestError.transport)
            harness.runScheduled(at: 0)
            harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"\(state)\"}"))
            XCTAssertEqual(try locationSequences(harness.sockets[1].sentMessages), [5])
        }
    }

    func testStopUnpairAndDisconnectClearPendingFixAndStaleCompletionCannotDrainIt() throws {
        for action in ["stop", "unpair", "disconnect"] {
            let harness = ClientHarness(socketCount: 1)
            harness.connect()
            harness.client.startRide()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
            harness.client.sendLatest(fix(sequence: 1))
            harness.client.sendLatest(fix(sequence: 2))
            switch action {
            case "stop": harness.client.stopRide()
            case "unpair": harness.client.unpair()
            default: harness.client.disconnect()
            }
            harness.sockets[0].completeSend(at: 0)
            XCTAssertEqual(try locationSequences(harness.sockets[0].sentMessages), [1])
        }
    }

    func testMalformedAndBinaryMessagesDoNotPublishOrBreakReceiveLoop() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.sockets[0].deliver(.string("{bad"))
        harness.sockets[0].deliver(.data(Data("binary".utf8)))

        XCTAssertEqual(states, [.connecting])
        XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 1)
    }

    func testInvalidConfigurationFailsClosedWithoutCreatingSocket() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.client.connect(relayURL: "https://relay.example", sessionToken: " ", allowSelfSignedTLS: false)

        XCTAssertTrue(harness.requests.isEmpty)
        XCTAssertEqual(states, [.failed(code: "configuration", detail: "Invalid relay URL or session token.")])
    }

    func testInjectedFactoryCreatesNothingBeforeConnect() {
        let harness = ClientHarness(socketCount: 1)
        XCTAssertTrue(harness.requests.isEmpty)
        XCTAssertEqual(harness.sockets[0].resumeCount, 0)
    }

    func testReadyBeforeStartRideCannotAuthorizeLocation() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        harness.client.sendLatest(fix(sequence: 20))

        XCTAssertTrue(try locationSequences(harness.sockets[0].sentMessages).isEmpty)
    }

    func testStopRejectsRacedFixAcrossReadyAndLateSharing() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.stopRide()

        harness.client.sendLatest(fix(sequence: 21))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.sendLatest(fix(sequence: 22))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.sendLatest(fix(sequence: 23))

        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.stop"]
        )
    }

    func testStopLateSharingRapidRestartAndReadySendsOneFreshStart() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))
        harness.client.stopRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.stop", "companion.start"]
        )
    }

    func testUnpairRejectsNewFixesAcrossLateReadyAndSharing() throws {
        let harness = ClientHarness(socketCount: 1)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.unpair()

        harness.client.sendLatest(fix(sequence: 24))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

        XCTAssertTrue(try locationSequences(harness.sockets[0].sentMessages).isEmpty)
    }

    func testDisconnectRejectsNewFixThatCouldCrossAReconnect() throws {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.client.disconnect()
        harness.client.sendLatest(fix(sequence: 25))

        harness.connect(token: "next-account-token")
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        XCTAssertTrue(try locationSequences(harness.sockets[1].sentMessages).isEmpty)
    }

    func testConvenienceClientConstructionIsHeadlessUntilConnect() {
        let client = RDKCompanionClient()
        var states: [CompanionConnectionState] = []
        client.onState = { states.append($0) }

        XCTAssertTrue(states.isEmpty)
        client.disconnect()
        XCTAssertEqual(states, [.signedOut])
    }

    func testProductionCompanionSourcesUseDedicatedSessionAndHaveNoVoiceAgentCoupling() throws {
        let sourceDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("MaxHelmet/Companion", isDirectory: true)
        let sources = try ["RDKCompanionProtocol.swift", "RDKCompanionClient.swift"]
            .map { try String(contentsOf: sourceDirectory.appendingPathComponent($0), encoding: .utf8) }
            .joined(separator: "\n")
        let normalizedSources = sources.lowercased()

        XCTAssertTrue(sources.contains("DedicatedCompanionSocket(request: request, allowSelfSignedTLS: allowSelfSignedTLS)"))
        XCTAssertTrue(sources.contains("URLSession(configuration: configuration, delegate: self, delegateQueue: nil)"))
        XCTAssertTrue(sources.contains("session.webSocketTask(with: request)"))

        for forbidden in ["AgentSession", "MicStreamer", "AVAudioSession", "microphone", "/agent"] {
            XCTAssertFalse(
                normalizedSources.contains(forbidden.lowercased()),
                "Companion source must not reference \(forbidden)"
            )
        }
    }

    private func fix(sequence: Int) -> CompanionFix {
        CompanionFix(
            sequence: sequence,
            latitude: 31.2,
            longitude: 121.5,
            horizontalAccuracyMeters: 5,
            timestampMilliseconds: 1_700_000_000_000 + Double(sequence),
            courseDegrees: nil,
            speedMps: nil
        )
    }

    private func jsonObject(_ message: URLSessionWebSocketTask.Message) throws -> [String: Any] {
        guard case let .string(text) = message else { throw TestError.notString }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func messageType(_ message: URLSessionWebSocketTask.Message) throws -> String {
        try XCTUnwrap(jsonObject(message)["type"] as? String)
    }

    private func messageTypes(_ messages: [URLSessionWebSocketTask.Message]) throws -> [String] {
        try messages.map(messageType)
    }

    private func locationSequences(_ messages: [URLSessionWebSocketTask.Message]) throws -> [Int] {
        try messages.compactMap { message in
            let object = try jsonObject(message)
            guard object["type"] as? String == "companion.location" else { return nil }
            return try XCTUnwrap(object["sequence"] as? Int)
        }
    }
}

private final class ClientHarness {
    struct Scheduled {
        let block: () -> Void
        let delay: TimeInterval
    }

    let sockets: [FakeCompanionSocket]
    private(set) var requests: [URLRequest] = []
    private(set) var tlsFlags: [Bool] = []
    private(set) var scheduled: [Scheduled] = []
    lazy var client = RDKCompanionClient(
        socketFactory: { [unowned self] request, allowSelfSignedTLS in
            let index = self.requests.count
            self.requests.append(request)
            self.tlsFlags.append(allowSelfSignedTLS)
            return self.sockets[index]
        },
        schedule: { [unowned self] block, delay in
            self.scheduled.append(Scheduled(block: block, delay: delay))
        }
    )

    init(socketCount: Int) {
        sockets = (0..<socketCount).map { _ in FakeCompanionSocket() }
    }

    func connect(token: String = "account-token", allowSelfSignedTLS: Bool = false) {
        client.connect(relayURL: "wss://relay.example/agent", sessionToken: token, allowSelfSignedTLS: allowSelfSignedTLS)
    }

    func runScheduled(at index: Int) {
        scheduled[index].block()
    }
}

private final class FakeCompanionSocket: CompanionSocketTask, CompanionHTTPStatusProviding {
    private(set) var resumeCount = 0
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private var sendCompletions: [(Error?) -> Void] = []
    private var receiveCompletions: [(Result<URLSessionWebSocketTask.Message, Error>) -> Void] = []
    private var lastReceiveCompletion: ((Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
    private(set) var cancelCount = 0
    var httpStatusCode: Int?
    var pendingReceiveCount: Int { receiveCompletions.count }

    func resume() { resumeCount += 1 }

    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping (Error?) -> Void) {
        sentMessages.append(message)
        sendCompletions.append(completionHandler)
    }

    func receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        receiveCompletions.append(completionHandler)
        lastReceiveCompletion = completionHandler
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancelCount += 1
    }

    func deliver(_ message: URLSessionWebSocketTask.Message) {
        let completion = receiveCompletions.removeFirst()
        completion(.success(message))
    }

    func redeliverLast(_ message: URLSessionWebSocketTask.Message) {
        lastReceiveCompletion?(.success(message))
    }

    func failReceive(_ error: Error) {
        let completion = receiveCompletions.removeFirst()
        completion(.failure(error))
    }

    func completeSend(at index: Int, error: Error? = nil) {
        sendCompletions[index](error)
    }
}

private enum TestError: Error {
    case transport
    case notString
}
