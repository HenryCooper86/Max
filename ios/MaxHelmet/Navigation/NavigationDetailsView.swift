import SwiftUI

func navigationManeuverSymbol(_ instruction: String) -> String {
    let text = instruction.lowercased()
    if text.contains("掉头") || text.contains("u-turn") { return "arrow.uturn.left" }
    if text.contains("左") || text.contains("left") { return "arrow.turn.up.left" }
    if text.contains("右") || text.contains("right") { return "arrow.turn.up.right" }
    if text.contains("到达") || text.contains("destination") { return "flag.checkered" }
    return "arrow.up"
}

func navigationDistance(_ meters: Double) -> String {
    meters >= 1000 ? String(format: "%.1f 公里", meters / 1000) : "\(Int(max(0, meters).rounded())) 米"
}

struct NavigationDetailsView: View {
    let guidance: GuidanceState
    var music: MusicPlaybackModel? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var followsRider = true

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(alignment: .top, spacing: 16) {
                            Image(systemName: navigationManeuverSymbol(guidance.maneuverInstruction ?? ""))
                                .font(.system(size: 34, weight: .bold)).foregroundStyle(HudColors.lume)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(guidance.offRoute ? "偏离路线，正在重新规划…" : navigationDistance(guidance.distanceToManeuverMeters) + " 后")
                                    .font(.title2.bold())
                                Text(guidance.maneuverInstruction ?? "沿路线前往目的地").font(.headline).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Text("前往 \(guidance.destinationName)").font(.headline)
                        HStack {
                            Text("剩余 \(navigationDistance(guidance.remainingDistanceMeters)) · \(Int(ceil(guidance.remainingSeconds / 60))) 分钟")
                            Spacer()
                            Text(Date().addingTimeInterval(guidance.remainingSeconds), style: .time)
                            Text("到达")
                        }.font(.subheadline)
                        GuidanceMapHost(guidance: guidance, interactive: true, followsRider: followsRider)
                            .frame(height: max(220, min(440, geometry.size.height * 0.48)))
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                        Picker("地图视角", selection: $followsRider) {
                            Text("跟随位置").tag(true)
                            Text("全程 · 自由浏览").tag(false)
                        }.pickerStyle(.segmented)
                        Text(followsRider ? "地图随位置更新，显示附近道路和下一路口。" : "可双指缩放、拖动地图，点击标记查看说明。")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("接下来的路线").font(.title3.bold())
                        if guidance.upcomingSteps.isEmpty {
                            Text("暂无更多路口信息，请按当前路线行驶。").foregroundStyle(.secondary)
                        }
                        ForEach(guidance.upcomingSteps) { detail in
                            HStack(alignment: .top, spacing: 14) {
                                Image(systemName: navigationManeuverSymbol(detail.step.instruction)).frame(width: 28)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(detail.step.instruction).fixedSize(horizontal: false, vertical: true)
                                    Text("距当前位置 \(navigationDistance(detail.distanceMeters))").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                            }.padding(.vertical, 8)
                            Divider()
                        }
                    }.padding(20)
                }
            }
            .navigationTitle("详细导航")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                if let music { NavigationMusicPanel(model: music) }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let music {
                        Button { Task { await music.chooseMusic() } } label: {
                            Label("音乐", systemImage: "music.note")
                        }
                        .accessibilityIdentifier("navigationChooseMusic")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("收起") { dismiss() } }
            }
        }
    }
}


/// Observe the same player as the main HUD so voice requests appear immediately
/// above the map sheet, and the library picker presents from this visible sheet.
private struct NavigationMusicPanel: View {
    @ObservedObject var model: MusicPlaybackModel

    var body: some View {
        if model.visible {
            MusicPlaybackCard(model: model)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial)
        }
    }
}
