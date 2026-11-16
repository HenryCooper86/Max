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
                    Text("高德地图与隐私")
                        .visorFont(.title, .semibold)
                        .foregroundStyle(Visor.text)
                        .accessibilityAddTraits(.isHeader)
                    Text("导航卡片使用高德地图（AMap）显示路线与当前位置。启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求；\(Visor.assistantName) 仍使用现有位置与路线数据，不启用高德定位服务。")
                        .visorFont(.subhead)
                        .foregroundStyle(Visor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Link(
                        "查看高德地图隐私政策",
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
                    Button("同意并启用", action: onAccept)
                        .buttonStyle(.visor(.primary))
                    Button("暂不启用", action: onDecline)
                        .buttonStyle(.visor(.secondary))
                }
                .padding(.horizontal, Visor.Space.s6)
                .padding(.vertical, Visor.Space.s4)
                .background(Visor.surface1)
                .overlay(alignment: .top) { VisorDivider() }
            }
            .navigationTitle("地图设置")
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
