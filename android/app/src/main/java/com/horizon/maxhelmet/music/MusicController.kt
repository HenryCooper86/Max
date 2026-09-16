package com.horizon.maxhelmet.music

import android.content.ComponentName
import android.content.Context
import android.media.AudioAttributes
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.AudioManager
import android.media.AudioFocusRequest
import android.media.session.MediaSession
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.core.app.NotificationManagerCompat
import com.horizon.maxhelmet.actions.DeviceResult
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class MusicState(
    val visible: Boolean = false, val title: String = "音乐", val artist: String = "",
    val playing: Boolean = false, val busy: Boolean = false, val message: String? = null,
    val source: String = "本机音乐", val remoteAccess: Boolean = false
)

class MusicController(private val context: Context, private val scope: CoroutineScope) {
    private val mutableState = MutableStateFlow(MusicState())
    val state = mutableState.asStateFlow()
    private val sessions = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
    private val component = ComponentName(context, MusicSessionListener::class.java)
    private var remote: MediaController? = null
    private var remoteOperation: Pair<MediaController, RemotePlaybackSnapshot>? = null
    private var local: MediaPlayer? = null
    private var playlist = emptyList<Uri>()
    private var index = 0
    private var generation = 0
    private var monitor: Job? = null
    private var prepareTimeout: Job? = null
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var resumeAfterFocus = false
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        .setOnAudioFocusChangeListener({ change ->
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS -> { resumeAfterFocus = false; runCatching { local?.pause() }; mutableState.update { it.copy(playing = false) }; MusicPlaybackService.stop(context) }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { resumeAfterFocus = state.value.playing; runCatching { local?.pause() }; mutableState.update { it.copy(playing = false) } }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> runCatching { local?.setVolume(0.2f, 0.2f) }
                AudioManager.AUDIOFOCUS_GAIN -> {
                    runCatching {
                        local?.setVolume(1f, 1f)
                        if (resumeAfterFocus) { local?.start(); mutableState.update { it.copy(playing = true) } }
                    }
                    resumeAfterFocus = false
                }
            }
        }, Handler(Looper.getMainLooper())).build()
    val mediaSession = MediaSession(context, "Max music").apply {
        setCallback(object : MediaSession.Callback() {
            override fun onPlay() { control("play") }
            override fun onPause() { control("pause") }
            override fun onSkipToNext() { control("next") }
            override fun onSkipToPrevious() { control("previous") }
            override fun onStop() { control("pause") }
        }, Handler(Looper.getMainLooper()))
    }
    val isLocalPlayback: Boolean get() = local != null

    init {
        scope.launch {
            state.collect { current ->
                mediaSession.isActive = local != null
                if (local != null) {
                    mediaSession.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, current.title).build())
                    mediaSession.setPlaybackState(PlaybackState.Builder()
                        .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                        .setState(if (current.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                            PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (current.playing) 1f else 0f).build())
                }
            }
        }
    }
    private val callback = object : MediaController.Callback() {
        override fun onPlaybackStateChanged(state: PlaybackState?) { refreshRemote() }
        override fun onMetadataChanged(metadata: MediaMetadata?) { refreshRemote() }
        override fun onSessionDestroyed() { bindRemote(null) }
    }

    fun show() { mutableState.update { it.copy(visible = true) }; refreshAccess() }

    fun observeWhileVisible(visible: Boolean) {
        monitor?.cancel()
        if (visible) monitor = scope.launch {
            while (isActive) { refreshAccess(); delay(1500) }
        }
    }

    fun refreshAccess() {
        val enabled = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
        mutableState.update { it.copy(remoteAccess = enabled) }
        if (!enabled) { if (remote != null) bindRemote(null); return }
        if (local != null) return
        val controllers = runCatching { sessions.getActiveSessions(component) }.getOrDefault(emptyList()).filter {
            it.packageName != context.packageName && it.playbackState?.state in setOf(
                PlaybackState.STATE_PLAYING, PlaybackState.STATE_PAUSED, PlaybackState.STATE_BUFFERING, PlaybackState.STATE_CONNECTING)
        }
        val current = controllers.firstOrNull { it.sessionToken == remote?.sessionToken }
        bindRemote(current ?: controllers.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: controllers.firstOrNull())
    }

    private fun bindRemote(controller: MediaController?) {
        if (remote?.sessionToken == controller?.sessionToken) { refreshRemote(); return }
        remote?.unregisterCallback(callback)
        remote = controller
        controller?.registerCallback(callback, Handler(Looper.getMainLooper()))
        refreshRemote()
    }

    private fun refreshRemote() {
        if (local != null) return
        val controller = remote
        mutableState.update { it.copy(
            title = controller?.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: "音乐",
            artist = controller?.metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST).orEmpty(),
            playing = controller?.playbackState?.state == PlaybackState.STATE_PLAYING,
            source = controller?.let { playerLabel(it.packageName) } ?: "本机音乐"
        ) }
    }

    private fun playerLabel(packageName: String): String = runCatching {
        context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(packageName, 0)).toString()
    }.getOrDefault(packageName)

    fun useExternalPlayer() {
        generation++; local?.release(); local = null; playlist = emptyList()
        prepareTimeout?.cancel()
        audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context); mediaSession.isActive = false
        mutableState.update { it.copy(playing = false, busy = false, message = null) }
        show(); refreshAccess()
    }

    fun select(uris: List<Uri>) {
        if (uris.isEmpty()) return
        runCatching { remote?.transportControls?.pause() }
        bindRemote(null)
        playlist = uris; index = 0
        show(); prepareLocal()
    }

    private fun prepareLocal() {
        val uri = playlist.getOrNull(index) ?: return
        generation++
        prepareTimeout?.cancel()
        resumeAfterFocus = false
        val owner = generation
        local?.release()
        val player = MediaPlayer()
        local = player
        mutableState.update { it.copy(visible = true, title = "正在准备音乐", playing = false, busy = true, message = null, source = "本机音乐", artist = "") }
        runCatching {
            MusicPlaybackService.start(context)
            player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            player.setDataSource(context, uri)
            player.setOnPreparedListener {
                if (owner != generation) return@setOnPreparedListener
                prepareTimeout?.cancel()
                val title = runCatching {
                    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) cursor.getString(0) else null
                    }
                }.getOrNull() ?: "本机音乐"
                if (audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    player.start()
                    mutableState.update { it.copy(title = title, playing = true, busy = false) }
                } else {
                    mutableState.update { it.copy(title = title, playing = false, busy = false, message = "音频正被其他应用占用，请稍后播放。") }
                    MusicPlaybackService.stop(context)
                }
            }
            player.setOnCompletionListener {
                if (owner == generation) {
                    if (index + 1 < playlist.size) { index++; prepareLocal() }
                    else {
                        mutableState.update { it.copy(playing = false) }
                        audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context)
                    }
                }
            }
            player.setOnErrorListener { _, _, _ ->
                if (owner == generation) {
                    mutableState.update { it.copy(playing = false, busy = false, message = "音乐无法播放，请重新选择音频文件。") }
                    local?.release(); local = null
                    audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context); mediaSession.isActive = false
                }
                true
            }
            player.prepareAsync()
            prepareTimeout = scope.launch {
                delay(6000)
                if (owner == generation && state.value.busy) {
                    generation++; local?.release(); local = null
                    audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context); mediaSession.isActive = false
                    mutableState.update { it.copy(playing = false, busy = false, message = "音乐加载超时，请重新选择。") }
                }
            }
        }.onFailure {
            player.release(); local = null
            audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context); mediaSession.isActive = false
            mutableState.update { it.copy(busy = false, message = "音乐无法播放，请重新选择音频文件。") }
        }
    }

    /** A relay confirmation waits for local preparation instead of announcing
     * success while a file is still loading or failing. */
    suspend fun execute(action: String, app: String? = null): DeviceResult {
        remoteOperation = null
        val result = control(action, app)
        if (result.status != "ok") return result
        val operation = remoteOperation
        if (operation != null) {
            mutableState.update { it.copy(busy = true, message = null) }
            try {
                val (controller, before) = operation
                repeat(30) {
                    if (remote?.sessionToken != controller.sessionToken) return DeviceResult.failed("music.playerUnavailable")
                    if (remoteControlCompleted(action, before, snapshot(controller))) return DeviceResult.OK
                    delay(100)
                }
                if (remoteControlCompleted(action, before, snapshot(controller))) return DeviceResult.OK
                mutableState.update { it.copy(message = "音乐应用没有完成操作，请检查播放队列或在音乐应用中重试。") }
                return DeviceResult.failed("music.controlUnavailable")
            } finally { mutableState.update { it.copy(busy = false) } }
        }
        if (!state.value.busy) return result
        val settled = withTimeoutOrNull(7000) { state.first { !it.busy } }
        return if (settled?.playing == true) DeviceResult.OK else DeviceResult.failed("music.unavailable")
    }

    private fun snapshot(controller: MediaController): RemotePlaybackSnapshot {
        val metadata = controller.metadata
        val queueId = controller.playbackState?.activeQueueItemId?.takeIf { it != MediaSession.QueueItem.UNKNOWN_ID.toLong() }
        return RemotePlaybackSnapshot(
            metadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_ID), queueId,
            metadata?.getString(MediaMetadata.METADATA_KEY_TITLE), metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST),
            controller.playbackState?.state == PlaybackState.STATE_PLAYING
        )
    }

    fun control(control: String, app: String? = null): DeviceResult {
        show()
        if (control !in setOf("play", "pause", "next", "previous")) return DeviceResult.failed("action.invalid")
        if (state.value.busy) return DeviceResult.failed("music.busy")
        // A named app must never silently control a different player's queue.
        if (!app.isNullOrBlank()) {
            val target = if (state.value.remoteAccess) runCatching { sessions.getActiveSessions(component) }.getOrDefault(emptyList())
                .firstOrNull { matchesMusicApp(app, it.packageName, playerLabel(it.packageName)) } else null
            if (target == null) {
                mutableState.update { it.copy(message = "请先授权音乐应用控制，并在指定音乐应用中建立播放队列。") }
                return if (!state.value.remoteAccess) DeviceResult.denied("permission.musicControl") else DeviceResult.failed("music.playerUnavailable")
            }
            generation++; local?.release(); local = null
            audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context); mediaSession.isActive = false
            bindRemote(target)
        }
        val player = local
        if (player != null) {
            return runCatching {
                when (control) {
                    "play" -> {
                        MusicPlaybackService.start(context)
                        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                            MusicPlaybackService.stop(context); return DeviceResult.failed("music.unavailable")
                        }
                        player.start(); mutableState.update { it.copy(playing = true, message = null) }
                    }
                    "pause" -> {
                        resumeAfterFocus = false; player.pause(); mutableState.update { it.copy(playing = false) }
                        audio.abandonAudioFocusRequest(focus); MusicPlaybackService.stop(context)
                    }
                    "next" -> if (index + 1 < playlist.size) { index++; prepareLocal() } else return DeviceResult.failed("music.queueEnd")
                    "previous" -> if (index > 0) { index--; prepareLocal() } else return DeviceResult.failed("music.queueEnd")
                }
                DeviceResult.OK
            }.getOrElse { DeviceResult.failed("music.unavailable") }
        }
        val controller = remote ?: run {
            mutableState.update { it.copy(message = "请选择本机音乐，或授权控制正在播放的音乐应用。") }
            return DeviceResult.failed("music.emptyQueue")
        }
        val requiredAction = when (control) {
            "play" -> PlaybackState.ACTION_PLAY
            "pause" -> PlaybackState.ACTION_PAUSE
            "next" -> PlaybackState.ACTION_SKIP_TO_NEXT
            else -> PlaybackState.ACTION_SKIP_TO_PREVIOUS
        }
        if ((controller.playbackState?.actions ?: 0L) and requiredAction == 0L) return DeviceResult.unsupported("music.controlUnavailable")
        remoteOperation = controller to snapshot(controller)
        return runCatching {
            when (control) {
                "play" -> controller.transportControls.play()
                "pause" -> controller.transportControls.pause()
                "next" -> controller.transportControls.skipToNext()
                "previous" -> controller.transportControls.skipToPrevious()
            }
            DeviceResult.OK
        }.getOrElse { DeviceResult.failed("music.unavailable") }
    }
}

fun matchesMusicApp(request: String, packageName: String, label: String): Boolean {
    val name = request.trim().lowercase()
    val aliases = mapOf("apple music" to "com.apple.android.music", "苹果音乐" to "com.apple.android.music",
        "网易云音乐" to "com.netease.cloudmusic", "qq音乐" to "com.tencent.qqmusic")
    return packageName.equals(name, true) || label.equals(name, true) || aliases[name] == packageName
}
