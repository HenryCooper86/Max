import XCTest
@testable import MaxHelmet

final class VoiceMicDockTests: XCTestCase {
    private let livePresentation = MicDockPresentation(
        mode: .live,
        label: "结束免提",
        accessibilityLabel: "结束免提",
        displayLevel: 0.7
    )

    func testMapsIdleConnectingLiveAndMutedStates() {
        var state = AgentSession.State()
        XCTAssertEqual(micDockPresentation(state).mode, .idle)
        XCTAssertEqual(micDockPresentation(state).label, "开始免提")

        state.handsFree = true
        state.connection = .provider
        XCTAssertEqual(micDockPresentation(state).mode, .connecting)
        XCTAssertEqual(micDockPresentation(state).label, "连接中")

        state.connection = .ready
        XCTAssertEqual(micDockPresentation(state).mode, .live)
        XCTAssertEqual(micDockPresentation(state).label, "结束免提")

        state.micMuted = true
        XCTAssertEqual(micDockPresentation(state).mode, .muted)
    }

    func testAnimatesOnlyReadyUnmutedRiderInput() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.turnState = .listening
        state.voiceLevel = 0.5

        XCTAssertTrue(isVoiceInputActive(state))
        state.turnState = .hearing
        XCTAssertTrue(isVoiceInputActive(state))
        state.turnState = .thinking
        XCTAssertFalse(isVoiceInputActive(state))
        state.turnState = .speaking
        XCTAssertFalse(isVoiceInputActive(state))
        state.turnState = .listening
        state.connection = .degraded
        XCTAssertFalse(isVoiceInputActive(state))
        state.connection = .ready
        state.micMuted = true
        XCTAssertFalse(isVoiceInputActive(state))
    }

    func testAppliesNoiseFloorSensitivityAndClamp() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.turnState = .listening

        state.voiceLevel = 0.035
        XCTAssertEqual(micDisplayLevel(state), 0, accuracy: 0.0001)
        state.voiceLevel = 0.5
        XCTAssertEqual(micDisplayLevel(state), 0.7905, accuracy: 0.0001)
        state.voiceLevel = 1
        XCTAssertEqual(micDisplayLevel(state), 1, accuracy: 0.0001)
        state.turnState = .thinking
        XCTAssertEqual(micDisplayLevel(state), 0, accuracy: 0.0001)
    }

    func testReturnsStableThreeBarGeometry() {
        XCTAssertEqual(micMeterHeights(0), [6, 6, 6])
        XCTAssertEqual(micMeterHeights(1), [14, 18, 15])
        XCTAssertEqual(micMeterHeights(2), [14, 18, 15])
    }

    func testSnapsLevelWhenLiveBecomesMuted() {
        let muted = MicDockPresentation(
            mode: .muted,
            label: "结束免提",
            accessibilityLabel: "结束免提",
            displayLevel: 0
        )

        XCTAssertEqual(
            micDockLevelTransition(
                from: livePresentation,
                to: muted,
                displayedLevel: 0.7,
                reduceMotion: false
            ),
            .snap(to: 0)
        )
    }

    func testSnapsLevelWhenLiveBecomesIdle() {
        let idle = MicDockPresentation(
            mode: .idle,
            label: "开始免提",
            accessibilityLabel: "开始免提",
            displayLevel: 0
        )

        XCTAssertEqual(
            micDockLevelTransition(
                from: livePresentation,
                to: idle,
                displayedLevel: 0.7,
                reduceMotion: false
            ),
            .snap(to: 0)
        )
    }

    func testSnapsLevelWhenLiveBecomesConnecting() {
        let connecting = MicDockPresentation(
            mode: .connecting,
            label: "连接中",
            accessibilityLabel: "正在连接免提，点按取消",
            displayLevel: 0
        )

        XCTAssertEqual(
            micDockLevelTransition(
                from: livePresentation,
                to: connecting,
                displayedLevel: 0.7,
                reduceMotion: false
            ),
            .snap(to: 0)
        )
    }

    func testPreservesLiveRiseFallAndReducedMotionPolicy() {
        let rising = MicDockPresentation(
            mode: .live,
            label: "结束免提",
            accessibilityLabel: "结束免提",
            displayLevel: 0.8
        )
        let falling = MicDockPresentation(
            mode: .live,
            label: "结束免提",
            accessibilityLabel: "结束免提",
            displayLevel: 0.2
        )

        XCTAssertEqual(
            micDockLevelTransition(from: livePresentation, to: rising, displayedLevel: 0.7, reduceMotion: false),
            .animate(to: 0.8, duration: 0.08)
        )
        XCTAssertEqual(
            micDockLevelTransition(from: livePresentation, to: falling, displayedLevel: 0.7, reduceMotion: false),
            .animate(to: 0.2, duration: 0.18)
        )
        XCTAssertEqual(
            micDockLevelTransition(from: livePresentation, to: rising, displayedLevel: 0.7, reduceMotion: true),
            .snap(to: 0.8)
        )
    }

    func testMuteUtilityPillUsesMinimumInteractiveHeight() {
        XCTAssertGreaterThanOrEqual(muteUtilityMinimumHitHeight, 44)
    }
}
