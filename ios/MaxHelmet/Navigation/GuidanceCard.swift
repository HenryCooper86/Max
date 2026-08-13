import SwiftUI

/// The live guidance surface, glanceable-first: the next maneuver and its
/// distance dominate; ETA and remaining distance sit below; the route map is
/// secondary. Replaces Spec 1's DestinationCard.
struct GuidanceCard: View {
    let guidance: GuidanceState

    private var distanceText: String {
        let m = guidance.distanceToManeuverMeters
        return m >= 1000 ? String(format: "%.1f 公里", m / 1000) : "\(Int(m)) 米"
    }

    private var etaText: String {
        "\(Int((guidance.remainingSeconds / 60).rounded())) 分钟 · \(String(format: "%.1f", guidance.remainingDistanceMeters / 1000)) 公里"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            guidanceSummary

            routeMap
                .frame(height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(14)
        .background(HudColors.panelElevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(HudColors.border, lineWidth: 1)
        )
        .frame(maxWidth: 420)
        .accessibilityElement(children: .contain)
    }

    private var guidanceSummary: some View {
        VStack(alignment: .leading, spacing: 10) {
            if guidance.offRoute {
                Text("重新规划中…")
                    .font(.headline)
                    .foregroundStyle(HudColors.amber)
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "arrow.turn.up.right")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(HudColors.lume)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(guidance.maneuverInstruction ?? guidance.destinationName)
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(HudColors.hudInk)
                        Text(distanceText)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(HudColors.hudDim)
                    }
                }
            }

            Text(etaText)
                .font(.subheadline)
                .foregroundStyle(HudColors.hudDim)
        }
        .accessibilityElement(children: .ignore)
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
