import Combine
import MediaPlayer
import UIKit

@MainActor
protocol MusicPlaybackDriving: AnyObject {
    var title: String? { get }
    var artist: String? { get }
    var hasItem: Bool { get }
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
private final class SystemMusicPlaybackDriver: MusicPlaybackDriving {
    private let player = MPMusicPlayerController.systemMusicPlayer
    var title: String? { player.nowPlayingItem?.title }
    var artist: String? { player.nowPlayingItem?.artist }
    var hasItem: Bool { player.nowPlayingItem != nil }
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

/// Shared by voice commands and the HUD. The system queue stays available to
/// lock-screen/headset controls without navigating away from Max.
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
        self.player = player ?? SystemMusicPlaybackDriver()
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

    private func authorize() async -> Bool {
        let status = await requestAuthorization()
        guard status == .authorized else {
            message = "请在系统设置中允许 Max 访问媒体与 Apple Music。"
            return false
        }
        observePlayback()
        return true
    }

    func chooseMusic() async {
        visible = true
        guard !busy else { return }
        busy = true
        defer { busy = false }
        guard await authorize() else { return }
        message = nil
        showingPicker = true
    }

    func select(_ collection: MPMediaItemCollection) async {
        guard !busy, !collection.items.isEmpty else { return }
        visible = true
        busy = true
        defer { busy = false }
        guard await authorize() else { return }
        player.setQueue(collection)
        needsPreparation = true
        _ = await startPlayback()
    }

    func perform(_ control: MusicControl) async -> DeviceActionResult {
        visible = true
        guard !busy else { return .failed("music.busy", "音乐正在准备，请稍后重试。") }
        busy = true
        defer { busy = false }
        guard await authorize() else { return .denied("permission.music", message) }
        message = nil
        if control == .play { return await startPlayback() }
        guard player.hasItem else { return emptyQueue() }
        switch control {
        case .play: break
        case .pause: player.pause()
        case .next: player.next()
        case .previous: player.previous()
        }
        refresh()
        return .ok
    }

    private func startPlayback() async -> DeviceActionResult {
        // Resume Music's existing queue directly. Preparing it again can fail
        // even though Music has a valid current item. Only a new picker queue
        // needs preparation, and a missing callback must not freeze the card.
        if needsPreparation {
            let operation = MusicPreparation()
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
            refresh()
            if isPlaying { return .ok }
            if Task.isCancelled { return .failed("music.unavailable", "播放请求已取消。") }
            await waitForPlayback()
        }
        refresh()
        if isPlaying { return .ok }
        message = "Apple Music 未开始播放。请重新选择歌曲；若在 Apple Music 中也无法播放，请检查网络、账号或歌曲是否可用。"
        return .failed("music.unavailable", message)
    }

    private func emptyQueue() -> DeviceActionResult {
        message = "暂无播放队列，请点“选择音乐”添加歌曲。"
        refresh()
        return .failed("music.emptyQueue", message)
    }
}
