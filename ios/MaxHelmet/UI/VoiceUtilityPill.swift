import SwiftUI

let muteUtilityMinimumHitHeight: CGFloat = 44

struct MuteUtilityPill: View {
    let muted: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VisorPillLabel(
                icon: muted ? "mic.slash.fill" : "mic.fill",
                label: muted ? L("pill.unmute") : L("pill.mute"),
                active: muted,
                tint: Visor.warn
            )
        }
        .buttonStyle(.plain)
        .frame(minHeight: muteUtilityMinimumHitHeight)
        .contentShape(Rectangle())
        .accessibilityLabel(muted ? L("pill.unmute") : L("pill.mute"))
        .accessibilityIdentifier(HudAccessibilityID.muteUtility)
    }
}
