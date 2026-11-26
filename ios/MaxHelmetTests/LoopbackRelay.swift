import CryptoKit
import Foundation
import Network
import XCTest
@testable import MaxHelmet

/// A loopback relay for session tests. It completes each WebSocket upgrade by hand, keeps the
/// JSON text events the client sends, and sends what a test scripts, so the session's real
/// URLSessionWebSocketTask transport and delegate callbacks see everything as a relay sends it.
final class LoopbackRelay {
    /// One accepted WebSocket connection. Its frames are read on the relay's queue; sending
    /// and closing are safe from any thread.
    final class Connection {
        private let link: NWConnection
        private let relay: LoopbackRelay
        private var buffer = Data()

        fileprivate init(_ link: NWConnection, relay: LoopbackRelay) {
            self.link = link
            self.relay = relay
        }

        /// Sends one text (JSON) event.
        func send(text: String) {
            link.send(content: Self.frame(opcode: 0x1, payload: Data(text.utf8)), completion: .contentProcessed { _ in })
        }

        /// Closes the WebSocket with `code`, the way a relay does (RFC 6455 5.5.1).
        func close(code: UInt16, reason: String = "") {
            var payload = Data([UInt8(code >> 8), UInt8(code & 0xFF)])
            payload.append(Data(reason.utf8))
            link.send(content: Self.frame(opcode: 0x8, payload: payload), completion: .contentProcessed { _ in
                // Leave TCP up until the client has answered the close handshake.
                self.relay.queue.asyncAfter(deadline: .now() + 2) { self.link.cancel() }
            })
        }

        /// Drops the TCP connection with no WebSocket close, as a lost link does.
        func drop() { link.cancel() }

        fileprivate func start() {
            link.start(queue: relay.queue)
            readUpgrade(into: Data())
        }

        private func readUpgrade(into request: Data) {
            link.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
                guard let self else { return }
                var request = request
                request.append(data ?? Data())
                guard let headerEnd = request.range(of: Data("\r\n\r\n".utf8)) else {
                    if isComplete || error != nil { self.link.cancel() } else { self.readUpgrade(into: request) }
                    return
                }
                let header = String(decoding: request[..<headerEnd.lowerBound], as: UTF8.self)
                let key = header.components(separatedBy: "\r\n")
                    .first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
                    .split(separator: ":", maxSplits: 1).last?
                    .trimmingCharacters(in: .whitespaces) ?? ""
                self.link.send(content: Self.upgradeResponse(key: key), completion: .contentProcessed { _ in
                    self.readFrames()
                })
            }
        }

        private func readFrames() {
            link.receive(minimumIncompleteLength: 1, maximumLength: 262_144) { [weak self] data, _, isComplete, error in
                guard let self, !isComplete, error == nil else { return }
                if let data {
                    self.buffer.append(data)
                    while let frame = Self.takeFrame(from: &self.buffer) { self.handle(frame) }
                }
                self.readFrames()
            }
        }

        private func handle(_ frame: (opcode: UInt8, payload: Data)) {
            switch frame.opcode {
            case 0x1:
                relay.sent.append(String(decoding: frame.payload, as: UTF8.self))
            case 0x8:
                // Answer the client's close with its own code, then end TCP.
                link.send(content: Self.frame(opcode: 0x8, payload: frame.payload.prefix(2)), completion: .contentProcessed { _ in
                    self.relay.queue.asyncAfter(deadline: .now() + 1) { self.link.cancel() }
                })
            case 0x9:
                link.send(content: Self.frame(opcode: 0xA, payload: frame.payload), completion: .contentProcessed { _ in })
            default:
                break // 0x2: binary audio; 0xA: a pong.
            }
        }

        /// A server-to-client frame (RFC 6455 5.2): FIN + opcode, a length of 7, 16 or 64 bits,
        /// and the payload unmasked.
        private static func frame(opcode: UInt8, payload: Data) -> Data {
            var frame = Data([0x80 | opcode])
            switch payload.count {
            case 0..<126:
                frame.append(UInt8(payload.count))
            case 126..<65_536:
                frame.append(126)
                frame.append(UInt8(payload.count >> 8))
                frame.append(UInt8(payload.count & 0xFF))
            default:
                frame.append(127)
                var length = UInt64(payload.count).bigEndian
                withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
            }
            frame.append(payload)
            return frame
        }

