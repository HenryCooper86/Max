import SwiftUI

enum GuidanceMapHostViewState: Equatable {
    case consentRequired
    case notEnabled
    case unavailable
    case nativeMap(AMapAcceptedConsent)
}

enum GuidanceMapHostLifecycleEvent {
    case appeared
}

@MainActor
func handleGuidanceMapHostLifecycle(
    _ event: GuidanceMapHostLifecycleEvent,
    consent: AMapConsentStore
) {
    switch event {
    case .appeared:
        consent.requestIfNeeded()
    }
}

func guidanceMapHostViewState(
    decision: AMapConsentDecision,
    hasAPIKey: Bool,
    hasGeometry: Bool,
    requiresDevice: Bool
) -> GuidanceMapHostViewState {
    switch amapMapPresentation(
        decision: decision,
        hasAPIKey: hasAPIKey,
        hasGeometry: hasGeometry
    ) {
    case .consentRequired:
        return .consentRequired
    case .notEnabled:
        return .notEnabled
    case .unavailable:
        return .unavailable
    case .map:
        guard !requiresDevice, let consent = AMapAcceptedConsent(decision: decision) else {
            return .unavailable
        }
        return .nativeMap(consent)
    }
}

struct GuidanceMapHostPresentation: Equatable {
    let viewState: GuidanceMapHostViewState
    let showsUnavailableOverlay: Bool
}

func guidanceMapHostPresentation(
    decision: AMapConsentDecision,
    hasAPIKey: Bool,
    hasGeometry: Bool,
    loadFailed: Bool,
    requiresDevice: Bool
) -> GuidanceMapHostPresentation {
    let viewState = guidanceMapHostViewState(
        decision: decision,
        hasAPIKey: hasAPIKey,
        hasGeometry: hasGeometry,
        requiresDevice: requiresDevice
    )
    let hasNativeMap: Bool
    if case .nativeMap = viewState {
        hasNativeMap = true
    } else {
        hasNativeMap = false
    }
    return GuidanceMapHostPresentation(
        viewState: viewState,
        showsUnavailableOverlay: hasNativeMap && loadFailed
    )
}

struct GuidanceMapLoadContainer<MapContent: View, FailureOverlay: View>: View {
    let showsUnavailableOverlay: Bool
    private let mapContent: MapContent
    private let failureOverlay: FailureOverlay

    init(
        showsUnavailableOverlay: Bool,
        @ViewBuilder mapContent: () -> MapContent,
        @ViewBuilder failureOverlay: () -> FailureOverlay
    ) {
        self.showsUnavailableOverlay = showsUnavailableOverlay
        self.mapContent = mapContent()
        self.failureOverlay = failureOverlay()
    }

    var body: some View {
        ZStack {
            mapContent
            if showsUnavailableOverlay {
                failureOverlay
            }
        }
    }
}

struct GuidanceMapHost: View {
    let guidance: GuidanceState
    var interactive = false
    var followsRider = false

    @StateObject private var consent = AMapConsentStore()
    @State private var loadFailed = false
    private let configuration = AMapConfiguration()

    private var model: AMapRouteDisplayModel? {
        AMapRouteDisplayModel.make(guidance: guidance, followsRider: followsRider)
    }

    private var presentation: GuidanceMapHostPresentation {
        guidanceMapHostPresentation(
            decision: consent.decision,
            hasAPIKey: configuration.hasAPIKey,
            hasGeometry: model != nil,
            loadFailed: loadFailed,
            requiresDevice: requiresDevice
        )
    }

    private var requiresDevice: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            switch presentation.viewState {
            case .consentRequired:
                placeholder(title: "等待启用高德地图", actionTitle: nil, action: nil)
            case .notEnabled:
                placeholder(title: "地图未启用", actionTitle: "启用地图", action: consent.reconsider)
            case .unavailable:
                placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
            case let .nativeMap(acceptedConsent):
                map(consent: acceptedConsent)
            }
        }
        .onAppear { handleGuidanceMapHostLifecycle(.appeared, consent: consent) }
        .sheet(isPresented: $consent.isPromptPresented) {
            AMapConsentSheet(onAccept: consent.accept, onDecline: consent.decline)
        }
    }

    @ViewBuilder
    private func map(consent: AMapAcceptedConsent) -> some View {
        if let model,
           let apiKey = configuration.apiKey {
            GuidanceMapLoadContainer(
                showsUnavailableOverlay: presentation.showsUnavailableOverlay,
                mapContent: {
                    AMapRouteMap(
                        model: model,
                        consent: consent,
                        apiKey: apiKey,
                        loadFailed: $loadFailed,
                        interactive: interactive,
                        followsRider: followsRider
                    )
                },
                failureOverlay: {
                    placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
                }
            )
        } else {
            placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
        }
    }

    @ViewBuilder
    private func placeholder(
        title: String,
        actionTitle: String?,
        action: (() -> Void)?
    ) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "map")
            Text(title).font(.subheadline.weight(.semibold))
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(HudAccessibilityID.guidanceMapAction)
            }
        }
        .foregroundStyle(HudColors.hudDim)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HudColors.void.opacity(0.65))
    }
}
