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

    init(player: MusicPlaybackDriving? = nil,
         preparationTimeoutNanoseconds: UInt64 = 8_000_000_000,
         playbackAttempts: Int = 30,
         waitForPlayback: @escaping () async -> Void = { try? await Task.sleep(nanoseconds: 100_000_000) },
         requestAuthorization: @escaping () async -> MPMediaLibraryAuthorizationStatus = {
        await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
        }
    }) {
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
        title = player.title ?? "Apple Music"
        artist = player.artist ?? ""
        isPlaying = player.isPlaying
        if isPlaying { message = nil }
    }

    private func authorize(_ generation: Int) async -> Bool {
        let status = await requestAuthorization()
        guard operationIsCurrent(generation) else { return false }
        guard status == .authorized else {
            message = "请在系统设置中允许 Max 访问媒体与 Apple Music。"
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
            userInfo: [NSLocalizedDescriptionKey: "播放请求已取消。"] ))
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
        return .failed("music.unavailable", "音乐控制已取消。")
    }

    func chooseMusic() async {
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
        guard !appInBackground, !busy, !collection.items.isEmpty else { return }
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
            return isPlaying ? .failed("music.controlUnavailable", "音乐未暂停，请重试。") : .ok
        }
        guard !appInBackground else { return .failed("music.unavailable", "请回到 Max 中播放音乐。") }
        visible = true
        guard !busy else { return .failed("music.busy", "音乐正在准备，请稍后重试。") }
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
        message = "歌曲没有切换。播放队列可能已到末尾，请在 Max 的“选择音乐”中添加多首歌曲或歌单。"
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
                        userInfo: [NSLocalizedDescriptionKey: "准备音乐超时，请重试或重新选择歌曲。"] ))
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
                message = "音乐准备失败：\(failure.localizedDescription)（\(failure.domain) / \(failure.code)）"
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
        message = "音乐未开始播放。请在 Max 中重新选择歌曲，并检查网络、Apple Music 账号或歌曲是否可用。"
        return .failed("music.unavailable", message)
    }

    private func emptyQueue() -> DeviceActionResult {
        message = "暂无播放队列，请点“选择音乐”添加歌曲。"
        refresh()
        return .failed("music.emptyQueue", message)
    }
}
