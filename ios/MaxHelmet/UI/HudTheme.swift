import Observation
import SwiftUI

// MARK: - Visor design system (dark only)
//
// The single source of visual tokens. The web and Android clients implement the
// same spec, so values here are deliberately literal. Views never hard-code a
// colour, radius, spacing or type size: they read `Visor.*`.
//
// Branding is runtime data. `VisorTheme` is an @Observable object, so any view
// that reads `Visor.accent` (or `Visor.assistantName`) inside its `body`
// re-renders when the relay /health branding or a future settings screen
// changes it.

/// What the assistant is worn as. Only changes nouns and glyphs, never layout.
enum DeviceKind: String, CaseIterable, Equatable {
    case helmet, glasses, other

    init(wire: String?) {
        self = DeviceKind(rawValue: (wire ?? "").lowercased()) ?? .helmet
    }

    /// Short noun for UI copy ("头盔" / "眼镜" / "设备").
    var noun: String {
        switch self {
        case .helmet: return "头盔"
        case .glasses: return "眼镜"
        case .other: return "设备"
        }
    }

    /// SF Symbol for settings rows about the wearable itself.
    var symbol: String {
        switch self {
        case .helmet: return "shield.lefthalf.filled"
        case .glasses: return "eyeglasses"
        case .other: return "dot.radiowaves.left.and.right"
        }
    }
}

/// Branding fields the relay may advertise under `/health.assistant`.
struct AssistantBranding: Equatable {
    var name: String?
    var device: String?
    var wakePhrase: String?
    var accentColor: String?
}

@Observable
final class VisorTheme {
    static let shared = VisorTheme()
    static let defaultAccentHex: UInt32 = 0xC6F432
    static let defaultAssistantName = "Max"

    var accent: Color = Color(hex: VisorTheme.defaultAccentHex)
    var assistantName: String = VisorTheme.defaultAssistantName
    var deviceKind: DeviceKind = .helmet
    var wakePhrase: String?

    init() {}

    /// Parses `#RRGGBB` (the leading `#` is optional). Anything else is nil.
    static func parseHex(_ text: String) -> UInt32? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return v
    }

    /// Applies whichever branding fields are present and valid; the rest keep
    /// their current value. Safe to call from any thread's completion that has
    /// hopped to main.
    func apply(_ branding: AssistantBranding) {
        if let name = branding.name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty, name.count <= 24 {
            assistantName = name
        }
        if let device = branding.device, let kind = DeviceKind(rawValue: device.lowercased()) {
            deviceKind = kind
        }
        if let wake = branding.wakePhrase?.trimmingCharacters(in: .whitespacesAndNewlines) {
            wakePhrase = wake.isEmpty ? nil : wake
        }
        if let hex = branding.accentColor.flatMap(Self.parseHex) {
            accent = Color(hex: hex)
        }
    }

    func reset() {
        accent = Color(hex: Self.defaultAccentHex)
        assistantName = Self.defaultAssistantName
        deviceKind = .helmet
        wakePhrase = nil
    }
}

enum Visor {
    // Surfaces — flat fills only.
    static let bg = Color(hex: 0x0B0C0E)
    static let surface1 = Color(hex: 0x131518)
    static let surface2 = Color(hex: 0x1A1D21)
    static let surface3 = Color(hex: 0x23272C)

    // Lines — 1pt hairlines.
    static let line = Color.white.opacity(0.08)
    static let lineStrong = Color.white.opacity(0.14)
    static let hairline: CGFloat = 1

    // Text.
    static let text = Color(hex: 0xF2F4F5)
    static let textSecondary = Color(hex: 0xA3ABB3)
    static let textTertiary = Color(hex: 0x6B737C)

    // Accent — a runtime value, never a constant.
    static var accent: Color { VisorTheme.shared.accent }
    static var accentSoft: Color { VisorTheme.shared.accent.opacity(0.14) }
    static let onAccent = Color(hex: 0x0B0C0E)

    // Semantic.
    static let user = Color(hex: 0xFF7A45)
    static let danger = Color(hex: 0xFF5A4D)
    static let warn = Color(hex: 0xFFC53D)
    static let ok = Color(hex: 0x3DDC97)

    // Branding passthroughs so views have one import for everything.
    static var assistantName: String { VisorTheme.shared.assistantName }
    static var deviceKind: DeviceKind { VisorTheme.shared.deviceKind }
    static var wakePhrase: String? { VisorTheme.shared.wakePhrase }

    enum Radius {
        static let control: CGFloat = 10
        static let card: CGFloat = 16
        static let sheet: CGFloat = 24
    }

    /// 4pt spacing scale.
    enum Space {
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 20
        static let s6: CGFloat = 24
        static let s8: CGFloat = 32
    }

    enum Motion {
        static let fast: Double = 0.16
        static let standard: Double = 0.20
        static let slow: Double = 0.24
        static var ease: Animation { .easeOut(duration: standard) }
    }

    /// Minimum hit target on both axes.
    static let hit: CGFloat = 44
}

// MARK: - type

/// SF Pro text scale; SF Mono only for numbers, timings and ids (`mono: true`).
enum VisorTextStyle {
    case caption    // 12
    case footnote   // 13
    case subhead    // 15
    case body       // 17
    case title      // 22
    case display    // 32
    case alarm      // 44 — the crash alarm only

    var size: CGFloat {
        switch self {
        case .caption: return 12
        case .footnote: return 13
        case .subhead: return 15
        case .body: return 17
        case .title: return 22
        case .display: return 32
        case .alarm: return 44
        }
    }

    var relativeTo: Font.TextStyle {
        switch self {
        case .caption: return .caption
        case .footnote: return .footnote
        case .subhead: return .subheadline
        case .body: return .body
        case .title: return .title2
        case .display, .alarm: return .largeTitle
        }
    }
}

private struct VisorFontModifier: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    let mono: Bool

    init(style: VisorTextStyle, weight: Font.Weight, mono: Bool) {
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.relativeTo)
        self.weight = weight
        self.mono = mono
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: mono ? .monospaced : .default))
    }
}

extension View {
    /// Applies a Visor text style that scales with Dynamic Type.
    func visorFont(_ style: VisorTextStyle, _ weight: Font.Weight = .regular, mono: Bool = false) -> some View {
        modifier(VisorFontModifier(style: style, weight: weight, mono: mono))
    }

    /// easeOut 0.16–0.24s, or no animation under Reduce Motion.
    func visorAnimation<V: Equatable>(_ value: V, duration: Double = Visor.Motion.standard) -> some View {
        modifier(VisorAnimationModifier(value: value, duration: duration))
    }
}

private struct VisorAnimationModifier<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let value: V
    let duration: Double

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : .easeOut(duration: duration), value: value)
    }
}

// MARK: - colour plumbing

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

/// Compatibility shim for navigation views outside the redesign's ownership
/// (GuidanceMapHost). New code must use `Visor`.
enum HudColors {
    static var void: Color { Visor.bg }
    static var hudDim: Color { Visor.textSecondary }
}
