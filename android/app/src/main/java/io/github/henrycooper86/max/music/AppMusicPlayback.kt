package io.github.henrycooper86.max.music

import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.AssistantBranding

import io.github.henrycooper86.max.actions.DeviceResult
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class MusicState(
    val visible: Boolean = false, val title: String = "音乐", val artist: String = "",
    val playing: Boolean = false, val busy: Boolean = false, val message: String? = null,
    val source: String = "Max 音乐"
)

/** Hardware boundary: the queue and lifecycle below can be exercised without Android. */
interface AppMusicDriver {
    fun prepare(track: String, prepared: (String) -> Unit, completed: () -> Unit, failed: () -> Unit)
    fun play(): Boolean
    fun pause()
    fun release()
}

/** Main-thread owned player. Nothing is delegated to another music application's queue. */
class AppMusicPlayback(private val scope: CoroutineScope, private val createDriver: () -> AppMusicDriver) {
    private val mutableState = MutableStateFlow(MusicState())
    val state = mutableState.asStateFlow()
    private var foreground = false
    private var generation = 0
    private var driver: AppMusicDriver? = null
    private var prepared = false
    private var playlist = emptyList<String>()
    private var index = 0
    private var timeout: Job? = null
    private var selectionSequence = 0
    private var selectionTicket: Int? = null
    private var pendingSelection: List<String>? = null

    fun show() { mutableState.update { it.copy(visible = true) } }

    fun setForeground(value: Boolean) {
        foreground = value
        if (!value) stop(preserveSelection = true)
        else pendingSelection?.let { tracks -> pendingSelection = null; select(tracks) }
    }

    // A document-picker result can arrive before Activity.onStart. Only a result
    // from an explicit, still-current selection may start when Max returns.
    fun beginSelection(): Int? {
        if (!foreground) return null
        return (++selectionSequence).also { selectionTicket = it }
    }

    fun completeSelection(ticket: Int, tracks: List<String>) {
        if (ticket != selectionTicket) return
        selectionTicket = null
        if (tracks.isEmpty()) return
        if (foreground) select(tracks) else pendingSelection = tracks
    }

    fun select(tracks: List<String>) {
        if (!foreground || tracks.isEmpty()) return
        playlist = tracks.toList(); index = 0
        show(); prepareTrack()
    }

    fun stop(dismiss: Boolean = false, preserveSelection: Boolean = false) {
        generation++
        timeout?.cancel(); timeout = null
        if (!preserveSelection) { selectionTicket = null; pendingSelection = null }
        if (prepared) {
            runCatching { driver?.pause() }.onFailure {
                runCatching { driver?.release() }; driver = null; prepared = false
            }
        } else { runCatching { driver?.release() }; driver = null }
        mutableState.update { it.copy(visible = it.visible && !dismiss, playing = false, busy = false, message = null) }
    }

    fun control(action: String, app: String? = null): DeviceResult {
        if (action !in setOf("play", "pause", "next", "previous")) return DeviceResult.failed("action.invalid")
        if (!app.isNullOrBlank()) return DeviceResult.unsupported("player.unsupported")
        if (action == "pause") { stop(); return DeviceResult.OK }
        if (!foreground) return DeviceResult.failed("music.unavailable", tr(Str.MUSIC_RETURN, "name" to AssistantBranding.name))
        show()
        if (state.value.busy) return DeviceResult.failed("music.busy")
        if (playlist.isEmpty()) {
            mutableState.update { it.copy(message = tr(Str.MUSIC_NO_QUEUE, "name" to AssistantBranding.name)) }
            return DeviceResult.failed("music.emptyQueue")
        }
        when (action) {
            "next" -> {
                if (index + 1 >= playlist.size) return DeviceResult.failed("music.queueEnd")
                index++; prepareTrack()
            }
            "previous" -> {
                if (index == 0) return DeviceResult.failed("music.queueEnd")
                index--; prepareTrack()
            }
            "play" -> if (prepared && driver != null) {
                if (!runCatching { driver!!.play() }.getOrDefault(false)) return failPlayback()
                mutableState.update { it.copy(playing = true, message = null) }
            } else prepareTrack()
        }
        return DeviceResult.OK
    }

    suspend fun execute(action: String, app: String? = null): DeviceResult {
        val result = control(action, app)
        if (result.status != "ok" || action == "pause") return result
        val owner = generation
        try {
            val settled = withTimeoutOrNull(7000) { state.first { !it.busy || generation != owner } }
            if (generation != owner) return DeviceResult.failed(if (state.value.message == null) "action.cancelled" else "music.unavailable")
            return if (settled?.playing == true) DeviceResult.OK else DeviceResult.failed("music.unavailable")
        } catch (cancelled: CancellationException) {
            if (generation == owner) stop()
            throw cancelled
        }
    }

    private fun prepareTrack() {
        val track = playlist.getOrNull(index) ?: return
        generation++
        val owner = generation
        timeout?.cancel()
        runCatching { driver?.release() }
        driver = null; prepared = false
        mutableState.update { it.copy(visible = true, title = tr(Str.MUSIC_PREPARING_TITLE), artist = "", playing = false, busy = true, message = null) }
        try {
            val current = createDriver()
            driver = current
            current.prepare(track, prepared = { title ->
                if (owner == generation && driver === current && foreground) {
                    timeout?.cancel(); timeout = null
                    prepared = true
                    if (runCatching { current.play() }.getOrDefault(false)) {
                        mutableState.update { it.copy(title = title, playing = true, busy = false) }
                    } else failPlayback()
                }
            }, completed = {
                // A paused ready player retains its queue position. Completion is
                // accepted only while that same driver is actively playing.
                if (driver === current && foreground && state.value.playing) {
                    if (index + 1 < playlist.size) { index++; prepareTrack() } else stop()
                }
            }, failed = {
                if (driver === current) failPlayback()
            })
            if (owner == generation && state.value.busy) timeout = scope.launch {
                delay(6000)
                if (owner == generation && state.value.busy) failPlayback(tr(Str.MUSIC_LOAD_TIMEOUT))
            }
        } catch (_: Exception) { if (owner == generation) failPlayback() }
    }

    private fun failPlayback(message: String = tr(Str.MUSIC_PLAY_FAILED)) : DeviceResult {
        generation++
        timeout?.cancel(); timeout = null
        runCatching { driver?.release() }; driver = null; prepared = false
        mutableState.update { it.copy(playing = false, busy = false, message = message) }
        return DeviceResult.failed("music.unavailable", message)
    }
}
