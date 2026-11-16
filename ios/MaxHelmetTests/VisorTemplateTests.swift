import XCTest
@testable import MaxHelmet

final class VisorTemplateTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let name = "VisorTemplateTests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    // MARK: tokens

    func testEveryTemplateDefinesEveryToken() {
        XCTAssertEqual(VisorTemplate.all.map(\.id), ["visor", "daylight", "beacon", "ember", "holo"])
        for t in VisorTemplate.all {
            XCTAssertEqual(Set(t.colors.keys), Set(VisorTemplate.colorTokens), t.id)
            XCTAssertEqual(Set(t.lengths.keys), Set(VisorTemplate.lengthTokens), t.id)
            XCTAssertEqual(Set(t.numbers.keys), Set(VisorTemplate.numberTokens), t.id)
        }
    }

    func testSpotTokenValues() {
        let visor = VisorTemplate.visor, day = VisorTemplate.daylight, beacon = VisorTemplate.beacon
        XCTAssertEqual(visor.colors["accent"]?.hexString, "#C6F432")
        XCTAssertEqual(visor.colors["bg"]?.hexString, "#0B0C0E")
        XCTAssertEqual(visor.colors["on-accent"]?.hexString, "#0B0C0E")
        XCTAssertEqual(visor.colors["line"], VisorRGBA(r: 255, g: 255, b: 255, a: 0.08))
        XCTAssertEqual(visor.lengths["radius-card"], 16)
        XCTAssertEqual(visor.scheme, .dark)

        XCTAssertEqual(day.scheme, .light)
        XCTAssertEqual(day.colors["bg"]?.hexString, "#F4F5F3")
        XCTAssertEqual(day.colors["accent"]?.hexString, "#1336E8")
        XCTAssertEqual(day.colors["on-accent"]?.hexString, "#FFFFFF")
        XCTAssertEqual(day.lengths["radius-card"], 14)
        XCTAssertEqual(day.numbers["glow"], 0.45)
        XCTAssertEqual(day.colors["line"]?.a ?? 0, 0.12, accuracy: 1e-9)

        XCTAssertEqual(beacon.colors["text"]?.hexString, "#FFFFFF")
        XCTAssertEqual(beacon.colors["accent"]?.hexString, "#FFE500")
        XCTAssertEqual(beacon.colors["line"]?.hexString, "#8A8A8A")
        XCTAssertEqual(beacon.lengths["fs-17"], 21)
        XCTAssertEqual(beacon.lengths["fs-32"], 40)
        XCTAssertEqual(beacon.lengths["line-w"], 2)
        XCTAssertEqual(beacon.lengths["focus-w"], 3)
        XCTAssertEqual(beacon.numbers["disabled-opacity"], 0.72)
        XCTAssertEqual(beacon.softAlpha, 0.2)

        XCTAssertEqual(VisorTemplate.ember.colors["accent"]?.hexString, "#FFA631")
        XCTAssertEqual(VisorTemplate.ember.lengths["radius-sheet"], 26)
        XCTAssertEqual(VisorTemplate.holo.colors["accent"]?.hexString, "#4AE3FF")
        XCTAssertEqual(VisorTemplate.holo.softAlpha, 0.16)
        XCTAssertEqual(VisorTemplate.holo.lengths["radius-card"], 22)
    }

    func testBaseTextMeetsContrast() {
        for t in VisorTemplate.all {
            let r = VisorRGBA.contrast(t.colors["text"]!, t.colors["surface-1"]!)
            XCTAssertGreaterThanOrEqual(r, 7, t.id)
        }
    }

    // MARK: precedence

    func testPrecedence() {
        func resolve(_ i: VisorAppearanceInput) -> VisorAppearance { VisorAppearance.resolve(i) }
        XCTAssertEqual(resolve(.init()).template.id, "visor")
        XCTAssertEqual(resolve(.init()).source, .defaultTemplate)
        XCTAssertEqual(resolve(.init(relayTemplate: "beacon")).template.id, "beacon")
        XCTAssertEqual(resolve(.init(relayTemplate: "beacon")).source, .relay)
        XCTAssertEqual(resolve(.init(relayTemplate: "nope")).template.id, "visor")
        let wearer = resolve(.init(relayTemplate: "beacon", viewerTemplate: "daylight"))
        XCTAssertEqual(wearer.template.id, "daylight")
        XCTAssertEqual(wearer.source, .viewer)
        XCTAssertEqual(resolve(.init(relayTemplate: "beacon", viewerTemplate: "daylight", templateSwitching: true)).template.id, "daylight")
        let pinned = resolve(.init(relayTemplate: "beacon", viewerTemplate: "daylight", templateSwitching: false))
        XCTAssertEqual(pinned.template.id, "beacon")
        XCTAssertEqual(pinned.source, .relay)
        XCTAssertEqual(resolve(.init(viewerTemplate: "bogus")).template.id, "visor")
    }

    func testOverridesThenRelayAccent() {
        let withTheme = VisorAppearance.resolve(.init(
            relayTemplate: "daylight",
            theme: ["accent": "#112233", "radius-card": "20px", "bg": "#ff0000", "radius-pill": "4"]
        ))
        XCTAssertEqual(withTheme.color("accent").hexString, "#112233")
        XCTAssertEqual(withTheme.length("radius-card"), 20)
        XCTAssertEqual(withTheme.color("bg").hexString, "#F4F5F3", "surface colours are not overridable")
        XCTAssertEqual(withTheme.length("radius-pill"), 999)
        XCTAssertEqual(withTheme.color("on-accent").hexString, "#FFFFFF")

        let both = VisorAppearance.resolve(.init(theme: ["accent": "#112233"], accentColor: "#FF0000"))
        XCTAssertEqual(both.color("accent").hexString, "#FF0000", "relay accentColor wins over theme.accent")
        XCTAssertEqual(both.color("accent-soft").a, 0.14, accuracy: 1e-9)
    }

    func testAccentIsNudgedForContrastOutsideVisor() {
        // Pale yellow on white is illegible; daylight must darken it, the visor keeps it.
        let day = VisorAppearance.resolve(.init(relayTemplate: "daylight", accentColor: "#FFEE00"))
        let ratio = VisorRGBA.contrast(day.color("accent"), day.color("surface-1"))
        XCTAssertGreaterThanOrEqual(ratio, 4.5)
        XCTAssertNotEqual(day.color("accent").hexString, "#FFEE00")
        let visor = VisorAppearance.resolve(.init(accentColor: "#FFEE00"))
        XCTAssertEqual(visor.color("accent").hexString, "#FFEE00")
        // Already-legible accents are untouched.
        XCTAssertEqual(VisorAppearance.resolve(.init(relayTemplate: "daylight", accentColor: "#1336E8")).color("accent").hexString, "#1336E8")
    }

    func testThemeOverrideValidation() {
        let ok = VisorThemeOverrides.sanitize([
            "accent": "#AbCdEf", "radius-control": "8", "radius-card": "1rem", "radius-sheet": "24px"
        ])
        XCTAssertEqual(ok.accent?.hexString, "#ABCDEF")
        XCTAssertEqual(ok.radii["radius-control"], 8)
        XCTAssertEqual(ok.radii["radius-card"], 16)
        XCTAssertEqual(ok.radii["radius-sheet"], 24)

        let bad = VisorThemeOverrides.sanitize([
            "accent": "red", "radius-card": "999px", "radius-control": "-4", "radius-sheet": "calc(1px)",
            "text": "#ffffff", "fs-17": "30px", "unknown": "1"
        ])
        XCTAssertTrue(bad.isEmpty)
        XCTAssertNil(VisorThemeOverrides.sanitize(["accent": "#abc"]).accent)
        XCTAssertNil(VisorThemeOverrides.sanitize(["accent": "#12345678"]).accent)
        XCTAssertTrue(VisorThemeOverrides.sanitize(nil).isEmpty)
    }

    // MARK: theme object

    func testThemeWearerChoicePersistsAndPinnedIgnoresIt() {
        let defaults = freshDefaults()
        let theme = VisorTheme(defaults: defaults)
        theme.apply(AssistantBranding(template: "beacon"))
        XCTAssertEqual(theme.template.id, "beacon")
        theme.selectTemplate("daylight")
        XCTAssertEqual(theme.template.id, "daylight")
        XCTAssertEqual(VisorTheme(defaults: defaults).viewerTemplate, "daylight")

        theme.apply(AssistantBranding(template: "beacon", templateSwitching: false))
        XCTAssertEqual(theme.template.id, "beacon")
        XCTAssertFalse(theme.canSwitchTemplate)
        theme.apply(AssistantBranding(template: "beacon", templateSwitching: true))
        XCTAssertEqual(theme.template.id, "daylight")

        theme.selectTemplate("bogus")
        XCTAssertEqual(theme.template.id, "beacon")
    }

    // MARK: device marks

    func testDeviceMarkSelection() {
        for mark in DeviceMark.allCases {
            XCTAssertEqual(DeviceMark.resolve(profile: mark.rawValue, kind: .helmet), mark)
        }
        XCTAssertEqual(DeviceMark.resolve(profile: " VR-Headset ", kind: .helmet), .vrHeadset)
        XCTAssertEqual(DeviceMark.resolve(profile: nil, kind: .helmet), .motorcycleHelmet)
        XCTAssertEqual(DeviceMark.resolve(profile: "unknown-thing", kind: .glasses), .smartGlasses)
        XCTAssertEqual(DeviceMark.resolve(profile: "", kind: .other), .wearable)
        XCTAssertEqual(DeviceMark.allCases.count, 8)
    }

    func testEveryDeviceMarkIsInTheBundle() {
        for mark in DeviceMark.allCases {
            XCTAssertNotNil(UIImage(named: mark.assetName, in: Bundle(for: VisorTheme.self), compatibleWith: nil), mark.assetName)
        }
    }

    // MARK: /health

    func testHealthParsesTemplateFields() {
        let json = """
        {"assistant":{"name":"Nova","device":"glasses","wakePhrase":"hey","deviceProfile":"assistive-glasses",
         "deviceLabel":"Assistive glasses","template":"beacon","templateSwitching":false,
         "theme":{"accent":"#112233","radius-card":"20px"},"logoUrl":"/brand/logo?v=abc","visualizer":"ring"}}
        """
        let b = RelayHealthClient.parse(data: Data(json.utf8))!.branding
        XCTAssertEqual(b.deviceProfile, "assistive-glasses")
        XCTAssertEqual(b.deviceLabel, "Assistive glasses")
        XCTAssertEqual(b.template, "beacon")
        XCTAssertEqual(b.templateSwitching, false)
        XCTAssertEqual(b.theme?["radius-card"], "20px")
        XCTAssertEqual(b.logoUrl, "/brand/logo?v=abc")
        XCTAssertEqual(b.visualizer, "ring")

        let theme = VisorTheme(defaults: freshDefaults())
        theme.apply(b)
        XCTAssertEqual(theme.deviceMark, .assistiveGlasses)
        XCTAssertEqual(theme.template.id, "beacon")
        XCTAssertEqual(theme.appearance.length("radius-card"), 20)
        XCTAssertEqual(theme.visualizer, .ring)

        let old = RelayHealthClient.parse(data: Data(#"{"assistant":{"name":"Max"}}"#.utf8))!.branding
        XCTAssertNil(old.template)
        XCTAssertNil(old.logoUrl)
        theme.apply(old)
        XCTAssertEqual(theme.template.id, "visor")
        XCTAssertEqual(theme.visualizer, .wave)
    }

    func testLogoUrlAndContentTypeHandling() {
        let base = URL(string: "http://localhost:8787")!
        XCTAssertEqual(RelayHealthClient.logoURL(base: base, path: "/brand/logo?v=abc")?.absoluteString, "http://localhost:8787/brand/logo?v=abc")
        XCTAssertNil(RelayHealthClient.logoURL(base: base, path: "//evil.example/x.png"))
        XCTAssertNil(RelayHealthClient.logoURL(base: base, path: "https://evil.example/x.png"))
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])
        XCTAssertEqual(RelayHealthClient.classifyLogo(contentType: "image/png", data: png), .png(png))
        XCTAssertEqual(RelayHealthClient.classifyLogo(contentType: "image/svg+xml", data: png), .unsupported)
        XCTAssertEqual(RelayHealthClient.classifyLogo(contentType: "image/png", data: Data("<svg/>".utf8)), .unsupported)
    }
}

