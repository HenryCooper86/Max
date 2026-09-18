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
    var hudCast: HUDCastClient? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var followsRider = true
    @State private var showsSteps = false

    init(guidance: GuidanceState, music: MusicPlaybackModel? = nil, initiallyShowsSteps: Bool = false, hudCast: HUDCastClient? = nil) {
        self.guidance = guidance
        self.music = music
        self.hudCast = hudCast
        _showsSteps = State(initialValue: initiallyShowsSteps)
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                if geometry.size.width > geometry.size.height * 1.2 {
                    HStack(spacing: 12) {
                        map
                        ScrollView {
                            VStack(spacing: 10) {
                                maneuver(compact: true)
                                tripSummary(compact: true)
                                musicPanel
                            }
                        }.frame(width: min(340, geometry.size.width * 0.42))
                    }.padding(12)
                } else {
                    // Intrinsic text and music heights must never compress the map
                    // into neighboring controls, including when route steps expand.
                    ScrollView {
                        VStack(spacing: 12) {
                            maneuver()
                            map.frame(height: max(240, min(420, geometry.size.height * 0.48)))
                            tripSummary()
                            musicPanel
                        }.padding(12)
                    }
                }
            }
            .background(HudColors.void)
            .navigationTitle(guidance.destinationName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let music {
                        Button { Task { await music.chooseMusic() } } label: {
                            Label("音乐", systemImage: "music.note")
                        }.accessibilityIdentifier("navigationChooseMusic")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if let hudCast { HUDCastControl(client: hudCast) }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("收起") { dismiss() } }
            }
        }
    }

    private func maneuver(compact: Bool = false) -> some View {
        HStack(spacing: 16) {
            Image(systemName: navigationManeuverSymbol(guidance.maneuverInstruction ?? ""))
                .font(.system(size: compact ? 32 : 42, weight: .bold))
                .frame(width: compact ? 44 : 58, height: compact ? 48 : 64)
                .foregroundStyle(guidance.offRoute ? HudColors.amber : HudColors.lume)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(guidance.offRoute ? "重新规划中" : navigationDistance(guidance.distanceToManeuverMeters) + " 后")
                    .font(compact ? .title2.bold() : .largeTitle.bold()).monospacedDigit()
                Text(guidance.maneuverInstruction ?? "沿路线前往目的地")
                    .font(.headline).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(compact ? 12 : 16)
        .background(HudColors.panelElevated, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }

    private var map: some View {
        GuidanceMapHost(guidance: guidance, interactive: true, followsRider: followsRider)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topTrailing) {
                Button { followsRider.toggle() } label: {
                    Label(followsRider ? "全程" : "跟随位置",
                          systemImage: followsRider ? "map" : "location.fill")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14).frame(minHeight: 48)
                        .background(.regularMaterial, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(followsRider ? "查看全程路线" : "返回并跟随当前位置")
                .padding(12)
            }
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .accessibilityIdentifier("ridingNavigationMap")
    }

    private func tripSummary(compact: Bool = false, stepsHeight: CGFloat = 160) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(Int(ceil(guidance.remainingSeconds / 60))) 分钟")
                        .font(.title2.bold()).foregroundStyle(HudColors.lume)
                    Text("\(navigationDistance(guidance.remainingDistanceMeters)) · 剩余")
                        .font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Date().addingTimeInterval(guidance.remainingSeconds), style: .time)
                        .font(.title3.weight(.semibold)).monospacedDigit()
                    Text("预计到达").font(.caption).foregroundStyle(.secondary)
                }
                Button { showsSteps.toggle() } label: {
                    Image(systemName: showsSteps ? "chevron.down" : "list.bullet")
                        .frame(width: 48, height: 48)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsSteps ? "收起路线步骤" : "展开路线步骤")
                .accessibilityValue(showsSteps ? "已展开" : "已收起")
            }
            if showsSteps {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if guidance.upcomingSteps.isEmpty {
                            Text("暂无更多路口信息，请按当前路线行驶。").foregroundStyle(.secondary)
                        }
                        ForEach(guidance.upcomingSteps) { detail in
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: navigationManeuverSymbol(detail.step.instruction)).frame(width: 24)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(detail.step.instruction).font(.subheadline)
                                    Text("距当前位置 \(navigationDistance(detail.distanceMeters))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                // A maximum alone lets the map compress this viewport to zero.
                .frame(height: stepsHeight)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(compact ? 8 : 12)
        .background(HudColors.panelElevated, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder private var musicPanel: some View {
        if let music { NavigationMusicPanel(model: music) }
    }
}

/// The same player and picker remain reachable without leaving navigation.
private struct NavigationMusicPanel: View {
    @ObservedObject var model: MusicPlaybackModel
    var body: some View {
        if model.visible { MusicPlaybackCard(model: model, compact: true) }
    }
}
