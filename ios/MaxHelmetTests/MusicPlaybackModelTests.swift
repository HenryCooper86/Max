import MediaPlayer
import XCTest
@testable import MaxHelmet

final class MusicPlaybackModelTests: XCTestCase {
    @MainActor func testDeniedVoiceRequestShowsRecoverableCard() async {
        let model = MusicPlaybackModel(requestAuthorization: { .denied })
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
        let model = MusicPlaybackModel(requestAuthorization: { .restricted })
        await model.chooseMusic()
        XCTAssertTrue(model.visible)
        XCTAssertFalse(model.showingPicker)
        XCTAssertFalse(model.busy)
        XCTAssertNotNil(model.message)
    }

    @MainActor func testConcurrentVoiceCommandDoesNotRacePermissionRequest() async {
        var pending: CheckedContinuation<MPMediaLibraryAuthorizationStatus, Never>?
        let model = MusicPlaybackModel(requestAuthorization: {
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
}