final class VoiceVisualizerTests: XCTestCase {
    func testIdsAndValidation() {
        XCTAssertEqual(VoiceVisualizer.allCases.map(\.rawValue), ["wave", "bars", "mirror", "dots", "ring"])
        XCTAssertEqual(VoiceVisualizer.parse("dots"), .dots)
        XCTAssertNil(VoiceVisualizer.parse("DOTS"))
        XCTAssertNil(VoiceVisualizer.parse("spiral"))
        XCTAssertNil(VoiceVisualizer.parse(nil))
        XCTAssertNil(VoiceVisualizer.parse(3))
    }

    func testPrecedenceAndPinning() {
        XCTAssertEqual(VoiceVisualizer.resolve(relay: nil, viewer: nil, templateSwitching: nil), .wave)
        XCTAssertEqual(VoiceVisualizer.resolve(relay: "bars", viewer: nil, templateSwitching: nil), .bars)
        XCTAssertEqual(VoiceVisualizer.resolve(relay: "bars", viewer: "ring", templateSwitching: nil), .ring)
        XCTAssertEqual(VoiceVisualizer.resolve(relay: "bars", viewer: "ring", templateSwitching: false), .bars)
        XCTAssertEqual(VoiceVisualizer.resolve(relay: "junk", viewer: "junk", templateSwitching: nil), .wave)

        let name = "VizTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let theme = VisorTheme(defaults: defaults)
        theme.apply(AssistantBranding(visualizer: "mirror"))
        XCTAssertEqual(theme.visualizer, .mirror)
        theme.selectVisualizer(.dots)
        XCTAssertEqual(theme.visualizer, .dots)
        XCTAssertEqual(VisorTheme(defaults: defaults).viewerVisualizer, "dots")
        theme.apply(AssistantBranding(templateSwitching: false, visualizer: "mirror"))
        XCTAssertEqual(theme.visualizer, .mirror)
        defaults.removePersistentDomain(forName: name)
    }

