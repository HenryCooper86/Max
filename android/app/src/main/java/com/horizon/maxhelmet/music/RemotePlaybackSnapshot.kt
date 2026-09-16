package com.horizon.maxhelmet.music

internal data class RemotePlaybackSnapshot(
    val mediaId: String?, val queueId: Long?, val title: String?, val artist: String?, val playing: Boolean
)

internal fun remoteControlCompleted(action: String, before: RemotePlaybackSnapshot, after: RemotePlaybackSnapshot): Boolean {
    if (action == "play") return after.playing
    if (action == "pause") return !after.playing
    val changed = (after.mediaId != null && after.mediaId != before.mediaId)
        || (after.queueId != null && after.queueId != before.queueId)
        || (after.title != null && (after.title != before.title || after.artist != before.artist))
    return changed && (!before.playing || after.playing)
}
