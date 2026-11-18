package io.github.henrycooper86.max.music

import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.AssistantBranding

import io.github.henrycooper86.max.actions.DeviceResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Only an adapter scoped to QQ Music may supply this interface. */
interface QQMusicSession {
    fun snapshot(): QQMusicSnapshot
    fun send(action: String)
}

data class QQMusicSnapshot(
    val identity: String?, val title: String, val artist: String = "",
    val playing: Boolean, val actions: Set<String>, val paused: Boolean = false
)

/** Never acknowledges a skip until the remote session reports a different item. */
class QQMusicPlayback(
    private val permitted: () -> Boolean,
    private val findSession: () -> QQMusicSession?,
    private val wait: suspend () -> Unit = { delay(100) },
    private val attempts: Int = 50
) {
    private val mutableState = MutableStateFlow(MusicState(title = "QQ音乐", source = "QQ音乐"))
    val state = mutableState.asStateFlow()
    private var generation = 0
    fun show() { mutableState.update { it.copy(visible = true) } }
    fun dismiss() {
        generation++
        mutableState.update { it.copy(visible = false, busy = false, message = null) }
    }
    fun refresh() {
        val snapshot = runCatching { if (permitted()) findSession()?.snapshot() else null }.getOrNull()
        if (snapshot != null) publish(snapshot)
        else mutableState.update { it.copy(title = "QQ音乐", artist = "", playing = false) }
    }
    private fun publish(snapshot: QQMusicSnapshot) {
        mutableState.update { it.copy(title = snapshot.title.ifBlank { "QQ音乐" }, artist = snapshot.artist, playing = snapshot.playing) }
    }
    private fun failure(reason: String, message: String): DeviceResult {
        mutableState.update { it.copy(message = message) }
        return DeviceResult.failed(reason)
    }
    suspend fun execute(action: String): DeviceResult {
        if (action !in setOf("play", "pause", "next", "previous")) return DeviceResult.unsupported("action.mismatch")
        show()
        if (state.value.busy && action != "pause") return DeviceResult.failed("music.busy")
        val owner = ++generation
        mutableState.update { it.copy(busy = true, message = null) }
        try {
            if (!permitted()) return failure("permission.musicControl", tr(Str.QQ_NEEDS_PERMISSION, "name" to AssistantBranding.name))
            val session = findSession() ?: return failure("music.playerUnavailable", tr(Str.QQ_OPEN_FIRST, "name" to AssistantBranding.name))
            val before = session.snapshot()
            publish(before)
            if ((action == "play" && before.playing) || (action == "pause" && before.paused)) return DeviceResult.OK
            if (action !in before.actions) return failure("music.controlUnavailable", tr(Str.QQ_NO_ACTION))
            if (action in setOf("next", "previous") && before.identity == null)
                return failure("music.controlUnavailable", tr(Str.QQ_UNKNOWN_SONG))
            session.send(action)
            repeat(attempts) {
                wait()
                if (owner != generation) return DeviceResult.failed("action.cancelled")
                if (!permitted()) return failure("permission.musicControl", tr(Str.QQ_PERMISSION_OFF))
                val after = session.snapshot()
                publish(after)
                val confirmed = when (action) {
                    "play" -> after.playing
                    "pause" -> after.paused
                    else -> after.identity != null && after.identity != before.identity && (!before.playing || after.playing)
                }
                if (confirmed) return DeviceResult.OK
            }
            return failure("music.controlUnavailable", tr(Str.QQ_UNCONFIRMED))
        } catch (_: SecurityException) {
            return failure("permission.musicControl", tr(Str.QQ_GRANT_FIRST))
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (_: Exception) {
            return failure("music.playerUnavailable", tr(Str.QQ_SESSION_LOST))
        } finally {
            if (owner == generation) mutableState.update { it.copy(busy = false) }
        }
    }
}
