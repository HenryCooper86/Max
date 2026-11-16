import SwiftUI

enum GuidanceCardAccessibilityChildPolicy: Equatable {
    case contain
    case ignore
    case combine
}

struct GuidanceCardAccessibilityContract: Equatable {
    let enclosingCardChildren: GuidanceCardAccessibilityChildPolicy
    let navigationSummaryChildren: GuidanceCardAccessibilityChildPolicy

    var keepsMapControlsSeparate: Bool {
        enclosingCardChildren == .contain && navigationSummaryChildren == .ignore
    }
}

let guidanceCardAccessibilityContract = GuidanceCardAccessibilityContract(
    enclosingCardChildren: .contain,
    navigationSummaryChildren: .ignore
)

private let guidanceCardMapHeight: CGFloat = 120
private let guidanceCardStackSpacing: CGFloat = 10
private let guidanceCardVerticalPadding: CGFloat = 14
/// The maneuver line, its distance, and the ETA row at default Dynamic Type.
/// Nominal on purpose: this layout never measures intrinsic text, and larger
/// type scrolls inside the viewport rather than resizing the allocation.
private let guidanceCardSummaryNominalHeight: CGFloat = 74

/// What the card wants when it shows the designed map, used by the HUD
/// allocation to size the viewport that holds it.
let guidanceCardNominalHeight: CGFloat =
    guidanceCardVerticalPadding * 2
        + guidanceCardSummaryNominalHeight
        + guidanceCardStackSpacing
        + guidanceCardMapHeight

enum GuidanceCardArrangement: Equatable {
    /// Map beneath the summary. Portrait has the height for it.
    case stacked
    /// Map beside the summary. Landscape has ~700 points of width and barely
    /// 200 of height, so stacking either clips the map or drops it.
    case sideBySide
}

func guidanceCardArrangement(for layout: HudLayout) -> GuidanceCardArrangement {
    switch layout {
    case .portrait: return .stacked
    case .landscape: return .sideBySide
    }
}

/// The map height that fits the viewport the card was actually granted.
///
/// Stacked, the map is whatever is left under the summary. Side by side it no
/// longer competes with the summary for height, so it takes the card's full
/// content height — which is how landscape recovers a readable map.
func guidanceMapHeight(forAlertViewport viewportHeight: CGFloat, layout: HudLayout) -> CGFloat {
    let outside = HudMetrics.topBarHeight
        + HudMetrics.alertStackSpacing
        + guidanceCardVerticalPadding * 2
    let budget: CGFloat
    switch guidanceCardArrangement(for: layout) {
    case .stacked:
        budget = viewportHeight - outside - guidanceCardSummaryNominalHeight - guidanceCardStackSpacing
    case .sideBySide:
        budget = viewportHeight - outside
    }
    guard budget >= guidanceCardMinimumMapHeight else { return 0 }
    return min(guidanceCardMapHeight, budget)
}

/// Below this the map reads as a smear of tiles rather than a route.
private let guidanceCardMinimumMapHeight: CGFloat = 48
/// Landscape gives the map a fixed column so the summary keeps a stable
/// measure rather than reflowing as distances change.
private let guidanceCardSideMapWidth: CGFloat = 300

private extension View {
    @ViewBuilder
    func applyingGuidanceCardAccessibilityPolicy(
        _ policy: GuidanceCardAccessibilityChildPolicy
    ) -> some View {
        switch policy {
        case .contain:
            accessibilityElement(children: .contain)
        case .ignore:
            accessibilityElement(children: .ignore)
        case .combine:
            accessibilityElement(children: .combine)
        }
    }
}

/// The live guidance surface, glanceable-first: the next maneuver and its
/// distance dominate; ETA and remaining distance sit below; the route map is
/// secondary. Replaces Spec 1's DestinationCard.
struct GuidanceCard: View {
    let guidance: GuidanceState
    /// Granted by the HUD allocation. Zero drops the map rather than clipping
    /// the card into the viewport below it.
    var mapHeight: CGFloat = guidanceCardMapHeight
    var arrangement: GuidanceCardArrangement = .stacked
    @State private var showingDetails = false
    var onConfirm: (UUID, Bool) -> Void = { _, _ in }
    var music: MusicPlaybackModel? = nil
    var hudCast: HUDCastClient? = nil
    var onDetailsPresentationChanged: (Bool) -> Void = { _ in }

    private var distanceText: String {
        let m = guidance.distanceToManeuverMeters
        return m >= 1000 ? String(format: "%.1f 公里", m / 1000) : "\(Int(m)) 米"
    }

    private var etaText: String {
        "\(Int((guidance.remainingSeconds / 60).rounded())) 分钟 · \(String(format: "%.1f", guidance.remainingDistanceMeters / 1000)) 公里"
    }

