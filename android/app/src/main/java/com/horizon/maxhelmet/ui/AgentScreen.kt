package com.horizon.maxhelmet.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.agent.AgentEvent
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.DemoScenario
import com.horizon.maxhelmet.agent.HazardLevel
import com.horizon.maxhelmet.agent.RideMode
import com.horizon.maxhelmet.agent.Speaker
import com.horizon.maxhelmet.agent.TranscriptItem
import com.horizon.maxhelmet.agent.TurnState
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.VoicePersonality
import com.horizon.maxhelmet.ui.theme.HudColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Captions and orb palette ported from src/components/HelmetVisual.tsx.
private val TURN_CAPTIONS = mapOf(
    TurnState.IDLE to "待机",
    TurnState.LISTENING to "免提待命 · 请讲话",
    TurnState.HEARING to "正在聆听…",
    TurnState.THINKING to "Max 思考中…",
    TurnState.SPEAKING to "Max 回答中"
)

private fun ringColor(connected: Boolean, turnState: TurnState): Color {
    if (!connected) return HudColors.Danger
    return when (turnState) {
        TurnState.IDLE -> HudColors.Accent
        TurnState.LISTENING, TurnState.HEARING -> HudColors.AccentCyan
        TurnState.THINKING -> HudColors.Warn
        TurnState.SPEAKING -> HudColors.Accent
    }
}

private fun hazardColor(hazard: HazardLevel): Color = when (hazard) {
    HazardLevel.NORMAL -> HudColors.Accent
    HazardLevel.CAUTION -> HudColors.Warn
    HazardLevel.CRITICAL -> HudColors.Danger
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.OFFLINE -> "离线"
    ConnectionState.CONNECTING -> "连接中"
    ConnectionState.RELAY -> "中继在线"
    ConnectionState.PROVIDER -> "代理握手"
    ConnectionState.READY -> "已就绪"
    ConnectionState.DEGRADED -> "降级"
}

/** The orb's hue follows the session: a calm green invites a tap when idle,
 * amber while connecting, then the per-turn ring color once live. */
private fun orbColor(state: AgentSession.State): Color {
    if (!state.handsFree) return HudColors.Accent
    return when (state.connection) {
        ConnectionState.OFFLINE, ConnectionState.DEGRADED -> HudColors.Danger
        ConnectionState.CONNECTING, ConnectionState.PROVIDER -> HudColors.Warn
        ConnectionState.RELAY, ConnectionState.READY -> ringColor(true, state.turnState)
    }
}

/** The single line under the orb — the only words on the clean screen. */
private fun orbCaption(state: AgentSession.State): String {
    if (!state.handsFree) return "点按光球，开始对话"
    if (state.micMuted) return "麦克风已静音"
    return when (state.connection) {
        ConnectionState.READY -> TURN_CAPTIONS.getValue(state.turnState)
        else -> connectionLabel(state.connection)
    }
}

