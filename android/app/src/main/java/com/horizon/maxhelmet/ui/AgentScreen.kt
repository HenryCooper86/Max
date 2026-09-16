package com.horizon.maxhelmet.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.agent.AgentEvent
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.HazardLevel
import com.horizon.maxhelmet.agent.Speaker
import com.horizon.maxhelmet.agent.TURN_FLAG_REASONS
import com.horizon.maxhelmet.agent.TranscriptItem
import com.horizon.maxhelmet.agent.TurnState
import com.horizon.maxhelmet.navigation.NavGuidanceState
import com.horizon.maxhelmet.ui.theme.HudColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

// Captions and palette ported from src/components/HelmetVisual.tsx.
private val TURN_CAPTIONS = mapOf(
    TurnState.IDLE to "待机",
    TurnState.LISTENING to "免提待命 · 请讲话",
    TurnState.HEARING to "正在聆听…",
    TurnState.THINKING to "Max 思考中…",
    TurnState.SPEAKING to "Max 回答中"
)

/** Caption prefixes for a non-normal fused hazard (HAZARD_CAPTIONS in HelmetVisual.tsx). */
private val HAZARD_CAPTIONS = mapOf(
    HazardLevel.CAUTION to "注意路况",
    HazardLevel.CRITICAL to "高风险 · 优先安全"
)

private fun ringColor(connected: Boolean, turnState: TurnState): Color {
    if (!connected) return HudColors.Red
    return when (turnState) {
        // Green = live/ready for every conversational state; amber = thinking.
        // The cyan "listening" hue is retired (Night Instrument palette).
        TurnState.IDLE -> HudColors.Lume
        TurnState.LISTENING, TurnState.HEARING -> HudColors.Lume
        TurnState.THINKING -> HudColors.Amber
        TurnState.SPEAKING -> HudColors.Lume
    }
}

internal fun hazardColor(hazard: HazardLevel): Color = when (hazard) {
    HazardLevel.NORMAL -> HudColors.Lume
    HazardLevel.CAUTION -> HudColors.Amber
    HazardLevel.CRITICAL -> HudColors.Red
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.OFFLINE -> "离线"
    ConnectionState.CONNECTING -> "连接中"
    ConnectionState.RELAY -> "中继在线"
    ConnectionState.PROVIDER -> "代理握手"
    ConnectionState.READY -> "已就绪"
    ConnectionState.DEGRADED -> "降级"
}

/** The glow's hue follows the session: a calm green invites a tap when idle,
 * amber while connecting, then the per-turn ring color once live. */
private fun orbColor(state: AgentSession.State): Color {
    if (!state.handsFree) return HudColors.Lume
    if (isHazardPresentationActive(state)) return hazardColor(state.fusedHazard)
    return when (state.connection) {
        ConnectionState.OFFLINE, ConnectionState.DEGRADED -> HudColors.Red
        ConnectionState.CONNECTING, ConnectionState.PROVIDER -> HudColors.Amber
        // The fused hazard overrides the conversational palette: a rider glancing
        // at the helmet must see danger first, turn state second (HelmetVisual.tsx).
        ConnectionState.RELAY, ConnectionState.READY -> ringColor(true, state.turnState)
    }
}

/** Latin instrument telltale under the Chinese state word — the system monospaced
 *  face here (Space Mono on web). Deliberately English: a gauge label, not primary
 *  copy. Mirrors the web HelmetVisual TELLTALE map. */
private fun stateTelltale(state: AgentSession.State): String {
    if (isHazardPresentationActive(state)) {
        return if (state.fusedHazard == HazardLevel.CRITICAL) "HAZARD" else "CAUTION"
    }
    if (!state.handsFree) return "STANDBY"
    if (state.micMuted) return "MUTED"
    return when (state.connection) {
        ConnectionState.OFFLINE, ConnectionState.DEGRADED -> "OFFLINE"
        ConnectionState.CONNECTING, ConnectionState.PROVIDER -> "CONNECTING"
        ConnectionState.RELAY, ConnectionState.READY -> when (state.turnState) {
            TurnState.IDLE -> "STANDBY"
            TurnState.LISTENING -> "LISTENING"
            TurnState.HEARING -> "HEARING"
            TurnState.THINKING -> "THINKING"
            TurnState.SPEAKING -> "SPEAKING"
        }
    }
}

