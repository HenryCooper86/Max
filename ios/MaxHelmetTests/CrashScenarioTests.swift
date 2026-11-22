import XCTest
@testable import MaxHelmet

// SYNTHETIC SCENARIOS — NOT RECORDED RIDES.
//
// Every trace below is hand-written from the physics of the event it names
// (impact magnitudes, fall times, rotation rates) at the 100 Hz rate
// SystemMotionFeed delivers. None of it was captured on a motorcycle. The
// tests pin what CrashEngine does today with the standard tuning so a retune
// shows up as a visible diff; the one marked KNOWN GAP describes behaviour that
// is probably wrong and is reported rather than fixed here, because changing it
// means retuning thresholds, which needs real ride recordings.
//
// Units match CrashSample: accelG is |userAcceleration| (gravity removed, so a
// phone at rest reads ~0 g and a phone in free fall reads ~1 g), rotationRadS
// is |rotationRate|, speedKmh is the ride speed the crash feed supplies.

private struct Segment {
    var seconds: Double
    var accelG: (Int) -> Double
    var rotation: (Int) -> Double = { _ in 0.3 }
    var speedKmh: (Int) -> Double?
}

/// Concatenates segments into one 100 Hz trace starting at `t0`.
private func scenario(_ segments: [Segment], from t0: TimeInterval = 0) -> [CrashSample] {
    var samples: [CrashSample] = []
    var t = t0
    for segment in segments {
        let count = Int((segment.seconds * 100).rounded())
        for i in 0..<count {
            samples.append(CrashSample(t: t, accelG: segment.accelG(i), rotationRadS: segment.rotation(i), speedKmh: segment.speedKmh(i)))
            t += 0.01
        }
    }
    return samples
}

/// Road buzz on a handlebar mount: 0.2–0.45 g, never near the 4.5 g threshold.
private func riding(_ seconds: Double, kmh: Double) -> Segment {
    Segment(seconds: seconds, accelG: { 0.2 + 0.25 * Double($0 % 7) / 6 }, rotation: { 0.2 + 0.3 * Double($0 % 5) / 4 }, speedKmh: { _ in kmh })
}

/// A phone lying on tarmac: tiny sensor noise, rider speed reported as zero.
private func lyingStill(_ seconds: Double, kmh: Double? = 0) -> Segment {
    Segment(seconds: seconds, accelG: { 0.01 + 0.01 * Double($0 % 3) / 2 }, rotation: { _ in 0.02 }, speedKmh: { _ in kmh })
}

private struct Outcome {
    var state: CrashState
    var effects: [CrashEffect]
    var phases: [CrashPhase]
}

/// Feeds the trace sample by sample, ticking the engine at every sample the way
/// CrashController's timer would, then keeps ticking for `tickFor` seconds after
/// the last sample (sensor input stops mattering once an incident is latched).
private func play(_ samples: [CrashSample], tickFor extra: TimeInterval = 0) -> Outcome {
    var state = CrashState.armed
    var effects: [CrashEffect] = []
    var phases: [CrashPhase] = []
    func record(_ update: CrashUpdate) {
        state = update.state
        effects += update.effects
        if phases.last != state.phase { phases.append(state.phase) }
    }
    for sample in samples {
        record(CrashEngine.step(sample: sample, state: state))
        record(CrashEngine.tick(now: sample.t, state: state))
    }
    let end = (samples.last?.t ?? 0)
    var now = end
    while now < end + extra {
        now += 0.5
        record(CrashEngine.tick(now: now, state: state))
    }
    return Outcome(state: state, effects: effects, phases: phases)
}

private func isCandidate(_ phase: CrashPhase) -> Bool {
    if case .impactCandidate = phase { return true }
    return false
}

final class CrashScenarioTests: XCTestCase {

    // MARK: - must stay silent

    /// Synthetic: front wheel drops into a pothole at 50 km/h — a 40 ms 5.5 g
    /// jolt with a little pitch, then normal riding.
    func testPotholeAtSpeedIsSilent() {
        let trace = scenario([
            riding(2, kmh: 50),
            Segment(seconds: 0.04, accelG: { _ in 5.5 }, rotation: { _ in 2.0 }, speedKmh: { _ in 50 }),
            riding(8, kmh: 50),
        ])
        let outcome = play(trace)
        XCTAssertTrue(outcome.phases.contains(where: isCandidate), "a 40 ms jolt at speed does open the confirm window")
        XCTAssertEqual(outcome.state.phase, .armed, "riding on must close it again")
        XCTAssertEqual(outcome.effects, [], "a single pothole must never prompt the rider")
    }

