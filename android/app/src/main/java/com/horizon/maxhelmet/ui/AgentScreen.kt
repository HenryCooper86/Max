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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.drawscope.withTransform
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

/** The glow's hue follows the session: a calm green invites a tap when idle,
 * amber while connecting, then the per-turn ring color once live. */
private fun orbColor(state: AgentSession.State): Color {
    if (!state.handsFree) return HudColors.Accent
    return when (state.connection) {
        ConnectionState.OFFLINE, ConnectionState.DEGRADED -> HudColors.Danger
        ConnectionState.CONNECTING, ConnectionState.PROVIDER -> HudColors.Warn
        // The fused hazard overrides the conversational palette: a rider glancing
        // at the helmet must see danger first, turn state second (HelmetVisual.tsx).
        ConnectionState.RELAY, ConnectionState.READY ->
            if (state.fusedHazard != HazardLevel.NORMAL) hazardColor(state.fusedHazard)
            else ringColor(true, state.turnState)
    }
}

/** The single line under the helmet — the only words on the clean screen. */
private fun orbCaption(state: AgentSession.State): String {
    if (!state.handsFree) return "点按头盔，开始对话"
    if (state.micMuted) return "麦克风已静音"
    val caption = when (state.connection) {
        ConnectionState.READY -> TURN_CAPTIONS.getValue(state.turnState)
        else -> connectionLabel(state.connection)
    }
    // A non-normal fused hazard leads the caption (HAZARD_CAPTIONS in HelmetVisual.tsx).
    val hazardPrefix = HAZARD_CAPTIONS[state.fusedHazard]
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

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HudColors.Background),
        contentAlignment = Alignment.TopCenter
    ) {
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
            StatusPill(state = state)

            state.hazardAlert?.let {
                Spacer(Modifier.height(12.dp))
                HazardBanner(it)
            }

            Spacer(Modifier.weight(1f))

            HelmetVisual(
                color = color,
                turnState = state.turnState,
                voiceLevel = state.voiceLevel,
                dimmed = state.micMuted,
                hazard = if (state.handsFree) state.fusedHazard else HazardLevel.NORMAL,
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
            SheetContent("设置") { SettingsPanel(state, viewModel, onExportTranscript) }
        }
    }
}

// ---- top status pill -----------------------------------------------------------------

@Composable
private fun StatusPill(state: AgentSession.State) {
    val online = state.connection == ConnectionState.READY
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(HudColors.PanelElevated.copy(alpha = 0.7f))
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
        if (state.bluetoothRouted) {
            Text("🎧", fontSize = 11.sp)
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
    onTap: () -> Unit
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

    val shell = remember { svgToPath(HELMET_SHELL) }
    val chin = remember { svgToPath(HELMET_CHIN) }
    val visor = remember { svgToPath(HELMET_VISOR) }

    Canvas(
        modifier = Modifier
            .size(300.dp)
            .alpha(if (dimmed) 0.55f else 1f)
            .clickable(onClick = onTap)
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
                    colors = listOf(Color(0xFF3C5B60), Color(0xFF1E3539), Color(0xFF11252A)),
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
            // Mic + status dots.
            drawCircle(if (listening) HudColors.AccentCyan else HudColors.Muted, radius = 9f, center = Offset(258f, 205f))
            drawCircle(color, radius = 9f, center = Offset(282f, 205f))
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

// ---- secondary controls (字幕 · 设置) ------------------------------------------------

@Composable
private fun SecondaryControls(viewModel: MainViewModel) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        PillToggle(glyph = "💬", label = "字幕", on = viewModel.showCaptions, onClick = viewModel::toggleCaptions)
        Spacer(Modifier.weight(1f))
        PillToggle(glyph = "⚙", label = "设置", on = false, onClick = { viewModel.showPreferences = true })
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
                icon = if (state.micMuted) Icons.Filled.MicOff else Icons.Filled.Mic,
                iconColor = if (state.micMuted) HudColors.Warn else HudColors.Text,
                background = HudColors.PanelElevated,
                label = if (state.micMuted) "取消静音" else "静音",
                onClick = onToggleMute
            )
            CircleControl(
                icon = Icons.Filled.Close,
                iconColor = Color.White,
                background = HudColors.Danger,
                label = "结束",
                onClick = onToggleHandsFree
            )
        }
    } else {
        CircleControl(
            icon = Icons.Filled.Mic,
            iconColor = Color(0xFF07221A),
            background = HudColors.Accent,
            diameter = 76.dp,
            label = "开始",
            onClick = onToggleHandsFree
        )
    }
}