/** Drive mode for the instrument bezel — mirrors the web HelmetVisual gauge, so
 *  the tick ring and the caption always agree on what Max is doing. */
private enum class GaugeMode { OFFLINE, IDLE, CONNECTING, MIC, THINKING, SPEAKING, HAZARD }

private fun gaugeMode(state: AgentSession.State): GaugeMode {
    if (isHazardPresentationActive(state)) return GaugeMode.HAZARD
    if (!state.handsFree) return GaugeMode.IDLE
    return when (state.connection) {
        ConnectionState.OFFLINE, ConnectionState.DEGRADED -> GaugeMode.OFFLINE
        ConnectionState.CONNECTING, ConnectionState.PROVIDER -> GaugeMode.CONNECTING
        ConnectionState.RELAY, ConnectionState.READY -> when (state.turnState) {
            TurnState.THINKING -> GaugeMode.THINKING
            TurnState.SPEAKING -> GaugeMode.SPEAKING
            TurnState.LISTENING, TurnState.HEARING -> GaugeMode.MIC
            TurnState.IDLE -> GaugeMode.IDLE
        }
    }
}

/** The single line under the helmet — the only words on the clean screen. */
internal fun orbCaption(state: AgentSession.State): String {
    if (!state.handsFree) return "点按头盔，开始对话"
    val caption = if (state.micMuted) {
        "麦克风已静音"
    } else {
        when (state.connection) {
            ConnectionState.READY -> TURN_CAPTIONS.getValue(state.turnState)
            else -> connectionLabel(state.connection)
        }
    }
    // A non-normal fused hazard leads the caption (HAZARD_CAPTIONS in HelmetVisual.tsx).
    val presentedHazard = if (isHazardPresentationActive(state)) state.fusedHazard else HazardLevel.NORMAL
    val hazardPrefix = HAZARD_CAPTIONS[presentedHazard]
    return if (hazardPrefix != null) "$hazardPrefix · $caption" else caption
}

