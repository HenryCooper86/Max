import SwiftUI

struct GuidanceMapHost: View {
    let guidance: GuidanceState

    @StateObject private var consent = AMapConsentStore()
    @State private var loadFailed = false
    private let configuration = AMapConfiguration()

    private var model: AMapRouteDisplayModel? {
        AMapRouteDisplayModel.make(guidance: guidance)
    }

    private var presentation: AMapMapPresentation {
        amapMapPresentation(
            decision: consent.decision,
            hasAPIKey: configuration.hasAPIKey,
            hasGeometry: model != nil,
            loadFailed: loadFailed
        )
    }

    var body: some View {
        Group {
            switch presentation {
            case .consentRequired:
                placeholder(title: "等待启用高德地图", actionTitle: nil, action: nil)
            case .notEnabled:
                placeholder(title: "地图未启用", actionTitle: "启用地图", action: consent.reconsider)
            case .unavailable:
                placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
            case .map:
                map
            }
        }
        .onAppear { consent.requestIfNeeded() }
        .sheet(isPresented: $consent.isPromptPresented) {
            AMapConsentSheet(onAccept: consent.accept, onDecline: consent.decline)
        }
    }

    @ViewBuilder
    private var map: some View {
        #if targetEnvironment(simulator)
        placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
        #else
        if let model,
           let apiKey = configuration.apiKey,
           let acceptedConsent = AMapAcceptedConsent(decision: consent.decision) {
            AMapRouteMap(
                model: model,
                consent: acceptedConsent,
                apiKey: apiKey,
                loadFailed: $loadFailed
            )
        } else {
            placeholder(title: "地图暂不可用", actionTitle: nil, action: nil)
        }
        #endif
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
            }
        }
        .foregroundStyle(HudColors.hudDim)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HudColors.void.opacity(0.65))
    }
}
