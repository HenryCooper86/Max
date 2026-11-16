import Combine
import MediaPlayer
import UIKit

@MainActor
protocol MusicPlaybackDriving: AnyObject {
    var title: String? { get }
    var artist: String? { get }
    var hasItem: Bool { get }
    var itemIdentity: String? { get }
    var isPlaying: Bool { get }
    var notificationObject: AnyObject { get }
    func beginObserving()
    func endObserving()
    func setQueue(_ collection: MPMediaItemCollection)
    func prepare(_ completion: @escaping @Sendable (Error?) -> Void)
    func play()
    func pause()
    func next()
    func previous()
}

@MainActor
private final class AppMusicPlaybackDriver: MusicPlaybackDriving {
    private let player = MPMusicPlayerController.applicationMusicPlayer
    var title: String? { player.nowPlayingItem?.title }
    var artist: String? { player.nowPlayingItem?.artist }
    var hasItem: Bool { player.nowPlayingItem != nil }
    var itemIdentity: String? {
        guard let item = player.nowPlayingItem else { return nil }
        return "\(item.persistentID):\(item.playbackStoreID):\(player.indexOfNowPlayingItem)"
    }
    var isPlaying: Bool { player.playbackState == .playing }
    var notificationObject: AnyObject { player }
    func beginObserving() { player.beginGeneratingPlaybackNotifications() }
    func endObserving() { player.endGeneratingPlaybackNotifications() }
    func setQueue(_ collection: MPMediaItemCollection) { player.setQueue(with: collection) }
    func prepare(_ completion: @escaping @Sendable (Error?) -> Void) { player.prepareToPlay(completionHandler: completion) }
    func play() { player.play() }
    func pause() { player.pause() }
    func next() { player.skipToNextItem() }
    func previous() { player.skipToPreviousItem() }
}

/// Resolves exactly once even if MediaPlayer never replies or replies after timeout.
@MainActor
private final class MusicPreparation {
    var continuation: CheckedContinuation<Error?, Never>?
    var timeout: Task<Void, Never>?
    func finish(_ error: Error?) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel(); timeout = nil
        continuation.resume(returning: error)
    }
}

/// Shared by voice commands and the HUD, with a queue owned only by Max.
@MainActor
final class MusicPlaybackModel: NSObject, ObservableObject, SystemMusicPlaying {
    @Published private(set) var prefersQQMusic: Bool
    @Published private(set) var visible = false
    @Published private(set) var title = "Apple Music"
    @Published private(set) var artist = ""
    @Published private(set) var isPlaying = false
    @Published private(set) var busy = false
    @Published private(set) var message: String?
    @Published var showingPicker = false

    private let player: MusicPlaybackDriving
    private var needsPreparation = false
    private var operationGeneration = 0
    private var activePreparation: MusicPreparation?
    private var appInBackground = false
    private let preparationTimeoutNanoseconds: UInt64
    private let playbackAttempts: Int
    private let waitForPlayback: () async -> Void
    private var observing = false
    private let requestAuthorization: () async -> MPMediaLibraryAuthorizationStatus