    /// Synthetic: emergency stop from 60 km/h — about 1 g of deceleration for
    /// 2.5 s with the fork diving, then waiting at a standstill.
    func testHardBrakingToAStopIsSilent() {
        let trace = scenario([
            riding(2, kmh: 60),
            Segment(seconds: 2.5, accelG: { 0.9 + 0.2 * Double($0 % 4) / 3 }, rotation: { _ in 0.6 },
                    speedKmh: { 60 - 60 * Double($0) / 250 }),
            lyingStill(5),
        ])
        let outcome = play(trace, tickFor: 60)
        XCTAssertEqual(outcome.phases, [.armed])
        XCTAssertEqual(outcome.effects, [])
    }

    /// Synthetic: phone slips off the tank bag while parked — 0.35 s of free
    /// fall without spinning, an 8 g landing, then it lies there.
    func testPhoneDroppedFlatWhileParkedIsSilent() {
        let trace = scenario([
            lyingStill(2),
            Segment(seconds: 0.35, accelG: { _ in 1.0 }, rotation: { _ in 1.5 }, speedKmh: { _ in 0 }),
            Segment(seconds: 0.03, accelG: { _ in 8.0 }, rotation: { _ in 2.0 }, speedKmh: { _ in 0 }),
            lyingStill(5),
        ])
        let outcome = play(trace, tickFor: 60)
        XCTAssertEqual(outcome.phases, [.armed], "one signal below the speed gate never promotes")
        XCTAssertEqual(outcome.effects, [])
    }

    // MARK: - must alert

    /// Synthetic: high-side at 50 km/h — a 60 ms 9 g impact while the body
    /// tumbles at 10 rad/s, a 1.5 s slide, then the rider lies still. The last
    /// ride.context before the crash said 50 km/h; the next one says 0.
    func testRealImpactThenStillnessRunsTheWholeEscalation() {
        let trace = scenario([
            riding(2, kmh: 50),
            Segment(seconds: 0.06, accelG: { _ in 9.0 }, rotation: { _ in 10.0 }, speedKmh: { _ in 50 }),
            Segment(seconds: 0.4, accelG: { _ in 2.5 }, rotation: { _ in 9.0 }, speedKmh: { _ in 50 }),
            Segment(seconds: 1.5, accelG: { 0.8 + 0.8 * Double($0 % 5) / 4 }, rotation: { _ in 2.0 }, speedKmh: { $0 < 50 ? 50 : 0 }),
            lyingStill(3),
        ])
        let outcome = play(trace, tickFor: 50)
        XCTAssertEqual(outcome.effects, [.speakCheckIn, .showAlarm, .escalate])
        guard case .escalated = outcome.state.phase else { return XCTFail("expected escalation, got \(outcome.state.phase)") }
        XCTAssertEqual(outcome.state.peakSpeedKmh, 50)
    }

    /// Synthetic: same crash, but the rider gets up and walks to the bike
    /// within the check-in window and cancels — the engine itself keeps the
    /// incident until the cancel arrives, it never self-cancels on movement.
    func testRiderMovingAgainAfterACrashDoesNotSelfCancel() {
        let trace = scenario([
            riding(2, kmh: 50),
            Segment(seconds: 0.06, accelG: { _ in 9.0 }, rotation: { _ in 10.0 }, speedKmh: { _ in 50 }),
            Segment(seconds: 0.4, accelG: { _ in 2.5 }, rotation: { _ in 9.0 }, speedKmh: { _ in 0 }),
            lyingStill(2),
            riding(5, kmh: 0),
        ])
        let outcome = play(trace)
        guard case .checkIn = outcome.state.phase else { return XCTFail("expected check-in, got \(outcome.state.phase)") }
        XCTAssertEqual(outcome.effects, [.speakCheckIn])
        XCTAssertEqual(CrashEngine.riderCancelled(state: outcome.state).effects, [.dismiss, .logNearMiss])
    }

    // MARK: - current behaviour worth a second look (see the test names)