/**
 * Pure voice-mode main screen, in the spirit of ChatGPT's voice mode: a dark
 * glow, one big animated orb that breathes with the conversation and swells with
 * the rider's voice, a single status caption, and minimal controls. The
 * safety-critical ADAS hazard banner still pins to the top. Rider preferences and
 * the developer panel open as bottom sheets; captions are optional under the orb.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(
    viewModel: MainViewModel,
    onToggleHandsFree: () -> Unit,
    onExportTranscript: () -> Unit
) {
    val state by viewModel.sessionState.collectAsStateWithLifecycle()
    val color = orbColor(state)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HudColors.Background),
        contentAlignment = Alignment.TopCenter
    ) {
        // Soft state-tinted glow behind everything.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.radialGradient(colors = listOf(color.copy(alpha = 0.16f), Color.Transparent))
                )
        )

        Column(
            modifier = Modifier
                .widthIn(max = 560.dp)
                .fillMaxHeight()
                .padding(horizontal = 20.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            StatusPill(state = state, devMode = viewModel.devMode, onToggleDevMode = viewModel::toggleDevMode)

            state.hazardAlert?.let {
                Spacer(Modifier.height(12.dp))
                HazardBanner(it)
            }

            Spacer(Modifier.weight(1f))

            VoiceOrb(
                color = color,
                turnState = state.turnState,
                voiceLevel = state.voiceLevel,
                dimmed = state.micMuted,
                onTap = onToggleHandsFree
            )
            Spacer(Modifier.height(18.dp))
            Text(
                text = orbCaption(state),
                color = HudColors.Text,
                fontSize = 18.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center
            )

            Spacer(Modifier.weight(1f))

            AnimatedVisibility(visible = viewModel.showCaptions) {
                CaptionsOverlay(state.transcript)
            }
            Spacer(Modifier.height(12.dp))

            SecondaryControls(viewModel)
            Spacer(Modifier.height(16.dp))
            PrimaryControls(state = state, onToggleHandsFree = onToggleHandsFree, onToggleMute = viewModel::toggleMute)
        }
    }

    if (viewModel.showPreferences) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.showPreferences = false },
            containerColor = HudColors.Background
        ) {
            SheetContent("偏好设置") { PreferencesPanel(state, viewModel) }
        }
    }
    if (viewModel.showDevPanel) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.showDevPanel = false },
            containerColor = HudColors.Background
        ) {
            SheetContent("开发者模式") { DevPanel(state, viewModel, onExportTranscript) }
        }
    }
}

// ---- top status pill (long-press toggles the developer panel) ----------------------

@Composable
private fun StatusPill(state: AgentSession.State, devMode: Boolean, onToggleDevMode: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val online = state.connection == ConnectionState.READY
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(HudColors.PanelElevated.copy(alpha = 0.7f))
            .pointerInput(Unit) {
                // Hidden gesture: long-press the status pill to toggle developer mode.
                detectTapGestures(onLongPress = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onToggleDevMode()
                })
            }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp)
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(if (online) HudColors.Accent else HudColors.Muted)
        )
        Text("Max", color = HudColors.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text("·", color = HudColors.Muted, fontSize = 13.sp)
        Text(connectionLabel(state.connection), color = HudColors.Muted, fontSize = 13.sp)
        if (devMode) {
            Text("· 开发者", color = HudColors.AccentCyan, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        if (state.bluetoothRouted) {
            Text("🎧", fontSize = 11.sp)
        }
    }
}

// ---- voice orb --------------------------------------------------------------------

/**
 * A glowing, breathing sphere that reacts to the session: it breathes faster
 * while thinking, ripples outward with the rider's voice level, and shows a
 * rotating shimmer while Max thinks. Tapping it toggles hands-free.
 */
