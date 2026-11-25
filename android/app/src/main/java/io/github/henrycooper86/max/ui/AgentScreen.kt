package io.github.henrycooper86.max.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.Headset
import androidx.compose.material.icons.filled.Image
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLocale
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import io.github.henrycooper86.max.agent.ImageRefusal
import io.github.henrycooper86.max.agent.imageInputReady
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import kotlinx.coroutines.delay
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.henrycooper86.max.agent.AgentEvent
import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.agent.ConnectionState
import io.github.henrycooper86.max.agent.HazardLevel
import io.github.henrycooper86.max.agent.Speaker
import io.github.henrycooper86.max.agent.TURN_FLAG_REASONS
import io.github.henrycooper86.max.agent.TranscriptItem
import io.github.henrycooper86.max.agent.TurnState
import io.github.henrycooper86.max.agent.MAX_TEXT_INPUT_CHARS
import io.github.henrycooper86.max.agent.TypedInputMode
import io.github.henrycooper86.max.agent.toolStatusText
import io.github.henrycooper86.max.agent.typedInputMode
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.IconButton
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.text.input.ImeAction
import io.github.henrycooper86.max.navigation.NavGuidanceState
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorColors
import io.github.henrycooper86.max.ui.theme.VisorShapes
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorTheme
import io.github.henrycooper86.max.ui.theme.VisorType
import java.text.SimpleDateFormat
import java.util.Date

private fun turnCaption(turn: TurnState, name: String): String = when (turn) {
    TurnState.IDLE -> tr(Str.TURN_IDLE)
    TurnState.LISTENING -> tr(Str.TURN_LISTENING)
    TurnState.HEARING -> tr(Str.TURN_HEARING)
    TurnState.THINKING -> tr(Str.TURN_THINKING, "name" to name)
    TurnState.SPEAKING -> tr(Str.TURN_SPEAKING, "name" to name)
}

/** Caption prefixes for a non-normal fused hazard. */
private fun hazardCaption(level: HazardLevel): String? = when (level) {
    HazardLevel.CAUTION -> tr(Str.HAZARD_CAUTION)
    HazardLevel.CRITICAL -> tr(Str.HAZARD_CRITICAL)
    else -> null
}

internal fun hazardColor(c: VisorColors, hazard: HazardLevel): Color = when (hazard) {
    HazardLevel.NORMAL -> c.ok
    HazardLevel.CAUTION -> c.warn
    HazardLevel.CRITICAL -> c.danger
}

@Composable
internal fun hazardColor(hazard: HazardLevel): Color = hazardColor(Visor.colors, hazard)

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.OFFLINE -> tr(Str.CONN_OFFLINE)
    ConnectionState.CONNECTING -> tr(Str.CONN_CONNECTING)
    ConnectionState.RELAY -> tr(Str.CONN_RELAY)
    ConnectionState.PROVIDER -> tr(Str.CONN_PROVIDER)
    ConnectionState.READY -> tr(Str.CONN_READY)
    ConnectionState.DEGRADED -> tr(Str.CONN_DEGRADED)
}

/**
 * Starting hands-free passes through "offline" for a few frames before the
 * socket begins connecting. Shown as-is that is a red flash on every start, so
 * an offline reading is presented as "connecting" until it has lasted.
 */
@Composable
private fun settledState(state: AgentSession.State): AgentSession.State {
    val offline = state.handsFree && state.connection == ConnectionState.OFFLINE
    var lasted by remember { mutableStateOf(false) }
    LaunchedEffect(offline) {
        lasted = false
        if (offline) {
            delay(450)
            lasted = true
        }
    }
    return if (offline && !lasted) state.copy(connection = ConnectionState.CONNECTING, statusText = "") else state
}

