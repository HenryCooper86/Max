package com.horizon.maxhelmet.music

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import com.horizon.maxhelmet.actions.DeviceResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Android adapter for Max's own player; never controls another app's session. */
class MusicController(private val context: Context, scope: CoroutineScope) {
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var currentMediaPlayer: MediaPlayer? = null
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        .setOnAudioFocusChangeListener({ change ->
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> stopPlayback()
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> runCatching { currentMediaPlayer?.setVolume(0.2f, 0.2f) }
                // A focus gain must never restart a cancelled or backgrounded song.
                AudioManager.AUDIOFOCUS_GAIN -> runCatching { currentMediaPlayer?.setVolume(1f, 1f) }
            }
        }, Handler(Looper.getMainLooper())).build()
    private val playback = AppMusicPlayback(scope) { AndroidMusicDriver() }
    val state = playback.state
    private val mediaSession = MediaSession(context, "Max music").apply {
        setCallback(object : MediaSession.Callback() {
            override fun onPlay() { playback.control("play") }
            override fun onPause() { stopPlayback() }
            override fun onSkipToNext() { playback.control("next") }
            override fun onSkipToPrevious() { playback.control("previous") }
            override fun onStop() { stopPlayback() }
        }, Handler(Looper.getMainLooper()))
    }

    init {
        scope.launch {
            state.collect { current ->
                mediaSession.isActive = current.playing
                mediaSession.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, current.title).build())
                mediaSession.setPlaybackState(PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                    .setState(if (current.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (current.playing) 1f else 0f).build())
            }
        }
    }

    var launchPicker: ((Int) -> Unit)? = null
    fun show() = playback.show()
    fun chooseMusic() {
        val launch = launchPicker ?: return
        val ticket = playback.beginSelection() ?: return
        show()
        runCatching { launch(ticket) }.onFailure { playback.completeSelection(ticket, emptyList()) }
    }
    fun setAppForeground(foreground: Boolean) = playback.setForeground(foreground)
    fun stopPlayback(dismiss: Boolean = false) = playback.stop(dismiss)
    fun beginSelection(): Int? = playback.beginSelection()
    fun completeSelection(ticket: Int, uris: List<Uri>) = playback.completeSelection(ticket, uris.map(Uri::toString))
    suspend fun execute(action: String, app: String? = null): DeviceResult = playback.execute(action, app)

    private inner class AndroidMusicDriver : AppMusicDriver {
        private val player = MediaPlayer().also { currentMediaPlayer = it }
        private var released = false
        override fun prepare(track: String, prepared: (String) -> Unit, completed: () -> Unit, failed: () -> Unit) {
            val uri = Uri.parse(track)
            player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            player.setDataSource(context, uri)
            player.setOnPreparedListener {
                if (!released) {
                    val title = runCatching {
                        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                            if (cursor.moveToFirst()) cursor.getString(0) else null
                        }
                    }.getOrNull() ?: "Max 音乐"
                    prepared(title)
                }
            }
            player.setOnCompletionListener { if (!released) completed() }
            player.setOnErrorListener { _, _, _ -> if (!released) failed(); true }
            player.prepareAsync()
        }
        override fun play(): Boolean {
            if (released || audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false
            player.start()
            return player.isPlaying
        }
        override fun pause() {
            if (!released) { player.pause(); audio.abandonAudioFocusRequest(focus) }
        }
        override fun release() {
            if (released) return
            released = true
            player.setOnPreparedListener(null); player.setOnCompletionListener(null); player.setOnErrorListener(null)
            player.release()
            if (currentMediaPlayer === player) currentMediaPlayer = null
            audio.abandonAudioFocusRequest(focus)
        }
    }
}
