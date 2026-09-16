package com.horizon.maxhelmet.ui

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.music.MusicController
import kotlinx.coroutines.launch

@Composable
fun MusicPlaybackCard(controller: MusicController) {
    val state by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var showAccess by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { uri -> runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        controller.select(uris)
    }
    if (!state.visible) return
    HudCard {
        Text(state.title, style = MaterialTheme.typography.titleMedium)
        Text(listOf(state.artist, state.source).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
        state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        actionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(Triple("previous", "上一首", Icons.Default.SkipPrevious),
                Triple(if (state.playing) "pause" else "play", if (state.playing) "暂停" else "播放", if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow),
                Triple("next", "下一首", Icons.Default.SkipNext)).forEach { (action, label, icon) ->
                IconButton(enabled = !state.busy, onClick = {
                    scope.launch {
                        val result = controller.execute(action)
                        actionError = if (result.status == "ok") null else when (result.reason) {
                            "music.queueEnd" -> "已到播放队列末尾"
                            "music.controlUnavailable" -> "音乐应用没有完成操作，请检查播放队列。"
                            else -> "暂时无法控制播放，请选择音乐或检查播放应用。"
                        }
                    }
                }, modifier = Modifier.size(48.dp)) { Icon(icon, label) }
            }
            TextButton(onClick = { picker.launch(arrayOf("audio/*")) }, enabled = !state.busy) { Text("选择音乐") }
        }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        TextButton(onClick = {
            if (state.remoteAccess) controller.useExternalPlayer() else showAccess = true
        }) { Text("控制音乐应用") }
    }
    if (showAccess) AlertDialog(
        onDismissRequest = { showAccess = false }, title = { Text("连接音乐应用") },
        text = { Text("Android 需要通知访问权限才能读取音乐应用的播放状态和控制播放。Max 不读取或保存通知内容。也可以不授权，直接选择本机音乐。授权后，先在音乐应用中建立播放队列，再返回 Max。") },
        confirmButton = { TextButton(onClick = {
            showAccess = false
            runCatching { context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        }) { Text("前往授权") } },
        dismissButton = { TextButton(onClick = { showAccess = false }) { Text("暂不授权") } }
    )
}
