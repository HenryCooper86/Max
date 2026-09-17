package com.horizon.maxhelmet.music

import com.horizon.maxhelmet.actions.DeviceResult
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
            if (!permitted()) return failure("permission.musicControl", "请点“授权控制”，在系统通知使用权设置中允许 Max。授权用于读取 QQ 音乐的媒体会话；Max 不读取或保存通知内容。")
            val session = findSession() ?: return failure("music.playerUnavailable", "请打开 QQ 音乐，先选择并播放一首歌，再返回 Max。")
            val before = session.snapshot()
            publish(before)
            if ((action == "play" && before.playing) || (action == "pause" && before.paused)) return DeviceResult.OK
            if (action !in before.actions) return failure("music.controlUnavailable", "QQ 音乐当前未提供此操作，请在 QQ 音乐中操作。")
            if (action in setOf("next", "previous") && before.identity == null)
                return failure("music.controlUnavailable", "无法确认 QQ 音乐的当前歌曲，请在 QQ 音乐中切歌。")
            session.send(action)
            repeat(attempts) {
                wait()
                if (owner != generation) return DeviceResult.failed("action.cancelled")
                if (!permitted()) return failure("permission.musicControl", "音乐控制权限已关闭，请重新授权。")
                val after = session.snapshot()
                publish(after)
                val confirmed = when (action) {
                    "play" -> after.playing
                    "pause" -> after.paused
                    else -> after.identity != null && after.identity != before.identity && (!before.playing || after.playing)
                }
                if (confirmed) return DeviceResult.OK
            }
            return failure("music.controlUnavailable", "QQ 音乐未确认此操作。请检查播放队列或在 QQ 音乐中操作。")
        } catch (_: SecurityException) {
            return failure("permission.musicControl", "请先授权音乐控制。")
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (_: Exception) {
            return failure("music.playerUnavailable", "QQ 音乐播放会话已断开，请打开 QQ 音乐后重试。")
        } finally {
            if (owner == generation) mutableState.update { it.copy(busy = false) }
        }
    }
}
