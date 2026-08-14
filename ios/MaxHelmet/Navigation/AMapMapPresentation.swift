enum AMapMapPresentation: Equatable {
    case consentRequired
    case map
    case notEnabled
    case unavailable
}

func amapMapPresentation(
    decision: AMapConsentDecision,
    hasAPIKey: Bool,
    hasGeometry: Bool
) -> AMapMapPresentation {
    switch decision {
    case .unknown:
        return .consentRequired
    case .declined:
        return .notEnabled
    case .accepted:
        return hasAPIKey && hasGeometry ? .map : .unavailable
    }
}