/** The single caption under the visor. */
internal fun orbCaption(state: AgentSession.State, assistantName: String = DEFAULT_ASSISTANT_NAME): String {
    if (!state.handsFree) return tr(Str.TAP_VISOR)
    val caption = if (state.voiceCaptureDown) {
        tr(Str.VOICE_DOWN)
    } else if (state.audioPaused) {
        tr(Str.AUDIO_PAUSED)
    } else if (state.micMuted) {
        tr(Str.MIC_MUTED)
    } else {
        when (state.connection) {
            ConnectionState.READY -> turnCaption(state.turnState, assistantName)
            else -> connectionLabel(state.connection)
        }
    }
    // A non-normal fused hazard leads the caption.
    val presentedHazard = if (isHazardPresentationActive(state)) state.fusedHazard else HazardLevel.NORMAL
    val hazardPrefix = hazardCaption(presentedHazard)
    return if (hazardPrefix != null) "$hazardPrefix · $caption" else caption
}

/**
 * Why the last hands-free session ended. Shown instead of how to start one while hands-free
 * is off and the session ended in an error; the next start resets both fields.
 */
internal fun endedSessionNotice(state: AgentSession.State): String? =
    if (!state.handsFree && state.connection == ConnectionState.DEGRADED) relocalize(state.statusText) else null

/**
 * Voice-mode main screen: wordmark and connection state on top, the Visor hero,
 * greeting/hint, the mic dock and (optionally) the transcript. All rider and test
 * settings live in the settings sheet. The safety-critical hazard banner stays
 * pinned above the visor.
 */
