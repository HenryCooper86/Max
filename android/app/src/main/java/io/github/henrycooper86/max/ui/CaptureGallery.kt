package io.github.henrycooper86.max.ui

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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorShapes
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorType
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.henrycooper86.max.capture.Capture
import io.github.henrycooper86.max.capture.CaptureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun CaptureGallery(store: CaptureStore, assistantName: String = AssistantBranding.name, onDismiss: () -> Unit) {
    val c = Visor.colors
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
        io.github.henrycooper86.max.ui.theme.DialogSystemBars()
        Surface(Modifier.fillMaxSize(), color = c.bg) {
            Column(Modifier.fillMaxSize().padding(safeInsets).padding(VisorSpace.x4), verticalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(tr(Str.GALLERY_TITLE, "name" to assistantName), color = c.text, style = VisorType.headline)
                    VisorButton(if (selected != null) tr(Str.BACK) else tr(Str.CLOSE), { if (selected != null) selected = null else onDismiss() }, style = VisorButtonStyle.GHOST)
                }
                message?.let { Text(it, color = c.textSecondary, style = VisorType.bodySmall) }
                val item = selected
                if (item == null) {
                    if (captures.isEmpty()) Text(tr(Str.GALLERY_EMPTY, "name" to assistantName), color = c.textSecondary, style = VisorType.body)
                    LazyVerticalGrid(columns = GridCells.Adaptive(140.dp), modifier = Modifier.weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3), verticalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                        items(captures, key = { it.id }) { capture ->
                            Column(Modifier.clickable { selected = capture }, verticalArrangement = Arrangement.spacedBy(VisorSpace.x1)) {
                                CaptureThumbnail(capture, Modifier.fillMaxWidth().height(130.dp).clip(VisorShapes.card))
                                Row(horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
                                    Text(if (capture.video) tr(Str.VIDEO) else tr(Str.PHOTO), color = c.text, style = VisorType.caption)
                                    if (capture.exported) Text(tr(Str.EXPORTED), color = c.textTertiary, style = VisorType.caption)
                                }
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
                    } else CaptureThumbnail(item, Modifier.fillMaxWidth().weight(1f).clip(VisorShapes.card))
                    Row(horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                        VisorButton(if (Build.VERSION.SDK_INT >= 29) tr(Str.EXPORT_TO_GALLERY) else tr(Str.SAVE_OR_SHARE), style = VisorButtonStyle.PRIMARY, enabled = !exporting, onClick = {
                            if (Build.VERSION.SDK_INT >= 29) scope.launch {
                                exporting = true
                                message = if (runCatching { store.export(item) }.getOrDefault(false)) tr(Str.EXPORT_OK) else tr(Str.EXPORT_FAIL)
                                exporting = false
                            } else {
                                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", item.file)
                                runCatching { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND)
                                    .setType(if (item.video) "video/mp4" else "image/jpeg").putExtra(Intent.EXTRA_STREAM, uri)
                                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), tr(Str.SAVE_OR_SHARE))) }
                            }
                        })
                        VisorButton(tr(Str.DELETE), { deleting = item }, style = VisorButtonStyle.DANGER, enabled = !exporting)
                    }
                }
            }
        }
    }
    deleting?.let { item -> VisorAlertDialog(onDismissRequest = { deleting = null },
        title = tr(Str.DELETE_TITLE), text = { DialogText(tr(Str.DELETE_BODY, "name" to assistantName)) },
        confirmButton = { VisorButton(tr(Str.DELETE), {
            if (store.delete(item)) selected = null else message = tr(Str.DELETE_FAIL)
            deleting = null
        }, style = VisorButtonStyle.DANGER) }, dismissButton = { VisorButton(tr(Str.CANCEL), { deleting = null }, style = VisorButtonStyle.GHOST) }) }
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
    bitmap?.let { Image(it.asImageBitmap(), if (capture.video) tr(Str.VIDEO_PREVIEW) else tr(Str.PHOTO), modifier) }
        ?: Box(modifier.background(Visor.colors.surface2), contentAlignment = Alignment.Center) {
            Text(tr(Str.PREVIEW_LOADING), color = Visor.colors.textTertiary, style = VisorType.caption)
        }
}
