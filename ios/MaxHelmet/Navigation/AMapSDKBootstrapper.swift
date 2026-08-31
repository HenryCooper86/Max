import Foundation

/// A capability produced only from an accepted map-consent decision.
struct AMapAcceptedConsent: Equatable {
    init?(decision: AMapConsentDecision) {
        guard decision == .accepted else { return nil }
    }
}

protocol AMapSDKConfigurationApplying {
    func apply(apiKey: String)
}

struct AMapSDKPrivacyConfiguration: AMapSDKConfigurationApplying {
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

    func prepare(
        consent: AMapAcceptedConsent?,
        apiKey: String,
        configuration: some AMapSDKConfigurationApplying
    ) -> Bool {
        guard consent != nil else { return false }

        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return false }

        lock.lock()
        defer { lock.unlock() }

        guard !prepared else { return true }
        configuration.apply(apiKey: key)
        prepared = true
        return true
    }
}

#if !targetEnvironment(simulator)
func liveAMapSDKPrivacyConfiguration() -> AMapSDKPrivacyConfiguration {
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
    )
}
#endif