@Composable
fun AgentScreen(
    viewModel: MainViewModel,
    onToggleHandsFree: () -> Unit,
    onExportTranscript: () -> Unit
) {
    val appearance = remember(
        viewModel.relayTemplate, viewModel.wearerTemplate, viewModel.templateSwitching,
        viewModel.themeOverrides, viewModel.accentHex
    ) { viewModel.appearance }
    VisorTheme(template = appearance.template) {
        AgentScreenContent(viewModel, onToggleHandsFree, onExportTranscript)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentScreenContent(
    viewModel: MainViewModel,
    onToggleHandsFree: () -> Unit,
    onExportTranscript: () -> Unit
) {
    val c = Visor.colors
    val liveState by viewModel.sessionState.collectAsStateWithLifecycle()
    val state = settledState(liveState)

    // The relay requires a login (HTTP 401): open the settings sheet on the
    // 账号 section so the rider can sign in right where the fix is.
    LaunchedEffect(state.authRequired) {
        // Handles the stale-identity case too: a 401 while "logged in" means
        // the stored session died server-side; the view model drops it so
        // the login form (not the identity row) is what opens. The flag is
        // consumed there, so rotation/recomposition can't re-open the sheet.
        if (state.authRequired) {
            viewModel.handleAuthRequired()
        }
    }
    // Opening settings refreshes /health so the backend list is current.
    LaunchedEffect(viewModel.showPreferences) { if (viewModel.showPreferences) viewModel.refreshHealth() }

    Box(
        modifier = Modifier.fillMaxSize().background(c.bg).mascotFollowsTouches(),
        contentAlignment = Alignment.TopCenter
    ) {
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = VisorSpace.x4, vertical = VisorSpace.x3)) {
            val landscape = maxWidth > maxHeight
            val musicState by viewModel.music.state.collectAsStateWithLifecycle()
            val recording by viewModel.camera.isRecording.collectAsStateWithLifecycle()
            val galleryRequest by viewModel.deviceActions.galleryRequest.collectAsStateWithLifecycle()
            LaunchedEffect(galleryRequest) { if (galleryRequest > 0) viewModel.showGallery = true }
            val videoPreview by viewModel.videoPreview.collectAsStateWithLifecycle()
            val videoNote by viewModel.videoNote.collectAsStateWithLifecycle()
            val name = viewModel.assistantName
            val alerts: @Composable () -> Unit = {
                state.hazardAlert?.let { HazardBanner(it) }
                if (isNavPresentationActive(state)) state.navGuidance?.let {
                    GuidanceCard(it, viewModel::confirmNavigation, viewModel.music, viewModel.hudCast, mapPaused = state.extrasShed)
                }
                if (recording) RecordingNotice()
            }
            val utilities: @Composable () -> Unit = {
                MusicPlaybackCard(viewModel.music, assistantName = name)
                if (viewModel.showCaptions) CaptionsOverlay(
                    items = state.transcript, assistantName = name,
                    canFlag = state::canFlagTurn, onFlag = viewModel::flagTurn,
                    typedInput = typedInputMode(state), onSend = viewModel::sendText,
                    pictures = imageInputReady(state), onPicture = viewModel::sendPicture,
                    video = if (state.capabilities.videoInput) VideoControls(
                        active = state.videoActive,
                        canStart = state.connection == ConnectionState.READY,
                        front = viewModel.videoFront,
                        preview = videoPreview,
                        note = videoNote,
                        onStart = viewModel::startVideo,
                        onDenied = viewModel::videoPermissionDenied,
                        onStop = viewModel::stopVideo,
                        onSwitch = viewModel::switchVideoCamera
                    ) else null
                )
            }
            val visor: @Composable (Dp) -> Unit = { width ->
                Box(contentAlignment = Alignment.Center) {
                    VisorView(
                        mode = visorMode(state),
                        tint = visorTint(state),
                        level = state.voiceLevel,
                        handsFree = state.handsFree,
                        dimmed = state.micMuted,
                        onTap = onToggleHandsFree,
                        width = width,
                        style = viewModel.voiceStyle
                    )
                    val (birdWidth, birdOffset) = mascotPlacement(width)
                    Mascot(
                        mood = mascotMood(state),
                        width = birdWidth,
                        modifier = Modifier.offset(birdOffset.x, birdOffset.y),
                        tiltEnabled = !landscape
                    )
                }
            }
            val availableHeight = maxHeight
            val availableWidth = maxWidth
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                TopBar(state, name, viewModel)
                if (landscape) {
                    Row(Modifier.weight(1f).padding(top = VisorSpace.x2), horizontalArrangement = Arrangement.spacedBy(VisorSpace.x4)) {
                        Column(
                            Modifier.weight(0.46f).fillMaxHeight().verticalScroll(rememberScrollState()),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(VisorSpace.x3, Alignment.CenterVertically)
                        ) {
                            visor(minOf(availableWidth * 0.44f, (availableHeight - 190.dp) / 0.6f).coerceIn(150.dp, 360.dp))
                            SessionReadout(state, name, viewModel.wakePhrase)
                            UtilityPills(state, viewModel)
                        }
                        Column(
                            Modifier.weight(0.54f).fillMaxHeight().verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(VisorSpace.x3)
                        ) {
                            alerts(); utilities()
                        }
                    }
                } else {
                    // Visor first, directly under the top bar; everything else follows it.
                    Column(
                        Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = VisorSpace.x4),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(VisorSpace.x4, Alignment.Top)
                    ) {
                        // The visor, readout and pills never move. Alerts arrive below
                        // them: a hazard already recolours the visor and leads the
                        // headline, so the banner adds detail without shifting the
                        // control the wearer is about to tap.
                        visor(availableWidth.coerceAtMost(420.dp))
                        SessionReadout(state, name, viewModel.wakePhrase)
                        UtilityPills(state, viewModel)
                        alerts()
                        utilities()
                    }
                }
            }
        }
    }

    if (viewModel.showGallery) CaptureGallery(viewModel.captures, assistantName = viewModel.assistantName) { viewModel.showGallery = false }

    if (viewModel.showPreferences) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.showPreferences = false },
            containerColor = c.bg,
            scrimColor = c.scrim,
            shape = VisorShapes.sheet,
            dragHandle = {
                Box(
                    Modifier.padding(vertical = VisorSpace.x3).size(width = 36.dp, height = 4.dp)
                        .clip(VisorShapes.pill).background(c.lineStrong)
                )
            }
        ) {
            SheetContent(tr(Str.SETTINGS)) { SettingsPanel(state, viewModel, onExportTranscript) }
        }
    }
    CrashOverlay(viewModel)
}

// ---- top bar: wordmark + connection state ---------------------------------------------

@Composable
private fun connectionTone(state: AgentSession.State): Color {
    val c = Visor.colors
    return when {
        !state.handsFree -> c.textTertiary
        state.connection == ConnectionState.READY || state.connection == ConnectionState.RELAY -> c.ok
        state.connection == ConnectionState.CONNECTING || state.connection == ConnectionState.PROVIDER -> c.warn
        else -> c.danger
    }
}

