import Combine
import CoreLocation
import Foundation
import UIKit

/// Foreground bench transport. Navigation remains owned by AgentSession.
@MainActor
final class HUDCastClient: ObservableObject {
    @Published private(set) var status = "未投屏"
    @Published private(set) var active = false
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
    private var pending = false
    private var backgroundObserver: AnyCancellable?

    init() {
        backgroundObserver = NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .sink { [weak self] _ in Task { @MainActor in self?.stop() } }
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
        latestAt = Date()
        guard let guidance, guidance.confirmationID == nil else { stop(); return }
        pending = true
        flush()
    }

    func connect(address: String, code: String) {
        stop()
        guard Self.supported else { status = "Wi-Fi 投屏原型需要开发版本"; return }
        guard let url = Self.endpoint(address), code.count == 6, code.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            status = "请输入 RDK 屏幕上的地址和六位连接码"; return
        }
        guard latest != nil, Date().timeIntervalSince(latestAt) < 8 else {
            status = "等待手机导航更新后重试"; return
        }
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        active = true
        status = "正在连接 HUD…"
        lastReply = Date()
        lastPing = Date()
        pending = true
        task.resume()
        receiver = Task { [weak self] in
            do {
                let join = try JSONSerialization.data(withJSONObject: ["type": "hud.join", "code": code])
                try await task.send(.string(String(decoding: join, as: UTF8.self)))
                while !Task.isCancelled {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    guard case let .string(text) = message, let data = text.data(using: .utf8),
                          let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        self.fail("HUD 响应无效"); return
                    }
                    self.lastReply = Date()
                    if reply["type"] as? String == "hud.ready" {
                        self.ready = true
                        HUDMapSource.shared.start()
                        self.status = "已连接 · 正在发送导航"
                    } else if reply["type"] as? String == "hud.ack",
                              reply["sequence"] as? Int == self.sequence {
                        self.awaitingAck = false
                        self.status = "正在投屏到 HUD"
                    } else if reply["type"] as? String == "hud.map.ack", reply["sequence"] as? Int == self.mapSequence {
                        self.mapBusy = false
                    } else if reply["type"] as? String == "hud.pong" {
                        // Transport liveness only; never make old guidance fresh.
                    } else { self.fail("HUD 响应无效"); return }
                    self.flush()
                }
            } catch {
                guard let self, self.socket === task else { return }
                self.fail("HUD 已断开，请检查 Wi-Fi 和连接码后重试")
            }
        }
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, self.socket === task else { return }
                if Date().timeIntervalSince(self.lastReply) > 12 ||
                    (self.awaitingAck && Date().timeIntervalSince(self.frameSentAt) > 12) ||
                    (self.mapBusy && Date().timeIntervalSince(self.mapSentAt) > 12) {
                    self.fail("HUD 连接超时，请重新连接"); return
                }
                self.sendMap()
                if self.ready && Date().timeIntervalSince(self.lastPing) >= 4 {
                    self.lastPing = Date()
                    do { try await task.send(.string(#"{"type":"hud.ping"}"#)) }
                    catch {
                        if self.socket === task { self.fail("HUD 已断开，请重新连接") }
                        return
                    }
                }
            }
        }
    }

    func stop() {
        HUDMapSource.shared.stop()
        mapBusy = false; mapSequence = 0
        receiver?.cancel(); receiver = nil
        watchdog?.cancel(); watchdog = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        active = false; ready = false; awaitingAck = false; pending = false; sequence = 0
        status = "未投屏"
    }

    private func sendMap() {
        guard ready, !mapBusy, let socket, Date().timeIntervalSince(latestAt) < 8 else { return }
        mapBusy = true
        mapSentAt = Date()
        HUDMapSource.shared.snapshot { [weak self, weak socket] data in
            Task { @MainActor in
                guard let self, let socket, self.socket === socket else { return }
                guard let data, Date().timeIntervalSince(self.latestAt) < 8 else { self.mapBusy = false; return }
                self.mapSequence += 1
                let value: [String: Any] = ["type": "hud.map", "sequence": self.mapSequence, "jpeg": data.base64EncodedString()]
                do {
                    let json = try JSONSerialization.data(withJSONObject: value)
                    try await socket.send(.string(String(decoding: json, as: UTF8.self)))
                } catch {
                    if self.socket === socket { self.fail("地图投屏已断开，请重新连接") }
                }
            }
        }
    }

    private func fail(_ message: String) { stop(); status = message }

    private func flush() {
        guard ready, !awaitingAck, pending, let socket, let latest else { return }
        guard Date().timeIntervalSince(latestAt) < 8 else { return }
        sequence += 1
        guard let text = Self.frame(latest, sequence: sequence) else {
            fail("当前导航数据暂时无法投屏"); return
        }
        frameSentAt = Date()
        awaitingAck = true; pending = false
        Task { [weak self] in
            do { try await socket.send(.string(text)) }
            catch {
                guard let self, self.socket === socket else { return }
                self.fail("HUD 已断开，请重新连接")
            }
        }
    }

    static func frame(_ guidance: GuidanceState, sequence: Int) -> String? {
        guard guidance.confirmationID == nil, guidance.polyline.count >= 2 else { return nil }
        let source = guidance.polyline
        let count = min(source.count, 2048)
        let points = (0..<count).map { index in source[index * (source.count - 1) / (count - 1)] }
        func point(_ value: CLLocationCoordinate2D) -> [String: Double] { ["lat": value.latitude, "lon": value.longitude] }
        let value: [String: Any] = [
            "type": "hud.frame", "sequence": sequence,
            "destination": String(guidance.destinationName.prefix(200)),
            "instruction": String((guidance.maneuverInstruction ?? "沿路线前往目的地").prefix(500)),
            "distance": guidance.distanceToManeuverMeters, "remaining": guidance.remainingDistanceMeters,
            "seconds": guidance.remainingSeconds, "offRoute": guidance.offRoute,
            "turns": guidance.upcomingSteps.prefix(3).map { detail -> [String: Any] in
                ["lat": detail.step.coordinate.latitude, "lon": detail.step.coordinate.longitude,
                 "instruction": String(detail.step.instruction.prefix(500)), "distance": detail.distanceMeters]
            },
            "polyline": points.map(point), "position": guidance.currentLocation.map { point($0) as Any } ?? NSNull()
        ]
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
