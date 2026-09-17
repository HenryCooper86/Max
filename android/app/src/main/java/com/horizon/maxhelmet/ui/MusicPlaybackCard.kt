package com.horizon.maxhelmet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.music.MusicController
import kotlinx.coroutines.launch

@Composable
fun MusicPlaybackCard(controller: MusicController, compact: Boolean = false) {
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var actionError by remember { mutableStateOf<String?>(null) }
    if (!state.visible) return
    val controls: @Composable RowScope.() -> Unit = {
        listOf(Triple("previous", "上一首", Icons.Default.SkipPrevious),
            Triple(if (state.playing) "pause" else "play", if (state.playing) "暂停" else "播放", if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow),
            Triple("next", "下一首", Icons.Default.SkipNext)).forEach { (action, label, icon) ->
            IconButton(enabled = !state.busy || action == "pause", onClick = {
                actionError = null
                scope.launch {
                    val result = controller.execute(action)
                    actionError = when {
                        result.status == "ok" || result.reason == "action.cancelled" -> null
                        result.reason == "music.queueEnd" -> "已到播放队列末尾，请选择多首歌曲。"
                        state.source == "QQ音乐" -> null // QQ adapter provides actionable setup/response messages.
                        else -> "暂时无法播放，请在 Max 中重新选择音乐。"
                    }
                }
            }, modifier = Modifier.size(48.dp)) { Icon(icon, label) }
        }
    }
    HudCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { controller.chooseMusic() }, enabled = !state.busy, modifier = Modifier.weight(1f)) {
                Column(Modifier.fillMaxWidth()) {
                    Text(state.title, style = MaterialTheme.typography.titleSmall, maxLines = if (compact) 2 else 1, overflow = TextOverflow.Ellipsis)
                    Text(if (state.busy) "正在准备…" else state.source, style = MaterialTheme.typography.bodySmall)
                }
            }
            IconButton(onClick = { actionError = null; controller.stopPlayback(dismiss = true) }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Default.Close, if (state.source == "QQ音乐") "关闭音乐面板" else "停止并关闭音乐")
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { controls() }
        if (state.source == "QQ音乐") {
            Text("先在 QQ 音乐播放歌曲，再授权 Max 控制其媒体会话。系统权限名为通知使用权；Max 不读取或保存通知内容。关闭面板不会停止 QQ 音乐。", style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                TextButton(onClick = controller::openQQMusic) { Text("打开 QQ 音乐") }
                TextButton(onClick = controller::authorizeQQMusic) { Text("授权控制") }
            }
            TextButton(onClick = controller::chooseLocalMusic, enabled = !state.busy) { Text("改用本机音乐") }
        } else {
            TextButton(onClick = controller::chooseQQMusic, enabled = !state.busy) { Text("改用 QQ 音乐") }
        }
        state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        actionError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}
