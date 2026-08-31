import SwiftUI

struct AMapConsentSheet: View {
    let onAccept: () -> Void
    let onDecline: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("高德地图与隐私")
                        .font(.title2.bold())
                    Text("导航卡片使用高德地图（AMap）显示路线与当前位置。启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求；Max 仍使用现有位置与路线数据，不启用高德定位服务。")
                        .foregroundStyle(HudColors.hudDim)
                    Link(
                        "查看高德地图隐私政策",
                        destination: URL(string: "https://lbs.amap.com/pages/privacy/")!
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 12) {
                    Divider()
                    Button("同意并启用", action: onAccept)
                        .buttonStyle(.borderedProminent)
                        .tint(HudColors.lume)
                        .frame(maxWidth: .infinity)
                    Button("暂不启用", action: onDecline)
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
                .background(HudColors.panelElevated)
            }
            .navigationTitle("地图设置")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled()
    }
}
