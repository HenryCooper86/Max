import MediaPlayer

/// The playback surface we can actually reach. MPMusicPlayerController drives
/// Apple Music and the local library only; no iOS API lets one app control
/// another app's playback.
protocol SystemMusicPlaying {
    @MainActor func perform(_ control: MusicControl) async -> DeviceActionResult
    @MainActor func performQQ(_ control: MusicControl) async -> DeviceActionResult
}

extension SystemMusicPlaying {
    @MainActor func performQQ(_ control: MusicControl) async -> DeviceActionResult {
        .unsupported("music.qq.integrationRequired")
    }
}

struct MusicController: DeviceActionHandler {
    private let player: SystemMusicPlaying

    init(player: SystemMusicPlaying) {
        self.player = player
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .musicControl(control, app) = action else { return .unsupported("action.mismatch") }
        if let app {
            let normalized = app.lowercased().filter { !$0.isWhitespace }
            guard ["qq音乐", "qqmusic"].contains(normalized) else { return .unsupported("player.unsupported") }
            return await player.performQQ(control)
        }
        return await player.perform(control)
    }
}