/**
 * Pure voice-mode main screen, in the spirit of ChatGPT's voice mode: a dark glow
 * with the brand helmet centerpiece breathing and glowing with the conversation,
 * a single status caption, and minimal controls. The safety-critical ADAS hazard
 * banner pins to the top. All rider + test settings live in the gear sheet;
 * captions are optional under the helmet.
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

    // The relay requires a login (HTTP 401): open the settings sheet on the
    // 账号 section so the rider can sign in right where the fix is.
    LaunchedEffect(state.authRequired) {
        // Handles the stale-identity case too: a 401 while "logged in" means
        // the stored session died server-side — the view model drops it so
        // the login form (not the identity row) is what opens. The flag is
        // consumed there, so rotation/recomposition can't re-open the sheet.
        if (state.authRequired) {
            viewModel.handleAuthRequired()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HudColors.Void),
        contentAlignment = Alignment.TopCenter
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.radialGradient(colors = listOf(color.copy(alpha = 0.16f), Color.Transparent))
                )
        )

        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 16.dp, vertical = 12.dp)) {
            val landscape = maxWidth > maxHeight
            val musicState by viewModel.music.state.collectAsStateWithLifecycle()
            val recording by viewModel.camera.isRecording.collectAsStateWithLifecycle()
            val galleryRequest by viewModel.deviceActions.galleryRequest.collectAsStateWithLifecycle()
            LaunchedEffect(galleryRequest) { if (galleryRequest > 0) viewModel.showGallery = true }
            val alerts: @Composable () -> Unit = {
                state.hazardAlert?.let { HazardBanner(it) }
                if (isNavPresentationActive(state)) state.navGuidance?.let { GuidanceCard(it) }
                if (recording) Text("● 正在录像（无声）· 说“停止录像”结束", color = HudColors.Amber)
            }
            val utilities: @Composable () -> Unit = {
                MusicPlaybackCard(viewModel.music)
                if (viewModel.showCaptions) CaptionsOverlay(items = state.transcript,
                    canFlag = state::canFlagTurn, onFlag = viewModel::flagTurn)
            }
            val helmet: @Composable (Dp) -> Unit = { diameter ->
                HelmetVisual(color, state.turnState, state.voiceLevel, state.micMuted,
                    if (isHazardPresentationActive(state)) state.fusedHazard else HazardLevel.NORMAL,
                    gaugeMode(state), onToggleHandsFree, diameter, state.handsFree)
            }
            val availableHeight = maxHeight
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                TopBar(state)
                Spacer(Modifier.height(8.dp))
                if (landscape) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(0.42f).verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                            helmet((availableHeight - 100.dp).coerceIn(116.dp, 220.dp))
                            SessionReadout(state)
                        }
                        Column(Modifier.weight(0.58f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            alerts(); utilities(); SecondaryControls(state, viewModel)
                        }
                    }
                } else {
                    Column(Modifier.fillMaxWidth().heightIn(max = availableHeight * 0.35f).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) { alerts() }
                    helmet((availableHeight * if (musicState.visible || state.navGuidance != null) 0.25f else 0.40f).coerceIn(116.dp, 300.dp))
                    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SessionReadout(state); utilities()
                    }
                    SecondaryControls(state, viewModel)
                }
            }
        }
    }

    if (viewModel.showGallery) CaptureGallery(viewModel.captures) { viewModel.showGallery = false }

    if (viewModel.showPreferences) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.showPreferences = false },
            containerColor = HudColors.Background
        ) {
            SheetContent("设置") { SettingsPanel(state, viewModel, onExportTranscript) }
        }
    }
    CrashOverlay(viewModel)
}

// ---- top status pill -----------------------------------------------------------------

@Composable
private fun TopBar(state: AgentSession.State) {
    val online = state.connection == ConnectionState.RELAY || state.connection == ConnectionState.READY
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(if (online) HudColors.Lume else HudColors.HudDim)
            )
            Text("MAX", color = HudColors.HudInk, fontSize = 15.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp)
        }
        Spacer(Modifier.weight(1f))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if (state.bluetoothRouted) Text("🎧", fontSize = 11.sp)
            Box(
                modifier = Modifier
                    .size(5.dp)
                    .clip(CircleShape)
                    .background(if (online) HudColors.Lume else HudColors.Red)
            )
            Text(
                text = if (online) "RELAY ONLINE" else "RELAY OFFLINE",
                color = if (online) HudColors.HudDim else Color(0xFFB9776C),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 2.sp
            )
        }
    }
}

// ---- helmet centerpiece --------------------------------------------------------------

// Helmet SVG paths (viewBox 0 0 420 270), copied from src/components/HelmetVisual.tsx.
private const val HELMET_SHELL = "M54 161c4-81 68-132 151-132 93 0 159 61 166 149 2 24-11 45-34 54-45 17-126 26-204 8-50-12-81-39-79-79Z"
private const val HELMET_CHIN = "M220 167c40 4 82 0 126-12-5 28-18 46-40 54-31 11-66 17-103 17 17-17 22-36 17-59Z"
private const val HELMET_VISOR = "M155 88h155c22 0 40 18 40 40v13c-48 18-106 25-178 21-27-1-49-24-49-51 0-13 11-23 32-23Z"

/**
 * The brand helmet (shell + chin + visor + status dots), ported from the web
 * HelmetVisual SVG. A state-tinted halo behind it breathes with the turn state and
 * ripples outward with the rider's voice; the visor glows while Max listens or
 * speaks. Tapping it toggles hands-free.
 */
