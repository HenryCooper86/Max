import SwiftUI

let muteUtilityMinimumHitHeight: CGFloat = 44

struct MuteUtilityPill: View {
    let muted: Bool
    let action: () -> Void

    var body: some View {
        let tint = muted ? HudColors.amber : HudColors.hudDim
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text(muted ? "取消静音" : "静音")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(tint)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Capsule().fill(muted ? HudColors.amber.opacity(0.16) : HudColors.panelElevated))
        }
        .buttonStyle(.plain)
        .frame(minHeight: muteUtilityMinimumHitHeight)
        .contentShape(Rectangle())
        .accessibilityLabel(muted ? "取消静音" : "静音")
        .accessibilityIdentifier(HudAccessibilityID.muteUtility)
    }
}
