import MediaPlayer
import XCTest
@testable import MaxHelmet

final class MusicPlaybackModelTests: XCTestCase {
    @MainActor func testQQDefaultNeverRequestsApplePermissionOrClaimsPlayback() async {
        var permissions = 0
        let model = MusicPlaybackModel(requestAuthorization: { permissions += 1; return .authorized })
        XCTAssertFalse(model.visible)
        for control in [MusicControl.play, .pause, .next, .previous] {
            let result = await model.perform(control)
            XCTAssertEqual(result.status, .unsupported)
            XCTAssertEqual(result.reason, "music.qq.integrationRequired")
            XCTAssertTrue(model.visible)
            XCTAssertTrue(model.prefersQQMusic)
            XCTAssertFalse(model.isPlaying)
            XCTAssertFalse(model.showingPicker)
        }
        XCTAssertEqual(permissions, 0)
        model.stopPlayback(dismiss: true)
        XCTAssertFalse(model.visible)
    }

    @MainActor func testNamedQQRequestStopsLocalPlaybackWithoutAcknowledgingQQSuccess() async {
        let driver = PlaybackDriver()
        driver.starts = true
        let model = makeModel(driver)
        _ = await model.perform(.play)
        let controller = MusicController(player: model)
        let result = await controller.perform(.musicControl(control: .next, app: "QQ Music"))
        XCTAssertEqual(result.reason, "music.qq.integrationRequired")
        XCTAssertTrue(model.prefersQQMusic)
        XCTAssertFalse(model.isPlaying)
        XCTAssertTrue(model.visible)
    }

    @MainActor func testSwitchingToQQCancelsPendingAppleAuthorization() async {
        let driver = PlaybackDriver()
        driver.starts = true
        var pending: CheckedContinuation<MPMediaLibraryAuthorizationStatus, Never>?
        let model = MusicPlaybackModel(prefersQQMusic: false, player: driver, requestAuthorization: {
            await withCheckedContinuation { pending = $0 }
        })
        let play = Task { await model.perform(.play) }
        while pending == nil { await Task.yield() }
        model.useQQMusic()
        pending?.resume(returning: .authorized)
        _ = await play.value
        XCTAssertTrue(model.prefersQQMusic)
        XCTAssertEqual(driver.plays, 0)
        XCTAssertFalse(model.isPlaying)
        XCTAssertFalse(model.busy)
    }

    @MainActor func testDeniedVoiceRequestShowsRecoverableCard() async {
        let model = MusicPlaybackModel(prefersQQMusic: false, requestAuthorization: { .denied })
        XCTAssertFalse(model.visible)
        let result = await model.perform(.play)
        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.music")
        XCTAssertTrue(model.visible)
        XCTAssertFalse(model.busy)
        XCTAssertFalse(model.isPlaying)
        XCTAssertNotNil(model.message)
        XCTAssertFalse(model.showingPicker)
    }

    @MainActor func testRestrictedLibraryCannotPresentPicker() async {
        let model = MusicPlaybackModel(prefersQQMusic: false, requestAuthorization: { .restricted })
        await model.chooseMusic()
        XCTAssertTrue(model.visible)
        XCTAssertFalse(model.showingPicker)
        XCTAssertFalse(model.busy)
        XCTAssertNotNil(model.message)
    }

    @MainActor func testConcurrentVoiceCommandDoesNotRacePermissionRequest() async {
        var pending: CheckedContinuation<MPMediaLibraryAuthorizationStatus, Never>?
        let model = MusicPlaybackModel(prefersQQMusic: false, requestAuthorization: {
            await withCheckedContinuation { pending = $0 }
        })
        let first = Task { await model.perform(.play) }
        while pending == nil { await Task.yield() }
        let second = await model.perform(.next)
        XCTAssertEqual(second.reason, "music.busy")
        pending?.resume(returning: .denied)
        _ = await first.value
        XCTAssertFalse(model.busy)
    }

    @MainActor func testResumeExistingQueueDoesNotPrepareItAgain() async {
        let driver = PlaybackDriver()
        driver.starts = true
        let model = makeModel(driver)
        let result = await model.perform(.play)
        XCTAssertEqual(result.status, .ok)
        XCTAssertEqual(driver.prepares, 0)
        XCTAssertEqual(driver.plays, 1)
        XCTAssertTrue(model.isPlaying)
    }

