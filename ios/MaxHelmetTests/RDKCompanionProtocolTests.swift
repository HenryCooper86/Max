import Foundation
import XCTest
@testable import MaxHelmet

final class RDKCompanionProtocolTests: XCTestCase {
    func testParsesEveryStatusAndMapsDeviceLabel() {
        let cases: [(String, CompanionConnectionState)] = [
            ("unpaired", .unpaired),
            ("paired", .paired(deviceId: "rdk-1", label: "Road helmet")),
            ("helmetOffline", .helmetOffline(deviceId: "rdk-1", label: "Road helmet")),
            ("ready", .ready(deviceId: "rdk-1", label: "Road helmet")),
            ("sharing", .sharing(deviceId: "rdk-1", label: "Road helmet"))
        ]

        for (wireState, expected) in cases {
            let identity = wireState == "unpaired" ? "" : ",\"deviceId\":\"rdk-1\",\"deviceLabel\":\"Road helmet\""
            XCTAssertEqual(
                RDKCompanionProtocol.parseServerMessage(.string("{\"type\":\"companion.status\",\"state\":\"\(wireState)\"\(identity)}")),
                expected
            )
        }
    }

    func testParsesOptionalIdentityAndCompanionError() {
        XCTAssertEqual(
            RDKCompanionProtocol.parseServerMessage(.string("{\"type\":\"companion.status\",\"state\":\"ready\"}")),
            .ready(deviceId: nil, label: nil)
        )
        XCTAssertEqual(
            RDKCompanionProtocol.parseServerMessage(.string("{\"type\":\"companion.error\",\"code\":\"pair.code\",\"detail\":\"Expired\"}")),
            .failed(code: "pair.code", detail: "Expired")
        )
    }

    func testRejectsMalformedUnknownBinaryAndInvalidFieldsWithoutPartialState() {
        let invalid: [URLSessionWebSocketTask.Message] = [
            .string("not json"),
            .string("[]"),
            .string("{\"type\":\"companion.status\"}"),
            .string("{\"type\":\"companion.status\",\"state\":\"flying\"}"),
            .string("{\"type\":\"companion.status\",\"state\":\"ready\",\"deviceId\":7}"),
            .string("{\"type\":\"companion.error\",\"code\":\"auth\"}"),
            .string("{\"type\":\"companion.error\",\"code\":\"auth\",\"detail\":1e400}"),
            .string("{\"type\":\"other\"}"),
            .data(Data("{\"type\":\"companion.status\",\"state\":\"ready\"}".utf8))
        ]

        for message in invalid {
            XCTAssertNil(RDKCompanionProtocol.parseServerMessage(message))
        }
    }

    func testSerializesExactActionFieldSetsAndTrimsPairCode() throws {
        let messages = [
            try XCTUnwrap(RDKCompanionProtocol.pairMessage(code: "  S8NM5R  ")),
            RDKCompanionProtocol.startMessage(),
            RDKCompanionProtocol.stopMessage(),
            RDKCompanionProtocol.unpairMessage()
        ]
        let expected: [[String: AnyHashable]] = [
            ["type": "companion.pair", "code": "S8NM5R"],
            ["type": "companion.start"],
            ["type": "companion.stop"],
            ["type": "companion.unpair"]
        ]

        for (message, expectedObject) in zip(messages, expected) {
            XCTAssertEqual(try object(from: message) as NSDictionary, expectedObject as NSDictionary)
        }
        XCTAssertNil(RDKCompanionProtocol.pairMessage(code: " \n "))
        XCTAssertNil(RDKCompanionProtocol.pairMessage(code: String(repeating: "码", count: 41)))
    }