    /// Synthetic: two potholes 1.5 s apart at 50 km/h. The second jolt lands in
    /// the first one's confirm window and counts as a renewed impact, so the
    /// rider is asked whether they are OK. That is the engine's stated trade-off
    /// ("a check-in is cheap to cancel"); on broken roads it will be noisy.
    func testTwoPotholesInARowAtSpeedAskTheRiderByDesign() {
        let jolt = Segment(seconds: 0.04, accelG: { _ in 5.5 }, rotation: { _ in 2.0 }, speedKmh: { _ in 50 })
        let trace = scenario([riding(2, kmh: 50), jolt, riding(1.5, kmh: 50), jolt, riding(3, kmh: 50)])
        let outcome = play(trace)
        guard case .checkIn = outcome.state.phase else { return XCTFail("expected check-in, got \(outcome.state.phase)") }
        XCTAssertEqual(outcome.effects, [.speakCheckIn])
    }

    /// Synthetic: phone knocked off a café table while parked, spinning at
    /// 9 rad/s as it falls 0.35 s and lands at 8 g for 40 ms. Impact plus tumble together
    /// promote at any speed (meant for low-speed crashes), and the phone then
    /// lies still, so this prompts a check-in and, if nobody answers, escalates.
    func testSpinningPhoneDroppedWhileParkedAsksTheRiderByDesign() {
        let trace = scenario([
            lyingStill(2),
            Segment(seconds: 0.35, accelG: { _ in 1.0 }, rotation: { _ in 9.0 }, speedKmh: { _ in 0 }),
            Segment(seconds: 0.04, accelG: { _ in 8.0 }, rotation: { _ in 9.0 }, speedKmh: { _ in 0 }),
            lyingStill(3),
        ])
        let outcome = play(trace)
        guard case .checkIn = outcome.state.phase else { return XCTFail("expected check-in, got \(outcome.state.phase)") }
        XCTAssertEqual(outcome.effects, [.speakCheckIn])
    }

    /// KNOWN GAP (reported, not fixed). Synthetic: the bike tips over at 6 km/h
    /// while filtering — the handlebar rolls 90° in about half a second (peak
    /// 5 rad/s), then hits the ground at 5.5 g after the roll has stopped.
    /// Below the 10 km/h gate both signals are needed at the same instant, but a
    /// tip-over produces them one after the other, and the roll never reaches
    /// 6 rad/s anyway. The engine's own comment says a missed low-speed crash is
    /// expensive; today this one is never noticed.
    func testLowSpeedTipOverIsNotDetected_KnownGap() {
        let trace = scenario([
            riding(2, kmh: 6),
            Segment(seconds: 0.5, accelG: { _ in 1.2 }, rotation: { 1 + 4 * Double($0) / 49 }, speedKmh: { _ in 6 }),
            Segment(seconds: 0.04, accelG: { _ in 5.5 }, rotation: { _ in 1.0 }, speedKmh: { _ in 6 }),
            lyingStill(5),
        ])
        let outcome = play(trace, tickFor: 60)
        XCTAssertEqual(outcome.phases, [.armed])
        XCTAssertEqual(outcome.effects, [])
    }

    /// Engine behaviour, unchanged: if the speed it is handed stays at 2 km/h
    /// or more through the 5 s confirm window, stillness is never accepted and
    /// the crash is not confirmed. Synthetic: the high-side above with 50 km/h
    /// held for 6 s after the impact. The app no longer feeds it such a value
    /// on a real ride: speed comes from the phone's GPS, a fix without a usable
    /// speed makes it unknown, and the crash feed forgets GPS speed after 2 s
    /// (CrashSpeedFeedTests). It can still happen in a mock demo session, whose
    /// scenario speed stays constant, or if GPS keeps reporting a valid moving
    /// speed after the impact.
    func testAnEngineHandedAPersistentMovingSpeedDoesNotConfirm() {
        let trace = scenario([
            riding(2, kmh: 50),
            Segment(seconds: 0.06, accelG: { _ in 9.0 }, rotation: { _ in 10.0 }, speedKmh: { _ in 50 }),
            Segment(seconds: 0.4, accelG: { _ in 2.5 }, rotation: { _ in 9.0 }, speedKmh: { _ in 50 }),
            lyingStill(6, kmh: 50),
            lyingStill(30, kmh: 0),
        ])
        let outcome = play(trace, tickFor: 60)
        XCTAssertTrue(outcome.phases.contains(where: isCandidate))
        XCTAssertEqual(outcome.state.phase, .armed)
        XCTAssertEqual(outcome.effects, [], "the impact was seen but never confirmed")
    }
}