    init(prefersQQMusic: Bool = true, player: MusicPlaybackDriving? = nil,
         preparationTimeoutNanoseconds: UInt64 = 8_000_000_000,
         playbackAttempts: Int = 30,
         waitForPlayback: @escaping () async -> Void = { try? await Task.sleep(nanoseconds: 100_000_000) },
         requestAuthorization: @escaping () async -> MPMediaLibraryAuthorizationStatus = {
        await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
        }
    }) {
        self.prefersQQMusic = prefersQQMusic
        self.player = player ?? AppMusicPlaybackDriver()
        self.preparationTimeoutNanoseconds = preparationTimeoutNanoseconds
        self.playbackAttempts = playbackAttempts
        self.waitForPlayback = waitForPlayback
        self.requestAuthorization = requestAuthorization
        super.init()
    }

    private func observePlayback() {
        guard !observing else { return }
        observing = true
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(playbackChanged),
                           name: .MPMusicPlayerControllerPlaybackStateDidChange, object: player.notificationObject)
        center.addObserver(self, selector: #selector(playbackChanged),
                           name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: player.notificationObject)
        center.addObserver(self, selector: #selector(playbackChanged),
                           name: UIApplication.didBecomeActiveNotification, object: nil)
        player.beginObserving()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if observing {
            let driver = player
            Task { @MainActor in driver.endObserving() }
        }
    }

    @objc private nonisolated func playbackChanged() {
        Task { @MainActor [weak self] in self?.refresh() }
    }

    private func refresh() {
        if prefersQQMusic { title = L("music.qq.short"); artist = ""; isPlaying = false; return }
        title = player.title ?? "Apple Music"
        artist = player.artist ?? ""
        isPlaying = player.isPlaying
        if isPlaying { message = nil }
    }

    private func authorize(_ generation: Int) async -> Bool {
        let status = await requestAuthorization()
        guard operationIsCurrent(generation) else { return false }
        guard status == .authorized else {
            message = L("music.err.photosAccess", ("name", "Max"))
            return false
        }
        observePlayback()
        return true
    }

    /// Invalidates pending authorization, preparation, and skip requests before
    /// pausing, so a late callback cannot restart music after closing Max.
    func stopPlayback(dismiss: Bool = false) {
        operationGeneration += 1
        activePreparation?.finish(NSError(domain: "MaxMusic", code: 2,
            userInfo: [NSLocalizedDescriptionKey: L("music.err.requestCancelled")] ))
        activePreparation = nil
        player.pause()
        busy = false
        showingPicker = false
        message = nil
        refresh()
        if dismiss { visible = false }
    }

    func setAppInBackground(_ background: Bool) {
        appInBackground = background
        if background { stopPlayback() }
        // Returning to Max never automatically resumes a cancelled request.
    }

    private func operationIsCurrent(_ generation: Int) -> Bool {
        generation == operationGeneration && !appInBackground && !Task.isCancelled
    }

    private func cancelled(_ generation: Int) -> DeviceActionResult {
        if generation == operationGeneration { stopPlayback() }
        return .failed("music.unavailable", L("music.err.cancelled"))
    }

    func performQQ(_ control: MusicControl) async -> DeviceActionResult {
        useQQMusic()
        return .unsupported("music.qq.integrationRequired")
    }

    func useQQMusic() {
        stopPlayback()
        prefersQQMusic = true
        visible = true
        title = L("music.qq.short")
        artist = ""
        isPlaying = false
        message = L("music.err.qqNote", ("name", "Max"))
    }

    func chooseLocalMusic() async {
        prefersQQMusic = false
        await chooseMusic()
    }

    func chooseMusic() async {
        if prefersQQMusic { useQQMusic(); return }
        guard !appInBackground else { return }
        visible = true
        guard !busy else { return }
        operationGeneration += 1
        let generation = operationGeneration
        busy = true
        defer { if generation == operationGeneration { busy = false } }
        guard await authorize(generation), operationIsCurrent(generation) else { return }
        message = nil
        showingPicker = true
    }

    func select(_ collection: MPMediaItemCollection) async {
        guard !prefersQQMusic, !appInBackground, !busy, !collection.items.isEmpty else { return }
        visible = true
        operationGeneration += 1
        let generation = operationGeneration
        busy = true
        defer { if generation == operationGeneration { busy = false } }
        guard await authorize(generation), operationIsCurrent(generation) else { return }
        player.setQueue(collection)
        needsPreparation = true
        _ = await startPlayback(generation)
    }

    func perform(_ control: MusicControl) async -> DeviceActionResult {
        if prefersQQMusic { return await performQQ(control) }
        // Stop always wins, even while a picker selection is preparing.
        if control == .pause {
            stopPlayback()
            let generation = operationGeneration
            for _ in 0..<playbackAttempts {
                guard generation == operationGeneration else { return cancelled(generation) }
                refresh()
                if !isPlaying { return .ok }
                await waitForPlayback()
            }
            guard generation == operationGeneration else { return cancelled(generation) }
            refresh()
            return isPlaying ? .failed("music.controlUnavailable", L("music.err.notPaused")) : .ok
        }
        guard !appInBackground else { return .failed("music.unavailable", L("music.err.foreground", ("name", "Max"))) }
        visible = true
        guard !busy else { return .failed("music.busy", L("music.err.busy")) }
        operationGeneration += 1
        let generation = operationGeneration
        busy = true
        defer { if generation == operationGeneration { busy = false } }
        let authorized = await authorize(generation)
        guard operationIsCurrent(generation) else { return cancelled(generation) }
        guard authorized else { return .denied("permission.music", message) }
        message = nil
        if control == .play { return await startPlayback(generation) }
        guard player.hasItem else { return emptyQueue() }
        let previousItem = player.itemIdentity
        let wasPlaying = player.isPlaying
        switch control {
        case .play, .pause: break
        case .next: player.next()
        case .previous: player.previous()
        }
        var resumedNewItem = false
        // Transport calls can silently no-op at queue boundaries. Only
        // acknowledge a skip once the new item and playback are confirmed.
        for _ in 0..<playbackAttempts {
            guard operationIsCurrent(generation) else { return cancelled(generation) }
            refresh()
            let changed = player.hasItem && player.itemIdentity != nil && player.itemIdentity != previousItem
            if changed && (!wasPlaying || isPlaying) { return .ok }
            if changed && wasPlaying && !resumedNewItem {
                resumedNewItem = true
                player.play()
            }
            await waitForPlayback()
        }
        guard operationIsCurrent(generation) else { return cancelled(generation) }
        refresh()
        let changed = player.hasItem && player.itemIdentity != nil && player.itemIdentity != previousItem
        if changed && (!wasPlaying || isPlaying) { return .ok }
        message = L("music.err.noSkip", ("name", "Max"))
        return .failed("music.controlUnavailable", message)
    }

    private func startPlayback(_ generation: Int) async -> DeviceActionResult {
        guard operationIsCurrent(generation) else { return cancelled(generation) }
        // Resume Max's queue without preparing it again. Only a new selection
        // needs preparation; cancellation also resolves a missing callback.
        if needsPreparation {
            let operation = MusicPreparation()
            activePreparation = operation
            let error: Error? = await withCheckedContinuation { continuation in
                operation.continuation = continuation
                operation.timeout = Task { [preparationTimeoutNanoseconds] in
                    do { try await Task.sleep(nanoseconds: preparationTimeoutNanoseconds) }
                    catch { return }
                    operation.finish(NSError(domain: "MaxMusic", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: L("music.err.prepTimeout")] ))
                }
                player.prepare { error in
                    Task { @MainActor in operation.finish(error) }
                }
            }
            guard operationIsCurrent(generation) else { return cancelled(generation) }
            activePreparation = nil
            if let error {
                refresh()
                let failure = error as NSError
                message = L("music.err.prepFailed", ("detail", failure.localizedDescription), ("domain", failure.domain), ("code", String(failure.code)))
                return .failed("music.unavailable", message)
            }
            needsPreparation = false
        }
        guard player.hasItem else { return emptyQueue() }
        player.play()
        for _ in 0..<playbackAttempts {
            guard operationIsCurrent(generation) else { return cancelled(generation) }
            refresh()
            if isPlaying { return .ok }
            await waitForPlayback()
        }
        guard operationIsCurrent(generation) else { return cancelled(generation) }
        refresh()
        if isPlaying { return .ok }
        message = L("music.err.notPlaying", ("name", "Max"))
        return .failed("music.unavailable", message)
    }

    private func emptyQueue() -> DeviceActionResult {
        message = L("music.err.emptyQueue")
        refresh()
        return .failed("music.emptyQueue", message)
    }
}
