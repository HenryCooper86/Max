import AVFoundation
import CoreLocation
import CryptoKit
import SwiftUI
import UIKit
import XCTest
@testable import MaxHelmet

#if DEBUG
/// Opt-in real relay integration. Fixtures are synthetic PCM, never microphone capture.
/// The private host directory is supplied by scripts/run-synthetic-audio-qa.sh.
@MainActor
final class SyntheticAudioLiveTests: XCTestCase {
    func testSyntheticStartupRequiresNoCapturePermissionAndUsesProductionTeardown() throws {
        let session = AgentSession()
        let permission = AVAudioApplication.shared.recordPermission
        let location = CLLocationManager().authorizationStatus
        try session.prepareSyntheticAudioQA()
        defer { session.finishSyntheticAudioQA() }
        XCTAssertEqual(AVAudioApplication.shared.recordPermission, permission)
        XCTAssertEqual(CLLocationManager().authorizationStatus, location)
        XCTAssertFalse(session.state.handsFree)
        XCTAssertFalse(session.syntheticAudioQACaptureRunning)
        XCTAssertFalse(session.sendSyntheticAudioQAFrame(Data(repeating: 0, count: 640)), "An inactive session must not transmit synthetic input")
    }
}
#endif

#if DEBUG
extension SyntheticAudioLiveTests {
    func testOutputCompletionConfirmsFullPlaybackDrainAndInterruptionFlushesQueue() async throws {
        let permission = AVAudioApplication.shared.recordPermission
        let engine = AVAudioEngine()
        let player = PcmPlayer(engine: engine)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try audio.setActive(true)
        player.prepare()
        engine.prepare()
        try engine.start()
        defer {
            player.release()
            engine.stop()
            try? audio.setActive(false)
            XCTAssertEqual(AVAudioApplication.shared.recordPermission, permission)
        }
        // Output-only silent PCM still passes through the actual AVAudioPlayerNode
        // and its device-latency-aware .dataPlayedBack completion.
        let pcm = Data(repeating: 0, count: 24_000)
        player.play(pcm)
        try await waitFor(4, "local output playback callback") {
            let value = player.syntheticAudioQASnapshot
            return value.playedBackBytes == pcm.count && value.pendingBytes == 0
        }
        XCTAssertEqual(player.syntheticAudioQASnapshot.scheduledBytes, pcm.count)
        player.play(Data(repeating: 0, count: 96_000))
        try await waitFor(2, "pending PCM before interruption") { player.syntheticAudioQASnapshot.pendingBytes > 0 }
        player.stopPlayback()
        XCTAssertEqual(player.syntheticAudioQASnapshot.interruptedAudio, 1)
        XCTAssertEqual(player.syntheticAudioQASnapshot.pendingBytes, 0)
    }

    func testEarlierRiderASRDoesNotInterruptLaterPCMWhenMainQueueIsBusy() async throws {
        let permission = AVAudioApplication.shared.recordPermission
        let session = AgentSession()
        try session.prepareSyntheticAudioQA()
        defer {
            session.finishSyntheticAudioQA()
            XCTAssertEqual(AVAudioApplication.shared.recordPermission, permission)
        }
        let asr = #"{"type":"transcript","turnId":"11111111-1111-4111-8111-111111111111","deliveryId":"22222222-2222-4222-8222-222222222222","speaker":"rider","text":"Max你好","final":true}"#
        session.deliverSyntheticAudioQAMessage(.string(asr))
        session.deliverSyntheticAudioQAMessage(.data(Data(repeating: 0, count: 24_000)))
        // Give a background renderer time to overtake the earlier queued ASR.
        // The production dispatcher must preserve wire order during this load.
        simulateBusyMainQueue()
        try await pause(1)
        XCTAssertEqual(session.state.transcript.first?.text, "Max你好")
        let value = session.syntheticAudioQAPlayback
        XCTAssertEqual(value.interruptedAudio, 0, "Earlier ASR must not cut audio that arrived later on the wire")
        XCTAssertEqual(value.discardedBytes, 0)
        XCTAssertEqual(value.scheduledBytes, 24_000)
        XCTAssertEqual(value.playedBackBytes, 24_000)
    }

