import Foundation

struct CompanionFix: Equatable {
    let sequence: Int
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double
    let timestampMilliseconds: Double
    let courseDegrees: Double?
    let speedMps: Double?
}

enum CompanionConnectionState: Equatable {
    case signedOut
    case connecting
    case unpaired
    case paired(deviceId: String?, label: String?)
    case helmetOffline(deviceId: String?, label: String?)
    case ready(deviceId: String?, label: String?)
    case sharing(deviceId: String?, label: String?)
    case failed(code: String, detail: String)
}

enum RDKCompanionProtocol {
    private static let maximumStringBytes = 4_096
    private static let maximumPairCodeBytes = 120

    static func parseServerMessage(_ message: URLSessionWebSocketTask.Message) -> CompanionConnectionState? {
        guard case let .string(text) = message,
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let payload = object as? [String: Any],
              let type = payload["type"] as? String else {
            return nil
        }

        switch type {
        case "companion.status":
            guard hasOnlyFields(payload, allowed: ["type", "state", "deviceId", "deviceLabel", "detail"]),
                  let state = boundedString(payload["state"], required: true),
                  let deviceId = optionalBoundedString(payload, key: "deviceId"),
                  let label = optionalBoundedString(payload, key: "deviceLabel"),
                  optionalBoundedString(payload, key: "detail") != nil else {
                return nil
            }
            switch state {
            case "unpaired": return .unpaired
            case "paired": return .paired(deviceId: deviceId.value, label: label.value)
            case "helmetOffline": return .helmetOffline(deviceId: deviceId.value, label: label.value)
            case "ready": return .ready(deviceId: deviceId.value, label: label.value)
            case "sharing": return .sharing(deviceId: deviceId.value, label: label.value)
            default: return nil
            }

        case "companion.error":
            guard hasOnlyFields(payload, allowed: ["type", "code", "detail"]),
                  let code = boundedString(payload["code"], required: true),
                  let detail = boundedString(payload["detail"], required: true) else {
                return nil
            }
            return .failed(code: code, detail: detail)

        default:
            return nil
        }
    }

    static func pairMessage(code: String) -> String? {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.lengthOfBytes(using: .utf8) <= maximumPairCodeBytes else {
            return nil
        }
        return encode(["type": "companion.pair", "code": trimmed])
    }

    static func startMessage() -> String {
        #"{"type":"companion.start"}"#
    }

    static func stopMessage() -> String {
        #"{"type":"companion.stop"}"#
    }

    static func unpairMessage() -> String {
        #"{"type":"companion.unpair"}"#
    }

    static func locationMessage(_ fix: CompanionFix) -> String? {
        guard fix.sequence > 0,
              fix.latitude.isFinite, (-90...90).contains(fix.latitude),
              fix.longitude.isFinite, (-180...180).contains(fix.longitude),
              fix.horizontalAccuracyMeters.isFinite, fix.horizontalAccuracyMeters >= 0,
              fix.timestampMilliseconds.isFinite, fix.timestampMilliseconds >= 0,
              validOptional(fix.courseDegrees, range: 0...360),
              validOptional(fix.speedMps, minimum: 0) else {
            return nil
        }

        var payload: [String: Any] = [
            "type": "companion.location",
            "sequence": fix.sequence,
            "lat": fix.latitude,
            "lon": fix.longitude,
            "horizontalAccuracyMeters": fix.horizontalAccuracyMeters,
            "timestamp": fix.timestampMilliseconds
        ]
        if let courseDegrees = fix.courseDegrees {
            payload["courseDegrees"] = courseDegrees
        }
        if let speedMps = fix.speedMps {
            payload["speedMps"] = speedMps
        }
        return encode(payload)
    }

    private struct OptionalString {
        let value: String?
    }

    private static func optionalBoundedString(_ payload: [String: Any], key: String) -> OptionalString? {
        guard let value = payload[key] else { return OptionalString(value: nil) }
        guard let string = boundedString(value, required: false) else { return nil }
        return OptionalString(value: string)
    }

    private static func boundedString(_ value: Any?, required: Bool) -> String? {
        guard let string = value as? String,
              (!required || !string.isEmpty),
              string.lengthOfBytes(using: .utf8) <= maximumStringBytes else {
            return nil
        }
        return string
    }

    private static func hasOnlyFields(_ payload: [String: Any], allowed: Set<String>) -> Bool {
        payload.keys.allSatisfy(allowed.contains)
    }

    private static func validOptional(_ value: Double?, range: ClosedRange<Double>) -> Bool {
        guard let value else { return true }
        return value.isFinite && range.contains(value)
    }

    private static func validOptional(_ value: Double?, minimum: Double) -> Bool {
        guard let value else { return true }
        return value.isFinite && value >= minimum
    }

    private static func encode(_ payload: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
