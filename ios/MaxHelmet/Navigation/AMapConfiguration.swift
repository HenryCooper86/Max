import Foundation

struct AMapConfiguration: Equatable {
    static let plistKey = "MaxAMapKey"

    let apiKey: String?

    init(infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:]) {
        let raw = (infoDictionary[Self.plistKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        apiKey = raw.isEmpty || raw.hasPrefix("$(") ? nil : raw
    }

    var hasAPIKey: Bool { apiKey != nil }
}