@Composable
private fun CircleControl(
    icon: ImageVector,
    background: Color,
    label: String,
    onClick: () -> Unit,
    iconColor: Color = HudColors.Text,
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
            Icon(
                imageVector = icon,
                contentDescription = label,
                tint = iconColor,
                modifier = Modifier.size(diameter * 0.42f)
            )
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

// ---- settings (voice · connection · demo · diagnostics) ------------------------------

@Composable
private fun SettingsPanel(
    state: AgentSession.State,
    viewModel: MainViewModel,
    onExportTranscript: () -> Unit
) {
    // Rider voice preferences.
    SectionCard("语音") {
        ChipRow(label = "声音") {
            VoiceGender.entries.forEach { gender ->
                HudChip(gender.label, state.voiceGender == gender, { viewModel.setVoiceGender(gender) })
            }
        }
        ChipRow(label = "语气") {
            VoicePersonality.entries.forEach { personality ->
                HudChip(personality.label, state.voicePersonality == personality, { viewModel.setVoicePersonality(personality) })
            }
        }
        ChipRow(label = "模式") {
            RideMode.entries.forEach { mode ->
                HudChip(
                    mode.label,
                    state.rideContext.mode == mode,
                    { viewModel.setRideMode(mode) },
                    selectedColor = if (mode == RideMode.EMERGENCY) HudColors.Danger else HudColors.Accent
                )
            }
        }
    }

    // Server / relay connection.
    SectionCard("连接") {
        if (state.handsFree) {
            Text("当前服务器：${viewModel.relayUrl}", color = HudColors.Muted, fontSize = 12.sp)
            Text("结束免提后可修改服务器地址。", color = HudColors.Muted, fontSize = 11.sp)
        } else {
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
            // Optional shared relay secret, sent as the ?token= query parameter.
            OutlinedTextField(
                value = viewModel.authToken,
                onValueChange = viewModel::updateAuthToken,
                singleLine = true,
                label = { Text("认证令牌（可选）", fontSize = 12.sp) },
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

    // Demo scenarios (ADAS hazard injection).
    SectionCard("演示场景") {
        ChipRow(label = "场景") {
            DemoScenario.entries.forEach { scenario ->
                HudChip(
                    scenario.label,
                    state.rideContext.scenario == scenario,
                    { viewModel.setScenario(scenario) },
                    selectedColor = hazardColor(scenario.hazard)
                )
            }
        }
    }

    // Diagnostics: latency, telemetry, transcript export, raw status.
    SectionCard("诊断") {
        val toneColor = when {
            state.latencyMs < 140 -> HudColors.Accent
            state.latencyMs < 280 -> HudColors.Warn
            else -> HudColors.Danger
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("延迟", color = HudColors.Muted, fontSize = 11.sp)
                Text("${state.latencyMs}ms", color = toneColor, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                HudChip(
                    "导出日志",
                    state.transcript.isNotEmpty(),
                    { if (state.transcript.isNotEmpty()) onExportTranscript() },
                    selectedColor = HudColors.AccentCyan
                )
                HudChip(
                    "清空对话记录",
                    state.transcript.isNotEmpty(),
                    { if (state.transcript.isNotEmpty()) viewModel.clearTranscript() },
                    selectedColor = HudColors.Danger
                )
            }
        }
        state.telemetry?.let {
            Text(
                "ASR ${it.asrMs} · 思考 ${it.thinkMs} · 首音 ${it.firstAudioMs} · 总计 ${it.totalMs}ms",
                color = HudColors.Muted,
                fontSize = 11.sp
            )
        }
        Text(state.statusText, color = HudColors.Muted, fontSize = 12.sp)
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    HudCard {
        Text(title, color = HudColors.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
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
