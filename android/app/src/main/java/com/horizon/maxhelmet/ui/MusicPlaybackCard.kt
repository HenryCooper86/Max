package com.horizon.maxhelmet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.music.MusicController
import com.horizon.maxhelmet.ui.theme.Visor
import com.horizon.maxhelmet.ui.theme.VisorSpace
import com.horizon.maxhelmet.ui.theme.VisorType
import kotlinx.coroutines.launch

@Composable
fun MusicPlaybackCard(controller: MusicController, compact: Boolean = false, assistantName: String = AssistantBranding.name) {
    val c = Visor.colors
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var actionError by remember { mutableStateOf<String?>(null) }
    if (!state.visible) return
    val controls: @Composable RowScope.() -> Unit = {
        listOf(Triple("previous", "上一首", Icons.Default.SkipPrevious),
            Triple(if (state.playing) "pause" else "play", if (state.playing) "暂停" else "播放", if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow),
            Triple("next", "下一首", Icons.Default.SkipNext)).forEach { (action, label, icon) ->
            val primary = action == "play" || action == "pause"
            IconButton(enabled = !state.busy || action == "pause", onClick = {
                actionError = null
                scope.launch {
                    val result = controller.execute(action)
                    actionError = when {
                        result.status == "ok" || result.reason == "action.cancelled" -> null
                        result.reason == "music.queueEnd" -> "已到播放队列末尾，请选择多首歌曲。"
                        state.source == "QQ音乐" -> null // QQ adapter provides actionable setup/response messages.
                        else -> "暂时无法播放，请在 $assistantName 中重新选择音乐。"
                    }
                }
            }, modifier = Modifier.size(48.dp).then(if (primary) Modifier.background(c.accent, CircleShape) else Modifier)) {
                Icon(icon, label, tint = if (primary) c.onAccent else c.text)
            }
        }
    }
    VisorCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(
                Modifier.weight(1f).clip(com.horizon.maxhelmet.ui.theme.VisorShapes.control).clickable(enabled = !state.busy) { controller.chooseMusic() }
                    .padding(vertical = VisorSpace.x1)
            ) {
                Text(state.title, color = c.text, style = VisorType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
                    maxLines = if (compact) 2 else 1, overflow = TextOverflow.Ellipsis)
                Text(if (state.busy) "正在准备…" else state.source, color = c.textSecondary, style = VisorType.caption)
            }
            IconButton(onClick = { actionError = null; controller.stopPlayback(dismiss = true) }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Default.Close, if (state.source == "QQ音乐") "关闭音乐面板" else "停止并关闭音乐", tint = c.textSecondary)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) { controls() }
        if (state.source == "QQ音乐") {
            Text("先在 QQ 音乐播放歌曲，再授权 $assistantName 控制其媒体会话。系统权限名为通知使用权；$assistantName 不读取或保存通知内容。关闭面板不会停止 QQ 音乐。",
                color = c.textSecondary, style = VisorType.caption)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
                VisorButton("打开 QQ 音乐", controller::openQQMusic, Modifier.weight(1f))
                VisorButton("授权控制", controller::authorizeQQMusic, Modifier.weight(1f))
            }
            VisorButton("改用本机音乐", controller::chooseLocalMusic, enabled = !state.busy, style = VisorButtonStyle.GHOST)
        } else {
            VisorButton("改用 QQ 音乐", controller::chooseQQMusic, enabled = !state.busy, style = VisorButtonStyle.GHOST)
        }
        state.message?.let { Text(it, color = c.textSecondary, style = VisorType.caption) }
        actionError?.let { Text(it, color = c.danger, style = VisorType.caption) }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.accent, trackColor = c.surface3)
    }
}
