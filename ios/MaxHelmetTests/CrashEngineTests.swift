import XCTest
@testable import MaxHelmet

/// Trace helpers: literal IMU sequences at 100 Hz, GuidanceEngineTests-style.
private func trace(from t0: TimeInterval, seconds: Double, accelG: Double, rotation: Double = 0.3,
                   speedKmh: Double?, hz: Double = 100) -> [CrashSample] {
    stride(from: 0.0, to: seconds, by: 1.0 / hz).map {
        CrashSample(t: t0 + $0, accelG: accelG, rotationRadS: rotation, speedKmh: speedKmh)
    }
}

private func run(_ samples: [CrashSample], from state: CrashState = .armed,
                 tuning: CrashTuning = .standard) -> (CrashState, [CrashEffect]) {
    var s = state
    var effects: [CrashEffect] = []
    for sample in samples {
        let update = CrashEngine.step(sample: sample, state: s, tuning: tuning)
        s = update.state
        effects.append(contentsOf: update.effects)
    }
    return (s, effects)
}

final class CrashEngineDetectionTests: XCTestCase {

    /// Riding baseline: 0.3 g noise at 60 km/h.
    private func riding(_ seconds: Double, from t0: TimeInterval = 0) -> [CrashSample] {
        trace(from: t0, seconds: seconds, accelG: 0.3, speedKmh: 60)
    }

    func testNarrowSpikeDoesNotPromote() {
        // One 10 ms spike (a pothole) — below the 20 ms sustain requirement.
        var samples = riding(1.0)
        samples.append(CrashSample(t: 1.0, accelG: 6.0, rotationRadS: 0.3, speedKmh: 60))
        let (state, effects) = MaxHelmetTests.run(samples + riding(1.0, from: 1.01))
        XCTAssertEqual(state.phase, .armed)
        XCTAssertTrue(effects.isEmpty)
    }

    func testSustainedImpactThenStillnessReachesCheckIn() {
        var samples = riding(1.0)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 6.0, speedKmh: 60)       // 50 ms crash pulse
        samples += trace(from: 1.05, seconds: 2.0, accelG: 0.02, speedKmh: 0)       // still on the ground
        let (state, effects) = MaxHelmetTests.run(samples)
        guard case .checkIn = state.phase else { return XCTFail("expected checkIn, got \(state.phase)") }
        XCTAssertEqual(effects, [.speakCheckIn])
    }

    func testTumbleAtSpeedPromotes() {
        var samples = riding(1.0)
        samples += trace(from: 1.0, seconds: 0.15, accelG: 1.0, rotation: 8.0, speedKmh: 60)
        let (state, _) = MaxHelmetTests.run(samples)
        guard case .impactCandidate = state.phase else { return XCTFail("expected impactCandidate, got \(state.phase)") }
    }

    func testStandstillSingleSignalNeverPromotes() {
        // Dropped phone at 0 km/h: a big spike but no tumble — both are required below the speed gate.
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.05, speedKmh: 0)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 7.0, speedKmh: 0)
        let (state, _) = MaxHelmetTests.run(samples)
        XCTAssertEqual(state.phase, .armed)
    }

    func testStandstillBothSignalsPromote() {
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.05, speedKmh: 0)
        samples += trace(from: 1.0, seconds: 0.15, accelG: 6.0, rotation: 8.0, speedKmh: 0)
        let (state, _) = MaxHelmetTests.run(samples)
        guard case .impactCandidate = state.phase else { return XCTFail("expected impactCandidate, got \(state.phase)") }
    }

    func testUnknownSpeedIsTreatedAsBelowGate() {
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.3, speedKmh: nil)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 6.0, speedKmh: nil)
        let (state, _) = MaxHelmetTests.run(samples)
        XCTAssertEqual(state.phase, .armed, "single signal with unknown speed must not promote")
    }

    func testResumedRidingReturnsToArmed() {
        // Candidate, then normal riding through the 5 s confirm window: silent re-arm.
        var samples = riding(1.0)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 6.0, speedKmh: 60)
        samples += riding(6.0, from: 1.05)
        let (state, effects) = MaxHelmetTests.run(samples)
        XCTAssertEqual(state.phase, .armed)
        XCTAssertTrue(effects.isEmpty)
    }

    func testLatchedPhasesIgnoreSensorInput() {
        for phase in [CrashPhase.checkIn(since: 10), CrashPhase.alarm(since: 10), CrashPhase.escalated(at: 10)] {
            var state = CrashState.armed
            state.phase = phase
            let spike = CrashSample(t: 11, accelG: 9.0, rotationRadS: 9.0, speedKmh: 60)
            let update = CrashEngine.step(sample: spike, state: state)
            XCTAssertEqual(update.state.phase, phase, "sensor input must never advance or reset an active incident")
            XCTAssertTrue(update.effects.isEmpty)
        }
    }

    func testRenewedSingleSignalConfirmsAStandstillCandidate() {
        // Promote via standstill both-signals path, then ≥0.5 s later send a single-signal sample.
        // The renewed signal should confirm despite lacking tumble.
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.05, speedKmh: 0)
        samples += trace(from: 1.0, seconds: 0.15, accelG: 6.0, rotation: 8.0, speedKmh: 0)
        // Verify we reached impactCandidate
        let (candidate, _) = MaxHelmetTests.run(samples)
        guard case .impactCandidate = candidate.phase else { return XCTFail("expected impactCandidate after standstill") }

        // Now continue from impactCandidate state with a single-signal sample at t=1.65 (0.65s after promote at 1.15).
        let renewingSample = CrashSample(t: 1.65, accelG: 5.0, rotationRadS: 0.3, speedKmh: 0)
        let (state, effects) = MaxHelmetTests.run([renewingSample], from: candidate)
        guard case .checkIn = state.phase else { return XCTFail("expected checkIn after renewed signal, got \(state.phase)") }
        XCTAssertEqual(effects, [.speakCheckIn])
    }
}
