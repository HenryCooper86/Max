package io.github.henrycooper86.max.music

import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.AssistantBranding

import android.content.Context
import android.content.Intent
import android.provider.Settings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
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
import io.github.henrycooper86.max.actions.DeviceResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive

/** Routes to the selected source; QQ controls are restricted to its media session. */
class MusicController(private val context: Context, private val scope: CoroutineScope) {
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var currentMediaPlayer: MediaPlayer? = null
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        .setOnAudioFocusChangeListener({ change ->
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> playback.stop()
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> runCatching { currentMediaPlayer?.setVolume(0.2f, 0.2f) }
                // A focus gain must never restart a cancelled or backgrounded song.
                AudioManager.AUDIOFOCUS_GAIN -> runCatching { currentMediaPlayer?.setVolume(1f, 1f) }
            }
        }, Handler(Looper.getMainLooper())).build()
    private val playback = AppMusicPlayback(scope) { AndroidMusicDriver() }
    private val sessions = QQMusicSessions(context)
    private val qq = QQMusicPlayback(sessions::permitted, sessions::find)
    private var useQQ = true
    private var foreground = false
    private val mutableState = MutableStateFlow(qq.state.value)
    val state = mutableState.asStateFlow()
    private val mediaSession = MediaSession(context, "Max music").apply {
        setCallback(object : MediaSession.Callback() {
            override fun onPlay() { if (!useQQ) playback.control("play") }
            override fun onPause() { playback.stop() }
            override fun onSkipToNext() { if (!useQQ) playback.control("next") }
            override fun onSkipToPrevious() { if (!useQQ) playback.control("previous") }
            override fun onStop() { playback.stop() }
        }, Handler(Looper.getMainLooper()))
    }

    init {
        scope.launch {
            while (kotlinx.coroutines.currentCoroutineContext().isActive) {
                if (foreground && useQQ && state.value.visible && !state.value.busy) qq.refresh()
                kotlinx.coroutines.delay(1000)
            }
        }
        scope.launch { qq.state.collect { if (useQQ) mutableState.value = it } }
        scope.launch {
            playback.state.collect { current ->
                if (!useQQ) mutableState.value = current
                // Keep a paused queue addressable by Bluetooth so Play can resume it.
                mediaSession.isActive = !useQQ && current.visible
                mediaSession.setMetadata(MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, current.title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, current.artist).build())
                mediaSession.setPlaybackState(PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                    .setState(if (current.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (current.playing) 1f else 0f).build())
            }
        }
    }

    var launchPicker: ((Int) -> Unit)? = null
    fun show() { if (useQQ) { qq.show(); qq.refresh() } else playback.show() }
    fun chooseMusic() { if (useQQ) show() else chooseLocalMusic() }
    fun chooseQQMusic() {
        playback.stop()
        useQQ = true
        mediaSession.isActive = false
        mutableState.value = qq.state.value
        show()
    }
    fun openQQMusic() {
        val intent = context.packageManager.getLaunchIntentForPackage(QQMusicSessions.PACKAGE)
            ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://y.qq.com/"))
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { mutableState.value = state.value.copy(message = tr(Str.QQ_NOT_INSTALLED)) }
    }
    fun authorizeQQMusic() {
        runCatching { context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { mutableState.value = state.value.copy(message = tr(Str.QQ_ACCESS, "name" to AssistantBranding.name)) }
    }
    fun chooseLocalMusic() {
        if (useQQ) qq.refresh()
        if (useQQ && state.value.playing) {
            scope.launch { if (qq.execute("pause").status == "ok") activateLocalPicker() }
        } else activateLocalPicker()
    }
    private fun activateLocalPicker() {
        val launch = launchPicker ?: return
        val ticket = playback.beginSelection() ?: return
        qq.dismiss()
        useQQ = false
        mutableState.value = playback.state.value
        show()
        runCatching { launch(ticket) }.onFailure { playback.completeSelection(ticket, emptyList()) }
    }
    fun setAppForeground(foreground: Boolean) {
        this.foreground = foreground
        playback.setForeground(foreground)
        if (foreground && useQQ) qq.refresh()
    }
    fun stopPlayback(dismiss: Boolean = false) {
        if (!useQQ) playback.stop(dismiss)
        else {
            // Closing hides the handoff card; playback remains owned by QQ Music.
            if (dismiss) qq.dismiss()
            else if (state.value.playing) scope.launch { qq.execute("pause") }
        }
    }
    fun beginSelection(): Int? = playback.beginSelection()
    fun completeSelection(ticket: Int, uris: List<Uri>) = playback.completeSelection(ticket, uris.map(Uri::toString))
    suspend fun execute(action: String, app: String? = null): DeviceResult {
        if (!app.isNullOrBlank()) {
            if (!Regex("qq\\s*(音乐|music)", RegexOption.IGNORE_CASE).matches(app.trim())) return DeviceResult.unsupported("player.unsupported")
            if (!useQQ) chooseQQMusic()
        }
        return if (useQQ) qq.execute(action) else playback.execute(action)
    }

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
