package com.horizon.maxhelmet.ui

import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.capture.Capture
import com.horizon.maxhelmet.capture.CaptureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun CaptureGallery(store: CaptureStore, onDismiss: () -> Unit) {
    val captures by store.captures.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<Capture?>(null) }
    var deleting by remember { mutableStateOf<Capture?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var exporting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // Read the activity's insets before entering the dialog's separate window.
    val safeInsets = WindowInsets.safeDrawing.asPaddingValues()
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(safeInsets).padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Max 相册", style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { if (selected != null) selected = null else onDismiss() }) { Text(if (selected != null) "返回" else "关闭") }
                }
                message?.let { Text(it) }
                val item = selected
                if (item == null) {
                    if (captures.isEmpty()) Text("还没有拍摄内容。对 Max 说“拍照”或“开始录像”。")
                    LazyVerticalGrid(columns = GridCells.Adaptive(140.dp), modifier = Modifier.weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(captures, key = { it.id }) { capture ->
                            Column(Modifier.clickable { selected = capture }) {
                                CaptureThumbnail(capture, Modifier.fillMaxWidth().height(130.dp))
                                Text(if (capture.video) "录像" else "照片")
                                if (capture.exported) Text("已导出", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                } else {
                    if (item.video) {
                        var view by remember(item.id) { mutableStateOf<VideoView?>(null) }
                        AndroidView(factory = {
                            VideoView(it).apply {
                                setAudioFocusRequest(AudioManager.AUDIOFOCUS_NONE)
                                setVideoURI(Uri.fromFile(item.file))
                                setMediaController(MediaController(it).also { controls -> controls.setAnchorView(this) })
                                setOnPreparedListener { media -> media.setVolume(0f, 0f); seekTo(1) }
                                view = this
                            }
                        }, modifier = Modifier.fillMaxWidth().weight(1f))
                        DisposableEffect(item.id) { onDispose { view?.stopPlayback() } }
                    } else CaptureThumbnail(item, Modifier.fillMaxWidth().weight(1f))
                    Row {
                        TextButton(enabled = !exporting, onClick = {
                            if (Build.VERSION.SDK_INT >= 29) scope.launch {
                                exporting = true
                                message = if (runCatching { store.export(item) }.getOrDefault(false)) "已导出到系统相册" else "导出失败，请重试"
                                exporting = false
                            } else {
                                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", item.file)
                                runCatching { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND)
                                    .setType(if (item.video) "video/mp4" else "image/jpeg").putExtra(Intent.EXTRA_STREAM, uri)
                                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "保存或分享")) }
                            }
                        }) { Text(if (Build.VERSION.SDK_INT >= 29) "导出到相册" else "保存或分享") }
                        TextButton(enabled = !exporting, onClick = { deleting = item }) { Text("删除") }
                    }
                }
            }
        }
    }
    deleting?.let { item -> AlertDialog(onDismissRequest = { deleting = null },
        title = { Text("删除拍摄内容？") }, text = { Text("将删除 Max 中的原文件，已导出到系统相册的副本会保留。") },
        confirmButton = { TextButton(onClick = {
            if (store.delete(item)) selected = null else message = "删除失败，请重试"
            deleting = null
        }) { Text("删除") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }) }
}

@Composable
private fun CaptureThumbnail(capture: Capture, modifier: Modifier) {
    val bitmap by produceState<Bitmap?>(null, capture.id) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                if (!capture.video) CaptureStore.photoThumbnail(capture.file)
                else CaptureStore.withVideoReader { reader ->
                    reader.setDataSource(capture.file.absolutePath)
                    CaptureStore.videoThumbnail(reader)
                }
            }.getOrNull()
        }
    }
    bitmap?.let { Image(it.asImageBitmap(), if (capture.video) "录像预览" else "照片", modifier) }
        ?: Box(modifier) { Text("预览加载中") }
}