@Composable
private fun VoiceOrb(
    color: Color,
    turnState: TurnState,
    voiceLevel: Float,
    dimmed: Boolean,
    onTap: () -> Unit
) {
    val breatheDuration = when (turnState) {
        TurnState.IDLE -> 1700
        TurnState.LISTENING, TurnState.HEARING -> 1150
        TurnState.THINKING -> 760
        TurnState.SPEAKING -> 1000
    }
    val pulseAmp = when (turnState) {
        TurnState.IDLE -> 0.05f
        TurnState.LISTENING, TurnState.HEARING -> 0.10f
        TurnState.THINKING -> 0.14f
        TurnState.SPEAKING -> 0.17f
    }

    val transition = rememberInfiniteTransition(label = "orb")
    val breathe by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(breatheDuration, easing = LinearEasing), RepeatMode.Reverse),
        label = "breathe"
    )
    val spin by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart),
        label = "spin"
    )

    Canvas(
        modifier = Modifier
            .size(250.dp)
            .clip(CircleShape)
            .alpha(if (dimmed) 0.5f else 1f)
            .clickable(onClick = onTap)
    ) {
        val c = center
        val level = voiceLevel.coerceIn(0f, 1f)
        val base = size.minDimension * 0.30f
        val coreScale = 1f + pulseAmp * breathe + 0.28f * level

        // Outer halo — soft colored bloom.
        val haloR = base * (1.55f + 0.18f * breathe + 0.30f * level)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(color.copy(alpha = 0.42f), Color.Transparent),
                center = c,
                radius = haloR
            ),
            radius = haloR,
            center = c
        )
        // Voice ripple — expands as the rider speaks.
        drawCircle(
            color = color.copy(alpha = 0.15f + 0.7f * level),
            radius = base * (0.95f + 0.55f * level),
            center = c,
            style = Stroke(width = 2.dp.toPx())
        )
        // Core sphere — offset highlight reads as a lit orb.
        val coreR = base * coreScale
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color.White.copy(alpha = 0.92f), color, color.copy(alpha = 0.72f)),
                center = Offset(c.x - base * 0.22f, c.y - base * 0.28f),
                radius = coreR * 1.15f
            ),
            radius = coreR,
            center = c
        )
        drawCircle(
            color = Color.White.copy(alpha = 0.14f),
            radius = coreR,
            center = c,
            style = Stroke(width = 1.dp.toPx())
        )
        // Thinking shimmer — a rotating highlight arc.
        if (turnState == TurnState.THINKING) {
            rotate(spin, pivot = c) {
                val r = coreR * 1.04f
                drawArc(
                    color = Color.White.copy(alpha = 0.55f),
                    startAngle = 0f,
                    sweepAngle = 100f,
                    useCenter = false,
                    topLeft = Offset(c.x - r, c.y - r),
                    size = Size(r * 2f, r * 2f),
                    style = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round)
                )
            }
        }
    }
}

// ---- secondary controls (字幕 · 偏好 · 开发者) ---------------------------------------

@Composable
private fun SecondaryControls(viewModel: MainViewModel) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        PillToggle(glyph = "💬", label = "字幕", on = viewModel.showCaptions, onClick = viewModel::toggleCaptions)
        Spacer(Modifier.weight(1f))
        if (viewModel.devMode) {
            PillToggle(glyph = "🛠", label = "开发", on = false, onClick = { viewModel.showDevPanel = true })
            Spacer(Modifier.width(10.dp))
        }
        PillToggle(glyph = "⚙", label = "偏好", on = false, onClick = { viewModel.showPreferences = true })
    }
}

@Composable
private fun PillToggle(glyph: String, label: String, on: Boolean, onClick: () -> Unit) {
    val tint = if (on) HudColors.Accent else HudColors.Muted
    val background = if (on) HudColors.Accent.copy(alpha = 0.16f) else HudColors.PanelElevated
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(background)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(glyph, fontSize = 13.sp)
        Text(label, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

// ---- primary controls (start · mute · end) -------------------------------------------

@Composable
private fun PrimaryControls(
    state: AgentSession.State,
    onToggleHandsFree: () -> Unit,
    onToggleMute: () -> Unit
) {
    if (state.handsFree) {
        Row(horizontalArrangement = Arrangement.spacedBy(44.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleControl(
                glyph = if (state.micMuted) "🔇" else "🎙",
                background = HudColors.PanelElevated,
                label = if (state.micMuted) "取消静音" else "静音",
                onClick = onToggleMute
            )
            CircleControl(
                glyph = "✕",
                glyphColor = Color.White,
                background = HudColors.Danger,
                label = "结束",
                onClick = onToggleHandsFree
            )
        }
    } else {
        CircleControl(
            glyph = "🎙",
            background = HudColors.Accent,
            diameter = 76.dp,
            label = "开始",
            onClick = onToggleHandsFree
        )
    }
}

@Composable
private fun CircleControl(
    glyph: String,
    background: Color,
    label: String,
    onClick: () -> Unit,
    glyphColor: Color = HudColors.Text,
    diameter: androidx.compose.ui.unit.Dp = 64.dp
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(diameter)
                .clip(CircleShape)
                .background(background)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            Text(glyph, color = glyphColor, fontSize = (diameter.value * 0.34f).sp)
        }
        Spacer(Modifier.height(7.dp))
        Text(label, color = HudColors.Muted, fontSize = 12.sp)
    }
}

// ---- optional captions overlay (字幕) -------------------------------------------------

@Composable
private fun CaptionsOverlay(items: List<TranscriptItem>) {
    val listState = rememberLazyListState()
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

    LaunchedEffect(items.size, items.lastOrNull()?.text) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.lastIndex)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(HudColors.Panel)
            .padding(14.dp)
    ) {
        if (items.isEmpty()) {
            Text(
                text = "暂无字幕",
                color = HudColors.Muted,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 18.dp)
            )
        } else {
            LazyColumn(
                state = listState,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(190.dp)
            ) {
                items(items, key = { it.id }) { item ->
                    ChatBubble(item = item, time = timeFormat.format(Date(item.at)))
                }
            }
        }
    }
}