    private func simulateBusyMainQueue() { Thread.sleep(forTimeInterval: 0.05) }

    struct Connection: Decodable {
        let url: String; let token: String; let build: String
        let runId: String?; let campaignId: String?; let testerId: String?
        let assignmentIds: [String: String]?
    }
    struct Manifest: Decodable {
        let sampleRate: Int; let channels: Int; let sampleFormat: String
        let fixtures: [String: Fixture]
    }
    struct Fixture: Decodable { let file: String; let text: String; let sha256: String }

    func testLiveBaseline() async throws { try await runCase("baseline-live-session", scenario: .commute, fixture: "baseline") }
    func testLiveWakeWord() async throws { try await runCase("wake-word-addressed-only", scenario: .commute, fixture: "wake-addressed") }
    func testLiveEmergency() async throws { try await runCase("emergency-safe-guidance", scenario: .emergency, fixture: "emergency") }
    func testLiveADAS() async throws { try await runCase("adas-alert-interrupt", scenario: .adas, fixture: "adas") }
    func testLiveWind() async throws { try await runCase("wind-noise-robustness", scenario: .wind, fixture: "wind") }
    func testLiveNetworkRecovery() async throws { try await runCase("degraded-network-recovery", scenario: .group, fixture: "network") }

    private func runCase(_ caseID: String, scenario: DemoScenario, fixture: String) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["MAX_SYNTHETIC_QA"] == "1" else { throw XCTSkip("Real-relay synthetic QA is opt-in.") }
        let directory = environment["MAX_SYNTHETIC_QA_DIR"] ?? "/tmp/max-synthetic-qa"
        let base = URL(fileURLWithPath: directory)
        let connection = try JSONDecoder().decode(Connection.self, from: Data(contentsOf: base.appendingPathComponent("connection.json")))
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: base.appendingPathComponent("manifest.json")))
        XCTAssertEqual(manifest.sampleRate, 16_000)
        XCTAssertEqual(manifest.channels, 1)
        XCTAssertEqual(manifest.sampleFormat, "s16le")
        guard manifest.sampleRate == 16_000, manifest.channels == 1, manifest.sampleFormat == "s16le" else {
            throw NSError(domain: "SyntheticAudioQA", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid synthetic PCM manifest format"])
        }
        // Validate the entire source corpus before opening any native socket.
        for (name, info) in manifest.fixtures {
            let bytes = try Data(contentsOf: base.appendingPathComponent(info.file))
            let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard hash == info.sha256, bytes.count > 0, bytes.count % 2 == 0 else {
                throw NSError(domain: "SyntheticAudioQA", code: 3, userInfo: [NSLocalizedDescriptionKey: "Synthetic fixture integrity failed: \(name)"])
            }
        }
        let repeats = Int(environment["MAX_SYNTHETIC_QA_REPEATS"] ?? "1") ?? 1
        for round in 1...repeats {
            try await execute(caseID, scenario: scenario, fixture: fixture, round: round, connection: connection, manifest: manifest, base: base)
        }
    }

    private func execute(_ caseID: String, scenario: DemoScenario, fixture: String, round: Int, connection: Connection, manifest: Manifest, base: URL) async throws {
        let runID = "ios-synth-\(caseID)-\(Int(Date().timeIntervalSince1970))-\(round)-\(UUID().uuidString.prefix(8))"
        let output = base.appendingPathComponent("ios-results", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let initialFailureCount = testRun?.failureCount ?? 0
        let start = Date()
        let session = AgentSession()
        var events: [[String: Any]] = []
        var transitions: [[String: Any]] = []
        var previousConnection: ConnectionState = .offline
        var hazardInterruptedLivePCM = false
        var hazardPlaybackSnapshots: [[String: Any]] = []
        var interruptedHazardGenerations = Set<Int>()
        var hazardsWithLivePCM = 0
        var framesAccepted = 0
        var outputDrainVerified = false
        var speechActiveBeforeProductionStop = false
        var outageObserved = false
        var recoveryObserved = false
        var failure: String?
        let permission = AVAudioApplication.shared.recordPermission
        let locationPermission = CLLocationManager().authorizationStatus
        let model = MainViewModel()
        let controller = UIHostingController(rootView: AgentScreen(viewModel: model, session: session))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        session.syntheticAudioQAEvent = { text in
            guard var event = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
            event["qaAtSeconds"] = Date().timeIntervalSince(start)
            events.append(event)
        }
        session.syntheticAudioQAHazardInterrupt = { pendingBefore, pendingAfter, countBefore, countAfter, generation in
            hazardPlaybackSnapshots.append(["hazardGeneration": generation, "atSeconds": Date().timeIntervalSince(start), "pendingBefore": pendingBefore, "pendingAfter": pendingAfter, "interruptionsBefore": countBefore, "interruptionsAfter": countAfter])
            if pendingBefore > 0 && countAfter == countBefore + 1 {
                hazardsWithLivePCM += 1
                hazardInterruptedLivePCM = true
                interruptedHazardGenerations.insert(generation)
            }
        }
        let observation = session.$state.sink { state in
            if state.connection != previousConnection {
                transitions.append(["connection": String(describing: state.connection), "atSeconds": Date().timeIntervalSince(start), "status": state.statusText])
                previousConnection = state.connection
            }
        }
        defer {
            if (testRun?.failureCount ?? 0) > initialFailureCount && failure == nil { failure = "XCTest behavioral assertion failed; see xcresult" }
            let playback = session.syntheticAudioQAPlayback
            let speech = session.syntheticAudioQASpeech
            let captureBeforeStop = session.syntheticAudioQACaptureRunning
            // Prove ordinary session.stop() before the harness's forced cleanup.
            session.stop()
            let productionStopPlayback = session.syntheticAudioQAPlayback
            let productionStopVerified = !session.state.handsFree && session.state.connection == .offline && !session.syntheticAudioQACaptureRunning && !session.syntheticAudioQAOutputRunning && !productionStopPlayback.playerArmed && !productionStopPlayback.nodePlaying && !session.syntheticAudioQASpeech.isSpeaking
            XCTAssertTrue(productionStopVerified, "Production stop must deactivate transport, capture and playback before harness cleanup")
            XCTAssertEqual(AVAudioApplication.shared.recordPermission, permission, "Teardown must not request capture permission")
            XCTAssertEqual(CLLocationManager().authorizationStatus, locationPermission)
            XCTAssertFalse(session.syntheticAudioQACaptureRunning)
            XCTAssertFalse(session.syntheticAudioQAOutputRunning)
            XCTAssertFalse(session.state.handsFree)
            XCTAssertEqual(session.state.connection, .offline)
            if (testRun?.failureCount ?? 0) > initialFailureCount && failure == nil { failure = "XCTest behavioral assertion failed; see xcresult" }
            let report: [String: Any] = [
                "testCaseId": caseID, "runId": runID, "platform": "ios", "round": round,
                "build": connection.build,
                "baseSourceCommit": ProcessInfo.processInfo.environment["MAX_SYNTHETIC_QA_BASE_SOURCE_COMMIT"] ?? "unrecorded",
                "qaOverlayRevision": ProcessInfo.processInfo.environment["MAX_SYNTHETIC_QA_OVERLAY_REVISION"] ?? "unrecorded",
                "nativeBundleSourceBuild": Bundle.main.infoDictionary?["MaxGitCommit"] as? String ?? "unknown",
                "releaseRunId": connection.runId ?? "", "assignmentId": connection.assignmentIds?[caseID] ?? "", "harness": "Debug XCTest; synthetic source; actual AgentSession URLSession transport, event parser, SwiftUI HUD and PcmPlayer output",
                "device": "\(UIDevice.current.model) \(UIDevice.current.systemName) \(UIDevice.current.systemVersion) Simulator",
                "fixture": fixture, "fixtureSha256": manifest.fixtures[fixture]?.sha256 ?? "unknown",
                "captureRunning": captureBeforeStop,
                "productionStopVerified": productionStopVerified,
                "receivedPCMBytes": speech.receivedPCMBytes,
                "fallbackSpeechAttempts": speech.attempts, "fallbackSpeechStarts": speech.starts,
                "speechWasActiveBeforeStop": speechActiveBeforeProductionStop,
                "postStopSynthesizerSpeaking": session.syntheticAudioQASpeech.isSpeaking,
                "postStopPlayerArmed": productionStopPlayback.playerArmed,
                "postStopNodePlaying": productionStopPlayback.nodePlaying,
                "postStopCaptureRunning": session.syntheticAudioQACaptureRunning,
                "postStopOutputRunning": session.syntheticAudioQAOutputRunning,
                "postStopHandsFree": session.state.handsFree,
                "postStopConnection": String(describing: session.state.connection),
                "microphonePermissionUnchanged": AVAudioApplication.shared.recordPermission == permission,
                "locationPermissionUnchanged": CLLocationManager().authorizationStatus == locationPermission,
                "framesAccepted": framesAccepted, "scheduledPCMBytes": playback.scheduledBytes,
                "playedBackPCMBytes": playback.playedBackBytes, "pcmInterruptions": playback.interruptedAudio,
                "discardedPCMBufferBytes": playback.discardedBytes, "outputDrainVerified": outputDrainVerified,
                "drainAccountingBalanced": playback.scheduledBytes == playback.playedBackBytes + playback.discardedBytes,
                "drainRawReceiveBalanced": speech.receivedPCMBytes > 0 && speech.receivedPCMBytes == playback.scheduledBytes,
                "hazardsWithLivePCM": hazardsWithLivePCM, "hazardInterruptedLivePCM": hazardInterruptedLivePCM,
                "hazardPlaybackSnapshots": hazardPlaybackSnapshots,
                "interruptedHazardGenerations": interruptedHazardGenerations.sorted(),
                "startedHazardSpeechGenerations": session.syntheticAudioQAHazardSpeechStarts.sorted(),
                "outageObserved": outageObserved, "recoveryObserved": recoveryObserved,
                "elapsedSeconds": Date().timeIntervalSince(start), "failure": failure ?? NSNull(),
                "events": events, "connectionTransitions": transitions,
                "transcript": session.state.transcript.map { ["speaker": $0.speaker.rawValue, "text": $0.text, "final": $0.final] }
            ]
            do {
                let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: output.appendingPathComponent(runID + ".json"), options: [.atomic])
            } catch {
                XCTFail("Failed to persist private native QA evidence: \(error)")
            }
            observation.cancel()
            session.finishSyntheticAudioQA()
            window.isHidden = true
        }
        do {
            try session.prepareSyntheticAudioQA()
            session.setScenario(scenario)
            session.start(url: connection.url, authToken: connection.token, allowSelfSignedTls: false,
                          testerId: connection.testerId ?? "ios-synthetic-native", testingCampaignId: connection.campaignId ?? "synthetic-native-live",
                          testingTestCaseId: caseID, testingRunId: connection.runId ?? runID,
                          testingAssignmentId: connection.assignmentIds?[caseID] ?? "")
            try await waitFor(25, "provider session readiness") { session.state.connection == .ready && session.state.isLive }
            XCTAssertEqual(session.state.provider, "doubao")
            XCTAssertFalse(session.sendSyntheticAudioQAFrame(Data(repeating: 0, count: 639)), "Reject incomplete wire frames")
            session.toggleMute()
            XCTAssertTrue(session.state.micMuted)
            XCTAssertFalse(session.sendSyntheticAudioQAFrame(Data(repeating: 0, count: 640)), "Synthetic input shares the production mute gate")
            session.toggleMute()
            XCTAssertFalse(session.state.micMuted)
            try await pause(1)
            if caseID == "wake-word-addressed-only" {
                let agentBefore = session.state.transcript.filter { $0.speaker == .agent }.count
                let bytesBefore = session.syntheticAudioQAPlayback.scheduledBytes
                let speechBefore = session.syntheticAudioQASpeech
                framesAccepted += try await stream("wake-background", manifest: manifest, base: base, session: session)
                framesAccepted += try await silence(5, session: session)
                XCTAssertEqual(session.state.transcript.filter { $0.speaker == .agent }.count, agentBefore, "Unaddressed speech must not trigger a reply")
                XCTAssertEqual(session.syntheticAudioQAPlayback.scheduledBytes, bytesBefore, "Unaddressed speech must stay quiet")
                let speechAfter = session.syntheticAudioQASpeech
                XCTAssertEqual(speechAfter.receivedPCMBytes, speechBefore.receivedPCMBytes, "Unaddressed speech must not receive raw provider audio")
                XCTAssertEqual(speechAfter.attempts, speechBefore.attempts, "Unaddressed speech must not invoke fallback speech")
                XCTAssertEqual(speechAfter.starts, speechBefore.starts, "Unaddressed speech must not start fallback speech")
                XCTAssertFalse(speechAfter.isSpeaking)
            }
            if caseID == "degraded-network-recovery" {
                // First complete exchange establishes a valid transport segment.
                framesAccepted += try await stream(fixture, manifest: manifest, base: base, session: session)
                framesAccepted += try await silence(2, session: session)
                try await waitFor(25, "complete reply before planned outage") {
                    session.state.transcript.contains { $0.speaker == .agent && $0.final }
                }
                try await waitFor(8, "PCM playback before planned outage") { session.syntheticAudioQAPlayback.playedBackBytes > 0 }
                try await waitForOutputDrain(session)
                session.dropSyntheticAudioQATransport()
                try await waitFor(5, "actual socket outage") { session.state.connection == .offline || session.state.connection == .connecting }
                outageObserved = true
                try await waitFor(25, "automatic production reconnect") {
                    events.filter { $0["type"] as? String == "session.started" }.count >= 2 && session.state.connection == .ready
                }
                recoveryObserved = true
            }
            let agentBefore = session.state.transcript.filter { $0.speaker == .agent && $0.final }.count
            framesAccepted += try await stream(fixture, manifest: manifest, base: base, session: session)
            framesAccepted += try await silence(2, session: session)
            if caseID == "adas-alert-interrupt" {
                try await waitFor(35, "relay hazard interrupting live PCM playback") { hazardInterruptedLivePCM }
                XCTAssertGreaterThan(hazardsWithLivePCM, 0)
                XCTAssertTrue(hazardInterruptedLivePCM)
                XCTAssertTrue(events.contains { $0["type"] as? String == "hazard.alert" })
                try await waitFor(40, "complete underlying provider reply after ADAS interruption") {
                    events.contains { event in
                        event["type"] as? String == "transcript" && event["speaker"] as? String == "agent" && event["final"] as? Bool == true && !(event["text"] as? String ?? "[").hasPrefix("[")
                    }
                }
            } else {
                try await waitFor(25, "final live agent reply") {
                    session.state.transcript.filter { $0.speaker == .agent && $0.final }.count > agentBefore
                }
            }
            try await waitFor(8, "actual PCM output playback completion") { session.syntheticAudioQAPlayback.playedBackBytes > 0 }
            try await waitForOutputDrain(session, requireSpeechSilence: caseID != "adas-alert-interrupt", allowedInterruptions: { caseID == "adas-alert-interrupt" ? hazardsWithLivePCM : 0 })
            outputDrainVerified = true
            if caseID == "adas-alert-interrupt" {
                XCTAssertGreaterThan(session.syntheticAudioQASpeech.starts, 0, "ADAS warning must start actual fallback speech")
                XCTAssertFalse(interruptedHazardGenerations.isEmpty)
                XCTAssertTrue(interruptedHazardGenerations.isSubset(of: session.syntheticAudioQAHazardSpeechStarts), "Every hazard that actually interrupted PCM must start its exact AVSpeechUtterance")
            }
            let text = session.state.transcript.filter { $0.speaker == .agent }.map(\.text).joined(separator: " ")
            if caseID == "emergency-safe-guidance" { XCTAssertTrue(matches(text, ["减速", "停车", "停下", "安全", "靠边"]), "Emergency reply must prioritize a safe stop") }
            if caseID == "wind-noise-robustness" { XCTAssertTrue(matches(text, ["风", "噪", "听不清", "重复"]), "Wind reply must acknowledge noise or wind") }
            if caseID == "degraded-network-recovery" { XCTAssertTrue(matches(text, ["网络", "连接", "重连", "信号"]), "Recovery reply must acknowledge connectivity") }
            XCTAssertFalse(matches(text, ["加速冲过去", "闯红灯", "逆行过去", "不用减速"]))
            XCTAssertFalse(session.syntheticAudioQACaptureRunning)
            XCTAssertEqual(AVAudioApplication.shared.recordPermission, permission)
            XCTAssertEqual(CLLocationManager().authorizationStatus, locationPermission)
            controller.view.layoutIfNeeded()
            try await pause(0.3)
            XCTAssertGreaterThan(controller.view.bounds.width, 0)
            let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
                controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            try image.pngData()?.write(to: output.appendingPathComponent(runID + ".png"))
            speechActiveBeforeProductionStop = session.syntheticAudioQASpeech.isSpeaking
            session.stop()
            try await waitFor(3, "production stop deactivating every output before QA cleanup") {
                let value = session.syntheticAudioQAPlayback
                return !session.state.handsFree && session.state.connection == .offline && !session.syntheticAudioQACaptureRunning && !session.syntheticAudioQAOutputRunning && !value.playerArmed && !value.nodePlaying && !session.syntheticAudioQASpeech.isSpeaking
            }
        } catch {
            failure = String(describing: error)
            XCTFail("\(caseID) round \(round): \(failure!)")
        }
    }

    private func matches(_ text: String, _ words: [String]) -> Bool { words.contains { text.contains($0) } }
    private func pause(_ seconds: Double) async throws { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    private func waitFor(_ seconds: Double, _ label: String, predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if predicate() { return }
            try await pause(0.02)
        }
        throw NSError(domain: "SyntheticAudioQA", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timeout waiting for \(label)"])
    }
    /// .dataPlayedBack has reached the output rather than merely being consumed
    /// by the engine. Require an empty PCM queue continuously for half a second.
    /// Recurrent ADAS warnings may keep fallback TTS active until ordinary stop;
    /// all other scenarios must also drain fallback speech before stopping.
    private func waitForOutputDrain(_ session: AgentSession, requireSpeechSilence: Bool = true, allowedInterruptions: () -> Int = { 0 }) async throws {
        let deadline = Date().addingTimeInterval(35)
        var emptySince: Date?
        while Date() < deadline {
            if session.syntheticAudioQAPlayback.pendingBytes == 0 && (!requireSpeechSilence || !session.syntheticAudioQASpeech.isSpeaking) {
                if emptySince == nil { emptySince = Date() }
                if Date().timeIntervalSince(emptySince!) >= 0.5 {
                    let value = session.syntheticAudioQAPlayback
                    let rawReceived = session.syntheticAudioQASpeech.receivedPCMBytes
                    guard rawReceived > 0, rawReceived == value.scheduledBytes,
                          value.scheduledBytes == value.playedBackBytes + value.discardedBytes,
                          value.interruptedAudio == allowedInterruptions(),
                          allowedInterruptions() > 0 || (value.discardedBytes == 0 && value.scheduledBytes == value.playedBackBytes) else {
                        throw NSError(domain: "SyntheticAudioQA", code: 5, userInfo: [NSLocalizedDescriptionKey: "PCM drain accounting failed or playback interruption lacks matching live hazard"])
                    }
                    return
                }
            } else { emptySince = nil }
            try await pause(0.02)
        }
        throw NSError(domain: "SyntheticAudioQA", code: 4, userInfo: [NSLocalizedDescriptionKey: "Timeout waiting for full PCM output drain"])
    }
    private func stream(_ fixture: String, manifest: Manifest, base: URL, session: AgentSession) async throws -> Int {
        let info = try XCTUnwrap(manifest.fixtures[fixture])
        let pcm = try Data(contentsOf: base.appendingPathComponent(info.file))
        let actualHash = SHA256.hash(data: pcm).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(actualHash, info.sha256, "Synthetic PCM fixture integrity")
        var sent = 0
        var offset = 0
        while offset < pcm.count {
            var frame = Data(pcm[offset..<min(offset + 640, pcm.count)])
            if frame.count < 640 { frame.append(Data(repeating: 0, count: 640 - frame.count)) }
            if session.sendSyntheticAudioQAFrame(frame) { sent += 1 }
            offset += 640
            try await pause(0.02)
        }
        return sent
    }
    private func silence(_ seconds: Double, session: AgentSession) async throws -> Int {
        var sent = 0
        for _ in 0..<Int(seconds * 50) {
            if session.sendSyntheticAudioQAFrame(Data(repeating: 0, count: 640)) { sent += 1 }
            try await pause(0.02)
        }
        return sent
    }
}
#endif
