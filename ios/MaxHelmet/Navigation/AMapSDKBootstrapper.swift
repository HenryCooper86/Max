import Foundation

struct AMapSDKPrivacyConfiguration {
    let showPrivacy: () -> Void
    let agreePrivacy: () -> Void
    let enableHTTPS: () -> Void
    let assignAPIKey: (String) -> Void

    func apply(apiKey: String) {
        showPrivacy()
        agreePrivacy()
        enableHTTPS()
        assignAPIKey(apiKey)
    }
}

final class AMapSDKBootstrapper {
    static let shared = AMapSDKBootstrapper()

    private let lock = NSLock()
    private var prepared = false

    func prepare(apiKey: String, apply: (String) -> Void) -> Bool {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return false }

        lock.lock()
        defer { lock.unlock() }

        guard !prepared else { return true }
        apply(key)
        prepared = true
        return true
    }
}

#if !targetEnvironment(simulator)
func applyLiveAMapConfiguration(apiKey: String) {
    AMapSDKPrivacyConfiguration(
        showPrivacy: {
            MAMapView.updatePrivacyShow(.didShow, privacyInfo: .didContain)
        },
        agreePrivacy: {
            MAMapView.updatePrivacyAgree(.didAgree)
        },
        enableHTTPS: {
            AMapServices.shared()!.enableHTTPS = true
        },
        assignAPIKey: { key in
            AMapServices.shared()!.apiKey = key
        }
    ).apply(apiKey: apiKey)
}
#endif
