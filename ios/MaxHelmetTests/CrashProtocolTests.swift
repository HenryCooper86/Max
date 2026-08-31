import XCTest
@testable import MaxHelmet

final class CrashProtocolTests: XCTestCase {

    func testParsesCrashAck() {
        let event = parseAgentEvent(#"{"type":"crash.ack","incidentId":"i1","status":"notified"}"#)
        guard case let .crashAck(incidentId, status, detail) = event else {
            return XCTFail("expected crashAck, got \(event)")
        }
        XCTAssertEqual(incidentId, "i1")
        XCTAssertEqual(status, .notified)
        XCTAssertNil(detail)
    }

    func testUnknownAckStatusReadsAsFailed() {
        let event = parseAgentEvent(#"{"type":"crash.ack","incidentId":"i1","status":"delivered-maybe"}"#)
        guard case let .crashAck(_, status, _) = event else { return XCTFail("expected crashAck") }
        XCTAssertEqual(status, .failed, "an unknown outcome must never read as success")
    }

    func testParsesCrashSimulate() {
        guard case .crashSimulate = parseAgentEvent(#"{"type":"crash.simulate"}"#) else {
            return XCTFail("expected crashSimulate")
        }
    }

    func testBuildCrashAlertRoundTripsAndOmitsContactWhenNil() throws {
        let json = buildCrashAlert(incidentId: "i2", lat: 31.23, lon: 121.47, speedKmhRecent: 42,
                                   contactNumber: nil, contactOptIn: false, detectedAt: 1_754_200_000_000)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashAlert)
        XCTAssertEqual(parsed["incidentId"] as? String, "i2")
        XCTAssertEqual(parsed["contactOptIn"] as? Bool, false)
        XCTAssertNil(parsed["contactNumber"])

        let optedIn = buildCrashAlert(incidentId: "i3", lat: nil, lon: nil, speedKmhRecent: nil,
                                      contactNumber: "+8613800000000", contactOptIn: true, detectedAt: 0)
        let parsedIn = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(optedIn.utf8)) as? [String: Any])
        XCTAssertEqual(parsedIn["contactNumber"] as? String, "+8613800000000")
        XCTAssertNil(parsedIn["lat"])
    }

    func testBuildCrashCancelRoundTrips() throws {
        let json = buildCrashCancel(incidentId: "i4")
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashCancel)
        XCTAssertEqual(parsed["incidentId"] as? String, "i4")
    }
}