@Composable
private fun TopBar(state: AgentSession.State, name: String, viewModel: MainViewModel) {
    val c = Visor.colors
    val tone = connectionTone(state)
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        DeviceLogo(viewModel.deviceProfile, viewModel.deviceKind, viewModel.logoBitmap, size = 28.dp)
        Spacer(Modifier.width(VisorSpace.x2))
        // The name takes the remaining width, which pins the connection state to
        // the trailing edge. (A second weighted spacer split the space in two and
        // left the state floating mid-bar.)
        Text(
            name, color = c.text, style = VisorType.title, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
            if (state.bluetoothRouted) {
                Icon(Icons.Filled.Headset, contentDescription = tr(Str.BLUETOOTH_AUDIO), tint = c.textSecondary, modifier = Modifier.size(16.dp))
            }
            Box(Modifier.size(8.dp).clip(CircleShape).background(tone))
            Text(
                text = if (state.handsFree) connectionLabel(state.connection) else tr(Str.NOT_CONNECTED),
                color = c.textSecondary,
                style = VisorType.caption,
                maxLines = 1
            )
        }
    }
}

// ---- greeting / hint -------------------------------------------------------------------

@Composable
private fun SessionReadout(state: AgentSession.State, name: String, wakePhrase: String?) {
    val c = Visor.colors
    // Idle: greet, then why the last session ended if it failed, else how to start.
    // Live: the turn state, then relay detail.
    val idle = !state.handsFree
    val headline = if (idle) tr(Str.GREETING, "name" to name) else orbCaption(state, name)
    val hint = when {
        idle -> endedSessionNotice(state) ?: when {
            wakePhrase.isNullOrBlank() -> orbCaption(state, name)
            else -> tr(Str.HINT_WAKE, "caption" to orbCaption(state, name), "wake" to wakePhrase)
        }
        // A running tool says what the wait is for, ahead of the relay's own detail.
        state.toolStatus != null -> toolStatusText(state.toolStatus)
        // While a turn is in flight the relay's detail only rewords the headline
        // ("Max 思考中…" / "Max 正在思考"); it adds something only while waiting.
        state.connection == ConnectionState.READY &&
            state.turnState != TurnState.IDLE && state.turnState != TurnState.LISTENING -> ""
        else -> relocalize(state.statusText)
    }.takeIf { it != headline }.orEmpty()
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VisorSpace.x1)) {
        FitLine(headline, c.text, VisorType.headline)
        // Always one line tall, so the pills below hold their position as the hint comes and goes.
        FitLine(hint, c.textSecondary, VisorType.body, minLines = 1)
    }
}

/** One line of text that shrinks (down to 60%) rather than truncating, so longer English wording keeps the one-line readout. */
@Composable
private fun FitLine(text: String, color: Color, style: androidx.compose.ui.text.TextStyle, minLines: Int = 1) {
    var scale by remember(text, style.fontSize) { mutableStateOf(1f) }
    Text(
        text, color = color,
        style = style.copy(fontSize = style.fontSize * scale, lineHeight = style.lineHeight),
        textAlign = TextAlign.Center, minLines = minLines, maxLines = 1,
        overflow = if (scale <= 0.6f) TextOverflow.Ellipsis else TextOverflow.Clip,
        onTextLayout = { if (it.hasVisualOverflow && scale > 0.6f) scale = (scale - 0.06f).coerceAtLeast(0.6f) }
    )
}

