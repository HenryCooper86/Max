import MediaPlayer

/// The playback surface we can actually reach. MPMusicPlayerController drives
/// Apple Music and the local library only; no iOS API lets one app control
/// another app's playback.
protocol SystemMusicPlaying {
    func play()
    func pause()
    func next()
    func previous()
}

struct SystemMusicPlayer: SystemMusicPlaying {
    private let player = MPMusicPlayerController.systemMusicPlayer

    func play() { player.play() }
    func pause() { player.pause() }
    func next() { player.skipToNextItem() }
    func previous() { player.skipToPreviousItem() }
}

struct MusicController: DeviceActionHandler {
    private let player: SystemMusicPlaying

    init(player: SystemMusicPlaying = SystemMusicPlayer()) {
        self.player = player
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .musicControl(control, app) = action else { return .unsupported("action.mismatch") }
        // The relay tags a named player only when it is one we cannot drive.
        // Refuse honestly rather than silently controlling Apple Music instead.
        if app != nil { return .unsupported("player.unsupported") }
        switch control {
        case .play: player.play()
        case .pause: player.pause()
        case .next: player.next()
        case .previous: player.previous()
        }
        return .ok
    }
}