    func testSerializesExactLocationAndOmitsNilOptionalValues() throws {
        let fix = CompanionFix(
            sequence: 7,
            latitude: 31.2304,
            longitude: 121.4737,
            horizontalAccuracyMeters: 4.5,
            timestampMilliseconds: 1_700_000_000_125,
            courseDegrees: nil,
            speedMps: nil
        )
        let message = try XCTUnwrap(RDKCompanionProtocol.locationMessage(fix))
        let payload = try object(from: message)

        XCTAssertEqual(payload["type"] as? String, "companion.location")
        XCTAssertEqual(payload["sequence"] as? Int, 7)
        XCTAssertEqual(payload["lat"] as? Double, 31.2304)
        XCTAssertEqual(payload["lon"] as? Double, 121.4737)
        XCTAssertEqual(payload["horizontalAccuracyMeters"] as? Double, 4.5)
        XCTAssertEqual(payload["timestamp"] as? Double, 1_700_000_000_125)
        XCTAssertNil(payload["courseDegrees"])
        XCTAssertNil(payload["speedMps"])
        XCTAssertEqual(payload.count, 6)
    }

    func testSerializesFiniteOptionalLocationValuesAndRejectsInvalidFixes() throws {
        let valid = CompanionFix(
            sequence: 1,
            latitude: -90,
            longitude: 180,
            horizontalAccuracyMeters: 0,
            timestampMilliseconds: 0,
            courseDegrees: 360,
            speedMps: 0
        )
        let payload = try object(from: XCTUnwrap(RDKCompanionProtocol.locationMessage(valid)))
        XCTAssertEqual(payload["courseDegrees"] as? Double, 360)
        XCTAssertEqual(payload["speedMps"] as? Double, 0)

        let invalid = [
            CompanionFix(sequence: 0, latitude: 0, longitude: 0, horizontalAccuracyMeters: 1, timestampMilliseconds: 1, courseDegrees: nil, speedMps: nil),
            CompanionFix(sequence: 1, latitude: 91, longitude: 0, horizontalAccuracyMeters: 1, timestampMilliseconds: 1, courseDegrees: nil, speedMps: nil),
            CompanionFix(sequence: 1, latitude: 0, longitude: -.infinity, horizontalAccuracyMeters: 1, timestampMilliseconds: 1, courseDegrees: nil, speedMps: nil),
            CompanionFix(sequence: 1, latitude: 0, longitude: 0, horizontalAccuracyMeters: -1, timestampMilliseconds: 1, courseDegrees: nil, speedMps: nil),
            CompanionFix(sequence: 1, latitude: 0, longitude: 0, horizontalAccuracyMeters: 1, timestampMilliseconds: .nan, courseDegrees: nil, speedMps: nil),
            CompanionFix(sequence: 1, latitude: 0, longitude: 0, horizontalAccuracyMeters: 1, timestampMilliseconds: 1, courseDegrees: -1, speedMps: nil),
            CompanionFix(sequence: 1, latitude: 0, longitude: 0, horizontalAccuracyMeters: 1, timestampMilliseconds: 1, courseDegrees: nil, speedMps: -.infinity)
        ]
        for fix in invalid {
            XCTAssertNil(RDKCompanionProtocol.locationMessage(fix))
        }
    }

    func testBuildsCompanionURLWithOnlyTrimmedToken() throws {
        let url = try XCTUnwrap(RDKCompanionClient.companionURL(
            fromRelay: "  wss://relay.example:9443/agent/old?token=old&debug=1#voice  ",
            sessionToken: "  account token/+  "
        ))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))

        XCTAssertEqual(components.scheme, "wss")
        XCTAssertEqual(components.host, "relay.example")
        XCTAssertEqual(components.port, 9443)
        XCTAssertEqual(components.path, "/companion")
        XCTAssertEqual(components.fragment, nil)
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "token", value: "account token/+")])
    }

    func testCompanionURLRejectsInvalidRelayOrEmptyToken() {
        XCTAssertNil(RDKCompanionClient.companionURL(fromRelay: "https://relay.example/agent", sessionToken: "token"))
        XCTAssertNil(RDKCompanionClient.companionURL(fromRelay: "ws:///agent", sessionToken: "token"))
        XCTAssertNil(RDKCompanionClient.companionURL(fromRelay: "not a url", sessionToken: "token"))
        XCTAssertNil(RDKCompanionClient.companionURL(fromRelay: "ws://relay.example/agent", sessionToken: " \n "))
    }

    private func object(from message: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any])
    }
}
