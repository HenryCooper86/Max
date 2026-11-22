import MediaPlayer
import XCTest
@testable import MaxHelmet

private final class RecordingHandler: DeviceActionHandler, @unchecked Sendable {
    var received: [DeviceAction] = []
    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        received.append(action)
        return .ok
    }
}

private final class FakeTorch: TorchCapableDevice, @unchecked Sendable {
    var hasTorch = true
    var settings: [Bool] = []
    func setTorch(on: Bool) throws { settings.append(on) }
}

/// Critical heat sheds the torch and music like the Android app does
/// (DeviceLoad.loadRefusal): turning things on is refused with `device.hot`,
/// turning the torch off and pausing music always go through.
final class CriticalHeatExtrasTests: XCTestCase {
    private let critical = capturePolicy(heat: .critical, lowPowerMode: false)

    func testOnlyCriticalHeatRefusesExtras() {
        XCTAssertEqual(critical.extras, .hot)
        XCTAssertNil(capturePolicy(heat: .serious, lowPowerMode: false).extras)
        XCTAssertNil(capturePolicy(heat: .nominal, lowPowerMode: true).extras, "Low Power Mode leaves the torch and music alone")
    }

    func testTheTorchCanBeTurnedOffButNotOn() {
        XCTAssertEqual(loadRefusal(for: .torchSet(on: true), policy: critical), .denied("device.hot"))
        XCTAssertNil(loadRefusal(for: .torchSet(on: false), policy: critical))
        XCTAssertNil(loadRefusal(for: .torchSet(on: true), policy: capturePolicy(heat: .serious, lowPowerMode: false)))
    }

    func testMusicCanOnlyBePaused() {
        for control in [MusicControl.play, .next, .previous] {
            XCTAssertEqual(loadRefusal(for: .musicControl(control: control, app: nil), policy: critical), .denied("device.hot"), "\(control)")
        }
        XCTAssertNil(loadRefusal(for: .musicControl(control: .pause, app: nil), policy: critical))
        XCTAssertNil(loadRefusal(for: .musicControl(control: .play, app: nil), policy: .unrestricted))
    }

    func testOtherActionsAreLeftToTheirOwnHandlers() {
        XCTAssertNil(loadRefusal(for: .callDial(name: nil, number: "120"), policy: critical), "calling for help is never shed")
        XCTAssertNil(loadRefusal(for: .navigationStop, policy: critical))
    }

    func testTheRouterRefusesBeforeTheHandlerRuns() async {
        let torch = RecordingHandler()
        let music = RecordingHandler()
        let policy = critical
        let router = DeviceActionRouter(
            handlers: [.torch: torch, .music: music],
            isDeviceUnlocked: { true },
            loadRefusal: { loadRefusal(for: $0, policy: policy) }
        )
        let on = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))
        let off = await router.handle(DeviceCommand(commandId: "b", action: .torchSet(on: false), tier: .low))
        let play = await router.handle(DeviceCommand(commandId: "c", action: .musicControl(control: .play, app: nil), tier: .low))
        let pause = await router.handle(DeviceCommand(commandId: "d", action: .musicControl(control: .pause, app: nil), tier: .low))
        XCTAssertEqual(on, .denied("device.hot"))
        XCTAssertEqual(off, .ok)
        XCTAssertEqual(play, .denied("device.hot"))
        XCTAssertEqual(pause, .ok)
        XCTAssertEqual(torch.received, [.torchSet(on: false)])
        XCTAssertEqual(music.received, [.musicControl(control: .pause, app: nil)])
    }

    @MainActor
    func testEnteringCriticalHeatShedsTheTorchMaxsMusicAndHudCasting() {
        let torch = FakeTorch(), music = FakeOwnMusic(), cast = FakeCast()
        shedExtrasForHeat(critical, torch: torch, music: music, hudCast: cast)
        XCTAssertEqual(torch.settings, [false])
        XCTAssertEqual(music.stops, 1)
        XCTAssertEqual(cast.stops, 1)

        let warmTorch = FakeTorch(), warmMusic = FakeOwnMusic(), warmCast = FakeCast()
        shedExtrasForHeat(capturePolicy(heat: .serious, lowPowerMode: false), torch: warmTorch, music: warmMusic, hudCast: warmCast)
        XCTAssertEqual(warmTorch.settings, [])
        XCTAssertEqual(warmMusic.stops, 0)
        XCTAssertEqual(warmCast.stops, 0)

        let noTorch = FakeTorch()
        noTorch.hasTorch = false
        shedExtrasForHeat(critical, torch: noTorch, music: FakeOwnMusic(), hudCast: FakeCast())
        XCTAssertEqual(noTorch.settings, [])
    }

    /// Android's rule (MusicController.stopOwnPlayback): only playback Max
    /// drives itself is stopped; in QQ Music mode Max controls nothing.
    @MainActor
    func testOnlyMusicMaxPlaysItselfIsStopped() {
        let own = ShedMusicDriver()
        own.isPlaying = true
        MusicPlaybackModel(prefersQQMusic: false, player: own, requestAuthorization: { .authorized }).stopOwnPlayback()
        XCTAssertEqual(own.pauses, 1)
        XCTAssertFalse(own.isPlaying)

        let qq = ShedMusicDriver()
        qq.isPlaying = true
        MusicPlaybackModel(prefersQQMusic: true, player: qq, requestAuthorization: { .authorized }).stopOwnPlayback()
        XCTAssertEqual(qq.pauses, 0)
    }
}

@MainActor
private final class FakeOwnMusic: OwnMusicStopping {
    var stops = 0
    func stopOwnPlayback() { stops += 1 }
}

@MainActor
private final class FakeCast: HUDCastStopping {
    var stops = 0
    func stop() { stops += 1 }
}

private final class ShedMusicDriver: MusicPlaybackDriving {
    var title: String? = nil
    var artist: String? = nil
    var hasItem = true
    var itemIdentity: String? = "one"
    var isPlaying = false
    var notificationObject: AnyObject { self }
    var pauses = 0
    func beginObserving() {}
    func endObserving() {}
    func setQueue(_ collection: MPMediaItemCollection) {}
    func prepare(_ completion: @escaping @Sendable (Error?) -> Void) { completion(nil) }
    func play() { isPlaying = true }
    func pause() { pauses += 1; isPlaying = false }
    func next() {}
    func previous() {}
}