/** The utility row under the readout: capsule pills, the same set and order as
 *  iOS (字幕 · 静音 while live · 相册 · 设置). The music player opens from Settings. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UtilityPills(state: AgentSession.State, viewModel: MainViewModel) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(VisorSpace.x1)
    ) {
        UtilityPill(Icons.Filled.ClosedCaption, tr(Str.PILL_CAPTIONS), on = viewModel.showCaptions, onClick = viewModel::toggleCaptions)
        if (state.handsFree) {
            UtilityPill(
                if (state.micMuted) Icons.Filled.MicOff else Icons.Filled.Mic,
                if (state.micMuted) tr(Str.PILL_UNMUTE) else tr(Str.PILL_MUTE),
                on = state.micMuted, onColor = Visor.colors.warn, onClick = viewModel::toggleMute
            )
        }
        UtilityPill(Icons.Filled.PhotoLibrary, tr(Str.PILL_GALLERY), on = false, onClick = { viewModel.showGallery = true })
        UtilityPill(Icons.Filled.Settings, tr(Str.SETTINGS), on = false, onClick = { viewModel.showPreferences = true })
    }
}

@Composable
private fun UtilityPill(
    icon: ImageVector,
    label: String,
    on: Boolean,
    onClick: () -> Unit,
    onColor: Color = Visor.colors.accent
) {
    val c = Visor.colors
    val tint = if (on) onColor else c.textSecondary
    // A 48dp touch target around a 36dp capsule.
    Box(
        Modifier
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Row(
            Modifier
                .heightIn(min = 36.dp)
                .background(if (on) c.soft(onColor) else c.surface2, CircleShape)
                .border(Visor.metrics.lineWidth, if (on) onColor.copy(alpha = 0.4f) else c.line, CircleShape)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp)
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
            Text(label, color = tint, style = VisorType.bodySmall, maxLines = 1)
        }
    }
}

// ---- recording notice -------------------------------------------------------------------

@Composable
private fun RecordingNotice() {
    val c = Visor.colors
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(c.danger))
        Text(tr(Str.RECORDING_NOTICE), color = c.textSecondary, style = VisorType.bodySmall)
    }
}

// ---- optional transcript ---------------------------------------------------------------

@Composable
private fun CaptionsOverlay(
    items: List<TranscriptItem>,
    assistantName: String,
    canFlag: (TranscriptItem) -> Boolean = { false },
    onFlag: (TranscriptItem, String) -> Unit = { _, _ -> },
    typedInput: TypedInputMode = TypedInputMode.HIDDEN,
    onSend: (String) -> Boolean = { false },
    pictures: Boolean = false,
    onPicture: (Uri, String, (ImageRefusal?) -> Unit) -> Unit = { _, _, _ -> },
    video: VideoControls? = null
) {
    val c = Visor.colors
    val listState = rememberLazyListState()
    val locale = LocalLocale.current.platformLocale
    val timeFormat = remember(locale) { SimpleDateFormat("HH:mm", locale) }

    LaunchedEffect(items.size, items.lastOrNull()?.text) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.lastIndex)
    }

    VisorCard {
        if (items.isEmpty()) {
            Text(
                text = tr(Str.CAPTIONS_EMPTY),
                color = c.textTertiary,
                style = VisorType.bodySmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = VisorSpace.x4)
            )
        } else {
            LazyColumn(
                state = listState,
                verticalArrangement = Arrangement.spacedBy(VisorSpace.x3),
                modifier = Modifier.fillMaxWidth().height(220.dp)
            ) {
                items(items, key = { it.id }) { item ->
                    ChatBubble(
                        item = item,
                        assistantName = assistantName,
                        time = timeFormat.format(Date(item.at)),
                        flaggable = canFlag(item),
                        onFlag = { reason -> onFlag(item, reason) }
                    )
                }
            }
        }
        if (typedInput != TypedInputMode.HIDDEN) TypedTurnField(typedInput, onSend, pictures, onPicture, video)
    }
}

/** The camera controls for a session that takes live video; null when it does not. */
private class VideoControls(
    val active: Boolean,
    val canStart: Boolean,
    val front: Boolean,
    val preview: Bitmap?,
    val note: Str?,
    val onStart: () -> Unit,
    val onDenied: () -> Unit,
    val onStop: () -> Unit,
    val onSwitch: () -> Unit
)

