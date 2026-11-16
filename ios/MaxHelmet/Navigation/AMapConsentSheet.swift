import SwiftUI

struct AMapConsentSheet: View {
    let onAccept: () -> Void
    let onDecline: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Visor.Space.s4) {
                    Image(systemName: "map")
                        .font(.system(size: 28, weight: .regular))
                        .foregroundStyle(Visor.textSecondary)
                        .accessibilityHidden(true)
                    Text(L("amap.title"))
                        .visorFont(.title, .semibold)
                        .foregroundStyle(Visor.text)
                        .accessibilityAddTraits(.isHeader)
                    Text(L("amap.body", ("name", Visor.assistantName)))
                        .visorFont(.subhead)
                        .foregroundStyle(Visor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Link(
                        L("amap.policy"),
                        destination: URL(string: "https://lbs.amap.com/pages/privacy/")!
                    )
                    .visorFont(.subhead, .semibold)
                    .foregroundStyle(Visor.accent)
                    .frame(minHeight: Visor.hit)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Visor.Space.s6)
            }
            .background(Visor.bg)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: Visor.Space.s2) {
                    Button(L("amap.accept"), action: onAccept)
                        .buttonStyle(.visor(.primary))
                    Button(L("amap.decline"), action: onDecline)
                        .buttonStyle(.visor(.secondary))
                }
                .padding(.horizontal, Visor.Space.s6)
                .padding(.vertical, Visor.Space.s4)
                .background(Visor.surface1)
                .overlay(alignment: .top) { VisorDivider() }
            }
            .navigationTitle(L("amap.navTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Visor.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .tint(Visor.accent)
        .presentationBackground(Visor.bg)
        .presentationCornerRadius(Visor.Radius.sheet)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled()
    }
}