@Composable
private fun HelmetVisual(
    color: Color,
    turnState: TurnState,
    voiceLevel: Float,
    dimmed: Boolean,
    hazard: HazardLevel,
    gauge: GaugeMode,
    onTap: () -> Unit,
    diameter: Dp = 300.dp,
    handsFree: Boolean = false
) {
    val breatheDuration = when (turnState) {
        TurnState.IDLE -> 1700
        TurnState.LISTENING, TurnState.HEARING -> 1150
        TurnState.THINKING -> 760
        TurnState.SPEAKING -> 1000
    }
    val pulseAmp = when (turnState) {
        TurnState.IDLE -> 0.03f
        TurnState.LISTENING, TurnState.HEARING -> 0.06f
        TurnState.THINKING -> 0.08f
        TurnState.SPEAKING -> 0.10f
    }
    val listening = turnState == TurnState.LISTENING || turnState == TurnState.HEARING
    val speaking = turnState == TurnState.SPEAKING

    val breathe by rememberInfiniteTransition(label = "helmet").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(breatheDuration, easing = LinearEasing), RepeatMode.Reverse),
        label = "breathe"
    )

    // Critical fused hazard: a fast urgency pulse layered onto the glow alpha,
    // so danger reads even when the rider isn't talking.
    val hazardPulse by rememberInfiniteTransition(label = "hazard").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "hazardPulse"
    )
    val critical = hazard == HazardLevel.CRITICAL

    // Phase for the gauge's travelling shimmer (thinking / connecting).
    val gaugePhase by rememberInfiniteTransition(label = "gauge").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart),
        label = "gaugePhase"
    )

    val shell = remember { svgToPath(HELMET_SHELL) }
    val chin = remember { svgToPath(HELMET_CHIN) }
    val visor = remember { svgToPath(HELMET_VISOR) }

    Canvas(
        modifier = Modifier
            .size(diameter)
            .alpha(if (dimmed) 0.55f else 1f)
            .semantics { contentDescription = if (handsFree) "结束免提" else "开启免提" }
            .clickable(role = Role.Button, onClick = onTap)
    ) {
        val level = voiceLevel.coerceIn(0f, 1f)
        val pulse = pulseAmp * breathe + 0.06f * level
        val c = center
        // Clamp every glow radius to fit inside the canvas so the radial gradient
        // fades fully to clear before the edge — otherwise the bounded canvas clips
        // the growing glow into hard rectangular cuts at the top and bottom.
        val maxR = minOf(size.width, size.height) / 2f

        // Critical hazard throbs the glow; otherwise it holds steady.
        val urgency = if (critical) 0.6f + 0.4f * hazardPulse else 1f

        // Instrument bezel behind the helmet — its arc reads the session state.
        drawGauge(color = color, mode = gauge, level = level, phase = gaugePhase)

        // Halo — soft state-tinted bloom behind the helmet.
        val haloR = minOf(size.width * 0.34f * (1f + 0.16f * breathe + 0.45f * level), maxR)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(color.copy(alpha = (0.42f + 0.12f * level) * urgency), Color.Transparent),
                center = c,
                radius = haloR
            ),
            radius = haloR,
            center = c
        )
        // Voice ripple — expands as the rider speaks.
        drawCircle(
            color = color.copy(alpha = (0.12f + 0.5f * level) * urgency),
            radius = minOf(size.width * 0.30f * (0.92f + 0.5f * level), maxR * 0.95f),
            center = c,
            style = Stroke(width = 2.dp.toPx())
        )

        // Helmet, scaled to fit and breathing about the canvas center.
        val s = (size.width / 420f * 0.74f) * (1f + pulse)
        val tx = (size.width - 420f * s) / 2f
        val ty = (size.height - 270f * s) / 2f
        withTransform({ translate(tx, ty); scale(s, s, pivot = Offset.Zero) }) {
            drawPath(
                shell,
                brush = Brush.linearGradient(
                    colors = listOf(Color(0xFFF6F9F6), Color(0xFFCDD6D1), Color(0xFF8B9893)),
                    start = Offset(120f, 28f), end = Offset(150f, 215f)
                )
            )
            // Top rim light — lifts the shell off the background with volume
            // (mirrors the web shellSheen gradient in HelmetVisual.tsx).
            drawPath(
                shell,
                brush = Brush.linearGradient(
                    colors = listOf(Color.White.copy(alpha = 0.5f), Color.Transparent),
                    start = Offset(210f, 28f), end = Offset(210f, 120f)
                )
            )
            drawPath(
                chin,
                brush = Brush.linearGradient(
                    colors = listOf(Color(0xFF8B9B97), Color(0xFF5D6B68)),
                    start = Offset(283f, 160f), end = Offset(283f, 240f)
                )
            )
            drawPath(
                visor,
                brush = Brush.linearGradient(
                    colors = listOf(Color(0xFF54787E), Color(0xFF22393D), Color(0xFF0A1A1F)),
                    start = Offset(232f, 88f), end = Offset(232f, 165f)
                )
            )
            // Visor state glow — tints the visor while Max listens or speaks.
            val visorGlow = (if (speaking) 0.42f else if (listening) 0.30f else 0.10f) * (0.55f + 0.45f * level)
            drawPath(visor, color = color.copy(alpha = visorGlow))
            // Visor glare highlight.
            drawOval(
                color = Color.White.copy(alpha = 0.12f),
                topLeft = Offset(206f - 58f, 106f - 11f),
                size = Size(116f, 22f)
            )
            // Crisp glassy streak across the upper visor (mirrors web visorSpec).
            drawOval(
                color = Color.White.copy(alpha = 0.5f),
                topLeft = Offset(190f - 44f, 99f - 3.4f),
                size = Size(88f, 6.8f)
            )
            // Mic + status dots.
            drawCircle(if (listening) HudColors.Lume else HudColors.HudDim, radius = 9f, center = Offset(258f, 205f))
            drawCircle(color, radius = 9f, center = Offset(282f, 205f))
        }
    }
}