        /// Takes the first whole client frame off `buffer`: client frames are masked (RFC 6455
        /// 5.3), so the payload is unmasked on the way out.
        private static func takeFrame(from buffer: inout Data) -> (opcode: UInt8, payload: Data)? {
            let bytes = [UInt8](buffer)
            guard bytes.count >= 2 else { return nil }
            let opcode = bytes[0] & 0x0F
            let masked = bytes[1] & 0x80 != 0
            var length = Int(bytes[1] & 0x7F)
            var offset = 2
            if length == 126 {
                guard bytes.count >= 4 else { return nil }
                length = Int(bytes[2]) << 8 | Int(bytes[3])
                offset = 4
            } else if length == 127 {
                guard bytes.count >= 10 else { return nil }
                length = bytes[2..<10].reduce(0) { $0 << 8 | Int($1) }
                offset = 10
            }
            let mask = Array(bytes[offset ..< offset + (masked ? 4 : 0)])
            offset += mask.count
            guard bytes.count >= offset + length else { return nil }
            var payload = Array(bytes[offset ..< offset + length])
            if masked { for index in payload.indices { payload[index] ^= mask[index % 4] } }
            buffer = Data(bytes.dropFirst(offset + length))
            return (opcode, Data(payload))
        }

        /// The accept value is the client's key with a fixed GUID, SHA-1 hashed (RFC 6455 1.3).
        private static func upgradeResponse(key: String) -> Data {
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            return Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
        }
    }

    private let queue = DispatchQueue(label: "max.tests.loopback-relay")
    private let listener: NWListener
    /// Below here, touched only on `queue`.
    private var connections: [Connection] = []
    private var sent: [String] = []

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] link in
            guard let self else { return }
            self.queue.async {
                let connection = Connection(link, relay: self)
                self.connections.append(connection)
                connection.start()
            }
        }
    }

    /// The relay WebSocket URL a rider would type for this server.
    var agentURL: URL {
        URL(string: "ws://127.0.0.1:\(listener.port?.rawValue ?? 0)/agent")!
    }

    /// Connections accepted so far.
    var connectionCount: Int { queue.sync { connections.count } }

    /// The connection most recently accepted.
    var current: Connection? { queue.sync { connections.last } }

    /// Starts listening and returns once the port is known.
    func start() async throws {
        listener.start(queue: queue)
        // NWListener reports `.any` (port 0) until it is actually listening, so a nil check is not enough: a test
        // that read the port too early dialled 127.0.0.1:0 and timed out (seen on the CI runner). Wait for a real port.
        let deadline = Date().addingTimeInterval(10)
        while (listener.port?.rawValue ?? 0) == 0, Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        guard (listener.port?.rawValue ?? 0) != 0 else {
            throw URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: "The loopback relay did not start listening"])
        }
    }

    func stop() {
        listener.cancel()
        queue.sync { connections.forEach { $0.drop() } }
    }

    /// Every event of one `type` the client has sent, decoded, oldest first across connections.
    func events(ofType type: String) -> [[String: Any]] {
        queue.sync { sent }.compactMap { text in
            let event = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
            return event?["type"] as? String == type ? event : nil
        }
    }

    func sessionStarts() -> [[String: Any]] { events(ofType: "session.start") }
    func deviceResults() -> [[String: Any]] { events(ofType: "device.result") }

    /// A `session.started` event as a relay sends it: the mock demo here, with the conversation's
    /// `resume` id and the relay's protocol version when given.
    static func sessionStarted(resume: String? = nil, protocol relayProtocol: Int? = 1) -> String {
        var event = #"{"type":"session.started","provider":"mock","mode":"mock","capabilities":{}"#
        if let resume { event += #","resume":"\#(resume)""# }
        if let relayProtocol { event += #","protocol":\#(relayProtocol)"# }
        return event + "}"
    }
}

/// Polls `condition` until it holds; fails the test if it does not within `timeout`.
@MainActor
func waitUntil(timeout: TimeInterval = 10, _ message: String, file: StaticString = #filePath, line: UInt = #line, _ condition: @MainActor () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTAssertTrue(condition(), "timed out waiting for \(message)", file: file, line: line)
}
