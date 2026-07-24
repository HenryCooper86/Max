import MapKit
import SwiftUI

/// A glanceable destination readout. Deliberately not a navigation view: no
/// heading, no maneuver list, no rerouting. It answers "where is it and how far"
/// and nothing more.
struct DestinationCard: View {
    let destination: Destination

    private var distanceText: String {
        String(format: "%.1f 公里", destination.distanceMeters / 1000)
    }

    private var etaText: String {
        "\(Int((destination.etaSeconds / 60).rounded())) 分钟"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Map(initialPosition: .region(MKCoordinateRegion(
                center: destination.coordinate,
                latitudinalMeters: 1_200,
                longitudinalMeters: 1_200
            ))) {
                Marker(destination.name, coordinate: destination.coordinate)
                    .tint(HudColors.ember)
            }
            .frame(height: 150)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .allowsHitTesting(false)

            Text(destination.name)
                .font(.headline)
                .foregroundStyle(HudColors.hudInk)

            HStack(spacing: 14) {
                Label(distanceText, systemImage: "arrow.triangle.turn.up.right.diamond")
                Label(etaText, systemImage: "clock")
            }
            .font(.subheadline)
            .foregroundStyle(HudColors.hudDim)
        }
        .padding(14)
        .background(HudColors.panelElevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HudColors.border, lineWidth: 1)
        )
        .frame(maxWidth: 420)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("目的地 \(destination.name)，距离 \(distanceText)，约 \(etaText)")
    }
}