/** A typed turn for backends that accept text.input; disabled while the bike is moving. */
@Composable
private fun TypedTurnField(
    mode: TypedInputMode,
    onSend: (String) -> Boolean,
    pictures: Boolean,
    onPicture: (Uri, String, (ImageRefusal?) -> Unit) -> Unit,
    video: VideoControls?
) {
    val c = Visor.colors
    val context = LocalContext.current
    // The camera permission is asked when the video is first turned on; a refusal is a note, not an error.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) video?.onStart?.invoke() else video?.onDenied?.invoke()
    }
    var draft by rememberSaveable { mutableStateOf("") }
    val ready = mode == TypedInputMode.READY
    val send = { if (ready && draft.isNotBlank() && onSend(draft)) draft = "" }
    // What became of the last picture, said under the field until the next one. Not kept when the screen is
    // made again (a new language, a new font size): a picture on its way then could not take "Sending…" away.
    var pictureNote by remember { mutableStateOf<Str?>(null) }
    var sendingPicture by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            sendingPicture = true
            pictureNote = Str.PICTURE_SENDING
            // What is typed goes with the picture, as one turn. It leaves the field now, so that it cannot be
            // sent a second time, and comes back if the picture does not go.
            val words = draft
            draft = ""
            onPicture(uri, words) { refusal ->
                sendingPicture = false
                if (refusal != null && words.isNotBlank()) {
                    draft = (if (draft.isBlank()) words else "$words $draft").take(MAX_TEXT_INPUT_CHARS)
                }
                pictureNote = when (refusal) {
                    // With words the assistant answers at once: nothing more to say here.
                    null -> if (words.isBlank()) Str.PICTURE_SENT else null
                    ImageRefusal.NOT_READY -> Str.PICTURE_NOT_READY
                    ImageRefusal.TOO_FAST -> Str.PICTURE_TOO_FAST
                    ImageRefusal.TOO_MANY -> Str.PICTURE_TOO_MANY
                    ImageRefusal.TOO_LARGE -> Str.PICTURE_UNREADABLE
                }
            }
        }
    }
    Column(modifier = Modifier.fillMaxWidth()) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2),
        modifier = Modifier.fillMaxWidth().padding(top = VisorSpace.x3)
    ) {
        VisorTextField(
            value = draft,
            onValueChange = { draft = it.take(MAX_TEXT_INPUT_CHARS) },
            label = if (ready) tr(Str.TYPE_HINT) else tr(Str.TYPE_STOP_FIRST),
            enabled = ready,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            modifier = Modifier.weight(1f)
        )
        if (pictures) {
            IconButton(
                onClick = {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                enabled = ready && !sendingPicture
            ) {
                Icon(
                    Icons.Filled.Image,
                    contentDescription = tr(Str.PICTURE_SHOW),
                    tint = if (ready && !sendingPicture) c.textSecondary else c.textTertiary
                )
            }
        }
        if (video != null) {
            // Like the field and the picture button, it is not turned on while the bike moves; off always works.
            val usable = video.active || (video.canStart && ready)
            IconButton(
                onClick = {
                    when {
                        video.active -> video.onStop()
                        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED ->
                            video.onStart()
                        else -> cameraPermission.launch(Manifest.permission.CAMERA)
                    }
                },
                enabled = usable
            ) {
                Icon(
                    if (video.active) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                    contentDescription = tr(if (video.active) Str.VIDEO_STOP else Str.VIDEO_START),
                    tint = if (video.active) c.accent else if (usable) c.textSecondary else c.textTertiary
                )
            }
        }
        IconButton(onClick = send, enabled = ready && draft.isNotBlank()) {
            Icon(
                Icons.AutoMirrored.Filled.Send,
                contentDescription = tr(Str.TYPE_SEND),
                tint = if (ready && draft.isNotBlank()) c.accent else c.textTertiary
            )
        }
    }
    if (video != null) {
        if (video.active) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2),
                modifier = Modifier.padding(top = VisorSpace.x1).semantics { liveRegion = LiveRegionMode.Polite }
            ) {
                val preview = video.preview
                Box(
                    modifier = Modifier.size(width = 96.dp, height = 72.dp).clip(RoundedCornerShape(8.dp)).background(c.surface2),
                    contentAlignment = Alignment.Center
                ) {
                    if (preview != null) Image(
                        bitmap = preview.asImageBitmap(),
                        contentDescription = tr(Str.LIVE_VIDEO_SEEN),
                        contentScale = ContentScale.Crop,
                        // The front camera shows as a mirror does; what is sent is not turned.
                        modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = if (video.front) -1f else 1f }
                    )
                }
                IconButton(onClick = video.onSwitch) {
                    Icon(Icons.Filled.Cameraswitch, contentDescription = tr(Str.VIDEO_SWITCH), tint = c.textSecondary)
                }
                Text(tr(Str.VIDEO_ON), color = c.textSecondary, style = VisorType.caption, modifier = Modifier.weight(1f))
            }
        } else video.note?.let { note ->
            Text(
                tr(note),
                color = c.textSecondary,
                style = VisorType.caption,
                modifier = Modifier.padding(top = VisorSpace.x1).semantics { liveRegion = LiveRegionMode.Polite }
            )
        }
    }
    pictureNote?.let { note ->
        Text(
            tr(note),
            color = c.textSecondary,
            style = VisorType.caption,
            modifier = Modifier
                .padding(top = VisorSpace.x1)
                .semantics { liveRegion = LiveRegionMode.Polite }
        )
    }
    }
}

