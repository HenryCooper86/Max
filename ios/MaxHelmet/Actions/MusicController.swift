import MediaPlayer

/// The playback surface we can actually reach. MPMusicPlayerController drives
/// Apple Music and the local library only; no iOS API lets one app control
/// another app's playback.
protocol SystemMusicPlaying {
    @MainActor func perform(_ control: MusicControl) async -> DeviceActionResult
}

struct MusicController: DeviceActionHandler {
    private let player: SystemMusicPlaying

    init(player: SystemMusicPlaying) {
        self.player = player
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .musicControl(control, app) = action else { return .unsupported("action.mismatch") }
        // The relay tags a named player only when it is one we cannot drive.
        // Refuse honestly rather than silently controlling Apple Music instead.
        if app != nil { return .unsupported("player.unsupported") }
        return await player.perform(control)
    }
}