// ---- instrument bezel (the signature) ------------------------------------------------

/**
 * A 270° tick ring (gap at the bottom, tachometer-style) around the helmet, whose
 * luminous arc reads the session state — a ready nub at standby, an arc tracking the
 * mic level while listening, a travelling shimmer while thinking/connecting, a
 * near-full arc while speaking, and a wide arc on hazard. Mirrors web .gaugeBezel.
 */
private const val GAUGE_TICKS = 56

private fun gaugeLit(mode: GaugeMode, i: Int, level: Float, phase: Float): Boolean {
    val n = GAUGE_TICKS
    return when (mode) {
        GaugeMode.OFFLINE -> false
        GaugeMode.IDLE -> i < 3 // a small "ready" nub at the start of the sweep
        GaugeMode.MIC -> i < ((0.08f + minOf(1f, level * 1.7f) * 0.82f) * n).toInt()
        GaugeMode.SPEAKING -> i < (0.9f * n).toInt()
        GaugeMode.HAZARD -> i < (0.82f * n).toInt()
        GaugeMode.THINKING, GaugeMode.CONNECTING -> {
            // A travelling window of lit ticks reads as "working".
            val head = phase * n
            val rel = (i - head + n) % n
            rel < 9f
        }
    }
}

private fun DrawScope.drawGauge(color: Color, mode: GaugeMode, level: Float, phase: Float) {
    val cx = size.width / 2f
    val cy = size.height / 2f
    val unit = size.width / 400f
    val rOut = size.width * 0.46f
    for (i in 0 until GAUGE_TICKS) {
        val frac = i.toFloat() / (GAUGE_TICKS - 1)
        val ang = ((-135f + frac * 270f) * PI / 180f).toFloat()
        val major = i % 6 == 0
        val len = (if (major) 15f else 9f) * unit
        val s = sin(ang)
        val cc = cos(ang)
        val p1 = Offset(cx + rOut * s, cy - rOut * cc)
        val p2 = Offset(cx + (rOut - len) * s, cy - (rOut - len) * cc)
        if (gaugeLit(mode, i, level, phase)) {
            drawLine(color.copy(alpha = 0.32f), p1, p2, strokeWidth = (if (major) 6f else 5f) * unit, cap = StrokeCap.Round)
            drawLine(color, p1, p2, strokeWidth = (if (major) 3f else 2.4f) * unit, cap = StrokeCap.Round)
        } else {
            drawLine(HudColors.Tick, p1, p2, strokeWidth = (if (major) 2.2f else 1.6f) * unit, cap = StrokeCap.Round)
        }
    }
}