@Composable
private fun ChatBubble(
    item: TranscriptItem,
    assistantName: String,
    time: String,
    flaggable: Boolean = false,
    onFlag: (String) -> Unit = {}
) {
    val c = Visor.colors
    val isUser = item.speaker == Speaker.RIDER
    val speakerColor = if (isUser) c.user else c.textSecondary

    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.padding(start = if (isUser) 40.dp else 0.dp, end = if (isUser) 0.dp else 40.dp)
        ) {
            Box(
                modifier = Modifier
                    .clip(VisorShapes.card)
                    .background(if (isUser) c.userSoft else c.surface2)
                    .padding(horizontal = VisorSpace.x3, vertical = VisorSpace.x2)
            ) {
                Text(item.text, color = c.text, style = VisorType.body)
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2),
                modifier = Modifier.padding(top = VisorSpace.x1)
            ) {
                Text(
                    text = if (isUser) tr(Str.SPEAKER_YOU) else assistantName,
                    color = speakerColor,
                    style = VisorType.caption.copy(fontWeight = FontWeight.SemiBold)
                )
                Text(time, color = c.textTertiary, style = VisorType.monoCaption)
                if (!item.final) Text("…", color = c.textTertiary, style = VisorType.caption)
                if (item.feedback != null) {
                    Text("⚑ ${item.feedback}", color = c.danger, style = VisorType.caption.copy(fontWeight = FontWeight.SemiBold))
                } else if (flaggable) {
                    // One tap opens the preset reasons: no typing mid-ride.
                    var reasonsOpen by remember { mutableStateOf(false) }
                    Box {
                        Text(
                            text = tr(Str.FLAG_ISSUE),
                            color = c.danger,
                            style = VisorType.caption.copy(fontWeight = FontWeight.SemiBold),
                            modifier = Modifier
                                .minimumInteractiveComponentSize()
                                .clip(VisorShapes.pill)
                                .background(c.dangerSoft)
                                .clickable(role = Role.Button) { reasonsOpen = true }
                                .padding(horizontal = VisorSpace.x2, vertical = 2.dp)
                        )
                        DropdownMenu(
                            expanded = reasonsOpen,
                            onDismissRequest = { reasonsOpen = false },
                            containerColor = c.surface2
                        ) {
                            TURN_FLAG_REASONS.forEach { reason ->
                                DropdownMenuItem(
                                    text = { Text(flagReasonLabel(reason), color = c.text, style = VisorType.body) },
                                    onClick = {
                                        reasonsOpen = false
                                        onFlag(reason)
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---- hazard banner (safety-critical: kept on every screen) -----------------------------

@Composable
private fun HazardBanner(alert: AgentEvent.HazardAlert) {
    val c = Visor.colors
    val color = hazardColor(c, alert.severity)
    VisorCard(borderColor = color) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .clip(VisorShapes.control)
                    .background(c.soft(color))
                    .padding(horizontal = VisorSpace.x3, vertical = VisorSpace.x2)
            ) {
                Text(alert.directionLabel, color = color, style = VisorType.title.copy(fontWeight = FontWeight.Bold))
            }
            Spacer(Modifier.width(VisorSpace.x3))
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VisorSpace.x1 + 2.dp)) {
                    Icon(Icons.Filled.Warning, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
                    Text(alert.label, color = c.text, style = VisorType.body.copy(fontWeight = FontWeight.SemiBold))
                }
                Text("${alert.message} ${alert.advice}", color = c.textSecondary, style = VisorType.caption)
            }
            Spacer(Modifier.width(VisorSpace.x2))
            Text("${alert.ttcSeconds}s", color = color, style = VisorType.monoLarge)
        }
    }
}

// ---- navigation guidance card -----------------------------------------------------------

/**
 * The live turn-by-turn surface: destination first, the next maneuver
 * dominates, then distance-to-maneuver and the remaining trip below.
 * Gated by [isNavPresentationActive] at the call site; `guidance.arrived` is
 * never true here (arrival publishes `navGuidance = null` instead), so there
 * is no arrived branch to render.
 */
@Composable
private fun GuidanceCard(
    guidance: NavGuidanceState,
    onConfirm: (String, Boolean) -> Unit,
    music: io.github.henrycooper86.max.music.MusicController,
    hudCast: io.github.henrycooper86.max.navigation.HudCastClient,
    mapPaused: Boolean = false
) {
    val c = Visor.colors
    var showingDetails by remember { mutableStateOf(guidance.confirmationId == null) }
    var awaitingApproval by remember { mutableStateOf(guidance.confirmationId != null) }
    LaunchedEffect(guidance.confirmationId) {
        if (awaitingApproval && guidance.confirmationId == null) showingDetails = true
        awaitingApproval = guidance.confirmationId != null
        if (awaitingApproval) showingDetails = false
    }
    if (showingDetails) NavigationDetailsDialog(guidance, music, hudCast, mapPaused) { showingDetails = false }
    VisorCard(borderColor = if (guidance.offRoute) c.warn else null) {
        Row(verticalAlignment = Alignment.Top) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(VisorSpace.x1)) {
                Text(guidance.destinationName, color = c.textSecondary, style = VisorType.caption, maxLines = 1)
                Text(
                    text = if (guidance.confirmationId != null) tr(Str.CONFIRM_DEST) else guidance.displayInstruction ?: guidance.destinationName,
                    color = c.text,
                    style = VisorType.headline
                )
                Spacer(Modifier.height(VisorSpace.x1))
                Text(
                    text = tr(Str.NAV_TO_TURN, "distance" to formatDistanceMeters(guidance.distanceToManeuverMeters)),
                    color = c.text,
                    style = VisorType.mono
                )
                Text(
                    text = tr(Str.NAV_REMAINING, "remaining" to formatRemaining(guidance.remainingMeters, guidance.remainingSeconds)),
                    color = c.textSecondary,
                    style = VisorType.monoCaption
                )
            }
            if (guidance.offRoute) {
                VisorTag(tr(Str.OFF_ROUTE), tint = c.warn)
            }
        }
        guidance.confirmationId?.let { id ->
            Row(horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3), modifier = Modifier.fillMaxWidth()) {
                VisorButton(tr(Str.CANCEL), onClick = { onConfirm(id, false) }, modifier = Modifier.weight(1f))
                VisorButton(tr(Str.CONFIRM_NAV), onClick = { onConfirm(id, true) }, modifier = Modifier.weight(1f), style = VisorButtonStyle.PRIMARY)
            }
        }
        if (guidance.confirmationId == null) {
            VisorButton(tr(Str.OPEN_NAV), onClick = { showingDetails = true }, style = VisorButtonStyle.GHOST)
        }
        GuidanceRouteMap(guidance, paused = mapPaused)
    }
}

/** Flag reasons are sent to the relay in Chinese (admin replay stays uniform); the menu shows them in the current language. */
internal fun flagReasonLabel(reason: String): String = when (reason) {
    "听错了" -> tr(Str.FLAG_MISHEARD)
    "回答不对" -> tr(Str.FLAG_WRONG)
    "太慢" -> tr(Str.FLAG_SLOW)
    "不安全" -> tr(Str.FLAG_UNSAFE)
    else -> reason
}
