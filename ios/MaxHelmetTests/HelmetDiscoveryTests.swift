import XCTest
@testable import MaxHelmet

final class HelmetDiscoveryTests: XCTestCase {
    func testTxtRecordParsing() {
        let token = String(repeating: "a", count: 32)
        XCTAssertEqual(BonjourHelmetDiscovery.token(fromTxt: ["dt": token, "v": "1"]), token)
        XCTAssertNil(BonjourHelmetDiscovery.token(fromTxt: ["dt": "short", "v": "1"]))
        XCTAssertNil(BonjourHelmetDiscovery.token(fromTxt: ["v": "1"]))
        XCTAssertNil(BonjourHelmetDiscovery.token(fromTxt: ["dt": token.uppercased(), "v": "1"]))
    }

    func testDedupeKeepsOneEntryPerToken() {
        let token = String(repeating: "a", count: 32)
        let merged = DiscoveredHelmet.merged([
            DiscoveredHelmet(token: token, transport: "mdns"),
            DiscoveredHelmet(token: token, transport: "mdns"),
            DiscoveredHelmet(token: String(repeating: "b", count: 32), transport: "mdns")
        ])
        XCTAssertEqual(merged.count, 2)
    }
}
