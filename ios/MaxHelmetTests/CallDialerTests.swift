import XCTest
@testable import MaxHelmet

private final class FakeOpener: URLOpening, @unchecked Sendable {
    var opened: [URL] = []
    var result = true
    func open(_ url: URL) async -> Bool {
        opened.append(url)
        return result
    }
}

private final class FakeResolver: ContactResolving, @unchecked Sendable {
    var number: String? = "13800000000"
    var authorized = true
    func isAuthorized() async -> Bool { authorized }
    func number(matching name: String) async -> String? { number }
}

final class CallDialerTests: XCTestCase {

    func testDialsAnEmergencyNumberWithoutTouchingContacts() async {
        let opener = FakeOpener()
        let resolver = FakeResolver()
        resolver.authorized = false
        let handler = CallDialer(opener: opener, resolver: resolver)

        let result = await handler.perform(.callDial(name: nil, number: "120"))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(opener.opened.first?.absoluteString, "tel://120")
    }

    func testResolvesANameThenDials() async {
        let opener = FakeOpener()
        let handler = CallDialer(opener: opener, resolver: FakeResolver())

        let result = await handler.perform(.callDial(name: "老王", number: nil))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(opener.opened.first?.absoluteString, "tel://13800000000")
    }

    func testReportsMissingContactsPermission() async {
        let resolver = FakeResolver()
        resolver.authorized = false
        let handler = CallDialer(opener: FakeOpener(), resolver: resolver)

        let result = await handler.perform(.callDial(name: "老王", number: nil))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.contacts")
    }

    func testReportsAnUnknownContact() async {
        let resolver = FakeResolver()
        resolver.number = nil
        let handler = CallDialer(opener: FakeOpener(), resolver: resolver)

        let result = await handler.perform(.callDial(name: "查无此人", number: nil))

        XCTAssertEqual(result.reason, "contact.notFound")
    }

    func testReportsAFailedOpen() async {
        let opener = FakeOpener()
        opener.result = false
        let handler = CallDialer(opener: opener, resolver: FakeResolver())

        let result = await handler.perform(.callDial(name: "老王", number: nil))

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "dial.failed")
    }

    func testNormalizesSpokenNamesForMatching() {
        XCTAssertEqual(normalizeContactName("老王，"), "老王")
        XCTAssertEqual(normalizeContactName("  Wang  "), "wang")
        XCTAssertEqual(normalizeContactName("Ｗａｎｇ"), "wang")
    }
}
