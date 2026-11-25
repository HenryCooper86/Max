import CryptoKit
import Network
import XCTest
@testable import MaxHelmet

/// A loopback relay for close-code tests. It completes the WebSocket upgrade
/// by hand, then closes every connection it accepts with one code, so the
/// session's real URLSession transport and delegate callbacks see the close
/// exactly as the relay sends it.
private final class ClosingRelay {
    private let closeCode: UInt16
    private let queue = DispatchQueue(label: "max.tests.closing-relay")
    private let listener: NWListener
    private var accepted = 0

    init(closeCode: UInt16) throws {
        self.closeCode = closeCode
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] in self?.closeAfterUpgrade($0) }
    }

    /// The relay WebSocket URL a rider would type for this server.
    var agentURL: URL {
        URL(string: "ws://127.0.0.1:\(listener.port?.rawValue ?? 0)/agent")!
    }

    /// Connections accepted so far.
    var connections: Int { queue.sync { accepted } }

    /// Starts listening and returns once the port is known.
    func start() async throws {
        listener.start(queue: queue)
        // NWListener publishes its port only once it is listening.
        let deadline = Date().addingTimeInterval(5)
        while listener.port == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        guard listener.port != nil else {
            throw URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: "The loopback relay did not start listening"])
        }
    }

    func stop() { listener.cancel() }

    private func closeAfterUpgrade(_ connection: NWConnection) {
        accepted += 1
        connection.start(queue: queue)
        readUpgrade(connection, into: Data())
    }

    private func readUpgrade(_ connection: NWConnection, into request: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var request = request
            request.append(data ?? Data())
            guard let headerEnd = request.range(of: Data("\r\n\r\n".utf8)) else {
                if isComplete || error != nil { connection.cancel(); return }
                self.readUpgrade(connection, into: request)
                return
            }
            let header = String(decoding: request[..<headerEnd.lowerBound], as: UTF8.self)
            let key = header.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
                .split(separator: ":", maxSplits: 1).last?
                .trimmingCharacters(in: .whitespaces) ?? ""
            connection.send(content: Self.upgradeResponse(key: key), completion: .contentProcessed { _ in
                self.sendClose(connection)
            })
        }
    }

    private func sendClose(_ connection: NWConnection) {
        // A close frame (RFC 6455 5.5.1): FIN + close opcode, then a 2-byte
        // unmasked payload carrying the code.
        let frame = Data([0x88, 0x02, UInt8(closeCode >> 8), UInt8(closeCode & 0xFF)])
        connection.send(content: frame, completion: .contentProcessed { _ in
            // Leave TCP up until the client has answered the close handshake.
            self.queue.asyncAfter(deadline: .now() + 2) { connection.cancel() }
        })
    }

    /// The accept value is the client's key with a fixed GUID, SHA-1 hashed
    /// (RFC 6455 1.3).
    private static func upgradeResponse(key: String) -> Data {
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        return Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
    }
}

/// The relay's final closes (docs/protocol.md, Close codes) as they reach the
/// session through its real transport and delegate callbacks. The synthetic
/// QA mode connects without a microphone or location, as the live harness does.
@MainActor
final class RelayCloseTests: XCTestCase {
    func testUsedUpMinutesEndTheSessionWithoutReconnecting() async throws {
        let session = try await endedSession(closingWith: 4003)

        XCTAssertEqual(session.state.connection, .degraded)
        XCTAssertEqual(session.state.statusText, L("st.minutesUsedUp"))
        XCTAssertFalse(session.state.authRequired)
    }

    func testRefusedCredentialsEndTheSessionAndAskForASignIn() async throws {
        let session = try await endedSession(closingWith: 1008)

        XCTAssertEqual(session.state.connection, .degraded)
        XCTAssertEqual(session.state.statusText, L("st.signInAgain"))
        XCTAssertTrue(session.state.authRequired)
    }

    /// Runs hands-free against a relay that closes with `closeCode`, and
    /// returns the session once hands-free has ended and the first reconnect
    /// backoff (1 s) has passed without another connection.
    private func endedSession(closingWith closeCode: UInt16) async throws -> AgentSession {
        let relay = try ClosingRelay(closeCode: closeCode)
        try await relay.start()
        defer { relay.stop() }
        let session = AgentSession()
        try session.prepareSyntheticAudioQA()
        defer { session.finishSyntheticAudioQA() }
        session.start(url: relay.agentURL.absoluteString, allowSelfSignedTls: false)

        let deadline = Date().addingTimeInterval(10)
        while session.state.handsFree, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertFalse(session.state.handsFree, "the close should end hands-free")
        try await Task.sleep(nanoseconds: 2_000_000_000)
        XCTAssertEqual(relay.connections, 1, "a final close must not be retried")
        return session
    }
}
