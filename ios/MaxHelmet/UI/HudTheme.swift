import SwiftUI

/// Design tokens ported from src/styles.css (:root variables) and
/// android/.../ui/theme/Theme.kt.
enum HudColors {
    static let background = Color(hex: 0x101415)
    static let text = Color(hex: 0xEFF6F8)
    static let muted = Color(hex: 0xA7B8B6)
    static let accent = Color(hex: 0x3EE89F)
    static let accentCyan = Color(hex: 0x5FE9D6)
    static let rider = Color(hex: 0xF26A3D)
    static let danger = Color(hex: 0xFF6F57)
    static let warn = Color(hex: 0xF2C14E)
    static let panel = Color(hex: 0x0B1112, alpha: 0.8)
    /// Softer raised surface for borderless cards (modern, production look).
    static let panelElevated = Color(hex: 0x181F20)
    static let border = Color(hex: 0xC4DAD8, alpha: 0.16)
    /// Button label on accent backgrounds (Android onPrimary).
    static let onAccent = Color(hex: 0x07221A)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}
