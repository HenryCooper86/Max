import Combine
import CoreLocation
import Foundation
import UIKit

/// Navigation-scoped bench transport. Navigation remains owned by AgentSession.
@MainActor
final class HUDCastClient: ObservableObject {
    @Published private(set) var status = L("hud.status.idle")
    @Published private(set) var active = false
    private struct Bond: Codable { var address: String; var token: String; var enabled: Bool }
    private static let bondAccount = "hud.wifi.bond.v1"
    private var bond: Bond? = SecureTokenStore.read(account: HUDCastClient.bondAccount).flatMap { try? JSONDecoder().decode(Bond.self, from: Data($0.utf8)) }
    var savedAddress: String { bond?.address ?? "" }
    private var reconnect: Task<Void, Never>?
    private var retryDelay = 3.0
    private func saveBond() {
        guard let bond, let data = try? JSONEncoder().encode(bond) else { return }
        if !SecureTokenStore.write(String(decoding: data, as: UTF8.self), account: Self.bondAccount) { self.bond?.enabled = false; SecureTokenStore.remove(account: Self.bondAccount) }
    }
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var latest: GuidanceState?
    private var latestAt = Date.distantPast
    private var lastReply = Date.distantPast
    private var lastPing = Date.distantPast
    private var frameSentAt = Date.distantPast
    private var mapSequence = 0
    private var mapBusy = false
    private var mapSentAt = Date.distantPast
    private var sequence = 0
    private var awaitingAck = false
    private var ready = false
    private var receiverDrawsMap = false
    private var pending = false
    private var lifecycleObservers: [AnyCancellable] = []
    private var mapCapturePending = false
    private var mapCaptureGeneration = 0