@Composable
private fun ChatBubble(item: TranscriptItem, time: String) {
    val isRider = item.speaker == Speaker.RIDER
    val bubbleColor = if (isRider) HudColors.Rider.copy(alpha = 0.16f) else HudColors.PanelElevated
    val speakerColor = if (isRider) HudColors.Rider else HudColors.Accent

    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (isRider) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Column(
            horizontalAlignment = if (isRider) Alignment.End else Alignment.Start,
            modifier = Modifier.padding(
                start = if (isRider) 40.dp else 0.dp,
                end = if (isRider) 0.dp else 40.dp
            )
        ) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(bubbleColor)
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            ) {
                Text(item.text, color = HudColors.Text, fontSize = 14.sp)
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    text = if (isRider) "骑手" else "Max",
                    color = speakerColor,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(time, color = HudColors.Muted, fontSize = 10.sp)
                if (!item.final) Text("…", color = HudColors.Muted, fontSize = 10.sp)
            }
        }
    }
}

// ---- ADAS hazard banner (safety-critical: kept on every screen) ----------------------

@Composable
private fun HazardBanner(alert: AgentEvent.HazardAlert) {
    val color = hazardColor(alert.severity)
    HudCard(borderColor = color) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(color.copy(alpha = 0.22f))
                    .padding(horizontal = 10.dp, vertical = 8.dp)
            ) {
                Text(alert.directionLabel, color = HudColors.Text, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("⚠️ ${alert.label}", color = HudColors.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text("${alert.message} ${alert.advice}", color = HudColors.Muted, fontSize = 12.sp)
            }
            Spacer(Modifier.width(8.dp))
            Text("${alert.ttcSeconds}s", color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
    }
}

// ---- settings sheet scaffold ----------------------------------------------------------

@Composable
private fun SheetContent(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 18.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text(title, color = HudColors.Text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        content()
    }
}

// ---- rider preferences ----------------------------------------------------------------

@Composable
private fun PreferencesPanel(state: AgentSession.State, viewModel: MainViewModel) {
    HudCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ChipRow(label = "声音") {
                VoiceGender.entries.forEach { gender ->
                    HudChip(
                        label = gender.label,
                        selected = state.voiceGender == gender,
                        onClick = { viewModel.setVoiceGender(gender) }
                    )
                }
            }
            ChipRow(label = "语气") {
                VoicePersonality.entries.forEach { personality ->
                    HudChip(
                        label = personality.label,
                        selected = state.voicePersonality == personality,
                        onClick = { viewModel.setVoicePersonality(personality) }
                    )
                }
            }
            ChipRow(label = "模式") {
                RideMode.entries.forEach { mode ->
                    HudChip(
                        label = mode.label,
                        selected = state.rideContext.mode == mode,
                        onClick = { viewModel.setRideMode(mode) },
                        selectedColor = if (mode == RideMode.EMERGENCY) HudColors.Danger else HudColors.Accent
                    )
                }
            }
        }
    }
}

@Composable
private fun ChipRow(label: String, content: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = HudColors.Muted, fontSize = 11.sp, modifier = Modifier.width(34.dp))
        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            content()
        }
    }
}

