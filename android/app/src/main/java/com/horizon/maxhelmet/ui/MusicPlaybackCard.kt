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
                    Text(if (state.busy) "正在准备…" else "选择音乐", style = MaterialTheme.typography.bodySmall)
                }
            }
            IconButton(onClick = { actionError = null; controller.stopPlayback(dismiss = true) }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Default.Close, "停止并关闭音乐")
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { controls() }
        state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        actionError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}
