import Observation
import SwiftUI

// MARK: - Visor design system
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
        case .helmet: return L("device.helmet")
        case .glasses: return L("device.glasses")
        case .other: return L("device.other")
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
    /// One of the relay's device presets ("motorcycle-helmet", "vr-headset", ...).
    var deviceProfile: String?
    var deviceLabel: String?
    /// Design template id the owner chose.
    var template: String?
    /// False when the owner pinned the template.
    var templateSwitching: Bool?
    /// Raw token overrides; only `accent` and `radius-*` are honoured.
    var theme: [String: String]?
    /// A path on the relay, e.g. "/brand/logo?v=abc".
    var logoUrl: String?
    /// Voice display style the owner chose (validated against `VoiceVisualizer`).
    var visualizer: String?
}

@Observable
final class VisorTheme {
    static let shared = VisorTheme()
    static let defaultAccentHex: UInt32 = 0xC6F432
    static let defaultAssistantName = "Max"
    /// UserDefaults key for the wearer's own template choice.
    static let viewerTemplateKey = "visor_template"
    static let viewerVisualizerKey = "visor_visualizer"
    static let languageKey = "app_language"

    /// The resolved design tokens every `Visor.*` reads. Replaced whenever an
    /// input changes, so views that read a token re-render.
    private(set) var appearance = VisorAppearance.default

    var assistantName: String = VisorTheme.defaultAssistantName
    var deviceKind: DeviceKind = .helmet
    var deviceProfile: String?
    var deviceLabel: String?
    var wakePhrase: String?

    /// The relay's own logo when it serves a PNG (nil: use the bundled mark).
    private(set) var customLogo: UIImage?
    /// "<relay><path>" of the last logo request, so a health refresh does not refetch.
    var logoAttemptKey: String?

    private var relayTemplate: String?
    private var templateSwitching: Bool?
    private var themeOverrides: [String: String]?
    private var relayAccent: String?
    private(set) var viewerTemplate: String?
    private var relayVisualizer: String?
    private(set) var viewerVisualizer: String?
    /// The resolved voice display style.
    private(set) var visualizer: VoiceVisualizer = .default

