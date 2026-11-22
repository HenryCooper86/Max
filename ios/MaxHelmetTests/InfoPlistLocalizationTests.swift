import XCTest
@testable import MaxHelmet

/// The system shows the app name and every permission prompt from the
/// Info.plist, not from the in-code `L()` table, so they need their own
/// InfoPlist.strings per language.
final class InfoPlistLocalizationTests: XCTestCase {
    private let languages = ["en", "zh-Hans"]

    func testEveryRiderFacingPlistStringIsTranslatedInBothLanguages() throws {
        for plistName in ["Info.plist", "Info-Debug.plist"] {
            let plist = try sourcePlist(named: plistName)
            let keys = riderFacingKeys(in: plist)
            XCTAssertTrue(keys.contains("CFBundleDisplayName"))
            XCTAssertTrue(keys.contains("NSMicrophoneUsageDescription"))
            for language in languages {
                let strings = try sourceStrings(language)
                for key in keys {
                    let value = try XCTUnwrap(strings[key], "\(language) is missing \(key) from \(plistName)")
                    XCTAssertFalse(value.trimmingCharacters(in: .whitespaces).isEmpty, "\(language) \(key)")
                }
            }
        }
    }

    func testChineseKeepsTheChineseNameAndEnglishUsesMax() throws {
        let release = try sourcePlist(named: "Info.plist")
        let zh = try sourceStrings("zh-Hans")
        let en = try sourceStrings("en")
        XCTAssertEqual(zh["CFBundleDisplayName"], "Max 头盔助手")
        XCTAssertEqual(en["CFBundleDisplayName"], "Max")
        // The Chinese table repeats the plist wording, so a Chinese rider sees
        // exactly what they saw before English existed.
        for key in riderFacingKeys(in: release) where key != "CFBundleDisplayName" {
            XCTAssertEqual(zh[key], release[key] as? String, key)
        }
        for (key, value) in en {
            XCTAssertNil(value.range(of: "\\p{Han}", options: .regularExpression), "English \(key) contains Chinese: \(value)")
        }
    }

    func testTheBuiltAppShipsBothLocalizations() throws {
        let bundle = Bundle.main
        for language in languages {
            XCTAssertTrue(bundle.localizations.contains(language), "built app lacks \(language).lproj")
            let path = try XCTUnwrap(
                bundle.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: language),
                "built app lacks \(language).lproj/InfoPlist.strings"
            )
            let table = try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String])
            XCTAssertNotNil(table["NSMicrophoneUsageDescription"])
        }
        XCTAssertEqual(bundle.developmentLocalization, "en")
    }

    // MARK: - helpers

    private func riderFacingKeys(in plist: [String: Any]) -> Set<String> {
        Set(plist.keys.filter { $0 == "CFBundleDisplayName" || $0.hasSuffix("UsageDescription") })
    }

    private var appSourceRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("MaxHelmet")
    }

    private func sourcePlist(named name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: appSourceRoot.appendingPathComponent(name))
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any]
        )
    }

    private func sourceStrings(_ language: String) throws -> [String: String] {
        let url = appSourceRoot.appendingPathComponent("\(language).lproj/InfoPlist.strings")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: String],
            "\(url.lastPathComponent) for \(language) is not a valid strings file"
        )
    }
}