    init() {
        HUDMapSource.shared.onHeading = { [weak self] heading in self?.sendHeading(heading) }
        lifecycleObservers = [
            NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)
                .sink { [weak self] _ in Task { @MainActor in self?.setForeground(false) } },
            NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
                .sink { [weak self] _ in Task { @MainActor in self?.setForeground(true) } }
        ]
    }

    func setForeground(_ foreground: Bool) {
        HUDMapSource.shared.setForeground(foreground)
        if !foreground && mapCapturePending {
            mapCaptureGeneration += 1
            mapCapturePending = false
            mapBusy = false
        }
        // Active navigation owns background execution. Do not close its socket.
    }

    static var supported: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    static func endpoint(_ address: String) -> URL? {
        // Deliberately no credentials, URL paths or query strings in the address field.
        guard let components = URLComponents(string: "ws://" + address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = components.host, components.user == nil, components.password == nil,
              components.path.isEmpty, components.query == nil, components.fragment == nil,
              let port = components.port, (1...65535).contains(port) else { return nil }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        let privateIP = host.split(separator: ".").count == 4 && parts.count == 4 && parts.allSatisfy { (0...255).contains($0) } &&
            (parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) ||
             (parts[0] == 172 && (16...31).contains(parts[1])))
        guard privateIP || host.hasSuffix(".local") else { return nil }
        var result = components
        result.path = "/cast/socket"
        return result.url
    }

    func update(_ guidance: GuidanceState?) {
        latest = guidance
        HUDMapSource.shared.update(guidance)
        latestAt = Date()
        guard let guidance, guidance.confirmationID == nil else {
            reconnect?.cancel(); reconnect = nil; closeTransport(); return
        }
        if !active, bond?.enabled == true { resumeSaved(); }
        pending = true
        flush()
    }

    func connect(address: String, code: String) {
        reconnect?.cancel(); reconnect = nil
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = code.isEmpty && bond?.address == address ? bond?.token : nil
        bond?.enabled = token != nil; saveBond()
        connect(address: address, code: code, token: token)
    }

    private func connect(address: String, code: String, token: String?) {
        closeTransport()
        guard Self.supported else { status = L("hud.status.debugOnly"); return }
        guard let url = Self.endpoint(address), token != nil || (code.count == 6 && code.allSatisfy({ $0.isASCII && $0.isNumber })) else {
            status = L("hud.status.needCode"); return
        }
        guard latest != nil, Date().timeIntervalSince(latestAt) < 8 else {
            status = L("hud.status.waitNav"); if token != nil { scheduleReconnect() }; return
        }
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        active = true
        status = L("hud.status.connecting")
        lastReply = Date()
        lastPing = Date()
        pending = true
        task.resume()
        receiver = Task { [weak self] in
            do {
                let fields: [String: Any] = token.map { ["type": "hud.join", "resumeToken": $0] } ?? ["type": "hud.join", "code": code, "remember": true]
                let join = try JSONSerialization.data(withJSONObject: fields)
                try await task.send(.string(String(decoding: join, as: UTF8.self)))
                while !Task.isCancelled {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    guard case let .string(text) = message, let data = text.data(using: .utf8),
                          let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        self.fail(L("hud.status.badReply")); return
                    }
                    self.lastReply = Date()
                    if reply["type"] as? String == "hud.ready" {
                        if let savedToken = reply["resumeToken"] as? String ?? token {
                            self.bond = Bond(address: address, token: savedToken, enabled: true)
                            self.saveBond()
                        }
                        self.retryDelay = 3
                        self.ready = true
                        self.receiverDrawsMap = reply["mapMode"] as? String == "streets"
                        HUDMapSource.shared.start(renderMap: !self.receiverDrawsMap)
                        self.status = L("hud.status.connectedSending")
                    } else if reply["type"] as? String == "hud.ack",
                              reply["sequence"] as? Int == self.sequence {
                        self.awaitingAck = false
                        if reply["mapMode"] as? String == "streets", !self.receiverDrawsMap {
                            self.receiverDrawsMap = true
                            HUDMapSource.shared.start(renderMap: false)
                        }
                        self.status = L("hud.status.casting")
                    } else if reply["type"] as? String == "hud.map.ack", reply["sequence"] as? Int == self.mapSequence {
                        self.mapBusy = false
                    } else if reply["type"] as? String == "hud.heading.ack" {
                        // Compass acknowledgment does not refresh guidance.
                    } else if reply["type"] as? String == "hud.pong" {
                        // Transport liveness only; never make old guidance fresh.
                    } else { self.fail(L("hud.status.badReply")); return }
                    self.flush()
                }
            } catch {
                guard let self, self.socket === task else { return }
                if task.closeCode == .policyViolation {
                    self.stop(); self.status = L("hud.status.pairInvalid")
                } else { self.fail(L("hud.status.droppedWaiting")) }
            }
        }
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, self.socket === task else { return }
                if Date().timeIntervalSince(self.lastReply) > 12 ||
                    (self.awaitingAck && Date().timeIntervalSince(self.frameSentAt) > 12) ||
                    (self.mapBusy && Date().timeIntervalSince(self.mapSentAt) > 12) {
                    self.fail(L("hud.status.timeout")); return
                }
                self.sendMap()
                if self.ready && Date().timeIntervalSince(self.lastPing) >= 4 {
                    self.lastPing = Date()
                    do { try await task.send(.string(#"{"type":"hud.ping"}"#)) }
                    catch {
                        if self.socket === task { self.fail(L("hud.status.dropped")) }
                        return
                    }
                }
            }
        }
    }

    /// Explicit user disconnect: persist the pause so a new GPS fix cannot reconnect.
    func stop() {
        bond?.enabled = false; saveBond()
        reconnect?.cancel(); reconnect = nil
        closeTransport()
    }

    private func closeTransport() {
        mapCaptureGeneration += 1
        mapCapturePending = false
        HUDMapSource.shared.stop()
        mapBusy = false; mapSequence = 0; receiverDrawsMap = false
        receiver?.cancel(); receiver = nil
        watchdog?.cancel(); watchdog = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        active = false; ready = false; awaitingAck = false; pending = false; sequence = 0
        status = L("hud.status.idle")
    }

    private func sendHeading(_ heading: Double) {
        guard ready, receiverDrawsMap, let socket else { return }
        Task { [weak self] in
            do {
                let data = try JSONSerialization.data(withJSONObject: ["type": "hud.heading", "heading": heading])
                try await socket.send(.string(String(decoding: data, as: UTF8.self)))
            } catch {
                if self?.socket === socket { self?.fail(L("hud.status.dropped")) }
            }
        }
    }

    private func sendMap() {
        guard ready, !receiverDrawsMap, !mapBusy, let socket, Date().timeIntervalSince(latestAt) < 8 else { return }
        mapBusy = true
        mapCapturePending = true
        mapCaptureGeneration += 1
        let generation = mapCaptureGeneration
        mapSentAt = Date()
        HUDMapSource.shared.snapshot { [weak self, weak socket] data in
            Task { @MainActor in
                guard let self, let socket, self.socket === socket, self.mapCaptureGeneration == generation else { return }
                self.mapCapturePending = false
                guard let data, Date().timeIntervalSince(self.latestAt) < 8 else { self.mapBusy = false; return }
                self.mapSequence += 1
                let value: [String: Any] = ["type": "hud.map", "sequence": self.mapSequence, "jpeg": data.base64EncodedString()]
                do {
                    let json = try JSONSerialization.data(withJSONObject: value)
                    try await socket.send(.string(String(decoding: json, as: UTF8.self)))
                } catch {
                    if self.socket === socket { self.fail(L("hud.status.mapDropped")) }
                }
            }
        }
    }

    private func fail(_ message: String) {
        closeTransport(); status = message; scheduleReconnect()
    }
    private func resumeSaved() {
        guard let bond, bond.enabled, latest != nil else { return }
        connect(address: bond.address, code: "", token: bond.token)
    }
    private func scheduleReconnect() {
        guard bond?.enabled == true, latest != nil else { return }
        reconnect?.cancel()
        active = true; status = L("hud.status.autoReconnect")
        let delay = retryDelay; retryDelay = min(30, retryDelay * 2)
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.reconnect = nil; self?.resumeSaved()
        }
    }

    private func flush() {
        guard ready, !awaitingAck, pending, let socket, let latest else { return }
        guard Date().timeIntervalSince(latestAt) < 8 else { return }
        sequence += 1
        guard let text = Self.frame(latest, sequence: sequence) else {
            fail(L("hud.status.noData")); return
        }
        frameSentAt = Date()
        awaitingAck = true; pending = false
        Task { [weak self] in
            do { try await socket.send(.string(text)) }
            catch {
                guard let self, self.socket === socket else { return }
                self.fail(L("hud.status.dropped"))
            }
        }
    }

    static func frame(_ guidance: GuidanceState, sequence: Int) -> String? {
        guard guidance.confirmationID == nil, guidance.polyline.count >= 2 else { return nil }
        let source = guidance.polyline
        let count = min(source.count, 2048)
        let points = (0..<count).map { index in source[index * (source.count - 1) / (count - 1)] }
        func point(_ value: CLLocationCoordinate2D) -> [String: Double] {
            let display = CoordinateDatum.wgs84ToGcj02(value)
            return ["lat": display.latitude, "lon": display.longitude]
        }
        let value: [String: Any] = [
            "type": "hud.frame", "sequence": sequence,
            "destination": String(guidance.destinationName.prefix(200)),
            "instruction": String((guidance.maneuverInstruction ?? L("nav.routeToDestination")).prefix(500)),
            "distance": guidance.distanceToManeuverMeters, "remaining": guidance.remainingDistanceMeters,
            "seconds": guidance.remainingSeconds, "offRoute": guidance.offRoute,
            "turns": guidance.upcomingSteps.prefix(3).map { detail -> [String: Any] in
                var turn: [String: Any] = point(detail.step.coordinate)
                turn["instruction"] = String(detail.step.displayInstruction.prefix(500))
                turn["distance"] = detail.distanceMeters
                return turn
            },
            "polyline": points.map(point), "position": guidance.currentLocation.map { point($0) as Any } ?? NSNull()
        ]
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}


extension HUDCastClient: HUDCastStopping {}
