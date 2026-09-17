package com.horizon.maxhelmet.music

import android.content.ComponentName
import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.service.notification.NotificationListenerService
import androidx.core.app.NotificationManagerCompat

// This service grants access to media sessions. No notification content is read.
class MusicSessionAccessService : NotificationListenerService()

class QQMusicSessions(private val context: Context) {
    companion object { const val PACKAGE = "com.tencent.qqmusic" }
    fun permitted() = context.packageName in NotificationManagerCompat.getEnabledListenerPackages(context)
    fun find(): QQMusicSession? {
        val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        val controller = manager.getActiveSessions(ComponentName(context, MusicSessionAccessService::class.java))
            .filter { it.packageName == PACKAGE }
            .sortedByDescending { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            .firstOrNull() ?: return null
        return Session(controller)
    }
    private class Session(private val controller: MediaController) : QQMusicSession {
        override fun snapshot(): QQMusicSnapshot {
            val state = controller.playbackState ?: error("Session unavailable")
            val metadata = controller.metadata
            val title = metadata?.getString(MediaMetadata.METADATA_KEY_TITLE).orEmpty()
            val artist = metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST).orEmpty()
            val mediaId = metadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_ID)?.takeIf { it.isNotBlank() }
            val queueId = state.activeQueueItemId.takeIf { it != android.media.session.MediaSession.QueueItem.UNKNOWN_ID.toLong() }
            val identity = mediaId ?: if (title.isNotBlank()) "$title|$artist|${metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION)}|$queueId" else queueId?.toString()
            val actions = buildSet {
                if (state.actions and PlaybackState.ACTION_PLAY != 0L) add("play")
                if (state.actions and PlaybackState.ACTION_PAUSE != 0L) add("pause")
                if (state.actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L) add("next")
                if (state.actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L) add("previous")
            }
            return QQMusicSnapshot(identity, title, artist, state.state == PlaybackState.STATE_PLAYING, actions,
                state.state == PlaybackState.STATE_PAUSED || state.state == PlaybackState.STATE_STOPPED)
        }
        override fun send(action: String) {
            when (action) {
                "play" -> controller.transportControls.play()
                "pause" -> controller.transportControls.pause()
                "next" -> controller.transportControls.skipToNext()
                "previous" -> controller.transportControls.skipToPrevious()
            }
        }
    }
}
