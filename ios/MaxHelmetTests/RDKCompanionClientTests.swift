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

    func testSynchronousReceiveSequenceUsesOneStackFrameAndStopsAfterTerminalFailure() {
        let statusCount = 96
        let expectedStatuses = (0..<statusCount).map {
            CompanionConnectionState.ready(deviceId: "rdk-\($0)", label: "Helmet \($0)")
        }
        let results = (0..<statusCount).map {
            Result<URLSessionWebSocketTask.Message, Error>.success(
                .string(
                    "{\"type\":\"companion.status\",\"state\":\"ready\","
                    + "\"deviceId\":\"rdk-\($0)\",\"deviceLabel\":\"Helmet \($0)\"}"
                )
            )
        }
        let socket = SynchronousCompanionSocket(results: results)
        let pending = expectation(description: "one receive remains pending after buffered statuses")
        socket.onFirstPendingReceive = { pending.fulfill() }
        var states: [CompanionConnectionState] = []
        let client = RDKCompanionClient(
            socketFactory: { _, _ in socket },
            schedule: { _, _ in XCTFail("Stopped pair-only transport must not reconnect") }
        )
        client.onState = { states.append($0) }

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )
        wait(for: [pending], timeout: 2)

        XCTAssertEqual(socket.maximumReceiveDepth, 1)
        XCTAssertEqual(socket.receiveCallCount, statusCount + 1)
        XCTAssertEqual(socket.pendingReceiveCount, 1)
        XCTAssertEqual(states, [.connecting] + expectedStatuses)

        socket.failPending(TestError.transport)
        let settled = expectation(description: "terminal failure cannot rearm")
        DispatchQueue.main.async { settled.fulfill() }
        wait(for: [settled], timeout: 1)

        XCTAssertEqual(socket.receiveCallCount, statusCount + 1)
        XCTAssertEqual(socket.pendingReceiveCount, 0)
        XCTAssertEqual(socket.cancelCount, 1)
        XCTAssertEqual(states.last, .failed(code: "connection", detail: "Companion connection closed."))
    }

    func testSynchronousMalformedUnknownAndBinaryMessagesRearmWithoutRecursion() {
        let socket = SynchronousCompanionSocket(results: [
            .success(.string("{bad")),
            .success(.string("{\"type\":\"unexpected.message\"}")),
            .success(.data(Data("binary".utf8)))
        ])
        let pending = expectation(description: "malformed sequence rearms once")
        socket.onFirstPendingReceive = { pending.fulfill() }
        var states: [CompanionConnectionState] = []
        let client = RDKCompanionClient(
            socketFactory: { _, _ in socket },
            schedule: { _, _ in XCTFail("Malformed messages must not schedule reconnect") }
        )
        client.onState = { states.append($0) }

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )
        wait(for: [pending], timeout: 1)

        XCTAssertEqual(states, [.connecting])
        XCTAssertEqual(socket.maximumReceiveDepth, 1)
        XCTAssertEqual(socket.receiveCallCount, 4)
        XCTAssertEqual(socket.pendingReceiveCount, 1)
    }

    func testSynchronousTerminalReceiveFailureStopsWithoutRearm() {
        let socket = SynchronousCompanionSocket(results: [
            .success(.string("{bad")),
            .failure(TestError.transport)
        ])
        let failed = expectation(description: "synchronous failure is terminal")
        var states: [CompanionConnectionState] = []
        let client = RDKCompanionClient(
            socketFactory: { _, _ in socket },
            schedule: { _, _ in XCTFail("Pair-only synchronous failure must not reconnect") }
        )
        client.onState = { state in
            states.append(state)
            if case .failed = state {
                failed.fulfill()
            }
        }

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )
        wait(for: [failed], timeout: 1)
        let settled = expectation(description: "failure leaves no deferred rearm")
        DispatchQueue.main.async { settled.fulfill() }
        wait(for: [settled], timeout: 1)

        XCTAssertEqual(socket.maximumReceiveDepth, 1)
        XCTAssertEqual(socket.receiveCallCount, 2)
        XCTAssertEqual(socket.pendingReceiveCount, 0)
        XCTAssertEqual(socket.cancelCount, 1)
        XCTAssertEqual(states, [.connecting, .failed(code: "connection", detail: "Companion connection closed.")])
    }

    func testDuplicateSynchronousCompletionIsConsumedOnlyOnce() {
        let socket = SynchronousCompanionSocket(
            results: [
                .success(.string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk-one\"}"))
            ],
            duplicateFirstResult: .success(
                .string("{\"type\":\"companion.status\",\"state\":\"sharing\",\"deviceId\":\"duplicate\"}")
            )
        )
        let pending = expectation(description: "one receive registration follows the consumed callback")
        socket.onFirstPendingReceive = { pending.fulfill() }
        var states: [CompanionConnectionState] = []
        let client = RDKCompanionClient(
            socketFactory: { _, _ in socket },
            schedule: { _, _ in XCTFail("Duplicate success must not schedule reconnect") }
        )
        client.onState = { states.append($0) }

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )
        wait(for: [pending], timeout: 1)

        XCTAssertEqual(states, [.connecting, .ready(deviceId: "rdk-one", label: nil)])
        XCTAssertEqual(socket.maximumReceiveDepth, 1)
        XCTAssertEqual(socket.receiveCallCount, 2)
        XCTAssertEqual(socket.pendingReceiveCount, 1)
    }

    func testTeardownBeforeDeferredSynchronousRearmPreventsAnotherReceive() {
        let socket = SynchronousCompanionSocket(results: [.success(.string("{bad"))])
        let client = RDKCompanionClient(
            socketFactory: { _, _ in socket },
            schedule: { _, _ in XCTFail("Explicit disconnect must not schedule reconnect") }
        )
        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )

        client.disconnect()
        let settled = expectation(description: "deferred receive rearm is invalidated")
        DispatchQueue.main.async { settled.fulfill() }
        wait(for: [settled], timeout: 1)

        XCTAssertEqual(socket.receiveCallCount, 1)
        XCTAssertEqual(socket.pendingReceiveCount, 0)
        XCTAssertEqual(socket.cancelCount, 1)
    }

    func testReentrantReplacementDuringSynchronousStatusOwnsTheOnlyNextReceive() {
        let oldSocket = SynchronousCompanionSocket(results: [
            .success(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        ])
        let replacementSocket = FakeCompanionSocket()
        var requests: [URLRequest] = []
        var replaced = false
        let client = RDKCompanionClient(
            socketFactory: { request, _ in
                requests.append(request)
                return requests.count == 1 ? oldSocket : replacementSocket
            },
            schedule: { _, _ in XCTFail("Replacement must not schedule reconnect") }
        )
        client.onState = { state in
            guard case .ready = state, !replaced else { return }
            replaced = true
            client.connect(
                relayURL: "wss://relay.example/agent",
                sessionToken: "account-b",
                allowSelfSignedTLS: false
            )
        }

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-a",
            allowSelfSignedTLS: false
        )
        let settled = expectation(description: "old deferred rearm cannot run")
        DispatchQueue.main.async { settled.fulfill() }
        wait(for: [settled], timeout: 1)

        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(oldSocket.receiveCallCount, 1)
        XCTAssertEqual(oldSocket.pendingReceiveCount, 0)
        XCTAssertEqual(oldSocket.cancelCount, 1)
        XCTAssertEqual(replacementSocket.resumeCount, 1)
        XCTAssertEqual(replacementSocket.pendingReceiveCount, 1)
    }

    func testFactoryCallingStartOnEveryInvocationOwnsOneBoundedOpenAttempt() throws {
        let sockets = (0..<4).map { _ in FakeCompanionSocket() }
        var factoryCalls = 0
        var client: RDKCompanionClient!
        client = RDKCompanionClient(
            socketFactory: { _, _ in
                let socket = sockets[factoryCalls]
                factoryCalls += 1
                if factoryCalls == sockets.count {
                    client.disconnect()
                }
                client.startRide()
                return socket
            },
            schedule: { _, _ in XCTFail("Factory reentry must not schedule reconnect") }
        )

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )

        XCTAssertEqual(factoryCalls, 1)
        XCTAssertEqual(sockets[0].cancelCount, 0)
        XCTAssertEqual(sockets[0].resumeCount, 1)
        XCTAssertEqual(sockets[0].pendingReceiveCount, 1)
        guard sockets[0].pendingReceiveCount == 1 else { return }
        sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        XCTAssertEqual(try messageTypes(sockets[0].sentMessages), ["companion.start"])
    }

    func testFactoryStopUnpairAndDisconnectInvalidateReturnedAttempt() {
        for action in ["stop", "unpair", "disconnect"] {
            let socket = FakeCompanionSocket()
            var client: RDKCompanionClient!
            var states: [CompanionConnectionState] = []
            client = RDKCompanionClient(
                socketFactory: { _, _ in
                    switch action {
                    case "stop": client.stopRide()
                    case "unpair": client.unpair()
                    default: client.disconnect()
                    }
                    return socket
                },
                schedule: { _, _ in XCTFail("Invalidated factory attempt must not reconnect") }
            )
            client.onState = { states.append($0) }

            client.connect(
                relayURL: "wss://relay.example/agent",
                sessionToken: "account-token",
                allowSelfSignedTLS: false
            )

            XCTAssertEqual(socket.cancelCount, 1, "action \(action)")
            XCTAssertEqual(socket.resumeCount, 0, "action \(action)")
            XCTAssertEqual(socket.pendingReceiveCount, 0, "action \(action)")
            if action == "disconnect" {
                XCTAssertEqual(states, [.signedOut])
            } else {
                XCTAssertTrue(states.isEmpty, "action \(action)")
            }
        }
    }

    func testFactoryStopOrUnpairThenStartDefersOneFreshOwnedAttempt() throws {
        for cutoff in ["stop", "unpair"] {
            let sockets = [FakeCompanionSocket(), FakeCompanionSocket()]
            var factoryCalls = 0
            var client: RDKCompanionClient!
            client = RDKCompanionClient(
                socketFactory: { _, _ in
                    let socket = sockets[factoryCalls]
                    factoryCalls += 1
                    if factoryCalls == 1 {
                        if cutoff == "stop" {
                            client.stopRide()
                        } else {
                            client.unpair()
                        }
                        client.startRide()
                    }
                    return socket
                },
                schedule: { _, _ in XCTFail("Semantic reopen must not use reconnect backoff") }
            )

            client.connect(
                relayURL: "wss://relay.example/agent",
                sessionToken: "account-token",
                allowSelfSignedTLS: false
            )
            XCTAssertEqual(factoryCalls, 1, "reopen must wait until the \(cutoff)-start factory unwinds")
            let settled = expectation(description: "fresh factory attempt after \(cutoff)-start")
            DispatchQueue.main.async { settled.fulfill() }
            wait(for: [settled], timeout: 1)

            XCTAssertEqual(factoryCalls, 2, "cutoff \(cutoff)")
            XCTAssertEqual(sockets[0].cancelCount, 1, "cutoff \(cutoff)")
            XCTAssertEqual(sockets[0].resumeCount, 0, "cutoff \(cutoff)")
            XCTAssertEqual(sockets[0].pendingReceiveCount, 0, "cutoff \(cutoff)")
            XCTAssertEqual(sockets[1].cancelCount, 0, "cutoff \(cutoff)")
            XCTAssertEqual(sockets[1].resumeCount, 1, "cutoff \(cutoff)")
            XCTAssertEqual(sockets[1].pendingReceiveCount, 1, "cutoff \(cutoff)")
            guard sockets[1].pendingReceiveCount == 1 else { continue }
            sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            XCTAssertEqual(try messageTypes(sockets[1].sentMessages), ["companion.start"], "cutoff \(cutoff)")
        }
    }

    func testFactoryAlwaysStopThenStartLimitsSemanticRecoveryToOneFreshAttempt() {
        let sockets = (0..<4).map { _ in FakeCompanionSocket() }
        var factoryCalls = 0
        var client: RDKCompanionClient!
        client = RDKCompanionClient(
            socketFactory: { _, _ in
                let socket = sockets[factoryCalls]
                factoryCalls += 1
                if factoryCalls == sockets.count {
                    client.disconnect()
                } else {
                    client.stopRide()
                    client.startRide()
                }
                return socket
            },
            schedule: { _, _ in XCTFail("Semantic recovery must remain separate from reconnect backoff") }
        )

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-token",
            allowSelfSignedTLS: false
        )
        XCTAssertEqual(factoryCalls, 1, "semantic recovery must not recurse before Connect returns")
        let settled = expectation(description: "bounded semantic recovery settles")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { settled.fulfill() }
        wait(for: [settled], timeout: 1)

        XCTAssertEqual(factoryCalls, 2)
        XCTAssertEqual(sockets[0].cancelCount, 1)
        XCTAssertEqual(sockets[1].cancelCount, 1)
        XCTAssertEqual(sockets[0].resumeCount, 0)
        XCTAssertEqual(sockets[1].resumeCount, 0)
        XCTAssertEqual(sockets[0].pendingReceiveCount, 0)
        XCTAssertEqual(sockets[1].pendingReceiveCount, 0)
    }

    func testDeferredFactoryRecoveryRevalidatesSemanticAndGenerationOwnership() {
        for boundary in ["stop", "unpair", "disconnect", "connect"] {
            let sockets = [FakeCompanionSocket(), FakeCompanionSocket()]
            var requests: [URLRequest] = []
            var client: RDKCompanionClient!
            client = RDKCompanionClient(
                socketFactory: { request, _ in
                    let socket = sockets[requests.count]
                    requests.append(request)
                    if requests.count == 1 {
                        client.stopRide()
                        client.startRide()
                    }
                    return socket
                },
                schedule: { _, _ in XCTFail("Semantic recovery must not use reconnect backoff") }
            )

            client.connect(
                relayURL: "wss://relay.example/agent",
                sessionToken: "account-a",
                allowSelfSignedTLS: false
            )
            XCTAssertEqual(requests.count, 1, "deferred recovery must not recurse before Connect returns")
            switch boundary {
            case "stop":
                client.stopRide()
            case "unpair":
                client.unpair()
            case "disconnect":
                client.disconnect()
            default:
                client.connect(
                    relayURL: "wss://relay.example/agent",
                    sessionToken: "account-b",
                    allowSelfSignedTLS: false
                )
            }

            let settled = expectation(description: "deferred recovery rejected after \(boundary)")
            DispatchQueue.main.async { settled.fulfill() }
            wait(for: [settled], timeout: 1)

            XCTAssertEqual(requests.count, boundary == "connect" ? 2 : 1, "boundary \(boundary)")
            XCTAssertEqual(sockets[0].cancelCount, 1, "boundary \(boundary)")
            XCTAssertEqual(sockets[0].resumeCount, 0, "boundary \(boundary)")
            XCTAssertEqual(sockets[0].pendingReceiveCount, 0, "boundary \(boundary)")
            if boundary == "connect" {
                XCTAssertEqual(
                    URLComponents(url: requests[1].url!, resolvingAgainstBaseURL: false)?
                        .queryItems?.first?.value,
                    "account-b"
                )
                XCTAssertEqual(sockets[1].cancelCount, 0)
                XCTAssertEqual(sockets[1].resumeCount, 1)
                XCTAssertEqual(sockets[1].pendingReceiveCount, 1)
            } else {
                XCTAssertEqual(sockets[1].resumeCount, 0, "boundary \(boundary)")
                XCTAssertEqual(sockets[1].pendingReceiveCount, 0, "boundary \(boundary)")
            }
        }
    }

    func testFactoryNewConnectMakesNewGenerationAuthoritative() {
        let sockets = [FakeCompanionSocket(), FakeCompanionSocket()]
        var requests: [URLRequest] = []
        var client: RDKCompanionClient!
        client = RDKCompanionClient(
            socketFactory: { request, _ in
                let index = requests.count
                requests.append(request)
                if index == 0 {
                    client.connect(
                        relayURL: "wss://relay.example/agent",
                        sessionToken: "account-b",
                        allowSelfSignedTLS: false
                    )
                }
                return sockets[index]
            },
            schedule: { _, _ in XCTFail("Explicit replacement must not schedule reconnect") }
        )

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-a",
            allowSelfSignedTLS: false
        )

        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(URLComponents(url: requests[1].url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "account-b")
        XCTAssertEqual(sockets[0].cancelCount, 1)
        XCTAssertEqual(sockets[0].resumeCount, 0)
        XCTAssertEqual(sockets[0].pendingReceiveCount, 0)
        XCTAssertEqual(sockets[1].cancelCount, 0)
        XCTAssertEqual(sockets[1].resumeCount, 1)
        XCTAssertEqual(sockets[1].pendingReceiveCount, 1)
    }

    func testFactoryNewConnectDoesNotCancelSharedAuthoritativeTaskOnStaleUnwind() {
        let socket = FakeCompanionSocket()
        var factoryCalls = 0
        var client: RDKCompanionClient!
        client = RDKCompanionClient(
            socketFactory: { _, _ in
                factoryCalls += 1
                if factoryCalls == 1 {
                    client.connect(
                        relayURL: "wss://relay.example/agent",
                        sessionToken: "account-b",
                        allowSelfSignedTLS: false
                    )
                }
                return socket
            },
            schedule: { _, _ in XCTFail("Explicit replacement must not schedule reconnect") }
        )

        client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-a",
            allowSelfSignedTLS: false
        )

        XCTAssertEqual(factoryCalls, 2)
        XCTAssertEqual(socket.cancelCount, 0)
        XCTAssertEqual(socket.resumeCount, 1)
        XCTAssertEqual(socket.pendingReceiveCount, 1)
    }

    func testInitialConnectingStartCallbackIsBoundedWithoutRecursivePublication() throws {
        let harness = ClientHarness(socketCount: 1)
        var connectingCallbacks = 0
        harness.client.onState = { state in
            guard case .connecting = state else { return }
            connectingCallbacks += 1
            if connectingCallbacks < 4 {
                harness.client.startRide()
            } else {
                harness.client.disconnect()
            }
        }

        harness.connect()

        XCTAssertEqual(connectingCallbacks, 1)
        XCTAssertEqual(harness.requests.count, 1)
        XCTAssertEqual(harness.sockets[0].resumeCount, 1)
        XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 1)
        guard harness.requests.count == 1, harness.sockets[0].pendingReceiveCount == 1 else { return }
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), ["companion.start"])
    }

    func testReconnectConnectingStartCallbackHasNoSynchronousReentryAndRetainsRide() throws {
        let harness = ClientHarness(socketCount: 2)
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].failReceive(TestError.transport)
        var insideConnectingCallback = false
        var recursivelyReentered = false
        var connectingCallbacks = 0
        harness.client.onState = { state in
            guard case .connecting = state else { return }
            connectingCallbacks += 1
            if insideConnectingCallback {
                recursivelyReentered = true
                return
            }
            insideConnectingCallback = true
            harness.client.startRide()
            insideConnectingCallback = false
        }

        harness.runScheduled(at: 0)

        XCTAssertFalse(recursivelyReentered)
        XCTAssertEqual(connectingCallbacks, 1)
        XCTAssertEqual(harness.requests.count, 2)
        XCTAssertEqual(harness.sockets[1].resumeCount, 1)
        XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 1)
        harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        XCTAssertEqual(try messageTypes(harness.sockets[1].sentMessages), ["companion.start"])
    }

    func testEveryConnectingCallbackMayStartRideWithoutRecursion() {
        do {
            let harness = ClientHarness(socketCount: 1)
            var connectingCallbacks = 0
            harness.client.onState = { state in
                guard case .connecting = state else { return }
                connectingCallbacks += 1
                harness.client.startRide()
            }

            harness.connect()

            XCTAssertEqual(connectingCallbacks, 1)
            XCTAssertEqual(harness.requests.count, 1)
            XCTAssertEqual(harness.sockets[0].resumeCount, 1)
            XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 1)
        }

        do {
            let harness = ClientHarness(socketCount: 2)
            harness.connect()
            harness.client.startRide()
            harness.sockets[0].failReceive(TestError.transport)
            var connectingCallbacks = 0
            harness.client.onState = { state in
                guard case .connecting = state else { return }
                connectingCallbacks += 1
                harness.client.startRide()
            }

            harness.runScheduled(at: 0)

            XCTAssertEqual(connectingCallbacks, 1)
            XCTAssertEqual(harness.requests.count, 2)
            XCTAssertEqual(harness.sockets[1].resumeCount, 1)
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 1)
        }
    }

    func testInitialConnectingCandidateOwnsReentrantPairStopUnpairAndLocation() throws {
        for action in ["pair", "stop", "unpair", "location"] {
            let harness = ClientHarness(socketCount: 1)
            var handled = false
            harness.client.onState = { state in
                guard case .connecting = state, !handled else { return }
                handled = true
                switch action {
                case "pair": harness.client.pair(code: "ABC123")
                case "stop": harness.client.stopRide()
                case "unpair": harness.client.unpair()
                default: harness.client.sendLatest(self.fix(sequence: 40))
                }
            }

            harness.connect()

            XCTAssertEqual(harness.requests.count, 1, "action \(action)")
            XCTAssertEqual(harness.sockets[0].resumeCount, 1, "action \(action)")
            XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 1, "action \(action)")
            let expectedMessages: [String]
            switch action {
            case "pair": expectedMessages = ["companion.pair"]
            case "stop": expectedMessages = ["companion.stop"]
            case "unpair": expectedMessages = ["companion.unpair"]
            default: expectedMessages = []
            }
            XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), expectedMessages, "action \(action)")
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            harness.client.sendLatest(fix(sequence: 41))
            XCTAssertTrue(try locationSequences(harness.sockets[0].sentMessages).isEmpty, "action \(action)")
            harness.sockets[0].failReceive(TestError.transport)
            XCTAssertTrue(harness.scheduled.isEmpty, "action \(action)")
        }
    }

    func testReconnectConnectingCandidateOwnsReentrantPairStopUnpairAndNewestLocation() throws {
        for action in ["pair", "stop", "unpair", "location"] {
            let harness = ClientHarness(socketCount: 2)
            harness.connect()
            harness.client.startRide()
            harness.sockets[0].failReceive(TestError.transport)
            var handled = false
            harness.client.onState = { state in
                guard case .connecting = state, !handled else { return }
                handled = true
                switch action {
                case "pair": harness.client.pair(code: "ABC123")
                case "stop": harness.client.stopRide()
                case "unpair": harness.client.unpair()
                default: harness.client.sendLatest(self.fix(sequence: 42))
                }
            }

            harness.runScheduled(at: 0)

            XCTAssertEqual(harness.requests.count, 2, "action \(action)")
            XCTAssertEqual(harness.sockets[1].resumeCount, 1, "action \(action)")
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 1, "action \(action)")
            harness.sockets[1].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            let expectedMessages: [String]
            switch action {
            case "pair": expectedMessages = ["companion.pair", "companion.start"]
            case "stop": expectedMessages = ["companion.stop"]
            case "unpair": expectedMessages = ["companion.unpair"]
            default: expectedMessages = ["companion.start", "companion.location"]
            }
            XCTAssertEqual(try messageTypes(harness.sockets[1].sentMessages), expectedMessages, "action \(action)")
            if action == "stop" || action == "unpair" {
                harness.client.sendLatest(fix(sequence: 43))
                XCTAssertTrue(try locationSequences(harness.sockets[1].sentMessages).isEmpty, "action \(action)")
                harness.sockets[1].failReceive(TestError.transport)
                XCTAssertEqual(harness.scheduled.count, 1, "action \(action)")
            }
        }
    }

    func testInitialConnectingTeardownAndReplacementOwnTheirCandidateSockets() {
        do {
            let harness = ClientHarness(socketCount: 1)
            harness.client.onState = { state in
                guard case .connecting = state else { return }
                harness.client.disconnect()
            }

            harness.connect()

            XCTAssertEqual(harness.requests.count, 1)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            XCTAssertEqual(harness.sockets[0].resumeCount, 0)
            XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 0)
        }

        do {
            let harness = ClientHarness(socketCount: 2)
            var replaced = false
            harness.client.onState = { state in
                guard case .connecting = state, !replaced else { return }
                replaced = true
                harness.connect(token: "account-b")
            }

            harness.connect(token: "account-a")

            XCTAssertEqual(harness.requests.count, 2)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            XCTAssertEqual(harness.sockets[0].resumeCount, 0)
            XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 0)
            XCTAssertEqual(harness.sockets[1].resumeCount, 1)
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 1)
        }
    }

    func testReconnectConnectingTeardownAndReplacementOwnTheirCandidateSockets() {
        do {
            let harness = ClientHarness(socketCount: 2)
            harness.connect()
            harness.client.startRide()
            harness.sockets[0].failReceive(TestError.transport)
            harness.client.onState = { state in
                guard case .connecting = state else { return }
                harness.client.disconnect()
            }

            harness.runScheduled(at: 0)

            XCTAssertEqual(harness.requests.count, 2)
            XCTAssertEqual(harness.sockets[1].cancelCount, 1)
            XCTAssertEqual(harness.sockets[1].resumeCount, 0)
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 0)
        }

        do {
            let harness = ClientHarness(socketCount: 3)
            harness.connect()
            harness.client.startRide()
            harness.sockets[0].failReceive(TestError.transport)
            var replaced = false
            harness.client.onState = { state in
                guard case .connecting = state, !replaced else { return }
                replaced = true
                harness.connect(token: "account-b")
            }

            harness.runScheduled(at: 0)

            XCTAssertEqual(harness.requests.count, 3)
            XCTAssertEqual(harness.sockets[1].cancelCount, 1)
            XCTAssertEqual(harness.sockets[1].resumeCount, 0)
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 0)
            XCTAssertEqual(harness.sockets[2].resumeCount, 1)
            XCTAssertEqual(harness.sockets[2].pendingReceiveCount, 1)
        }
    }

    func testPairedCallbackPairUnpairAndStopPreventOuterCloseAndKeepFailureOwnership() throws {
        for action in ["pair", "unpair", "stop"] {
            let harness = ClientHarness(socketCount: 1)
            var handled = false
            var states: [CompanionConnectionState] = []
            harness.client.onState = { state in
                states.append(state)
                guard case .paired = state, !handled else { return }
                handled = true
                switch action {
                case "pair": harness.client.pair(code: "NEXT42")
                case "unpair": harness.client.unpair()
                default: harness.client.stopRide()
                }
            }
            harness.sockets[0].sendErrorOnCancel = TestError.transport

            harness.connect()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\",\"deviceId\":\"rdk-1\"}"))

            let expectedType: String
            switch action {
            case "pair": expectedType = "companion.pair"
            case "unpair": expectedType = "companion.unpair"
            default: expectedType = "companion.stop"
            }
            XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), [expectedType], "action \(action)")
            XCTAssertEqual(harness.sockets[0].cancelCount, 0, "action \(action)")

            guard harness.sockets[0].cancelCount == 0 else { continue }
            harness.sockets[0].completeSend(at: 0, error: TestError.transport)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1, "action \(action)")
            XCTAssertEqual(
                states.last,
                .failed(code: "connection", detail: "Companion connection closed."),
                "action \(action)"
            )
        }
    }

    func testPairedCallbackStartDisconnectAndNewConnectRemainAuthoritative() throws {
        do {
            let harness = ClientHarness(socketCount: 1)
            var handled = false
            harness.client.onState = { state in
                guard case .paired = state, !handled else { return }
                handled = true
                harness.client.startRide()
            }

            harness.connect()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\"}"))

            XCTAssertEqual(harness.sockets[0].cancelCount, 0)
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), ["companion.start"])
        }

        do {
            let harness = ClientHarness(socketCount: 1)
            var handled = false
            var states: [CompanionConnectionState] = []
            harness.client.onState = { state in
                states.append(state)
                guard case .paired = state, !handled else { return }
                handled = true
                harness.client.disconnect()
            }

            harness.connect()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\"}"))

            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            XCTAssertEqual(states.last, .signedOut)
        }

        do {
            let harness = ClientHarness(socketCount: 2)
            var handled = false
            harness.client.onState = { state in
                guard case .paired = state, !handled else { return }
                handled = true
                harness.connect(token: "account-b")
            }

            harness.connect(token: "account-a")
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\"}"))

            XCTAssertEqual(harness.requests.count, 2)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            XCTAssertEqual(harness.sockets[1].resumeCount, 1)
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 1)
        }
    }

    func testPairedCallbackRejectedLocationAndObservationOnlyStateCloseOnce() throws {
        for callbackSendsLocation in [false, true] {
            let harness = ClientHarness(socketCount: 1)
            harness.client.onState = { state in
                guard case .paired = state, callbackSendsLocation else { return }
                harness.client.sendLatest(self.fix(sequence: 45))
            }

            harness.connect()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\"}"))

            XCTAssertTrue(try messageTypes(harness.sockets[0].sentMessages).isEmpty)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        }
    }

    func testReadyCallbackQueuesNewestLocationUntilStartIsSent() throws {
        let harness = ClientHarness(socketCount: 1)
        var handled = false
        harness.client.onState = { state in
            guard case .ready = state, !handled else { return }
            handled = true
            harness.client.sendLatest(self.fix(sequence: 46))
        }
        harness.connect()
        harness.client.startRide()

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.location"]
        )
        XCTAssertEqual(try locationSequences(harness.sockets[0].sentMessages), [46])
    }

    func testReadyCallbackPublicActionsRemainAuthoritative() throws {
        for action in ["pair", "start", "stop", "unpair", "disconnect", "connect"] {
            let socketCount = action == "connect" ? 2 : 1
            let harness = ClientHarness(socketCount: socketCount)
            var handled = false
            harness.client.onState = { state in
                guard case .ready = state, !handled else { return }
                handled = true
                switch action {
                case "pair": harness.client.pair(code: "READY1")
                case "start": harness.client.startRide()
                case "stop": harness.client.stopRide()
                case "unpair": harness.client.unpair()
                case "disconnect": harness.client.disconnect()
                default: harness.connect(token: "account-b")
                }
            }
            harness.connect(token: "account-a")
            harness.client.startRide()

            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))

            let expectedTypes: [String]
            switch action {
            case "pair": expectedTypes = ["companion.pair", "companion.start"]
            case "start": expectedTypes = ["companion.start"]
            case "stop": expectedTypes = ["companion.stop"]
            case "unpair": expectedTypes = ["companion.unpair"]
            default: expectedTypes = []
            }
            XCTAssertEqual(try messageTypes(harness.sockets[0].sentMessages), expectedTypes, "action \(action)")
            if action == "disconnect" {
                XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            } else if action == "connect" {
                XCTAssertEqual(harness.requests.count, 2)
                XCTAssertEqual(harness.sockets[0].cancelCount, 1)
                XCTAssertEqual(harness.sockets[1].resumeCount, 1)
            }
        }
    }

    func testTerminalReconnectFailureCallbackCanStartFreshSocketWithoutOuterRollback() {
        let harness = ClientHarness(socketCount: 8)
        var restarted = false
        harness.client.onState = { state in
            guard case let .failed(code, _) = state, code == "connection", !restarted else { return }
            restarted = true
            harness.client.startRide()
        }
        harness.connect()
        harness.client.startRide()

        for socketIndex in 0..<7 {
            harness.sockets[socketIndex].failReceive(TestError.transport)
            if socketIndex < 6 {
                harness.runScheduled(at: socketIndex)
            }
        }

        XCTAssertTrue(restarted)
        XCTAssertEqual(harness.requests.count, 8)
        XCTAssertEqual(harness.sockets[7].resumeCount, 1)
        XCTAssertEqual(harness.sockets[7].pendingReceiveCount, 1)
    }

    func testServerTerminalArrivesOnMainAndStopsTheReceiveLoop() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        var mainFlags: [Bool] = []
        harness.client.onState = {
            states.append($0)
            mainFlags.append(Thread.isMainThread)
        }
        harness.connect()

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"unpaired\"}"))
        harness.sockets[0].redeliverLast(
            .string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":\"rdk-1\",\"deviceLabel\":\"Helmet\"}")
        )

        XCTAssertEqual(states, [.connecting, .unpaired])
        XCTAssertEqual(mainFlags, [true, true])
        XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 0)
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
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

    func testUnpairCannotDisownPendingStopTransportFailure() throws {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].completeSend(at: 0)

        harness.client.stopRide()
        harness.client.unpair()
        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.stop", "companion.unpair"]
        )
        harness.sockets[0].completeSend(at: 1, error: TestError.transport)

        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(states.last, .failed(code: "connection", detail: "Companion connection closed."))
    }

    func testPairedObservationWaitsForOwnedUnpairSuccessThenClosesExactlyOnce() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        var results: [CompanionActionResult] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.unpair { results.append($0) }

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\"}"))

        XCTAssertEqual(harness.sockets[0].cancelCount, 0, "paired observation must not cancel its pending Unpair")
        XCTAssertTrue(results.isEmpty)
        harness.sockets[0].completeSend(at: 0)
        XCTAssertEqual(results, [.accepted])
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(states.last, .paired(deviceId: nil, label: nil))

        harness.sockets[0].completeSend(at: 0, error: TestError.transport)
        XCTAssertEqual(results, [.accepted], "duplicate transport completion is consumed once")
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(states.last, .paired(deviceId: nil, label: nil))
    }

    func testPairedObservationWaitsForOwnedUnpairFailureThenFailsAndClosesExactlyOnce() {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        var results: [CompanionActionResult] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.unpair { results.append($0) }

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"paired\"}"))

        XCTAssertEqual(harness.sockets[0].cancelCount, 0)
        harness.sockets[0].completeSend(at: 0, error: TestError.transport)
        XCTAssertEqual(results, [.failed])
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(states.last, .failed(code: "connection", detail: "Companion connection closed."))

        harness.sockets[0].completeSend(at: 0)
        XCTAssertEqual(results, [.failed])
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(states.last, .failed(code: "connection", detail: "Companion connection closed."))
    }

    func testAuthoritativeAuthAndUnpairedStatusesRetirePendingStopAndUnpairCompletions() {
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

        for action in ["stop", "unpair"] {
            for terminal in terminalCases {
                let harness = ClientHarness(socketCount: 1)
                var states: [CompanionConnectionState] = []
                var results: [CompanionActionResult] = []
                harness.client.onState = { states.append($0) }
                harness.connect()
                harness.client.startRide()
                harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
                harness.sockets[0].completeSend(at: 0)

                if action == "stop" {
                    harness.client.stopRide { results.append($0) }
                } else {
                    harness.client.unpair { results.append($0) }
                }
                harness.sockets[0].deliver(.string(terminal.message))
                harness.sockets[0].completeSend(at: 1, error: TestError.transport)
                harness.sockets[0].completeSend(at: 1)

                XCTAssertEqual(states.last, terminal.expected, "\(action) after \(terminal.expected)")
                XCTAssertTrue(results.isEmpty, "terminal state owns and retires \(action) completion")
                XCTAssertTrue(harness.scheduled.isEmpty)
            }
        }
    }

    func testAuthoritativeTerminalRetiresTransportBeforeCallbackAndRequiresExplicitConnect() {
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
            let harness = ClientHarness(socketCount: 2)
            var states: [CompanionConnectionState] = []
            var cancellationObservedByCallback: [Int] = []
            harness.client.onState = { state in
                states.append(state)
                guard state == terminal.expected else { return }
                cancellationObservedByCallback.append(harness.sockets[0].cancelCount)
                harness.client.startRide()
            }
            harness.connect(token: "account-a")
            harness.client.startRide()
            harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            harness.sockets[0].deliver(.string(terminal.message))

            XCTAssertEqual(cancellationObservedByCallback, [1], "terminal callback must observe retired transport")
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            XCTAssertEqual(harness.sockets[0].pendingReceiveCount, 0)
            XCTAssertEqual(harness.requests.count, 1, "Start cannot reuse the terminal account configuration")
            XCTAssertTrue(harness.scheduled.isEmpty)

            harness.sockets[0].refailLast(TestError.transport)
            harness.sockets[0].completeSend(at: 0, error: TestError.transport)
            harness.sockets[0].redeliverLast(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
            XCTAssertEqual(states.last, terminal.expected)
            XCTAssertTrue(harness.scheduled.isEmpty)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)

            harness.client.startRide()
            XCTAssertEqual(harness.requests.count, 1)
            harness.client.connect(
                relayURL: "wss://relay.example/agent",
                sessionToken: "account-b",
                allowSelfSignedTLS: false
            )
            XCTAssertEqual(harness.requests.count, 2)
            XCTAssertEqual(harness.sockets[1].resumeCount, 1)
            XCTAssertEqual(states.last, .connecting)
        }
    }

    func testHTTP401RetiresAccountConfigurationBeforeAuthCallback() {
        let harness = ClientHarness(socketCount: 2)
        var states: [CompanionConnectionState] = []
        harness.client.onState = { state in
            states.append(state)
            guard state == .failed(code: "auth", detail: "Authentication failed (HTTP 401).") else { return }
            harness.client.startRide()
        }
        harness.connect(token: "rejected-account")
        harness.sockets[0].httpStatusCode = 401

        harness.sockets[0].failReceive(TestError.transport)

        XCTAssertEqual(
            states.last,
            .failed(code: "auth", detail: "Authentication failed (HTTP 401).")
        )
        XCTAssertEqual(harness.sockets[0].cancelCount, 1)
        XCTAssertEqual(harness.requests.count, 1, "auth callback Start cannot reopen the rejected account")
        XCTAssertTrue(harness.scheduled.isEmpty)

        harness.client.connect(
            relayURL: "wss://relay.example/agent",
            sessionToken: "account-b",
            allowSelfSignedTLS: false
        )
        XCTAssertEqual(harness.requests.count, 2)
        XCTAssertEqual(harness.sockets[1].resumeCount, 1)
    }

    func testReentrantExplicitConnectFromTerminalCallbackOwnsReplacementTransport() {
        for message in [
            "{\"type\":\"companion.error\",\"code\":\"auth\",\"detail\":\"expired\"}",
            "{\"type\":\"companion.status\",\"state\":\"unpaired\"}"
        ] {
            let harness = ClientHarness(socketCount: 2)
            var didReplace = false
            var states: [CompanionConnectionState] = []
            harness.client.onState = { state in
                states.append(state)
                guard !didReplace,
                      state == .unpaired || state == .failed(code: "auth", detail: "expired") else {
                    return
                }
                didReplace = true
                harness.client.connect(
                    relayURL: "wss://relay.example/agent",
                    sessionToken: "account-b",
                    allowSelfSignedTLS: false
                )
            }
            harness.connect(token: "account-a")
            harness.sockets[0].deliver(.string(message))

            XCTAssertEqual(harness.requests.count, 2)
            XCTAssertEqual(harness.sockets[0].cancelCount, 1)
            XCTAssertEqual(harness.sockets[1].cancelCount, 0)
            XCTAssertEqual(harness.sockets[1].resumeCount, 1)
            XCTAssertEqual(harness.sockets[1].pendingReceiveCount, 1)
            XCTAssertEqual(states.last, .connecting)

            harness.sockets[0].refailLast(TestError.transport)
            harness.sockets[0].redeliverLast(.string(message))
            XCTAssertEqual(states.last, .connecting)
            XCTAssertTrue(harness.scheduled.isEmpty)
            XCTAssertEqual(harness.sockets[1].cancelCount, 0)
        }
    }

    func testFreshStartAtSharingImmediatelyRetiresOldStopAndStartsOnNextReady() throws {
        let harness = ClientHarness(socketCount: 1)
        var states: [CompanionConnectionState] = []
        var stopResults: [CompanionActionResult] = []
        harness.client.onState = { states.append($0) }
        harness.connect()
        harness.client.startRide()
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        harness.sockets[0].completeSend(at: 0)
        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"sharing\"}"))

        harness.client.stopRide { stopResults.append($0) }
        harness.client.startRide()
        harness.sockets[0].completeSend(at: 1, error: TestError.transport)
        harness.sockets[0].completeSend(at: 1)

        XCTAssertTrue(stopResults.isEmpty)
        XCTAssertEqual(harness.sockets[0].cancelCount, 0)
        XCTAssertTrue(harness.scheduled.isEmpty)
        XCTAssertEqual(states.last, .sharing(deviceId: nil, label: nil))

        harness.sockets[0].deliver(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}"))
        XCTAssertEqual(
            try messageTypes(harness.sockets[0].sentMessages),
            ["companion.start", "companion.stop", "companion.start"]
        )
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
    var sendErrorOnCancel: Error?
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
        guard let error = sendErrorOnCancel else { return }
        sendErrorOnCancel = nil
        let completions = sendCompletions
        completions.forEach { $0(error) }
    }

    func deliver(_ message: URLSessionWebSocketTask.Message) {
        let completion = receiveCompletions.removeFirst()
        completion(.success(message))
    }

    func redeliverLast(_ message: URLSessionWebSocketTask.Message) {
        lastReceiveCompletion?(.success(message))
    }

    func refailLast(_ error: Error) {
        lastReceiveCompletion?(.failure(error))
    }

    func failReceive(_ error: Error) {
        let completion = receiveCompletions.removeFirst()
        completion(.failure(error))
    }

    func completeSend(at index: Int, error: Error? = nil) {
        sendCompletions[index](error)
    }
}

