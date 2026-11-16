import SwiftUI

// MARK: - Design templates
//
// A port of src/lib/templates.ts (+ color.ts, theme-tokens.ts). A template is a
// complete, named token set; `VisorAppearance.resolve` applies the precedence
// shared by every client:
//
//   built-in default (visor) -> relay `assistant.template` -> the wearer's own
//   choice (ignored when the owner pinned it) -> relay `theme` overrides
//   (accent + the three radius keys only) -> relay `accentColor`.
//
// Token names and values are the web's, so the three clients match. Fonts are
// not carried over: iOS uses the system face (SF Pro + PingFang SC).

// MARK: colour arithmetic

/// An sRGB colour with channels 0...255 and an alpha 0...1.
struct VisorRGBA: Equatable {
    var r: Double
    var g: Double
    var b: Double
    var a: Double = 1

    init(r: Double, g: Double, b: Double, a: Double = 1) {
        self.r = r; self.g = g; self.b = b; self.a = a
    }

    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            r: Double((hex >> 16) & 0xFF),
            g: Double((hex >> 8) & 0xFF),
            b: Double(hex & 0xFF),
            a: alpha
        )
    }

    /// Strict `#RRGGBB` (case-insensitive, surrounding whitespace ignored).
    init?(hexString text: String) {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("#"), let v = VisorTheme.parseHex(s), s.count == 7 else { return nil }
        self.init(hex: v)
    }

    var color: Color {
        Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a)
    }

    /// `#RRGGBB`, uppercase, ignoring alpha.
    var hexString: String {
        func h(_ v: Double) -> String { String(format: "%02X", Int(max(0, min(255, v)).rounded())) }
        return "#" + h(r) + h(g) + h(b)
    }

    func withAlpha(_ alpha: Double) -> VisorRGBA {
        VisorRGBA(r: r.rounded(), g: g.rounded(), b: b.rounded(), a: alpha)
    }

    /// This colour flattened onto an opaque backdrop.
    func flattened(onto backdrop: VisorRGBA) -> VisorRGBA {
        func mix(_ front: Double, _ back: Double) -> Double { front * a + back * (1 - a) }
        return VisorRGBA(r: mix(r, backdrop.r), g: mix(g, backdrop.g), b: mix(b, backdrop.b), a: 1)
    }

    /// WCAG relative luminance of an opaque colour.
    var luminance: Double {
        func lin(_ c: Double) -> Double {
            let v = c / 255
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    static let black = VisorRGBA(hex: 0x000000)
    static let white = VisorRGBA(hex: 0xFFFFFF)

    /// WCAG contrast of `foreground` over `background` (translucent colours are
    /// flattened onto `backdrop`, default black).
    static func contrast(_ foreground: VisorRGBA, _ background: VisorRGBA, backdrop: VisorRGBA = .black) -> Double {
        let back = background.flattened(onto: backdrop)
        let front = foreground.flattened(onto: back)
        let lf = front.luminance, lb = back.luminance
        return (max(lf, lb) + 0.05) / (min(lf, lb) + 0.05)
    }

    /// Whichever ink reads with more contrast on `fill`. Ties go to the dark ink.
    static func inkOn(_ fill: VisorRGBA, dark: VisorRGBA, light: VisorRGBA) -> VisorRGBA {
        contrast(dark, fill) >= contrast(light, fill) ? dark : light
    }

    /// Move `color` toward `target` in 20 steps until it reaches `minimum`
    /// contrast on `background`, keeping as much of its hue as it can.
    static func ensureContrast(_ color: VisorRGBA, on background: VisorRGBA, toward target: VisorRGBA, minimum: Double) -> VisorRGBA {
        if contrast(color, background) >= minimum { return color }
        func hexed(_ c: VisorRGBA) -> VisorRGBA { VisorRGBA(r: c.r.rounded(), g: c.g.rounded(), b: c.b.rounded()) }
        for step in 1...20 {
            let t = Double(step) / 20
            let mixed = hexed(VisorRGBA(
                r: color.r + (target.r - color.r) * t,
                g: color.g + (target.g - color.g) * t,
                b: color.b + (target.b - color.b) * t
            ))
            if contrast(mixed, background) >= minimum { return mixed }
        }
        return hexed(target)
    }
}

// MARK: template

struct VisorTemplate: Equatable, Identifiable {
    /// Token vocabulary (shared with the web client).
    static let colorTokens = [
        "bg", "surface-1", "surface-2", "surface-3", "line", "line-strong", "line-hover", "frame",
        "text", "text-2", "text-3", "accent", "on-accent", "accent-soft", "user", "user-soft",
        "danger", "danger-soft", "on-danger", "warn", "warn-soft", "on-warn", "ok", "ok-soft",
        "scrim", "lens-stroke", "lens-tick", "scrollbar"
    ]
    static let lengthTokens = [
        "radius-control", "radius-card", "radius-sheet", "radius-pill",
        "fs-12", "fs-13", "fs-15", "fs-17", "fs-22", "fs-32", "line-w", "focus-w"
    ]
    static let numberTokens = ["glow", "disabled-opacity"]

    let id: String
    let labelZh: String
    let labelEn: String
    let descriptionZh: String
    let descriptionEn: String
    let scheme: ColorScheme
    /// Opacity of the -soft tints (selected states, banners).
    let softAlpha: Double
    let colors: [String: VisorRGBA]
    /// Lengths in points (web rem x 16).
    let lengths: [String: Double]
    let numbers: [String: Double]

    var isLight: Bool { scheme == .light }
    /// Name in the active language ("护目镜 Visor" in Chinese, "Visor" in English).
    var label: String { L("tpl." + id) }
    var descriptionText: String { L("tpl." + id + ".desc") }

    /// The four colours of the picker's thumbnail.
    var swatch: (bg: VisorRGBA, surface: VisorRGBA, text: VisorRGBA, accent: VisorRGBA) {
        (colors["bg"]!, colors["surface-2"]!, colors["text"]!, colors["accent"]!)
    }

    /// Dark ink for fills: the template's own darkest colour.
    var darkInk: VisorRGBA { isLight ? colors["text"]! : colors["bg"]! }

    // MARK: built-ins

    private static let baseLengths: [String: Double] = [
        "radius-control": 10, "radius-card": 16, "radius-sheet": 24, "radius-pill": 999,
        "fs-12": 12, "fs-13": 13, "fs-15": 15, "fs-17": 17, "fs-22": 22, "fs-32": 32,
        "line-w": 1, "focus-w": 2
    ]
    private static let baseNumbers: [String: Double] = ["glow": 1, "disabled-opacity": 0.5]

    private static func define(
        id: String, zh: String, en: String, descZh: String, descEn: String,
        scheme: ColorScheme, softAlpha: Double? = nil,
        base: [String: UInt32],
        colorOverrides: [String: VisorRGBA] = [:],
        lengthOverrides: [String: Double] = [:],
        numberOverrides: [String: Double] = [:]
    ) -> VisorTemplate {
        let soft = softAlpha ?? (scheme == .dark ? 0.14 : 0.12)
        var c = base.mapValues { VisorRGBA(hex: $0) }
        let darkInk = scheme == .dark ? c["bg"]! : c["text"]!
        func ink(_ fill: String) -> VisorRGBA { VisorRGBA.inkOn(c[fill]!, dark: darkInk, light: .white) }
        func tint(_ name: String) -> VisorRGBA { c[name]!.withAlpha(soft) }
        let text = c["text"]!
        if scheme == .dark {
            c["line"] = VisorRGBA(r: 255, g: 255, b: 255, a: 0.08)
            c["line-strong"] = VisorRGBA(r: 255, g: 255, b: 255, a: 0.14)
            c["line-hover"] = VisorRGBA(r: 255, g: 255, b: 255, a: 0.22)
            c["scrim"] = VisorRGBA(r: 0, g: 0, b: 0, a: 0.64)
            c["lens-stroke"] = VisorRGBA.white.withAlpha(0.05)
            c["lens-tick"] = VisorRGBA.white.withAlpha(0.1)
            c["scrollbar"] = c["surface-3"]!
        } else {
            c["line"] = text.withAlpha(0.12)
            c["line-strong"] = text.withAlpha(0.22)
            c["line-hover"] = text.withAlpha(0.36)
            c["scrim"] = text.withAlpha(0.32)
            c["lens-stroke"] = text.withAlpha(0.08)
            c["lens-tick"] = text.withAlpha(0.18)
            c["scrollbar"] = text.withAlpha(0.28)
        }
        c["frame"] = VisorRGBA(r: 0, g: 0, b: 0, a: 0)
        c["accent-soft"] = tint("accent")
        c["on-accent"] = ink("accent")
        c["user-soft"] = tint("user")
        c["danger-soft"] = tint("danger")
        c["on-danger"] = ink("danger")
        c["warn-soft"] = tint("warn")
        c["on-warn"] = ink("warn")
        c["ok-soft"] = tint("ok")
        for (k, v) in colorOverrides { c[k] = v }
        return VisorTemplate(
            id: id, labelZh: zh, labelEn: en, descriptionZh: descZh, descriptionEn: descEn,
            scheme: scheme, softAlpha: soft, colors: c,
            lengths: baseLengths.merging(lengthOverrides) { $1 },
            numbers: baseNumbers.merging(numberOverrides) { $1 }
        )
    }

    private static func white(_ alpha: Double, _ r: Double = 255, _ g: Double = 255, _ b: Double = 255) -> VisorRGBA {
        VisorRGBA(r: r, g: g, b: b, a: alpha)
    }

    /// The original look: a calm dark instrument with one lime signal colour.
    static let visor = define(
        id: "visor", zh: "护目镜", en: "Visor",
        descZh: "默认深色界面，一种信号色",
        descEn: "The default dark look with one signal colour",
        scheme: .dark,
        base: [
            "bg": 0x0B0C0E, "surface-1": 0x131518, "surface-2": 0x1A1D21, "surface-3": 0x23272C,
            "text": 0xF2F4F5, "text-2": 0xA3ABB3, "text-3": 0x6B737C,
            "accent": 0xC6F432, "user": 0xFF7A45, "danger": 0xFF5A4D, "warn": 0xFFC53D, "ok": 0x3DDC97
        ]
    )

    /// Bright outdoor use: white surfaces, ink text, deep cobalt accent.
    static let daylight = define(
        id: "daylight", zh: "日光", en: "Daylight",
        descZh: "浅色高亮，适合户外阳光和太阳镜",
        descEn: "Light and crisp for sunlight, sunglasses and cycling",
        scheme: .light,
        base: [
            "bg": 0xF4F5F3, "surface-1": 0xFFFFFF, "surface-2": 0xECEEE9, "surface-3": 0xDFE2DC,
            "text": 0x0D1014, "text-2": 0x3D444D, "text-3": 0x5A626C,
            "accent": 0x1336E8, "user": 0xA83808, "danger": 0xB5121A, "warn": 0x7D4A00, "ok": 0x08662F
        ],
        lengthOverrides: ["radius-control": 8, "radius-card": 14, "radius-sheet": 20, "line-w": 1],
        numberOverrides: ["glow": 0.45]
    )

    /// Low vision: pure black, white text, one strong yellow, larger type,
    /// 2pt lines. Every text tier is near-white.
    static let beacon = define(
        id: "beacon", zh: "灯塔", en: "Beacon",
        descZh: "高对比、大字号，适合低视力辅助眼镜",
        descEn: "High contrast and large type for low-vision glasses",
        scheme: .dark, softAlpha: 0.2,
        base: [
            "bg": 0x000000, "surface-1": 0x000000, "surface-2": 0x0D0D0D, "surface-3": 0x2E2E2E,
            "text": 0xFFFFFF, "text-2": 0xF0F0F0, "text-3": 0xD6D6D6,
            "accent": 0xFFE500, "user": 0x7FE3FF, "danger": 0xFF6E61, "warn": 0xFFAB4A, "ok": 0x5DF5A8
        ],
        colorOverrides: [
            "line": VisorRGBA(hex: 0x8A8A8A), "line-strong": VisorRGBA(hex: 0xD6D6D6),
            "line-hover": VisorRGBA(hex: 0xFFFFFF), "frame": VisorRGBA(hex: 0x8A8A8A),
            "scrim": white(0.86, 0, 0, 0),
            "lens-stroke": VisorRGBA(hex: 0x8A8A8A), "lens-tick": VisorRGBA(hex: 0x8A8A8A),
            "scrollbar": VisorRGBA(hex: 0xBDBDBD)
        ],
        lengthOverrides: [
            "radius-control": 8, "radius-card": 12, "radius-sheet": 16,
            "fs-12": 15, "fs-13": 16, "fs-15": 18, "fs-17": 21, "fs-22": 26, "fs-32": 40,
            "line-w": 2, "focus-w": 3
        ],
        numberOverrides: ["glow": 0, "disabled-opacity": 0.72]
    )

    /// Night riding without blue light: warm charcoal, amber accent.
    static let ember = define(
        id: "ember", zh: "余烬", en: "Ember",
        descZh: "暖色深色，夜骑时减少蓝光",
        descEn: "Warm dark with an amber accent, low on blue light",
        scheme: .dark,
        base: [
            "bg": 0x14100D, "surface-1": 0x1C1713, "surface-2": 0x251E19, "surface-3": 0x30271F,
            "text": 0xF7E9D7, "text-2": 0xCBB59C, "text-3": 0x9A846C,
            "accent": 0xFFA631, "user": 0xFF8F6B, "danger": 0xFF6A52, "warn": 0xFFD45A, "ok": 0xB8D65C
        ],
        colorOverrides: [
            "line": white(0.08, 255, 214, 170), "line-strong": white(0.15, 255, 214, 170),
            "line-hover": white(0.24, 255, 214, 170),
            "lens-stroke": white(0.06, 255, 214, 170), "lens-tick": white(0.12, 255, 214, 170)
        ],
        lengthOverrides: ["radius-control": 12, "radius-card": 18, "radius-sheet": 26],
        numberOverrides: ["glow": 0.8]
    )

    /// AR/VR headsets: deep blue-black, cyan signal, violet for the wearer.
    static let holo = define(
        id: "holo", zh: "全息", en: "Holo",
        descZh: "冷色深空，适合 AR 与 VR 头显",
        descEn: "Cool deep-space dark for AR and VR headsets",
        scheme: .dark, softAlpha: 0.16,
        base: [
            "bg": 0x060914, "surface-1": 0x0C1122, "surface-2": 0x121A30, "surface-3": 0x1B2541,
            "text": 0xEAF2FF, "text-2": 0xA4B4D3, "text-3": 0x7282A6,
            "accent": 0x4AE3FF, "user": 0xB995FF, "danger": 0xFF5F7E, "warn": 0xFFC95A, "ok": 0x4FF0B6
        ],
        colorOverrides: [
            "line": white(0.1, 150, 190, 255), "line-strong": white(0.18, 150, 190, 255),
            "line-hover": white(0.3, 150, 190, 255),
            "lens-stroke": white(0.12, 150, 190, 255), "lens-tick": white(0.16, 150, 190, 255)
        ],
        lengthOverrides: ["radius-control": 14, "radius-card": 22, "radius-sheet": 30]
    )

    static let defaultID = "visor"
    static let all: [VisorTemplate] = [.visor, .daylight, .beacon, .ember, .holo]

    static func find(_ id: String?) -> VisorTemplate? {
        guard let id else { return nil }
        return all.first { $0.id == id }
    }
}

// MARK: relay theme overrides

/// The relay `assistant.theme` keys this client honours: the accent and the
/// three corner radii. Everything else is ignored (surface and text colours
/// were tuned for the owner's template and would break the wearer's contrast).
struct VisorThemeOverrides: Equatable {
    var accent: VisorRGBA?
    var radii: [String: Double] = [:]

    var isEmpty: Bool { accent == nil && radii.isEmpty }

    static let radiusKeys = ["radius-control", "radius-card", "radius-sheet"]
    private static let maxRadius = 64.0

    /// Validates the raw relay map: `accent` must be `#RRGGBB`; radii must be a
    /// number of px (`16`, `16px`, `1rem` = 16px) no larger than 64.
    static func sanitize(_ raw: [String: String]?) -> VisorThemeOverrides {
        var out = VisorThemeOverrides()
        for (key, value) in raw ?? [:] {
            let v = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !v.isEmpty, v.count <= 48 else { continue }
            if key == "accent" {
                out.accent = VisorRGBA(hexString: v)
            } else if radiusKeys.contains(key), let px = parseLength(v), px <= maxRadius {
                out.radii[key] = px
            }
        }
        return out
    }

    /// `^\d{1,4}(\.\d{1,3})?(px|rem)?$` -> points.
    static func parseLength(_ v: String) -> Double? {
        guard let regex = try? NSRegularExpression(pattern: #"^(\d{1,4}(?:\.\d{1,3})?)(px|rem)?$"#),
              let m = regex.firstMatch(in: v, range: NSRange(v.startIndex..., in: v)),
              let numRange = Range(m.range(at: 1), in: v),
              let n = Double(v[numRange]) else { return nil }
        if let unitRange = Range(m.range(at: 2), in: v), v[unitRange] == "rem" { return n * 16 }
        return n
    }
}

// MARK: resolution

struct VisorAppearanceInput: Equatable {
    var relayTemplate: String?
    var viewerTemplate: String?
    /// False when the owner pinned the template.
    var templateSwitching: Bool?
    var theme: [String: String]?
    /// `#RRGGBB` from `assistant.accentColor`.
    var accentColor: String?
}

struct VisorAppearance: Equatable {
    enum Source: Equatable { case defaultTemplate, relay, viewer }

    let template: VisorTemplate
    let source: Source
    var colors: [String: VisorRGBA]
    var lengths: [String: Double]
    var numbers: [String: Double]

    static let `default` = resolve(VisorAppearanceInput())

    func color(_ token: String) -> VisorRGBA { colors[token] ?? VisorRGBA(hex: 0xFF00FF) }
    func length(_ token: String) -> Double { lengths[token] ?? 0 }
    func number(_ token: String) -> Double { numbers[token] ?? 0 }

    private static let visorDarkInk = VisorRGBA(hex: 0x0B0C0E)

    static func resolve(_ input: VisorAppearanceInput) -> VisorAppearance {
        let relay = VisorTemplate.find(input.relayTemplate)
        let owner = relay ?? .visor
        let viewer = input.templateSwitching != false ? VisorTemplate.find(input.viewerTemplate) : nil
        let template = viewer ?? owner
        let source: Source = viewer != nil ? .viewer : (relay != nil ? .relay : .defaultTemplate)
        var out = VisorAppearance(
            template: template, source: source,
            colors: template.colors, lengths: template.lengths, numbers: template.numbers
        )

        // Owner overrides (accent + radii); derived tokens follow the accent.
        let overrides = VisorThemeOverrides.sanitize(input.theme)
        if let accent = overrides.accent {
            out.colors["accent"] = accent
            out.colors["on-accent"] = VisorRGBA.inkOn(accent, dark: template.darkInk, light: .white)
            out.colors["accent-soft"] = accent.withAlpha(template.softAlpha)
        }
        for (key, px) in overrides.radii { out.lengths[key] = px }

        // Relay accent colour. The visor keeps the original behaviour; every
        // other template holds its contrast floor, because the accent doubles
        // as text on surface-1: a failing brand colour is nudged toward the
        // template's text colour, keeping its hue.
        if let hex = input.accentColor, let accent = VisorRGBA(hexString: hex) {
            if template.id == VisorTemplate.defaultID {
                out.colors["accent"] = accent
                out.colors["on-accent"] = VisorRGBA.inkOn(accent, dark: visorDarkInk, light: .white)
                out.colors["accent-soft"] = accent.withAlpha(0.14)
            } else {
                let legible = VisorRGBA.ensureContrast(
                    accent, on: out.color("surface-1"), toward: out.color("text"), minimum: 4.5
                )
                out.colors["accent"] = legible
                out.colors["on-accent"] = VisorRGBA.inkOn(legible, dark: template.darkInk, light: .white)
                out.colors["accent-soft"] = legible.withAlpha(template.softAlpha)
            }
        }
        return out
    }
}