/** Minimal SVG path parser (supports M/m L/l H/h V/v C/c Z) → Compose Path. */
private fun svgToPath(d: String): Path {
    val path = Path()
    val tokens = svgTokens(d)
    var i = 0
    var curX = 0f
    var curY = 0f
    var startX = 0f
    var startY = 0f
    var cmd = ' '

    fun num(k: Int): Float = (tokens.getOrNull(k) as? SvgToken.Num)?.v ?: 0f

    while (i < tokens.size) {
        when (val tok = tokens[i]) {
            is SvgToken.Cmd -> {
                cmd = tok.c
                i++
                if (cmd == 'Z' || cmd == 'z') {
                    path.close()
                    curX = startX; curY = startY
                }
            }
            is SvgToken.Num -> {
                when (cmd) {
                    'M' -> {
                        curX = num(i); curY = num(i + 1); i += 2
                        startX = curX; startY = curY; path.moveTo(curX, curY); cmd = 'L'
                    }
                    'm' -> {
                        curX += num(i); curY += num(i + 1); i += 2
                        startX = curX; startY = curY; path.moveTo(curX, curY); cmd = 'l'
                    }
                    'L' -> { curX = num(i); curY = num(i + 1); i += 2; path.lineTo(curX, curY) }
                    'l' -> { curX += num(i); curY += num(i + 1); i += 2; path.lineTo(curX, curY) }
                    'H' -> { curX = num(i); i += 1; path.lineTo(curX, curY) }
                    'h' -> { curX += num(i); i += 1; path.lineTo(curX, curY) }
                    'V' -> { curY = num(i); i += 1; path.lineTo(curX, curY) }
                    'v' -> { curY += num(i); i += 1; path.lineTo(curX, curY) }
                    'C' -> {
                        path.cubicTo(num(i), num(i + 1), num(i + 2), num(i + 3), num(i + 4), num(i + 5))
                        curX = num(i + 4); curY = num(i + 5); i += 6
                    }
                    'c' -> {
                        path.cubicTo(
                            curX + num(i), curY + num(i + 1),
                            curX + num(i + 2), curY + num(i + 3),
                            curX + num(i + 4), curY + num(i + 5)
                        )
                        curX += num(i + 4); curY += num(i + 5); i += 6
                    }
                    else -> i++
                }
            }
        }
    }
    return path
}

private sealed interface SvgToken {
    data class Cmd(val c: Char) : SvgToken
    data class Num(val v: Float) : SvgToken
}

private fun svgTokens(s: String): List<SvgToken> {
    val out = ArrayList<SvgToken>()
    val commands = "MmLlHhVvCcSsQqTtAaZz"
    var i = 0
    val n = s.length
    while (i < n) {
        val c = s[i]
        if (c == ' ' || c == ',' || c == '\n' || c == '\t') { i++; continue }
        if (c in commands) { out.add(SvgToken.Cmd(c)); i++; continue }
        var j = i
        if (s[j] == '+' || s[j] == '-') j++
        while (j < n && s[j].isDigit()) j++
        if (j < n && s[j] == '.') { j++; while (j < n && s[j].isDigit()) j++ }
        if (j < n && (s[j] == 'e' || s[j] == 'E')) {
            j++
            if (j < n && (s[j] == '+' || s[j] == '-')) j++
            while (j < n && s[j].isDigit()) j++
        }
        val v = if (j > i) s.substring(i, j).toFloatOrNull() else null
        if (v != null) { out.add(SvgToken.Num(v)); i = j } else i++
    }
    return out
}

// ---- secondary controls (字幕 · 静音 · 设置) ----------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SecondaryControls(state: AgentSession.State, viewModel: MainViewModel) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        PillToggle(glyph = "💬", label = "字幕", on = viewModel.showCaptions, onClick = viewModel::toggleCaptions)
        if (state.handsFree) {
            MuteUtilityPill(muted = state.micMuted, onClick = viewModel::toggleMute)
        }
        PillToggle(glyph = "▧", label = "相册", on = false, onClick = { viewModel.showGallery = true })
        PillToggle(glyph = "♫", label = "音乐", on = false, onClick = { viewModel.music.show() })
        PillToggle(glyph = "⚙", label = "设置", on = false, onClick = { viewModel.showPreferences = true })
    }
}

