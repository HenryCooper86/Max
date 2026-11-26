import XCTest
@testable import MaxHelmet

final class AgentProtocolTests: XCTestCase {

    func testGeneratedProtocolIncludesRDKCompanionAndNavigationPrompts() {
        XCTAssertTrue(ClientEventTypes.all.contains(ClientEventTypes.navPrompt))
        XCTAssertTrue(ServerEventTypes.all.contains(ServerEventTypes.companionPairing))
        XCTAssertTrue(ServerEventTypes.all.contains(ServerEventTypes.phoneLocation))
        XCTAssertTrue(ServerEventTypes.all.contains(ServerEventTypes.phoneLocationStatus))
    }

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

    /// The relay counts a command with no answer as a failure after 8 s, so an action this
    /// app has never heard of (a newer relay's) is answered at once instead of dropped.
    func testUnknownActionIsAnsweredUnsupportedAtOnce() throws {
        let event = parseAgentEvent(#"{"type":"device.command","commandId":"c4","action":"vehicle.unlock","args":{},"tier":"high"}"#)
        guard case let .unsupportedDeviceCommand(commandId, reason) = event else {
            return XCTFail("Expected an unsupported device command, got \(event)")
        }
        XCTAssertEqual(commandId, "c4")
        XCTAssertEqual(reason, "action.unknown")
        let reply = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(buildDeviceResult(commandId: commandId, result: .unsupported(reason)).utf8)) as? [String: Any]
        )
        XCTAssertEqual(reply["type"] as? String, "device.result")
        XCTAssertEqual(reply["commandId"] as? String, "c4")
        XCTAssertEqual(reply["status"] as? String, "unsupported")
        XCTAssertEqual(reply["reason"] as? String, "action.unknown")
    }

    func testMalformedArgumentsAreRefusedInsteadOfDefaulted() {
        func refusal(_ action: String, _ args: String) -> String? {
            let json = #"{"type":"device.command","commandId":"c","action":"\#(action)","args":\#(args),"tier":"low"}"#
            guard case let .unsupportedDeviceCommand(_, reason) = parseAgentEvent(json) else { return nil }
            return reason
        }
        // A torch with no `on`, or one of the wrong kind, used to read as "off". The numbers 0 and
        // 1 are not booleans either, though JSONSerialization bridges them to Bool.
        for args in [#"{}"#, #"{"on":"true"}"#, #"{"on":1}"#, #"{"on":0}"#] {
            XCTAssertEqual(refusal("torch.set", args), "action.invalid", args)
        }
        // A recording with no `start` used to read as "stop".
        XCTAssertEqual(refusal("camera.record", "{}"), "action.invalid")
        XCTAssertEqual(refusal("music.control", #"{"control":"play","app":3}"#), "action.invalid")
        // A missing or misshapen envelope is malformed too: the relay still gets its one result.
        for json in [
            #"{"type":"device.command","commandId":"c","action":"torch.set"}"#,
            #"{"type":"device.command","commandId":"c","action":"torch.set","args":"on","tier":"low"}"#
        ] {
            guard case let .unsupportedDeviceCommand(_, reason) = parseAgentEvent(json) else {
                return XCTFail("Expected an answer for \(json)")
            }
            XCTAssertEqual(reason, "action.invalid", json)
        }
    }

    /// A command id the relay's own device.result check refuses cannot be answered; sending
    /// one would only draw an error back.
    func testACommandIdTheRelayWouldRefuseIsNotAnswered() {
        let overlong = String(repeating: "x", count: 121)
        for json in [
            #"{"type":"device.command","commandId":"","action":"torch.set","args":{},"tier":"low"}"#,
            #"{"type":"device.command","commandId":"  ","action":"torch.set","args":{},"tier":"low"}"#,
            #"{"type":"device.command","commandId":"\#(overlong)","action":"vehicle.unlock","args":{},"tier":"low"}"#
        ] {
            guard case .unhandled = parseAgentEvent(json) else { return XCTFail("Expected no answer for \(json)") }
        }
        // At the relay's limit the answer still goes out.
        let atLimit = String(repeating: "x", count: 120)
        guard case .unsupportedDeviceCommand = parseAgentEvent(
            #"{"type":"device.command","commandId":"\#(atLimit)","action":"vehicle.unlock","args":{},"tier":"low"}"#
        ) else { return XCTFail("Expected an answer at the relay's limit") }
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

    func testParsesCameraPhotoCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"p1","action":"camera.photo","args":{},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .cameraPhoto)
    }

    func testParsesCameraRecordCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"r1","action":"camera.record","args":{"start":true},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .cameraRecord(start: true))
    }

    func testParsesGalleryOpenCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"g1","action":"gallery.open","args":{},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .galleryOpen)
    }

    func testParsesNavigationStartCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"n1","action":"navigation.start","args":{"query":"天安门"},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .navigationStart(query: "天安门"))
    }

    func testParsesNavigationStopCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"n2","action":"navigation.stop","args":{},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .navigationStop)
    }

    // MARK: - resuming, lifecycle events and the protocol version

    func testSessionStartCarriesResumeOnlyWhenGiven() throws {
        func payload(_ resume: String?) throws -> [String: Any] {
            let json = buildSessionStart(
                voiceGender: .female, voicePersonality: .concise, rideMode: .ride, scenario: .commute,
                lat: nil, lon: nil, resume: resume
            )
            return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        }
        // A new conversation leaves it out; only a reconnect sends the id back.
        XCTAssertNil(try payload(nil)["resume"])
        XCTAssertNil(try payload("")["resume"], "an empty id is not sent")
        XCTAssertEqual(try payload("rsm_Zk3p0xT1q8mYVw2n5HcA9rUe7LdJbG4s")["resume"] as? String, "rsm_Zk3p0xT1q8mYVw2n5HcA9rUe7LdJbG4s")
    }

    func testSessionStartedKeepsTheResumeIdAndTheRelayProtocol() {
        guard case let .sessionStarted(_, _, _, resume, relayProtocol) = parseAgentEvent(
            #"{"type":"session.started","provider":"openai","mode":"live","capabilities":{},"protocol":2,"resume":"rsm_abc"}"#
        ) else { return XCTFail("Expected session.started") }
        XCTAssertEqual(resume, "rsm_abc")
        XCTAssertEqual(relayProtocol, 2)
        // A relay older than resumption and the version handshake says neither.
        guard case let .sessionStarted(_, _, _, olderResume, olderProtocol) = parseAgentEvent(
            #"{"type":"session.started","provider":"openai","mode":"live","capabilities":{}}"#
        ) else { return XCTFail("Expected session.started") }
        XCTAssertNil(olderResume)
        XCTAssertNil(olderProtocol)
    }

    func testSessionStartedKeepsOnlyAResumeIdThatCanBeSentBack() {
        for json in [
            #"{"type":"session.started","provider":"openai","mode":"live","capabilities":{},"resume":""}"#,
            #"{"type":"session.started","provider":"openai","mode":"live","capabilities":{},"resume":17}"#
        ] {
            guard case let .sessionStarted(_, _, _, resume, _) = parseAgentEvent(json) else { return XCTFail("Expected session.started") }
            XCTAssertNil(resume, json)
        }
    }

    func testSessionStartedReadsTheRelayProtocolOnlyAsANumber() {
        func relayProtocol(_ value: String) -> Int? {
            guard case let .sessionStarted(_, _, _, _, version) = parseAgentEvent(
                #"{"type":"session.started","provider":"openai","mode":"live","capabilities":{},"protocol":\#(value)}"#
            ) else { return nil }
            return version
        }
        XCTAssertEqual(relayProtocol("1"), 1)
        XCTAssertEqual(relayProtocol("2"), 2)
        XCTAssertEqual(relayProtocol("2.0"), 2, "a version written as a decimal still counts")
        XCTAssertNil(relayProtocol("2.5"), "not a version")
        XCTAssertNil(relayProtocol(#""2""#), "a string is not a version")
        XCTAssertNil(relayProtocol("true"), "a boolean is not a version")
    }

    func testParsesSessionEndedAndAgentChanged() {
        guard case let .sessionEnded(reason) = parseAgentEvent(#"{"type":"session.ended","reason":"max_duration"}"#) else {
            return XCTFail("Expected session.ended")
        }
        XCTAssertEqual(reason, "max_duration")
        guard case let .agentChanged(agent) = parseAgentEvent(#"{"type":"agent.changed","agent":"billing"}"#) else {
            return XCTFail("Expected agent.changed")
        }
        XCTAssertEqual(agent, "billing")
        // A reason that is not a string still ends the conversation, without a named cause.
        guard case let .sessionEnded(unnamed) = parseAgentEvent(#"{"type":"session.ended","reason":null}"#) else {
            return XCTFail("Expected session.ended")
        }
        XCTAssertEqual(unnamed, "ended")
        // An agent that is not a name is no event.
        guard case .unhandled = parseAgentEvent(#"{"type":"agent.changed","agent":""}"#) else { return XCTFail("Expected unhandled") }
    }

    func testARelayEndedConversationSaysWhyWithoutShowingRelayText() {
        XCTAssertEqual(relayEndedStatusText("idle"), L("st.idleEnded"))
        XCTAssertEqual(relayEndedStatusText("agent"), L("st.endedByAgent"))
        XCTAssertEqual(relayEndedStatusText("max_duration"), L("st.endedMaxDuration"))
        // A reason from a newer relay is still an end, worded generally; the text itself is never shown.
        let unknown = relayEndedStatusText("something new")
        XCTAssertEqual(unknown, L("st.endedByRelay"))
        XCTAssertNotEqual(unknown, "something new")

        let ended = FinalRelayClose.conversationEnded(reason: "agent")
        XCTAssertEqual(ended.statusText, L("st.endedByAgent"))
        XCTAssertFalse(ended.isFailure, "a conversation the relay ended is not a failure")
        XCTAssertFalse(FinalRelayClose.idleEnded.isFailure)
        XCTAssertTrue(FinalRelayClose.minutesUsedUp.isFailure)
        XCTAssertTrue(FinalRelayClose.credentialsRejected.isFailure)
    }

    func testSessionStartDeclaresTheProtocolVersionItIsComparedAgainst() throws {
        let json = buildSessionStart(
            voiceGender: .female, voicePersonality: .concise, rideMode: .ride, scenario: .commute,
            lat: nil, lon: nil
        )
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(payload["protocol"] as? Int, protocolVersion)
    }
}

final class VoiceProviderProtocolTests: XCTestCase {
    private func start(voiceProvider: String?) -> [String: Any] {
        let json = buildSessionStart(
            voiceGender: .female, voicePersonality: .concise, rideMode: .ride,
            scenario: .commute, lat: nil, lon: nil, voiceProvider: voiceProvider
        )
        return (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    }

    func testVoiceProviderIsOmittedWhenNilAndSentWhenSet() {
        XCTAssertNil(start(voiceProvider: nil)["voiceProvider"])
        XCTAssertEqual(start(voiceProvider: "openai")["voiceProvider"] as? String, "openai")
    }

    func testHealthParsesBrandingAndVoice() {
        let json = """
        {"assistant":{"name":"Nova","device":"glasses","wakePhrase":"hey nova","accentColor":"#112233"},
         "voice":{"active":"mock","switching":true,"providers":[
           {"id":"mock","label":"Demo","kind":"demo","configured":true},
           {"id":"openai","label":"OpenAI","kind":"live","configured":false,"description":"d"}]}}
        """
        let health = RelayHealthClient.parse(data: Data(json.utf8))
        XCTAssertEqual(health?.branding.name, "Nova")
        XCTAssertEqual(health?.voice?.providers.count, 2)
        XCTAssertEqual(health?.voice?.providers[1].configured, false)
        XCTAssertEqual(health?.voice?.activeLabel, "Demo")
        let theme = VisorTheme()
        theme.apply(health!.branding)
        XCTAssertEqual(theme.assistantName, "Nova")
        XCTAssertEqual(theme.deviceKind, .glasses)
        XCTAssertEqual(theme.wakePhrase, "hey nova")
        XCTAssertEqual(VisorTheme.parseHex("#112233"), 0x112233)
        XCTAssertNil(VisorTheme.parseHex("nope"))
    }
}
