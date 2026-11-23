import XCTest
@testable import MaxHelmet

final class VideoInputTests: XCTestCase {

    // MARK: - session.started capabilities

    func testSessionStartedSaysWhetherTheSessionTakesVideo() {
        func capabilities(_ json: String) -> ProviderCapabilities? {
            let event = parseAgentEvent(#"{"type":"session.started","provider":"openai","mode":"live","capabilities":\#(json)}"#)
            guard case let .sessionStarted(_, _, capabilities) = event else { return nil }
            return capabilities
        }
        XCTAssertEqual(capabilities(#"{"textInput":true,"imageInput":true,"videoInput":true}"#)?.videoInput, true)
        XCTAssertEqual(capabilities(#"{"textInput":true,"imageInput":true,"videoInput":false}"#)?.videoInput, false)
        // A relay older than live video does not say, and does not take it.
        XCTAssertEqual(capabilities(#"{"textInput":true,"imageInput":true}"#)?.videoInput, false)
    }

    func testTheCameraButtonIsThereWhenVideoCouldBeSent() {
        var capabilities = ProviderCapabilities()
        capabilities.textInput = true
        XCTAssertFalse(liveVideoVisible(capabilities: capabilities, connection: .ready))
        capabilities.videoInput = true
        XCTAssertTrue(liveVideoVisible(capabilities: capabilities, connection: .ready))
        XCTAssertFalse(liveVideoVisible(capabilities: capabilities, connection: .connecting))
    }

    // MARK: - video.frame and video.stop

    private func event(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    func testAFrameCarriesAJPEGAndNothingElse() throws {
        var video = LiveVideoState()
        XCTAssertTrue(video.begin(supported: true, ready: true))
        let frame = try event(video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 10).get())
        XCTAssertEqual(frame["type"] as? String, "video.frame")
        XCTAssertEqual(frame["image"] as? String, "QUJD")
        XCTAssertEqual(frame["mimeType"] as? String, "image/jpeg")
        XCTAssertEqual(frame.count, 3)
        XCTAssertEqual(try event(videoStopEvent)["type"] as? String, "video.stop")
    }

    func testAFrameTooLongForTheRelayIsNotSent() {
        var video = LiveVideoState()
        _ = video.begin(supported: true, ready: true)
        let tooLong = String(repeating: "A", count: imageInputMaxBase64Chars + 1)
        XCTAssertEqual(video.frameEvent(jpegBase64: tooLong, supported: true, ready: true, now: 1), .failure(.unreadable))
        XCTAssertEqual(video.frameEvent(jpegBase64: "", supported: true, ready: true, now: 1), .failure(.unreadable))
    }

    // MARK: - pacing

    func testNoFrameGoesLessThan500msAfterTheLastAndOneAGoesEverySecond() {
        var video = LiveVideoState()
        _ = video.begin(supported: true, ready: true)
        func sends(_ now: TimeInterval) -> Bool {
            (try? video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: now).get()) != nil
        }
        XCTAssertTrue(sends(100))
        XCTAssertFalse(sends(100.1))
        XCTAssertFalse(sends(100.499))
        XCTAssertEqual(video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 100.2), .failure(.tooFast))
        XCTAssertTrue(sends(100.5))
        // The once-a-second tick sends every time.
        for second in 1...5 { XCTAssertTrue(sends(100.5 + Double(second))) }
    }

    func testFramesDoNotTouchThePictureBudget() {
        var limiter = ImageInputLimiter()
        var video = LiveVideoState()
        _ = video.begin(supported: true, ready: true)
        for second in 0..<(imageInputMaxPerConnection + 20) {
            XCTAssertNotNil(try? video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: Double(second)).get())
        }
        // More frames than a connection may have pictures, and a picture still goes, at once.
        XCTAssertNil(limiter.rejection(at: 0))
        limiter.didSend(at: 0)
        XCTAssertEqual(limiter.rejection(at: 0.5), .tooFast)
        // And a picture just sent does not slow a frame.
        XCTAssertNotNil(try? video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 1_000).get())
    }

    // MARK: - fitting a frame

    func testAFrameIsScaledTo768AndTriedAt60ThenAt45Percent() {
        var asked: [[Int]] = []
        let tooLong = String(repeating: "A", count: imageInputMaxBase64Chars + 1)
        let fitted = encodeVideoFrame(width: 1920, height: 1080) { width, height, quality in
            asked.append([width, height, Int((quality * 100).rounded())])
            return quality <= 0.45 ? "fits" : tooLong
        }
        XCTAssertEqual(fitted, "fits")
        XCTAssertEqual(asked, [[768, 432, 60], [768, 432, 45]])
        asked = []
        // A small frame is not made larger.
        _ = encodeVideoFrame(width: 320, height: 240) { width, height, quality in asked.append([width, height, Int((quality * 100).rounded())]); return "ok" }
        XCTAssertEqual(asked, [[320, 240, 60]])
    }

    func testAFrameThatStillDoesNotFitIsSkippedNotShrunk() {
        var tries = 0
        let tooLong = String(repeating: "A", count: imageInputMaxBase64Chars + 1)
        XCTAssertNil(encodeVideoFrame(width: 1920, height: 1080) { _, _, _ in tries += 1; return tooLong })
        XCTAssertEqual(tries, 2)
        XCTAssertNil(encodeVideoFrame(width: 0, height: 10) { _, _, _ in "ok" })
        XCTAssertNil(encodeVideoFrame(width: 100, height: 100) { _, _, _ in nil })
    }

    // MARK: - when it stops

    func testTurningTheVideoOffSendsStopOnceAndFramesStop() {
        var video = LiveVideoState()
        XCTAssertTrue(video.begin(supported: true, ready: true))
        XCTAssertTrue(video.end(ready: true))
        XCTAssertFalse(video.active)
        XCTAssertEqual(video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 1), .failure(.inactive))
        // Off already: nothing more to tell the relay.
        XCTAssertFalse(video.end(ready: true))
    }

    func testStopIsNotSentWhenTheSocketIsNotReady() {
        var video = LiveVideoState()
        _ = video.begin(supported: true, ready: true)
        XCTAssertFalse(video.end(ready: false))
        XCTAssertFalse(video.active)
    }

    func testAReconnectWithoutVideoInputEndsTheVideoAndSaysSo() {
        var video = LiveVideoState()
        _ = video.begin(supported: true, ready: true)
        XCTAssertTrue(video.sessionStarted(videoInput: false))
        XCTAssertFalse(video.active)
        XCTAssertEqual(video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 5), .failure(.inactive))
    }

    func testAReconnectThatTakesVideoLeavesItOnAndStartsThePacingAfresh() {
        var video = LiveVideoState()
        _ = video.begin(supported: true, ready: true)
        XCTAssertNotNil(try? video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 50).get())
        XCTAssertFalse(video.sessionStarted(videoInput: true))
        XCTAssertTrue(video.active)
        XCTAssertNotNil(try? video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 50.1).get())
        // With no video on, a session.started has nothing to stop.
        var off = LiveVideoState()
        XCTAssertFalse(off.sessionStarted(videoInput: false))
    }

    // MARK: - nothing without a connection

    func testNothingIsSentWhileNotConnectedOrWhenTheSessionTakesNoVideo() {
        var video = LiveVideoState()
        XCTAssertFalse(video.begin(supported: true, ready: false))
        XCTAssertFalse(video.begin(supported: false, ready: true))
        XCTAssertFalse(video.active)
        XCTAssertEqual(video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 1), .failure(.inactive))
        _ = video.begin(supported: true, ready: true)
        XCTAssertEqual(video.frameEvent(jpegBase64: "QUJD", supported: true, ready: false, now: 1), .failure(.notReady))
        XCTAssertEqual(video.frameEvent(jpegBase64: "QUJD", supported: false, ready: true, now: 1), .failure(.unsupported))
        // A refused frame does not use up the pacing.
        XCTAssertNotNil(try? video.frameEvent(jpegBase64: "QUJD", supported: true, ready: true, now: 1.1).get())
    }

    @MainActor func testTheSessionSendsNoFrameWhileItIsNotConnected() {
        let session = AgentSession()
        guard case let .failure(reason) = session.sendVideoFrame(jpegBase64: "QUJD", now: 1) else { return XCTFail("sent") }
        XCTAssertEqual(reason, .inactive)
        XCTAssertFalse(session.state.liveVideo)
    }

    // MARK: - what the user is told

    func testTheNoteSaysWhyTheCameraDidNotComeOn() {
        XCTAssertNil(videoNoteText(.started))
        XCTAssertEqual(videoNoteText(.denied), L("video.denied"))
        XCTAssertEqual(videoNoteText(.unavailable), L("video.unavailable"))
        XCTAssertEqual(videoNoteText(.notReady), L("video.notReady"))
    }

    // MARK: - a real frame

    func testAnUnseeableFrameBecomesAJPEGThatFits() throws {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, 1920, 1080, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        let base64 = try XCTUnwrap(jpegBase64ForVideoFrame(pixels))
        XCTAssertLessThanOrEqual(base64.utf8.count, imageInputMaxBase64Chars)
        let data = try XCTUnwrap(Data(base64Encoded: base64))
        XCTAssertEqual([UInt8](data.prefix(3)), [0xFF, 0xD8, 0xFF])
        let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual(image.width, 768)
        XCTAssertEqual(image.height, 432)
    }

    func testThereIsNoCameraOnTheSimulatorAndItSaysSoSoftly() async throws {
        #if targetEnvironment(simulator)
        let result = await VideoCamera().start()
        XCTAssertEqual(result, .unavailable)
        #endif
    }
}
