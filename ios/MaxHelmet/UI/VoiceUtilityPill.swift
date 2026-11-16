import SwiftUI

let muteUtilityMinimumHitHeight: CGFloat = 44

struct MuteUtilityPill: View {
    let muted: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VisorPillLabel(
                icon: muted ? "mic.slash.fill" : "mic.fill",
                label: muted ? "取消静音" : "静音",
                active: muted,
                tint: Visor.warn
            )
        }
        .buttonStyle(.plain)
        .frame(minHeight: muteUtilityMinimumHitHeight)
        .contentShape(Rectangle())
        .accessibilityLabel(muted ? "取消静音" : "静音")
        .accessibilityIdentifier(HudAccessibilityID.muteUtility)
    }
}