    var body: some View {
        content
            .padding(.vertical, guidanceCardVerticalPadding)
            .padding(.horizontal, Visor.Space.s4 - 2)
            .background(Visor.surface1, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                    .strokeBorder(Visor.line, lineWidth: Visor.hairline)
            )
            .frame(maxWidth: arrangement == .stacked ? 420 : .infinity)
            .applyingGuidanceCardAccessibilityPolicy(
                guidanceCardAccessibilityContract.enclosingCardChildren
            )
            .onAppear { if guidance.confirmationID == nil { showingDetails = true } }
            .onChange(of: guidance.confirmationID) { old, new in
                if old != nil && new == nil { showingDetails = true }
                if new != nil { showingDetails = false }
            }
            .onChange(of: showingDetails) { _, presented in onDetailsPresentationChanged(presented) }
            .onDisappear { onDetailsPresentationChanged(false) }
            .sheet(isPresented: $showingDetails) {
                NavigationDetailsView(guidance: guidance, music: music, hudCast: hudCast).presentationDetents([.large])
            }
    }

    @ViewBuilder
    private var content: some View {
        switch arrangement {
        case .stacked:
            VStack(alignment: .leading, spacing: guidanceCardStackSpacing) {
                summaryWithConfirmation
                map
            }
        case .sideBySide:
            HStack(alignment: .center, spacing: guidanceCardStackSpacing) {
                summaryWithConfirmation
                    .frame(maxWidth: .infinity, alignment: .leading)
                map
                    .frame(width: guidanceCardSideMapWidth)
            }
        }
    }

    private var summaryWithConfirmation: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let id = guidance.confirmationID {
                Text("确认目的地：\(guidance.destinationName)")
                    .visorFont(.body, .semibold).foregroundStyle(Visor.text)
                Text(etaText).visorFont(.subhead, mono: false).foregroundStyle(Visor.textSecondary)
                HStack(spacing: Visor.Space.s2) {
                    Button("取消") { onConfirm(id, false) }
                        .buttonStyle(.visor(.secondary))
                    Button("确认导航") { onConfirm(id, true) }
                        .buttonStyle(.visor(.primary))
                }
            } else { guidanceSummary }
        }
    }

    @ViewBuilder
    private var map: some View {
        if mapHeight > 0 {
            routeMap
                .frame(height: mapHeight)
                .clipShape(RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    if guidance.confirmationID == nil {
                        Button { showingDetails = true } label: {
                            Label("导航详情", systemImage: "arrow.up.left.and.arrow.down.right")
                                .visorFont(.footnote, .semibold)
                                .foregroundStyle(Visor.text)
                                .padding(.horizontal, Visor.Space.s3)
                                .frame(minHeight: Visor.hit)
                        }
                        .background(Visor.surface2, in: RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous).strokeBorder(Visor.lineStrong, lineWidth: Visor.hairline))
                        .padding(Visor.Space.s1)
                    }
                }
        } else if guidance.confirmationID == nil {
            Button("打开详细导航") { showingDetails = true }
                .buttonStyle(.visor(.plain, fullWidth: false))
        }
    }

    private var guidanceSummary: some View {
        VStack(alignment: .leading, spacing: 10) {
            if guidance.offRoute {
                Text("重新规划中…")
                    .visorFont(.body, .semibold)
                    .foregroundStyle(Visor.warn)
            } else {
                HStack(spacing: 12) {
                    Image(systemName: navigationManeuverSymbol(guidance.maneuverInstruction ?? ""))
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(Visor.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(guidance.maneuverInstruction ?? guidance.destinationName)
                            .visorFont(.title, .bold)
                            .foregroundStyle(Visor.text)
                        Text(distanceText)
                            .visorFont(.subhead, .semibold, mono: true)
                            .foregroundStyle(Visor.textSecondary)
                    }
                }
            }

            Text(etaText)
                .visorFont(.footnote, mono: true)
                .foregroundStyle(Visor.textSecondary)
        }
        .applyingGuidanceCardAccessibilityPolicy(
            guidanceCardAccessibilityContract.navigationSummaryChildren
        )
        .accessibilityLabel(guidanceCardAccessibilitySummary(guidance))
        .accessibilityAddTraits(.isStaticText)
    }

    private var routeMap: some View {
        GuidanceMapHost(guidance: guidance)
    }
}

func guidanceCardAccessibilitySummary(_ guidance: GuidanceState) -> String {
    let distance = guidance.distanceToManeuverMeters >= 1000
        ? String(format: "%.1f 公里", guidance.distanceToManeuverMeters / 1000)
        : "\(Int(guidance.distanceToManeuverMeters)) 米"
    let eta = "\(Int((guidance.remainingSeconds / 60).rounded())) 分钟 · \(String(format: "%.1f", guidance.remainingDistanceMeters / 1000)) 公里"
    return "导航 \(guidance.destinationName)，\(guidance.maneuverInstruction ?? "")，\(distance)，\(eta)"
}
