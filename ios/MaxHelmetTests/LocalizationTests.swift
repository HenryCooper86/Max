import XCTest
@testable import MaxHelmet

final class LocalizationTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let name = "LocalizationTests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func testEveryKeyHasBothLanguages() {
        XCTAssertGreaterThan(LocalizationTable.rows.count, 300)
        for (key, row) in LocalizationTable.rows {
            XCTAssertFalse(row.zh.isEmpty, key)
            XCTAssertFalse(row.en.isEmpty, key)
            // English rows carry the same {parameters} as Chinese rows.
            XCTAssertEqual(Self.params(in: row.zh), Self.params(in: row.en), key)
        }
    }

    private static func params(in text: String) -> Set<String> {
        let regex = try! NSRegularExpression(pattern: #"\{(\w+)\}"#)
        let ns = text as NSString
        return Set(regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) })
    }

    func testEnglishRowsAreEnglish() {
        // Only deliberate exceptions may contain CJK in the English column.
        let allowed: Set<String> = ["set.lang", "set.lang.zh", "set.rdk.awaiting", "nav.confirmSpoken"]
        for (key, row) in LocalizationTable.rows where !allowed.contains(key) {
            XCTAssertNil(row.en.range(of: #"[\u4e00-\u9fff]"#, options: .regularExpression), "\(key): \(row.en)")
        }
    }

    /// Every `L("key"…)` in the app's sources names a key that exists.
    func testEveryReferencedKeyExists() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("MaxHelmet")
        let files = FileManager.default.enumerator(at: sourceRoot, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        try XCTSkipIf(files.isEmpty, "sources not available")
        let regex = try NSRegularExpression(pattern: #"\bL\(\s*"([A-Za-z0-9_.]+)""#)
        var seen = 0
        for url in files {
            let text = try String(contentsOf: url, encoding: .utf8)
            for m in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                let key = (text as NSString).substring(with: m.range(at: 1))
                if key.hasSuffix(".") { continue }   // prefix of a built key, checked below
                seen += 1
                XCTAssertNotNil(LocalizationTable.rows[key], "\(url.lastPathComponent): \(key)")
            }
        }
        XCTAssertGreaterThan(seen, 200)
        // Keys built from a prefix.
        
        for style in VoiceVisualizer.allCases { XCTAssertNotNil(LocalizationTable.rows["viz." + style.rawValue]) }
        for t in VisorTemplate.all {
            XCTAssertNotNil(LocalizationTable.rows["tpl." + t.id])
            XCTAssertNotNil(LocalizationTable.rows["tpl." + t.id + ".desc"])
        }
        for m in DeviceMark.allCases { XCTAssertNotNil(LocalizationTable.rows["dev.p." + m.rawValue]) }
        for d in ["front", "rear", "left", "right", "left_rear", "right_rear"] {
            XCTAssertNotNil(LocalizationTable.rows["hazard.dir." + d])
        }
    }

    func testParametersSubstitute() {
        XCTAssertEqual(Loc.string("turn.thinking", .en, ["name": "Nova"]), "Nova is thinking…")
        XCTAssertEqual(Loc.string("turn.thinking", .zh, ["name": "Nova"]), "Nova 思考中…")
        XCTAssertEqual(Loc.string("hint.wake", .en, ["wake": "hey nova"]), "Tap the visor to start, or say “hey nova”")
        XCTAssertEqual(Loc.string("set.rdk.nearbyTitle", .en, ["name": "Nova"]), "Nova helmet")
        XCTAssertEqual(Loc.string("nav.eta", .en, ["min": "6", "km": "1.4"]), "6 min · 1.4 km")
        XCTAssertEqual(Loc.string("no.such.key", .en), "no.such.key")
    }

    func testOverrideBeatsSystemLanguage() {
        XCTAssertEqual(Loc.resolve(choice: .system, preferred: ["zh-Hans-CN"], underTest: false), .zh)
        XCTAssertEqual(Loc.resolve(choice: .system, preferred: ["en-US"], underTest: false), .en)
        XCTAssertEqual(Loc.resolve(choice: .system, preferred: ["fr-FR"], underTest: false), .en)
        XCTAssertEqual(Loc.resolve(choice: .system, preferred: [], underTest: false), .en)
        XCTAssertEqual(Loc.resolve(choice: .en, preferred: ["zh-Hans-CN"], underTest: false), .en)
        XCTAssertEqual(Loc.resolve(choice: .zh, preferred: ["en-US"], underTest: false), .zh)
        XCTAssertEqual(Loc.resolve(choice: .system, preferred: ["en-US"], underTest: true), .zh, "tests default to Chinese")
    }

    func testThemeLanguageChoicePersistsAndAppliesLive() {
        let defaults = freshDefaults()
        let theme = VisorTheme(defaults: defaults)
        XCTAssertEqual(theme.languageChoice, .system)
        XCTAssertEqual(theme.language, .zh)
        theme.selectLanguage(.en)
        XCTAssertEqual(theme.language, .en)
        XCTAssertEqual(VisorTheme(defaults: defaults).languageChoice, .en)
        XCTAssertEqual(VisorTheme(defaults: defaults).language, .en)
        theme.selectLanguage(.system)
        XCTAssertEqual(VisorTheme(defaults: defaults).languageChoice, .system)
    }

    func testLiveSwitchOfTheSharedLanguage() {
        let shared = VisorTheme.shared
        let before = shared.languageChoice
        defer { shared.selectLanguage(before) }
        shared.selectLanguage(.en)
        XCTAssertEqual(L("pill.settings"), "Settings")
        XCTAssertEqual(readoutLabel(), "Offline")
        shared.selectLanguage(.zh)
        XCTAssertEqual(L("pill.settings"), "设置")
        XCTAssertEqual(readoutLabel(), "离线")
    }

    private func readoutLabel() -> String { L("conn.offline") }

    /// Chinese output is byte-identical to the previously hard-coded strings.
    func testChineseMatchesPreviousLiterals() {
        let zh = AppLanguage.zh
        XCTAssertEqual(Loc.string("main.hello", zh, ["name": "Max"]), "你好，我是Max")
        XCTAssertEqual(Loc.string("hint.wake", zh, ["wake": "Max"]), "点按镜面开始对话，或说“Max”")
        XCTAssertEqual(Loc.string("turn.listening", zh), "免提待命 · 请讲话")
        XCTAssertEqual(Loc.string("main.hazard.critical", zh), "高风险 · 优先安全 · ")
        XCTAssertEqual(Loc.string("a11y.toggle.hint.stop", zh), "结束免提会话，或取消正在进行的连接")
        XCTAssertEqual(Loc.string("crash.alarm.countdown", zh, ["n": "5"]), "5 秒后通知紧急联系人")
        XCTAssertEqual(Loc.string("nav.a11y", zh, ["dest": "A", "instr": "左转", "dist": "50 米", "eta": "6 分钟 · 1.4 公里"]), "导航 A，左转，50 米，6 分钟 · 1.4 公里")
        XCTAssertEqual(Loc.string("set.rdk.awaiting", zh), "等待头盔确认…请对头盔说\u{201C}确认配对\u{201D}，无需按键")
        XCTAssertEqual(Loc.string("tpl.daylight", zh), "日光 Daylight")
        XCTAssertEqual(Loc.string("set.viz", zh), "语音显示 / Voice display")
        XCTAssertEqual(Loc.string("set.appearance", zh), "外观 / Appearance")
        XCTAssertEqual(Loc.string("st.relayRefused", zh, ["status": "502"]), "中继拒绝连接（HTTP 502），请检查中继地址")
        XCTAssertEqual(navigationDistance(1450), "1.4 公里")
        XCTAssertEqual(navigationDistance(250), "250 米")
    }

    func testSessionStartCarriesEffectiveLanguage() throws {
        func payload(_ language: String?) throws -> [String: Any] {
            let json = buildSessionStart(
                voiceGender: .female, voicePersonality: .concise, rideMode: .ride, scenario: .commute,
                lat: nil, lon: nil, language: language)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        }
        XCTAssertNil(try payload(nil)["language"], "key omitted when nil")
        XCTAssertNil(try payload("")["language"])
        XCTAssertEqual(try payload("en")["language"] as? String, "en")
        XCTAssertEqual(try payload("zh")["language"] as? String, "zh")
        // The value the session sends is the resolved (override-aware) language.
        let theme = VisorTheme.shared
        let before = theme.languageChoice
        defer { theme.selectLanguage(before) }
        theme.selectLanguage(.en)
        XCTAssertEqual(theme.language.rawValue, "en")
        theme.selectLanguage(.zh)
        XCTAssertEqual(theme.language.rawValue, "zh")
    }

    func testDeviceNameFollowsLanguage() {
        let theme = VisorTheme(defaults: UserDefaults(suiteName: "LocDev-\(UUID().uuidString)")!)
        theme.apply(AssistantBranding(deviceProfile: "motorcycle-helmet", deviceLabel: "摩托车头盔"))
        XCTAssertEqual(theme.deviceDisplayName, "摩托车头盔")
        theme.selectLanguage(.en)
        XCTAssertEqual(theme.deviceDisplayName, "Motorcycle helmet")
        theme.apply(AssistantBranding(deviceProfile: "custom-x", deviceLabel: "摩托车头盔"))
        XCTAssertEqual(theme.deviceDisplayName, "摩托车头盔", "custom profiles keep the relay's label")
        theme.apply(AssistantBranding(deviceProfile: "wearable", deviceLabel: "Wearable"))
        XCTAssertEqual(theme.deviceDisplayName, "Wearable")
    }

    func testFlagReasonWireValuesStayChinese() {
        XCTAssertEqual(turnFlagReasons, ["听错了", "回答不对", "太慢", "不安全"])
        let theme = VisorTheme.shared
        let before = theme.languageChoice
        defer { theme.selectLanguage(before) }
        theme.selectLanguage(.en)
        XCTAssertEqual(turnFlagReasonLabel("太慢"), "Too slow")
        XCTAssertEqual(turnFlagReasonLabel("custom"), "custom")
    }

    func testEnglishSpotChecks() {
        let en = AppLanguage.en
        XCTAssertEqual(Loc.string("pill.captions", en), "Captions")
        XCTAssertEqual(Loc.string("a11y.toggle.start", en), "Start hands-free")
        XCTAssertEqual(Loc.string("set.lang.system", en), "Follow system")
        XCTAssertEqual(Loc.string("caption.rider.other", en), "You")
        XCTAssertEqual(Loc.string("tpl.holo", en), "Holo")
    }
}