@Composable
private fun PillToggle(glyph: String, label: String, on: Boolean, onClick: () -> Unit) {
    val tint = if (on) HudColors.Lume else HudColors.HudDim
    val background = if (on) HudColors.Lume.copy(alpha = 0.16f) else HudColors.PanelElevated
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(background)
            .clickable(onClick = onClick)
            .heightIn(min = 44.dp)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(glyph, fontSize = 13.sp)
        Text(label, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

// ---- optional captions overlay (字幕) -------------------------------------------------

@Composable
private fun CaptionsOverlay(
    items: List<TranscriptItem>,
    canFlag: (TranscriptItem) -> Boolean = { false },
    onFlag: (TranscriptItem, String) -> Unit = { _, _ -> }
) {
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
                    ChatBubble(
                        item = item,
                        time = timeFormat.format(Date(item.at)),
                        flaggable = canFlag(item),
                        onFlag = { reason -> onFlag(item, reason) }
                    )
                }
            }
        }
    }
}

@Composable
private fun ChatBubble(
    item: TranscriptItem,
    time: String,
    flaggable: Boolean = false,
    onFlag: (String) -> Unit = {}
) {
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
                if (item.feedback != null) {
                    Text(
                        text = "⚑ ${item.feedback}",
                        color = HudColors.Danger,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                } else if (flaggable) {
                    // One tap opens the preset reasons — no typing mid-ride.
                    var reasonsOpen by remember { mutableStateOf(false) }
                    Box {
                        Text(
                            text = "有问题?",
                            color = HudColors.Danger.copy(alpha = 0.85f),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .clip(RoundedCornerShape(999.dp))
                                .border(1.dp, HudColors.Danger.copy(alpha = 0.4f), RoundedCornerShape(999.dp))
                                .clickable { reasonsOpen = true }
                                .padding(horizontal = 6.dp, vertical = 2.dp)
                        )
                        DropdownMenu(expanded = reasonsOpen, onDismissRequest = { reasonsOpen = false }) {
                            TURN_FLAG_REASONS.forEach { reason ->
                                DropdownMenuItem(
                                    text = { Text(reason) },
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

// ---- navigation guidance card (mirrors ios/MaxHelmet/Navigation/GuidanceCard.swift) --

/**
 * The live turn-by-turn surface: destination first, the next maneuver
 * dominates (large), then distance-to-maneuver and the remaining trip below.
 * Gated by [isNavPresentationActive] at the call site; `guidance.arrived` is
 * never true here (arrival publishes `navGuidance = null` instead — see
 * NavGuidanceState's doc), so there is no arrived branch to render.
 */
@Composable
private fun GuidanceCard(guidance: NavGuidanceState) {
    HudCard(borderColor = if (guidance.offRoute) HudColors.Amber else Color.Transparent) {
        Row(verticalAlignment = Alignment.Top) {
            Column(modifier = Modifier.weight(1f)) {
                Text(guidance.destinationName, color = HudColors.Muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(2.dp))
                Text(
                    text = guidance.currentInstruction ?: guidance.destinationName,
                    color = HudColors.Text,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "距下一路口 ${formatDistanceMeters(guidance.distanceToManeuverMeters)}",
                    color = HudColors.HudDim,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "剩余 ${formatRemaining(guidance.remainingMeters, guidance.remainingSeconds)}",
                    color = HudColors.Muted,
                    fontSize = 12.sp
                )
            }
            if (guidance.offRoute) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(HudColors.Amber.copy(alpha = 0.2f))
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                ) {
                    Text("已偏离路线", color = HudColors.Amber, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        GuidanceRouteMap(guidance)
    }
}

@Composable
internal fun HudCard(
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
        CompositionLocalProvider(LocalContentColor provides HudColors.Text) { content() }
    }
}

@Composable
private fun SessionReadout(state: AgentSession.State) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(orbCaption(state), color = HudColors.HudInk, fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Text(stateTelltale(state), color = orbColor(state), fontSize = 11.sp,
            fontFamily = FontFamily.Monospace, letterSpacing = 4.sp)
    }
}