    /// The wearer's language setting and the language it resolves to.
    private(set) var languageChoice: AppLanguageChoice = .system
    private(set) var language: AppLanguage = .zh

    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        viewerTemplate = VisorTemplate.find(defaults.string(forKey: Self.viewerTemplateKey))?.id
        viewerVisualizer = VoiceVisualizer.parse(defaults.string(forKey: Self.viewerVisualizerKey))?.rawValue
        languageChoice = AppLanguageChoice(rawValue: defaults.string(forKey: Self.languageKey) ?? "") ?? .system
        language = Loc.resolve(choice: languageChoice)
        #if DEBUG
        // Screenshot aid: `--debug-template daylight --debug-visualizer ring`
        // (not persisted).
        let args = ProcessInfo.processInfo.arguments
        if defaults === UserDefaults.standard {
            if let i = args.firstIndex(of: "--debug-template"), i + 1 < args.count {
                viewerTemplate = VisorTemplate.find(args[i + 1])?.id ?? viewerTemplate
            }
            if let i = args.firstIndex(of: "--debug-language"), i + 1 < args.count,
               let c = AppLanguageChoice(rawValue: args[i + 1]) {
                languageChoice = c
                language = Loc.resolve(choice: c)
            }
            if let i = args.firstIndex(of: "--debug-visualizer"), i + 1 < args.count {
                viewerVisualizer = VoiceVisualizer.parse(args[i + 1])?.rawValue ?? viewerVisualizer
            }
        }
        #endif
        recompute()
    }

    var accent: Color { appearance.color("accent").color }
    var template: VisorTemplate { appearance.template }
    /// False when the owner pinned the template: the picker is read-only.
    var canSwitchTemplate: Bool { templateSwitching != false }
    /// The device's name for the active language. The relay writes `deviceLabel`
    /// in its own language; when that is not the UI language and the profile is
    /// a built-in one, the client's own name is used (as the web does).
    var deviceDisplayName: String {
        guard let label = deviceLabel else { return deviceKind.noun }
        let hasHan = label.range(of: "[\\u4e00-\\u9fff]", options: .regularExpression) != nil
        if (language == .zh) == hasHan { return label }
        if let profile = deviceProfile, DeviceMark(rawValue: profile) != nil {
            return L("dev.p." + profile, in: language)
        }
        return label
    }
    var deviceMark: DeviceMark { DeviceMark.resolve(profile: deviceProfile, kind: deviceKind) }

    private func recompute() {
        visualizer = VoiceVisualizer.resolve(relay: relayVisualizer, viewer: viewerVisualizer, templateSwitching: templateSwitching)
        appearance = VisorAppearance.resolve(VisorAppearanceInput(
            relayTemplate: relayTemplate,
            viewerTemplate: viewerTemplate,
            templateSwitching: templateSwitching,
            theme: themeOverrides,
            accentColor: relayAccent
        ))
    }

    /// The wearer's pick from Settings, persisted. `nil` clears it.
    func selectTemplate(_ id: String?) {
        let valid = VisorTemplate.find(id)?.id
        viewerTemplate = valid
        if let valid { defaults.set(valid, forKey: Self.viewerTemplateKey) }
        else { defaults.removeObject(forKey: Self.viewerTemplateKey) }
        recompute()
    }

    /// The wearer's voice display pick, persisted. `nil` clears it.
    func selectVisualizer(_ v: VoiceVisualizer?) {
        viewerVisualizer = v?.rawValue
        if let v { defaults.set(v.rawValue, forKey: Self.viewerVisualizerKey) }
        else { defaults.removeObject(forKey: Self.viewerVisualizerKey) }
        recompute()
    }

    /// The wearer's language pick (跟随系统 / 中文 / English), persisted and applied live.
    func selectLanguage(_ choice: AppLanguageChoice) {
        languageChoice = choice
        if choice == .system { defaults.removeObject(forKey: Self.languageKey) }
        else { defaults.set(choice.rawValue, forKey: Self.languageKey) }
        language = Loc.resolve(choice: choice)
    }

    func setCustomLogo(_ image: UIImage?) { customLogo = image }

    /// Parses `#RRGGBB` (the leading `#` is optional). Anything else is nil.
    static func parseHex(_ text: String) -> UInt32? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return v
    }

    /// Applies whichever branding fields are present and valid; the rest keep
    /// their current value. Template fields are authoritative: a relay that
    /// does not send them means "default template". Safe to call from any
    /// thread's completion that has hopped to main.
    func apply(_ branding: AssistantBranding) {
        if let name = branding.name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty, name.count <= 24 {
            assistantName = name
        }
        if let device = branding.device, let kind = DeviceKind(rawValue: device.lowercased()) {
            deviceKind = kind
        }
        deviceProfile = branding.deviceProfile?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        deviceLabel = branding.deviceLabel?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        if let wake = branding.wakePhrase?.trimmingCharacters(in: .whitespacesAndNewlines) {
            wakePhrase = wake.isEmpty ? nil : wake
        }
        if let hex = branding.accentColor, VisorRGBA(hexString: hex) != nil {
            relayAccent = hex
        }
        relayTemplate = branding.template
        templateSwitching = branding.templateSwitching
        themeOverrides = branding.theme
        relayVisualizer = branding.visualizer
        recompute()
    }

    func reset() {
        assistantName = Self.defaultAssistantName
        deviceKind = .helmet
        deviceProfile = nil
        deviceLabel = nil
        wakePhrase = nil
        relayTemplate = nil
        templateSwitching = nil
        themeOverrides = nil
        relayVisualizer = nil
        relayAccent = nil
        customLogo = nil
        logoAttemptKey = nil
        recompute()
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// The design tokens of the active template. Every getter reads the observable
/// theme, so a view that calls one inside `body` re-renders when the template,
/// the relay branding or the wearer's choice changes.
enum Visor {
    private static var a: VisorAppearance { VisorTheme.shared.appearance }
    private static func c(_ token: String) -> Color { a.color(token).color }

    // Surfaces - flat fills only.
    static var bg: Color { c("bg") }
    static var surface1: Color { c("surface-1") }
    static var surface2: Color { c("surface-2") }
    static var surface3: Color { c("surface-3") }

    // Lines - the template's stroke width (1pt; 2pt in beacon).
    static var line: Color { c("line") }
    static var lineStrong: Color { c("line-strong") }
    static var hairline: CGFloat { CGFloat(a.length("line-w")) }

    // Text.
    static var text: Color { c("text") }
    static var textSecondary: Color { c("text-2") }
    static var textTertiary: Color { c("text-3") }

    // Accent - a runtime value, never a constant.
    static var accent: Color { c("accent") }
    static var accentSoft: Color { c("accent-soft") }
    static var onAccent: Color { c("on-accent") }

    // Semantic.
    static var user: Color { c("user") }
    static var userSoft: Color { c("user-soft") }
    static var danger: Color { c("danger") }
    static var dangerSoft: Color { c("danger-soft") }
    static var onDanger: Color { c("on-danger") }
    static var warn: Color { c("warn") }
    static var warnSoft: Color { c("warn-soft") }
    static var onWarn: Color { c("on-warn") }
    static var ok: Color { c("ok") }
    static var okSoft: Color { c("ok-soft") }

    /// A tinted wash of any status colour at the template's soft opacity.
    static func soft(_ color: Color) -> Color { color.opacity(a.template.softAlpha) }

    /// The vignette strength behind the visor (0 in beacon).
    static var glow: Double { a.number("glow") }
    /// How far disabled controls fade.
    static var disabledOpacity: Double { a.number("disabled-opacity") }
    /// The colour scheme system chrome (sheets, bars, status bar) should use.
    static var colorScheme: ColorScheme { a.template.scheme }
    static var templateID: String { a.template.id }
    static var visualizer: VoiceVisualizer { VisorTheme.shared.visualizer }

    // Branding passthroughs so views have one import for everything.
    static var assistantName: String { VisorTheme.shared.assistantName }
    static var deviceKind: DeviceKind { VisorTheme.shared.deviceKind }
    static var wakePhrase: String? { VisorTheme.shared.wakePhrase }

    enum Radius {
        static var control: CGFloat { CGFloat(Visor.a.length("radius-control")) }
        static var card: CGFloat { CGFloat(Visor.a.length("radius-card")) }
        static var sheet: CGFloat { CGFloat(Visor.a.length("radius-sheet")) }
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

    fileprivate static func length(_ token: String) -> CGFloat { CGFloat(a.length(token)) }
}

// MARK: - type

/// SF Pro text scale (the active template sets the sizes; beacon is larger);
/// SF Mono only for numbers, timings and ids (`mono: true`).
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
        case .caption: return Visor.length("fs-12")
        case .footnote: return Visor.length("fs-13")
        case .subhead: return Visor.length("fs-15")
        case .body: return Visor.length("fs-17")
        case .title: return Visor.length("fs-22")
        case .display: return Visor.length("fs-32")
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
