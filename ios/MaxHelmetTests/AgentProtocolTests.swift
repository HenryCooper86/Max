import XCTest
@testable import MaxHelmet

final class AgentProtocolTests: XCTestCase {

    func testParsesWeatherEventWithFallbacks() {
        let event = parseAgentEvent("""
        {
          "type": "weather",
          "description": "小雨",
          "temperatureC": 18,
          "windSpeedKmh": 24,
          "isDay": false,
          "riskLevel": "caution"
        }
        """)

        guard case let .weatherUpdate(weather) = event else {
            return XCTFail("Expected weather event")
        }
        XCTAssertEqual(weather.description, "小雨")
        XCTAssertEqual(weather.temperatureC, 18)
        XCTAssertEqual(weather.windSpeedKmh, 24)
        XCTAssertFalse(weather.isDay)
        XCTAssertEqual(weather.riskLevel, .caution)
        XCTAssertFalse(weather.riderAdvice.isEmpty)
    }

    func testBuildSessionStartMatchesRelayContract() throws {
        let json = buildSessionStart(
            voiceGender: .male,
            voicePersonality: .technical,
            rideMode: .emergency,
            scenario: .wind,
            lat: 31.2304,
            lon: 121.4737,
            testerId: "ios-rider",
            testerRegion: "Asia/Shanghai",
            testingCampaignId: "safety-regression",
            testingTestCaseId: "emergency-safe-guidance",
            appVersion: "1.2.3",
            gitCommit: "abcdef0",
            deviceLabel: "iPhone iOS 18",
            browserLanguage: "zh_CN",
            networkType: "ios-native"
        )
        let data = try XCTUnwrap(json.data(using: .utf8))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(payload["type"] as? String, "session.start")
        XCTAssertEqual(payload["sampleRate"] as? Int, MicStreamer.sampleRate)
        XCTAssertEqual(payload["channels"] as? Int, 1)
        XCTAssertEqual(payload["voiceGender"] as? String, "male")
        XCTAssertEqual(payload["voicePersonality"] as? String, "technical")
        XCTAssertEqual(payload["rideMode"] as? String, "emergency")
        XCTAssertEqual(payload["scenario"] as? String, "wind")
        XCTAssertEqual(payload["testerId"] as? String, "ios-rider")
        XCTAssertEqual(payload["testerRegion"] as? String, "Asia/Shanghai")
        XCTAssertEqual(payload["testingCampaignId"] as? String, "safety-regression")
        XCTAssertEqual(payload["testingTestCaseId"] as? String, "emergency-safe-guidance")
        XCTAssertEqual(payload["appVersion"] as? String, "1.2.3")
        XCTAssertEqual(payload["gitCommit"] as? String, "abcdef0")
        XCTAssertEqual(payload["deviceLabel"] as? String, "iPhone iOS 18")
        XCTAssertEqual(payload["browserLanguage"] as? String, "zh_CN")
        XCTAssertEqual(payload["networkType"] as? String, "ios-native")
        XCTAssertEqual(payload["lat"] as? Double, 31.2304)
        XCTAssertEqual(payload["lon"] as? Double, 121.4737)
    }

    func testParsesServerIssuedTranscriptIdentifiers() {
        let event = parseAgentEvent("""
        {
          "type": "transcript",
          "turnId": "turn-1",
          "deliveryId": "delivery-1",
          "speaker": "agent",
          "text": "前方畅通。",
          "final": true
        }
        """)

        guard case let .transcript(turnId, deliveryId, speaker, text, final, _) = event else {
            return XCTFail("Expected transcript event")
        }
        XCTAssertEqual(turnId, "turn-1")
        XCTAssertEqual(deliveryId, "delivery-1")
        XCTAssertEqual(speaker, .agent)
        XCTAssertEqual(text, "前方畅通。")
        XCTAssertTrue(final)
    }

    func testTranscriptNormalizationDedupesMixedPunctuation() {
        XCTAssertEqual(
            normalizeTranscriptText(" Max：保持 30 km/h！"),
            normalizeTranscriptText("max 保持30km h")
        )
    }

    func testTranscriptExportIncludesStableTurnFields() throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let items = [
            TranscriptItem(id: 1, turnId: "turn-1", deliveryId: "delivery-1", at: date, speaker: .rider, text: "天气怎么样？", final: true, language: "zh"),
            TranscriptItem(id: 2, at: date, speaker: .agent, text: "风有点大，放缓一点。", final: true, language: "zh")
        ]

        let json = buildTranscriptExportJSON(items)
        let data = try XCTUnwrap(json.data(using: .utf8))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let turns = try XCTUnwrap(payload["turns"] as? [[String: Any]])

        XCTAssertEqual(turns.count, 2)
        XCTAssertEqual(turns[0]["id"] as? Int, 1)
        XCTAssertEqual(turns[0]["turnId"] as? String, "turn-1")
        XCTAssertEqual(turns[0]["deliveryId"] as? String, "delivery-1")
        XCTAssertEqual(turns[0]["speaker"] as? String, "rider")
        XCTAssertEqual(turns[0]["language"] as? String, "zh")
        XCTAssertEqual(turns[0]["final"] as? Bool, true)
        XCTAssertEqual(turns[0]["text"] as? String, "天气怎么样？")
        XCTAssertNotNil(payload["exportedAt"] as? String)
    }

    func testParsesTorchCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c1","action":"torch.set","args":{"on":true},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.commandId, "c1")
        XCTAssertEqual(command.tier, .low)
        XCTAssertEqual(command.action, .torchSet(on: true))
    }

    func testParsesCallCommandWithName() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c2","action":"call.dial","args":{"name":"老王"},"tier":"high"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.tier, .high)
        XCTAssertEqual(command.action, .callDial(name: "老王", number: nil))
    }

    func testParsesMusicCommandWithNamedApp() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c3","action":"music.control","args":{"control":"play","app":"网易云音乐"},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .musicControl(control: .play, app: "网易云音乐"))
    }

    func testIgnoresUnknownActionRatherThanCrashing() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c4","action":"camera.record","args":{},"tier":"high"}
        """)
        guard case .unhandled = event else { return XCTFail("Expected unhandled for an unknown action") }
    }

    func testBuildsDeviceResult() throws {
        let json = buildDeviceResult(commandId: "c5", result: .denied("unsafe.speed", "骑行中"))
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        XCTAssertEqual(parsed["type"] as? String, "device.result")
        XCTAssertEqual(parsed["commandId"] as? String, "c5")
        XCTAssertEqual(parsed["status"] as? String, "denied")
        XCTAssertEqual(parsed["reason"] as? String, "unsafe.speed")
        XCTAssertEqual(parsed["detail"] as? String, "骑行中")
    }

    func testBuildsMinimalOkResultWithoutOptionalKeys() throws {
        let json = buildDeviceResult(commandId: "c6", result: .ok)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        XCTAssertEqual(parsed["status"] as? String, "ok")
        XCTAssertNil(parsed["reason"])
        XCTAssertNil(parsed["detail"])
    }
}