    func testSpectrumBoundedAndStateDependent() {
        let modes: [SpectrumMode] = [.idle, .connecting, .ready, .listening, .thinking, .speaking, .offline]
        var means: [SpectrumMode: Double] = [:]
        for mode in modes {
            var sum = 0.0, count = 0.0
            for level in [-1.0, 0, 0.3, 1, 5, .nan, .infinity] {
                for step in 0..<40 {
                    let s = Spectrum.synthesize(mode: mode, level: level, t: Double(step) * 0.37)
                    XCTAssertEqual(s.count, Spectrum.bins)
                    for v in s { XCTAssertTrue(v >= 0 && v <= 1, "\(mode) \(level) \(v)") }
                    if level == 0.3 { sum += s.reduce(0, +); count += Double(s.count) }
                }
            }
            means[mode] = sum / count
        }
        XCTAssertEqual(means[.offline]!, 0.02, accuracy: 1e-9)
        XCTAssertGreaterThan(means[.speaking]!, means[.thinking]!)
        XCTAssertGreaterThan(means[.speaking]!, means[.idle]!)
        XCTAssertGreaterThan(means[.listening]!, means[.ready]!)
        XCTAssertGreaterThan(means[.ready]!, means[.idle]!)
        XCTAssertNotEqual(
            Spectrum.synthesize(mode: .connecting, level: 0, t: 0.2),
            Spectrum.synthesize(mode: .connecting, level: 0, t: 1.0)
        )
        // Listening follows the mic level.
        let quiet = Spectrum.synthesize(mode: .listening, level: 0, t: 1).reduce(0, +)
        let loud = Spectrum.synthesize(mode: .listening, level: 0.8, t: 1).reduce(0, +)
        XCTAssertGreaterThan(loud, quiet * 2)
    }

    func testPeaksDecayAndSmoothing() {
        var peaks = [Double](repeating: 0, count: 4)
        Spectrum.updatePeaks(&peaks, values: [1, 0.5, 0, 0.2], dt: 0.1)
        XCTAssertEqual(peaks, [1, 0.5, 0, 0.2])
        Spectrum.updatePeaks(&peaks, values: [0, 0, 0, 0], dt: 1)
        XCTAssertEqual(peaks[0], 0.45, accuracy: 1e-9)
        XCTAssertEqual(peaks[1], 0, accuracy: 1e-9)
        Spectrum.updatePeaks(&peaks, values: [0, 0, 0, 0], dt: 10)
        XCTAssertEqual(peaks.max()!, 0, accuracy: 1e-9)
        Spectrum.updatePeaks(&peaks, values: [0.9, 0, 0, 0], dt: 0.5)
        XCTAssertEqual(peaks[0], 0.9, accuracy: 1e-9, "caps jump up immediately")

        var display = [0.0, 1.0]
        Spectrum.smooth(&display, toward: [1, 0], dt: 0.05)
        XCTAssertGreaterThan(display[0], 0.7, "rises fast")
        XCTAssertGreaterThan(display[1], 0.5, "falls soft")
    }
}
