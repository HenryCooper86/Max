import Combine
import MediaPlayer
import UIKit

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

    private let player = MPMusicPlayerController.systemMusicPlayer
    private var observing = false
    private let requestAuthorization: () async -> MPMediaLibraryAuthorizationStatus

    init(requestAuthorization: @escaping () async -> MPMediaLibraryAuthorizationStatus = {
        await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
        }
    }) {
        self.requestAuthorization = requestAuthorization
        super.init()
    }

    private func observePlayback() {
        guard !observing else { return }
        observing = true
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(playbackChanged),
                           name: .MPMusicPlayerControllerPlaybackStateDidChange, object: player)
        center.addObserver(self, selector: #selector(playbackChanged),
                           name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: player)
        center.addObserver(self, selector: #selector(playbackChanged),
                           name: UIApplication.didBecomeActiveNotification, object: nil)
        player.beginGeneratingPlaybackNotifications()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if observing { player.endGeneratingPlaybackNotifications() }
    }

    @objc private nonisolated func playbackChanged() {
        Task { @MainActor [weak self] in self?.refresh() }
    }

    private func refresh() {
        title = player.nowPlayingItem?.title ?? "Apple Music"
        artist = player.nowPlayingItem?.artist ?? ""
        isPlaying = player.playbackState == .playing
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
        busy = true
        defer { busy = false }
        player.setQueue(with: collection)
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
        guard player.nowPlayingItem != nil else { return emptyQueue() }
        switch control {
        case .play: break
        case .pause: player.pause()
        case .next: player.skipToNextItem()
        case .previous: player.skipToPreviousItem()
        }
        refresh()
        return .ok
    }

    private func startPlayback() async -> DeviceActionResult {
        // prepareToPlay resolves the Music app's existing queue or the queue
        // selected in our picker. Failures must reach the relay as failures.
        let error: Error? = await withCheckedContinuation { continuation in
            player.prepareToPlay { continuation.resume(returning: $0) }
        }
        if let error {
            message = "音乐无法播放，请选择音乐并检查 Apple Music 是否可用。"
            refresh()
            return .failed("music.unavailable", error.localizedDescription)
        }
        guard player.nowPlayingItem != nil else { return emptyQueue() }
        message = nil
        player.play()
        refresh()
        return .ok
    }

    private func emptyQueue() -> DeviceActionResult {
        message = "暂无播放队列，请点“选择音乐”添加歌曲。"
        refresh()
        return .failed("music.emptyQueue", message)
    }
}