@Composable
private fun HudChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    selectedColor: Color = HudColors.Accent
) {
    val background = if (selected) selectedColor.copy(alpha = 0.16f) else HudColors.PanelElevated
    val textColor = if (selected) selectedColor else HudColors.Muted
    val shape = RoundedCornerShape(50)
    Box(
        modifier = Modifier
            .clip(shape)
            .background(background)
            .then(
                if (selected) Modifier.border(1.dp, selectedColor.copy(alpha = 0.7f), shape)
                else Modifier
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp)
    ) {
        Text(
            label,
            color = textColor,
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal
        )
    }
}

// ---- developer panel (open from the wrench when developer mode is on) ------------------

@Composable
private fun DevPanel(
    state: AgentSession.State,
    viewModel: MainViewModel,
    onExportTranscript: () -> Unit
) {
    HudCard(borderColor = HudColors.AccentCyan.copy(alpha = 0.4f)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("会话与遥测", color = HudColors.AccentCyan, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            HudChip(
                label = "导出日志",
                selected = state.transcript.isNotEmpty(),
                onClick = { if (state.transcript.isNotEmpty()) onExportTranscript() },
                selectedColor = HudColors.AccentCyan
            )
        }
        Spacer(Modifier.height(6.dp))

        Text(state.statusText, color = HudColors.Muted, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))

        ChipRow(label = "场景") {
            DemoScenario.entries.forEach { scenario ->
                HudChip(
                    label = scenario.label,
                    selected = state.rideContext.scenario == scenario,
                    onClick = { viewModel.setScenario(scenario) },
                    selectedColor = hazardColor(scenario.hazard)
                )
            }
        }
        Spacer(Modifier.height(8.dp))

        // latencyTone in src/main.tsx: <140 good, <280 warn, else alert.
        val toneColor = when {
            state.latencyMs < 140 -> HudColors.Accent
            state.latencyMs < 280 -> HudColors.Warn
            else -> HudColors.Danger
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("延迟", color = HudColors.Muted, fontSize = 11.sp)
            Text("${state.latencyMs}ms", color = toneColor, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            state.telemetry?.let {
                Text(
                    "ASR ${it.asrMs} · 思考 ${it.thinkMs} · 首音 ${it.firstAudioMs} · 总计 ${it.totalMs}ms",
                    color = HudColors.Muted,
                    fontSize = 11.sp
                )
            }
        }

        // Connection settings: editable only while disconnected.
        if (!state.handsFree) {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = viewModel.relayUrl,
                onValueChange = viewModel::updateRelayUrl,
                singleLine = true,
                label = { Text("语音中继地址（ws:// 或 wss://）", fontSize = 12.sp) },
                textStyle = MaterialTheme.typography.bodySmall.copy(color = HudColors.Text),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = HudColors.AccentCyan,
                    unfocusedBorderColor = HudColors.Border,
                    focusedLabelColor = HudColors.AccentCyan,
                    unfocusedLabelColor = HudColors.Muted
                ),
                modifier = Modifier.fillMaxWidth()
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("信任自签名证书（测试服务器）", color = HudColors.Muted, fontSize = 12.sp)
                Switch(
                    checked = viewModel.allowSelfSigned,
                    onCheckedChange = viewModel::updateAllowSelfSigned,
                    colors = SwitchDefaults.colors(
                        checkedTrackColor = HudColors.Accent,
                        checkedThumbColor = Color(0xFF07221A)
                    )
                )
            }
        }
    }
}

// ---- shared card scaffolding -----------------------------------------------------------

@Composable
private fun HudCard(
    borderColor: Color = Color.Transparent,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(HudColors.PanelElevated)
            .then(
                if (borderColor != Color.Transparent) {
                    Modifier.border(1.dp, borderColor, RoundedCornerShape(16.dp))
                } else {
                    Modifier
                }
            )
            .padding(16.dp)
    ) {
        content()
    }
}