private final class SynchronousCompanionSocket: CompanionSocketTask, CompanionHTTPStatusProviding {
    private var results: [Result<URLSessionWebSocketTask.Message, Error>]
    private let duplicateFirstResult: Result<URLSessionWebSocketTask.Message, Error>?
    private var didDeliverDuplicate = false
    private var receiveCompletions: [(Result<URLSessionWebSocketTask.Message, Error>) -> Void] = []
    private var receiveDepth = 0
    private(set) var maximumReceiveDepth = 0
    private(set) var receiveCallCount = 0
    private(set) var resumeCount = 0
    private(set) var cancelCount = 0
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    var onFirstPendingReceive: (() -> Void)?
    var httpStatusCode: Int?
    var pendingReceiveCount: Int { receiveCompletions.count }

    init(
        results: [Result<URLSessionWebSocketTask.Message, Error>],
        duplicateFirstResult: Result<URLSessionWebSocketTask.Message, Error>? = nil
    ) {
        self.results = results
        self.duplicateFirstResult = duplicateFirstResult
    }

    func resume() {
        resumeCount += 1
    }

    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping (Error?) -> Void) {
        sentMessages.append(message)
    }

    func receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        receiveCallCount += 1
        guard !results.isEmpty else {
            receiveCompletions.append(completionHandler)
            if receiveCompletions.count == 1 {
                onFirstPendingReceive?()
            }
            return
        }

        let result = results.removeFirst()
        receiveDepth += 1
        maximumReceiveDepth = max(maximumReceiveDepth, receiveDepth)
        completionHandler(result)
        if !didDeliverDuplicate, let duplicateFirstResult {
            didDeliverDuplicate = true
            completionHandler(duplicateFirstResult)
        }
        receiveDepth -= 1
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancelCount += 1
    }

    func failPending(_ error: Error) {
        let completion = receiveCompletions.removeFirst()
        completion(.failure(error))
    }
}

private enum TestError: Error {
    case transport
    case notString
}
