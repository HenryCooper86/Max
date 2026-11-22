import XCTest
@testable import MaxHelmet

/// Version, build number and signing team come from xcconfig files, never from
/// hand edits to the project file, so contributors without the owner's Apple
/// account can still build and CI can stamp build numbers.
final class BuildConfigurationTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(path), encoding: .utf8)
    }

    func testTheProjectFileNoLongerPinsVersionOrTeamForTheApp() throws {
        let project = try source("MaxHelmet.xcodeproj/project.pbxproj")
        XCTAssertFalse(project.contains("V487HQQLC6"), "the signing team belongs in the untracked Secrets.xcconfig")
        // The app target's Debug and Release blocks must leave these to the xcconfig files.
        for id in ["7A000000000000000000000C", "7A000000000000000000000D"] {
            let start = try XCTUnwrap(project.range(of: "\t\t\(id) /* "), id)
            let end = try XCTUnwrap(project.range(of: "\n\t\t};", range: start.upperBound..<project.endIndex), id)
            let block = project[start.lowerBound..<end.lowerBound]
            XCTAssertTrue(block.contains("baseConfigurationReference"), "\(id) is an app configuration")
            for key in ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION", "DEVELOPMENT_TEAM"] {
                XCTAssertFalse(block.contains(key + " ="), "\(id) still sets \(key)")
            }
        }
    }

    func testBothConfigurationsReadTheTrackedBaseBeforeTheLocalSecrets() throws {
        for name in ["Debug", "Release"] {
            let config = try source("Config/\(name).xcconfig")
            let base = try XCTUnwrap(config.range(of: "#include \"Base.xcconfig\""), name)
            let secrets = try XCTUnwrap(config.range(of: "#include? \"Secrets.xcconfig\""), name)
            XCTAssertLessThan(base.lowerBound, secrets.lowerBound, "\(name): Secrets.xcconfig must be able to override Base")
        }
        let base = try source("Config/Base.xcconfig")
        XCTAssertTrue(base.contains("CURRENT_PROJECT_VERSION = $(MAX_BUILD_NUMBER)"))
        XCTAssertTrue(base.contains("DEVELOPMENT_TEAM = $(MAX_DEVELOPMENT_TEAM)"))
        let example = try source("Config/Secrets.xcconfig.example")
        XCTAssertTrue(example.contains("MAX_DEVELOPMENT_TEAM ="))
    }

    func testTheBuiltAppCarriesTheTrackedMarketingVersionAndANumericBuild() throws {
        let base = try source("Config/Base.xcconfig")
        let line = try XCTUnwrap(base.split(separator: "\n").first { $0.hasPrefix("MARKETING_VERSION") })
        let expected = line.split(separator: "=").last?.trimmingCharacters(in: .whitespaces)
        let info = Bundle.main.infoDictionary ?? [:]
        XCTAssertEqual(info["CFBundleShortVersionString"] as? String, expected)
        let build = try XCTUnwrap(info["CFBundleVersion"] as? String)
        XCTAssertNotNil(build.range(of: "^[0-9]+(\\.[0-9]+){0,2}$", options: .regularExpression), "build number \(build)")
    }
}
