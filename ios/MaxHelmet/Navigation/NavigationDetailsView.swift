import SwiftUI

func navigationManeuverSymbol(_ instruction: String) -> String {
    let text = instruction.lowercased()
    if text.contains("掉头") || text.contains("u-turn") { return "arrow.uturn.left" }
    if text.contains("左") || text.contains("left") { return "arrow.turn.up.left" }
    if text.contains("右") || text.contains("right") { return "arrow.turn.up.right" }
    if text.contains("到达") || text.contains("destination") { return "flag.checkered" }
    return "arrow.up"
}

func navigationDistance(_ meters: Double, rounding: FloatingPointRoundingRule = .toNearestOrAwayFromZero) -> String {
    meters >= 1000
        ? L("nav.km", ("v", String(format: "%.1f", meters / 1000)))
        : L("nav.m", ("v", String(Int(max(0, meters).rounded(rounding)))))
}

/// "6 分钟 · 1.4 公里" / "6 min · 1.4 km".
func navigationETA(_ guidance: GuidanceState) -> String {
    L("nav.eta",
      ("min", String(Int((guidance.remainingSeconds / 60).rounded()))),
      ("km", String(format: "%.1f", guidance.remainingDistanceMeters / 1000)))
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
            .background(Visor.bg)
            .navigationTitle(guidance.destinationName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Visor.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let music {
                        Button { Task { await music.chooseMusic() } } label: {
                            Label(L("nav.music"), systemImage: "music.note")
                        }.accessibilityIdentifier("navigationChooseMusic")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if let hudCast { HUDCastControl(client: hudCast) }
                }
                ToolbarItem(placement: .topBarTrailing) { Button(L("nav.collapse")) { dismiss() } }
            }
        }
        .tint(Visor.accent)
        .presentationBackground(Visor.bg)
        .presentationCornerRadius(Visor.Radius.sheet)
    }

    private func maneuver(compact: Bool = false) -> some View {
        HStack(spacing: 16) {
            Image(systemName: navigationManeuverSymbol(guidance.maneuverOriginalInstruction ?? guidance.maneuverInstruction ?? ""))
                .font(.system(size: compact ? 32 : 42, weight: .bold))
                .frame(width: compact ? 44 : 58, height: compact ? 48 : 64)
                .foregroundStyle(guidance.offRoute ? Visor.warn : Visor.accent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(guidance.offRoute ? L("nav.reroutingShort") : L("nav.after", ("dist", navigationDistance(guidance.distanceToManeuverMeters))))
                    .visorFont(compact ? .title : .display, .bold, mono: true)
                    .foregroundStyle(Visor.text)
                Text(guidance.maneuverInstruction ?? L("nav.routeToDestination"))
                    .visorFont(.body, .semibold).foregroundStyle(Visor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(compact ? 12 : 16)
        .background(Visor.surface1, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous).strokeBorder(Visor.line, lineWidth: Visor.hairline))
        .accessibilityElement(children: .combine)
    }

    private var map: some View {
        GuidanceMapHost(guidance: guidance, interactive: true, followsRider: followsRider)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topTrailing) {
                Button { followsRider.toggle() } label: {
                    Label(followsRider ? L("nav.full") : L("nav.follow"),
                          systemImage: followsRider ? "map" : "location.fill")
                        .visorFont(.footnote, .semibold)
                        .foregroundStyle(Visor.text)
                        .padding(.horizontal, Visor.Space.s4).frame(minHeight: 48)
                        .background(Visor.surface2, in: Capsule())
                        .overlay(Capsule().strokeBorder(Visor.lineStrong, lineWidth: Visor.hairline))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(followsRider ? L("nav.a11y.showFull") : L("nav.a11y.followBack"))
                .padding(12)
            }
            .clipShape(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
            .accessibilityIdentifier("ridingNavigationMap")
    }

    private func tripSummary(compact: Bool = false, stepsHeight: CGFloat = 160) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("nav.min", ("v", String(Int(ceil(guidance.remainingSeconds / 60))))))
                        .visorFont(.title, .bold, mono: true).foregroundStyle(Visor.accent)
                    Text(L("nav.remaining", ("dist", navigationDistance(guidance.remainingDistanceMeters))))
                        .visorFont(.caption).foregroundStyle(Visor.textSecondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Date().addingTimeInterval(guidance.remainingSeconds), style: .time)
                        .visorFont(.body, .semibold, mono: true).foregroundStyle(Visor.text)
                    Text(L("nav.eta.arrival")).visorFont(.caption).foregroundStyle(Visor.textSecondary)
                }
                Button { showsSteps.toggle() } label: {
                    Image(systemName: showsSteps ? "chevron.down" : "list.bullet")
                        .frame(width: 48, height: 48)
                        .foregroundStyle(Visor.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsSteps ? L("nav.steps.hide") : L("nav.steps.show"))
                .accessibilityValue(showsSteps ? L("nav.steps.expanded") : L("nav.steps.collapsed"))
            }
            if showsSteps {
                VisorDivider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if guidance.upcomingSteps.isEmpty {
                            Text(L("nav.steps.none")).visorFont(.footnote).foregroundStyle(Visor.textSecondary)
                        }
                        ForEach(guidance.upcomingSteps) { detail in
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: navigationManeuverSymbol(detail.step.instruction)).frame(width: 24).foregroundStyle(Visor.textSecondary)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(detail.step.displayInstruction).visorFont(.subhead).foregroundStyle(Visor.text)
                                    Text(L("nav.steps.from", ("dist", navigationDistance(detail.distanceMeters))))
                                        .visorFont(.caption, mono: true).foregroundStyle(Visor.textSecondary)
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
        .background(Visor.surface1, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous).strokeBorder(Visor.line, lineWidth: Visor.hairline))
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
