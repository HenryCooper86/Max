import Combine
import Foundation

enum AMapConsentDecision: String, Equatable {
    case unknown
    case accepted
    case declined
}

@MainActor
final class AMapConsentStore: ObservableObject {
    static let defaultsKey = "amap_map_consent"

    @Published private(set) var decision: AMapConsentDecision
    @Published var isPromptPresented = false

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        decision = defaults.string(forKey: Self.defaultsKey)
            .flatMap(AMapConsentDecision.init(rawValue:)) ?? .unknown
    }

    func requestIfNeeded() {
        if decision == .unknown { isPromptPresented = true }
    }

    func accept() {
        setDecision(.accepted)
    }

    func decline() {
        setDecision(.declined)
    }

    func reconsider() {
        isPromptPresented = true
    }

    private func setDecision(_ next: AMapConsentDecision) {
        decision = next
        defaults.set(next.rawValue, forKey: Self.defaultsKey)
        isPromptPresented = false
    }
}