    @MainActor func testSilentPlayFailureDoesNotReportSuccess() async {
        let driver = PlaybackDriver()
        let model = makeModel(driver)
        let result = await model.perform(.play)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "music.unavailable")
        XCTAssertFalse(model.isPlaying)
        XCTAssertNotNil(model.message)
        XCTAssertFalse(model.busy)
    }

    @MainActor func testDelayedPlaybackIsConfirmed() async {
        let driver = PlaybackDriver()
        var waits = 0
        let model = MusicPlaybackModel(prefersQQMusic: false, player: driver, playbackAttempts: 3,
            waitForPlayback: { waits += 1; if waits == 2 { driver.isPlaying = true } },
            requestAuthorization: { .authorized })
        let result = await model.perform(.play)
        XCTAssertEqual(result.status, .ok)
        XCTAssertEqual(waits, 2)
    }

    @MainActor func testEmptyQueueDoesNotPrepareOrPlay() async {
        let driver = PlaybackDriver(); driver.hasItem = false
        let model = makeModel(driver)
        let result = await model.perform(.play)
        XCTAssertEqual(result.reason, "music.emptyQueue")
        XCTAssertEqual(driver.prepares, 0)
        XCTAssertEqual(driver.plays, 0)
    }

    @MainActor func testNewSelectionPreparesOnceAndResumeDoesNotReprepare() async {
        let driver = PlaybackDriver(); driver.starts = true
        let model = makeModel(driver)
        await model.select(MPMediaItemCollection(items: [MPMediaItem()]))
        XCTAssertEqual(driver.prepares, 1)
        XCTAssertTrue(model.isPlaying)
        _ = await model.perform(.pause)
        _ = await model.perform(.play)
        XCTAssertEqual(driver.prepares, 1)
        XCTAssertTrue(model.isPlaying)
    }

    @MainActor func testPreparationErrorPreservesDiagnosticAndCanRetry() async {
        let driver = PlaybackDriver()
        driver.error = NSError(domain: "PlaybackTest", code: 42)
        let model = makeModel(driver)
        await model.select(MPMediaItemCollection(items: [MPMediaItem()]))
        XCTAssertTrue(model.message?.contains("PlaybackTest / 42") == true)
        XCTAssertEqual(driver.plays, 0)
        driver.error = nil; driver.starts = true
        let result = await model.perform(.play)
        XCTAssertEqual(result.status, .ok)
        XCTAssertEqual(driver.prepares, 2)
        XCTAssertNil(model.message)
    }

    @MainActor func testMissingPreparationCallbackTimesOutAndLateCallbackIsIgnored() async {
        let driver = PlaybackDriver(); driver.holdPreparation = true
        let model = MusicPlaybackModel(prefersQQMusic: false, player: driver, preparationTimeoutNanoseconds: 1_000_000,
            playbackAttempts: 1, waitForPlayback: {}, requestAuthorization: { .authorized })
        await model.select(MPMediaItemCollection(items: [MPMediaItem()]))
        XCTAssertFalse(model.busy)
        XCTAssertTrue(model.message?.contains("MaxMusic / 1") == true)
        driver.pending?(nil)
        await Task.yield()
        XCTAssertEqual(driver.plays, 0)
        XCTAssertFalse(model.isPlaying)
    }

    @MainActor func testSilentSkipDoesNotClaimSuccess() async {
        let driver = PlaybackDriver()
        driver.isPlaying = true
        let model = makeModel(driver)
        let result = await model.perform(.next)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "music.controlUnavailable")
        XCTAssertNotNil(model.message)
    }

    @MainActor func testDelayedSkipWaitsForNewItemAndPlayback() async {
        let driver = PlaybackDriver()
        driver.isPlaying = true
        var waits = 0
        let model = MusicPlaybackModel(prefersQQMusic: false, player: driver, playbackAttempts: 4, waitForPlayback: {
            waits += 1
            if waits == 1 { driver.itemIdentity = "two"; driver.isPlaying = false }
            if waits == 2 { driver.isPlaying = true }
        }, requestAuthorization: { .authorized })
        let result = await model.perform(.next)
        XCTAssertEqual(result.status, .ok)
        XCTAssertEqual(waits, 2)
    }

    @MainActor func testPreviousRestartingSameSongIsNotAnotherTrack() async {
        let result = await makeModel(PlaybackDriver()).perform(.previous)
        XCTAssertEqual(result.status, .failed)
    }

    @MainActor func testClosingCardStopsPlaybackButPreservesQueueForExplicitResume() async {
        let driver = PlaybackDriver(); driver.starts = true
        let model = makeModel(driver)
        _ = await model.perform(.play)
        model.stopPlayback(dismiss: true)
        XCTAssertFalse(model.visible)
        XCTAssertFalse(model.isPlaying)
        XCTAssertTrue(driver.hasItem)
        XCTAssertEqual(driver.pauses, 1)
        _ = await model.perform(.play)
        XCTAssertTrue(model.isPlaying)
        XCTAssertTrue(model.visible)
    }

    @MainActor func testBackgroundStopsAndCannotRestartUntilExplicitForegroundPlay() async {
        let driver = PlaybackDriver(); driver.starts = true
        let model = makeModel(driver)
        _ = await model.perform(.play)
        model.setAppInBackground(true)
        XCTAssertFalse(model.isPlaying)
        let backgroundResult = await model.perform(.play)
        XCTAssertEqual(backgroundResult.status, .failed)
        XCTAssertEqual(driver.plays, 1)
        model.setAppInBackground(false)
        XCTAssertFalse(model.isPlaying)
        XCTAssertEqual(driver.plays, 1)
        _ = await model.perform(.play)
        XCTAssertTrue(model.isPlaying)
    }

    @MainActor func testCloseDuringAuthorizationCannotOpenPickerLater() async {
        var pending: CheckedContinuation<MPMediaLibraryAuthorizationStatus, Never>?
        let driver = PlaybackDriver()
        let model = MusicPlaybackModel(prefersQQMusic: false, player: driver, requestAuthorization: {
            await withCheckedContinuation { pending = $0 }
        })
        let request = Task { await model.chooseMusic() }
        while pending == nil { await Task.yield() }
        model.stopPlayback(dismiss: true)
        pending?.resume(returning: .authorized)
        await request.value
        XCTAssertFalse(model.showingPicker)
        XCTAssertFalse(model.visible)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(driver.plays, 0)
    }

    @MainActor func testPauseCancelsPendingPreparationAndLateCallbackCannotPlay() async {
        let driver = PlaybackDriver(); driver.holdPreparation = true; driver.starts = true
        let model = makeModel(driver)
        let selection = Task { await model.select(MPMediaItemCollection(items: [MPMediaItem()])) }
        while driver.pending == nil { await Task.yield() }
        let result = await model.perform(.pause)
        XCTAssertEqual(result.status, .ok)
        await selection.value
        driver.pending?(nil)
        await Task.yield()
        XCTAssertEqual(driver.plays, 0)
        XCTAssertFalse(model.isPlaying)
        XCTAssertFalse(model.busy)
    }

    @MainActor func testBackgroundDuringSkipCannotResumeChangedTrack() async {
        let driver = PlaybackDriver(); driver.isPlaying = true; driver.starts = true
        var model: MusicPlaybackModel!
        model = MusicPlaybackModel(prefersQQMusic: false, player: driver, playbackAttempts: 3, waitForPlayback: {
            model.setAppInBackground(true)
            driver.itemIdentity = "two"
        }, requestAuthorization: { .authorized })
        let result = await model.perform(.next)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(driver.plays, 0)
        XCTAssertFalse(model.isPlaying)
    }

    @MainActor private func makeModel(_ driver: PlaybackDriver) -> MusicPlaybackModel {
        MusicPlaybackModel(prefersQQMusic: false, player: driver, playbackAttempts: 2, waitForPlayback: {}, requestAuthorization: { .authorized })
    }
}


@MainActor
private final class PlaybackDriver: MusicPlaybackDriving {
    var title: String? = "Test song"
    var artist: String? = "Test artist"
    var hasItem = true
    var itemIdentity: String? = "one"
    var isPlaying = false
    var notificationObject: AnyObject { self }
    var prepares = 0
    var plays = 0
    var pauses = 0
    var starts = false
    var error: Error?
    var holdPreparation = false
    var pending: (@Sendable (Error?) -> Void)?
    func beginObserving() {}
    func endObserving() {}
    func setQueue(_ collection: MPMediaItemCollection) { isPlaying = false }
    func prepare(_ completion: @escaping @Sendable (Error?) -> Void) {
        prepares += 1
        if holdPreparation { pending = completion } else { completion(error) }
    }
    func play() { plays += 1; isPlaying = starts }
    func pause() { pauses += 1; isPlaying = false }
    func next() {}
    func previous() {}
}
