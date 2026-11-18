package io.github.henrycooper86.max.ui

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
import io.github.henrycooper86.max.music.MusicController
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorType
import kotlinx.coroutines.launch

@Composable
fun MusicPlaybackCard(controller: MusicController, compact: Boolean = false, assistantName: String = AssistantBranding.name) {
    val c = Visor.colors
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var actionError by remember { mutableStateOf<String?>(null) }
    if (!state.visible) return
    val controls: @Composable RowScope.() -> Unit = {
        listOf(Triple("previous", tr(Str.PREVIOUS), Icons.Default.SkipPrevious),
            Triple(if (state.playing) "pause" else "play", if (state.playing) tr(Str.PAUSE) else tr(Str.PLAY), if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow),
            Triple("next", tr(Str.NEXT), Icons.Default.SkipNext)).forEach { (action, label, icon) ->
            val primary = action == "play" || action == "pause"
            IconButton(enabled = !state.busy || action == "pause", onClick = {
                actionError = null
                scope.launch {
                    val result = controller.execute(action)
                    actionError = when {
                        result.status == "ok" || result.reason == "action.cancelled" -> null
                        result.reason == "music.queueEnd" -> tr(Str.QUEUE_END)
                        state.source == "QQ音乐" -> null // QQ adapter provides actionable setup/response messages.
                        else -> tr(Str.PLAY_FAIL, "name" to assistantName)
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
                Modifier.weight(1f).clip(io.github.henrycooper86.max.ui.theme.VisorShapes.control).clickable(enabled = !state.busy) { controller.chooseMusic() }
                    .padding(vertical = VisorSpace.x1)
            ) {
                Text(musicLabel(state.title), color = c.text, style = VisorType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
                    maxLines = if (compact) 2 else 1, overflow = TextOverflow.Ellipsis)
                Text(if (state.busy) tr(Str.PREPARING) else musicLabel(state.source), color = c.textSecondary, style = VisorType.caption)
            }
            IconButton(onClick = { actionError = null; controller.stopPlayback(dismiss = true) }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Default.Close, if (state.source == "QQ音乐") tr(Str.CLOSE_MUSIC_PANEL) else tr(Str.STOP_CLOSE_MUSIC), tint = c.textSecondary)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) { controls() }
        if (state.source == "QQ音乐") {
            Text(tr(Str.QQ_HELP, "name" to assistantName, "name" to assistantName),
                color = c.textSecondary, style = VisorType.caption)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
                VisorButton(tr(Str.OPEN_QQ), controller::openQQMusic, Modifier.weight(1f))
                VisorButton(tr(Str.GRANT_CONTROL), controller::authorizeQQMusic, Modifier.weight(1f))
            }
            VisorButton(tr(Str.USE_LOCAL_MUSIC), controller::chooseLocalMusic, enabled = !state.busy, style = VisorButtonStyle.GHOST)
        } else {
            VisorButton(tr(Str.USE_QQ_MUSIC), controller::chooseQQMusic, enabled = !state.busy, style = VisorButtonStyle.GHOST)
        }
        state.message?.let { Text(it, color = c.textSecondary, style = VisorType.caption) }
        actionError?.let { Text(it, color = c.danger, style = VisorType.caption) }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.accent, trackColor = c.surface3)
    }
}
