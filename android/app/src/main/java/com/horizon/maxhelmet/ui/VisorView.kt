package com.horizon.maxhelmet.ui

import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.drawscope.DrawScope
import android.provider.Settings
import kotlin.math.cos
import kotlin.math.max
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.animation.animateColorAsState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.TurnState
import com.horizon.maxhelmet.ui.theme.Visor
import com.horizon.maxhelmet.ui.theme.VisorMotion
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

/** What the visor's waveform line is saying about the session. */
internal enum class VisorMode { IDLE, CONNECTING, LISTENING, THINKING, SPEAKING, OFFLINE }

internal fun visorMode(state: AgentSession.State): VisorMode {
    if (!state.handsFree) return VisorMode.IDLE
    return when (state.connection) {
        ConnectionState.OFFLINE, ConnectionState.DEGRADED -> VisorMode.OFFLINE
        ConnectionState.CONNECTING, ConnectionState.PROVIDER -> VisorMode.CONNECTING
        ConnectionState.RELAY, ConnectionState.READY -> when {
            state.micMuted -> VisorMode.IDLE
            else -> when (state.turnState) {
                TurnState.IDLE -> VisorMode.IDLE
                TurnState.LISTENING, TurnState.HEARING -> VisorMode.LISTENING
                TurnState.THINKING -> VisorMode.THINKING
                TurnState.SPEAKING -> VisorMode.SPEAKING
            }
        }
    }
}

/** Target wave energy 0..1 for a mode; listening follows the mic [level]. */
internal fun visorEnergy(mode: VisorMode, level: Float): Float = when (mode) {
    VisorMode.IDLE -> 0.04f
    VisorMode.CONNECTING -> 0f
    VisorMode.LISTENING -> 0.10f + 0.90f * level.coerceIn(0f, 1f)
    VisorMode.THINKING -> 0.16f
    VisorMode.SPEAKING -> 0.55f + 0.25f * level.coerceIn(0f, 1f)
    VisorMode.OFFLINE -> 0f
}

/**
 * Waveform height (-1..1) at horizontal position [x] (0..1) for the given
 * [energy] and travelling [phase] (0..1). Ends taper to the baseline so the line
 * always sits inside the lens.
 */
internal fun visorWave(x: Float, energy: Float, phase: Float): Float {
    val envelope = sin(PI.toFloat() * x.coerceIn(0f, 1f)).let { it * it }
    val t = phase * 2f * PI.toFloat()
    val body = 0.55f * sin(2f * PI.toFloat() * 2.6f * x - t) +
        0.30f * sin(2f * PI.toFloat() * 5.8f * x + 2f * t + 1.3f) +
        0.15f * sin(2f * PI.toFloat() * 9.7f * x - 3f * t + 0.4f)
    return (energy * envelope * body).coerceIn(-1f, 1f)
}

/** Colour of the live line: accent normally, a hazard colour while a hazard is presented. */
@Composable
internal fun visorTint(state: AgentSession.State): Color {
    val c = Visor.colors
    return when {
        isHazardPresentationActive(state) -> hazardColor(c, state.fusedHazard)
        visorMode(state) == VisorMode.OFFLINE -> c.textTertiary
        visorMode(state) == VisorMode.IDLE -> c.textSecondary
        else -> c.accent
    }
}

/**
 * The hero: a wide capsule lens (about 2.4:1) with a thin rim and a waveform line that
 * reflects the session. Pure Canvas; no blur, glow or multi-colour gradient. The only
 * effect is a faint tinted radial vignette behind it. Tapping toggles hands-free
 * (same semantics as the helmet artwork it replaces).
 */
@Composable
internal fun VisorView(
    mode: VisorMode,
    tint: Color,
    level: Float,
    handsFree: Boolean,
    dimmed: Boolean,
    onTap: () -> Unit,
    width: Dp,
    modifier: Modifier = Modifier,
    style: VoiceStyle = VoiceStyle.WAVE
) {
    val c = Visor.colors
    val metrics = Visor.metrics
    val ease = tween<Float>(VisorMotion.SLOW, easing = VisorMotion.easeOut)
    val tintAnimated by animateColorAsState(tint, tween(VisorMotion.SLOW, easing = VisorMotion.easeOut), label = "visorTint")
    val energy by animateFloatAsState(visorEnergy(mode, level), tween(VisorMotion.FAST, easing = VisorMotion.easeOut), label = "visorEnergy")
    val rimActive by animateFloatAsState(if (mode == VisorMode.IDLE || mode == VisorMode.OFFLINE) 0f else 1f, ease, label = "visorRim")
    val dim by animateFloatAsState(if (mode == VisorMode.OFFLINE) 0.55f else 1f, ease, label = "visorDim")

    val transition = rememberInfiniteTransition(label = "visor")
    val phase by transition.animateFloat(
        0f, 1f, infiniteRepeatable(tween(2600, easing = LinearEasing), RepeatMode.Restart), label = "visorPhase"
    )
    val sweep by transition.animateFloat(
        0f, 1f, infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Restart), label = "visorSweep"
    )
    val breath by transition.animateFloat(
        0f, 1f, infiniteRepeatable(tween(3200, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "visorBreath"
    )
    val pulse by transition.animateFloat(
        0f, 1f, infiniteRepeatable(tween(720, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "visorPulse"
    )

    // Spectrum styles (everything but the wave): one frame clock drives a synthesised spectrum,
    // smoothed with peak caps. With animations off (animator scale 0) a single still frame per
    // state is drawn instead. The clock is read in the draw phase, so frames never recompose.
    val context = LocalContext.current
    val animationsOff = remember {
        runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
    }
    val spectrumMode = spectrumModeOf(mode, handsFree)
    val spectrumModeNow by rememberUpdatedState(spectrumMode)
    val levelNow by rememberUpdatedState(level)
    val target = remember { FloatArray(SPECTRUM_BINS) }
    val display = remember { FloatArray(SPECTRUM_BINS) }
    val peaks = remember { FloatArray(SPECTRUM_BINS) }
    val still = remember { FloatArray(SPECTRUM_BINS) }
    var clock by remember { mutableFloatStateOf(0f) }
    if (style != VoiceStyle.WAVE && !animationsOff) {
        LaunchedEffect(style) {
            var last = 0L
            while (true) {
                withFrameNanos { now ->
                    val dt = if (last == 0L) 1f / 60f else ((now - last) / 1e9f).coerceIn(0f, 0.1f)
                    last = now
                    synthesizeSpectrum(target, spectrumModeNow, levelNow, now / 1e9f)
                    smoothSpectrum(display, target, dt)
                    updatePeaks(peaks, display, dt)
                    clock = now / 1e9f
                }
            }
        }
    }

    val surface = c.surface1
    val rimIdle = c.lineStrong
    val tickColor = c.danger
    val baseline = c.lineStrong

    val interaction = remember { MutableInteractionSource() }
    Canvas(
        modifier = modifier
            .width(width)
            .height(width * 0.6f)
            .alpha(if (dimmed) 0.55f else 1f)
            .semantics { contentDescription = if (handsFree) tr(Str.HF_END) else tr(Str.HF_START) }
            // No ripple: it is drawn as the canvas's rectangle, which shows its
            // corners around a capsule. The lens itself reacts to the tap.
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onTap)
    ) {
        if (style != VoiceStyle.WAVE) clock // read: redraw on every frame of the clock
        val lensW = size.width * 0.84f
        val lensH = lensW / 2.4f
        val left = (size.width - lensW) / 2f
        val top = (size.height - lensH) / 2f
        val cy = size.height / 2f
        val radius = CornerRadius(lensH / 2f, lensH / 2f)

        // The one allowed effect: a faint tinted vignette behind the lens. Drawn
        // as an ellipse that reaches zero alpha exactly at the canvas edge, so
        // no edge of the drawing area can ever show against the background.
        if (mode != VisorMode.OFFLINE && metrics.glow > 0f) {
            val glow = tintAnimated.copy(alpha = 0.10f * metrics.glow * (0.4f + 0.6f * rimActive))
            scale(scaleX = 1f, scaleY = size.height / size.width, pivot = Offset(size.width / 2f, cy)) {
                drawCircle(
                    brush = Brush.radialGradient(
                        0f to glow,
                        0.55f to glow.copy(alpha = glow.alpha * 0.45f),
                        1f to Color.Transparent,
                        center = Offset(size.width / 2f, cy),
                        radius = size.width / 2f
                    ),
                    radius = size.width / 2f,
                    center = Offset(size.width / 2f, cy)
                )
            }
        }

        // Lens body and rim.
        drawRoundRect(surface, Offset(left, top), Size(lensW, lensH), radius)
        val rim = if (rimActive > 0f) tintAnimated.copy(alpha = 0.55f * rimActive) else rimIdle
        drawRoundRect(
            color = if (rimActive > 0f) lerpColor(rimIdle, tintAnimated.copy(alpha = 0.6f), rimActive) else rim,
            topLeft = Offset(left, top),
            size = Size(lensW, lensH),
            cornerRadius = radius,
            style = Stroke(width = 1.5.dp.toPx() * metrics.lineWidth.value)
        )

        // Waveform area, inset from the rim.
        val inset = lensH * 0.42f
        val x0 = left + inset
        val x1 = left + lensW - inset
        val span = x1 - x0
        val amp = lensH * 0.34f
        val stroke = (2.5.dp + (metrics.lineWidth - 1.dp)).toPx()
        val steps = 72

        fun wavePath(e: Float, p: Float): Path = Path().apply {
            for (i in 0..steps) {
                val x = i.toFloat() / steps
                val y = cy - visorWave(x, e, p) * amp
                if (i == 0) moveTo(x0, y) else lineTo(x0 + x * span, y)
            }
        }

        if (style != VoiceStyle.WAVE) {
            val frame = if (animationsOff) synthesizeSpectrum(still, spectrumMode, level, 1.2f) else display
            val caps = if (animationsOff) still else peaks
            val unit = lensW / 480f
            if (style == VoiceStyle.MIRROR) drawLine(baseline, Offset(left, cy), Offset(left + lensW, cy), strokeWidth = 1.5.dp.toPx(), cap = StrokeCap.Round)
            drawSpectrum(style, frame, caps, tintAnimated.copy(alpha = if (mode == VisorMode.OFFLINE) 0.5f else 1f), left, top, unit)
            if (mode == VisorMode.OFFLINE) {
                val tick = lensH * 0.26f
                drawLine(tickColor, Offset((x0 + x1) / 2f, cy - tick), Offset((x0 + x1) / 2f, cy + tick), strokeWidth = stroke, cap = StrokeCap.Round)
            }
        } else when (mode) {
            VisorMode.IDLE -> {
                // Flat line, slowly breathing in weight and brightness.
                val e = energy * (0.6f + 0.4f * breath)
                drawPath(
                    wavePath(e, phase * 0.5f),
                    tintAnimated.copy(alpha = 0.55f + 0.35f * breath),
                    style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
                )
            }
            VisorMode.CONNECTING -> {
                // Dim baseline with a bright window sweeping across it.
                drawLine(baseline, Offset(x0, cy), Offset(x1, cy), strokeWidth = stroke, cap = StrokeCap.Round)
                val head = -0.2f + 1.4f * sweep
                for (i in 0 until steps) {
                    val xm = (i + 0.5f) / steps
                    val d = abs(xm - head)
                    val a = (1f - d / 0.2f).coerceIn(0f, 1f)
                    if (a > 0f) drawLine(
                        tintAnimated.copy(alpha = a),
                        Offset(x0 + i.toFloat() / steps * span, cy),
                        Offset(x0 + (i + 1).toFloat() / steps * span, cy),
                        strokeWidth = stroke, cap = StrokeCap.Butt
                    )
                }
            }
            VisorMode.THINKING -> {
                // Pulse: a low swell that breathes in amplitude and brightness.
                val e = energy * (0.55f + 0.9f * pulse)
                drawPath(
                    wavePath(e, phase * 0.6f),
                    tintAnimated.copy(alpha = 0.45f + 0.55f * pulse),
                    style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
                )
            }
            VisorMode.LISTENING, VisorMode.SPEAKING -> {
                // A fainter echo trails the main line for body.
                drawPath(
                    wavePath(energy * 0.6f, phase + 0.35f),
                    tintAnimated.copy(alpha = 0.28f),
                    style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
                )
                drawPath(
                    wavePath(energy, phase),
                    tintAnimated,
                    style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
                )
            }
            VisorMode.OFFLINE -> {
                drawLine(
                    c.textTertiary.copy(alpha = 0.6f * dim), Offset(x0, cy), Offset(x1, cy),
                    strokeWidth = stroke, cap = StrokeCap.Round
                )
                val tick = lensH * 0.26f
                drawLine(
                    tickColor, Offset((x0 + x1) / 2f, cy - tick), Offset((x0 + x1) / 2f, cy + tick),
                    strokeWidth = stroke, cap = StrokeCap.Round
                )
            }
        }
    }
}

private fun lerpColor(a: Color, b: Color, t: Float): Color = androidx.compose.ui.graphics.lerp(a, b, t.coerceIn(0f, 1f))

// Spectrum geometry in the web's 480x200 lens units (see VisorVisual.tsx): 24 columns 12 units
// apart from x = 96, so the capsule's round ends stay clear.
private const val SPECTRUM_LEFT = 96f
private const val SPECTRUM_STEP = 12f
private const val BAR_WIDTH = 8f
private const val BAR_BASE = 152f
private const val BAR_MAX = 106f
private const val MIRROR_HALF = 66f
private const val MID = 100f
private const val DOT_ROWS = 9
private const val DOT_STEP = 12f
private const val RING_SPOKES = SPECTRUM_BINS * 2
private const val RING_INNER = 36f
private const val RING_REACH = 46f

/** Draws one frame of a spectrum style; [left]/[top] is the lens origin and [u] the pixels per lens unit. */
private fun DrawScope.drawSpectrum(style: VoiceStyle, values: FloatArray, peaks: FloatArray, color: Color, left: Float, top: Float, u: Float) {
    fun px(x: Float) = left + x * u
    fun py(y: Float) = top + y * u
    fun columnX(i: Int) = SPECTRUM_LEFT + i * SPECTRUM_STEP + (SPECTRUM_STEP - BAR_WIDTH) / 2f
    when (style) {
        VoiceStyle.BARS -> for (i in 0 until SPECTRUM_BINS) {
            val h = max(2f, values[i] * BAR_MAX)
            drawRoundRect(color, Offset(px(columnX(i)), py(BAR_BASE - h)), Size(BAR_WIDTH * u, h * u), CornerRadius(2f * u))
            val capY = BAR_BASE - max(2f, peaks[i] * BAR_MAX) - 6f
            drawRoundRect(color.copy(alpha = color.alpha * 0.85f), Offset(px(columnX(i)), py(capY)), Size(BAR_WIDTH * u, 3f * u), CornerRadius(1.5f * u))
        }
        VoiceStyle.MIRROR -> for (i in 0 until SPECTRUM_BINS) {
            val half = max(1f, values[i] * MIRROR_HALF)
            drawRoundRect(color, Offset(px(columnX(i)), py(MID - half)), Size(BAR_WIDTH * u, half * 2f * u), CornerRadius(2f * u))
        }
        VoiceStyle.DOTS -> for (i in 0 until SPECTRUM_BINS) {
            val lit = Math.round(values[i] * DOT_ROWS)
            val peak = minOf(DOT_ROWS - 1, Math.round(peaks[i] * DOT_ROWS) - 1)
            for (row in 0 until DOT_ROWS) {
                val a = if (row < lit) 1f else if (row == peak) 0.7f else 0.14f
                drawCircle(color.copy(alpha = color.alpha * a), 3.6f * u, Offset(px(columnX(i) + BAR_WIDTH / 2f), py(BAR_BASE - 4f - row * DOT_STEP)))
            }
        }
        VoiceStyle.RING -> {
            var sum = 0f
            for (k in 0 until RING_SPOKES) {
                val value = values[if (k < SPECTRUM_BINS) k else RING_SPOKES - 1 - k]
                sum += value
                val angle = k.toFloat() / RING_SPOKES * 2f * PI.toFloat() - PI.toFloat() / 2f
                val outer = RING_INNER + 4f + value * RING_REACH
                drawLine(
                    color, Offset(px(240f + cos(angle) * RING_INNER), py(MID + sin(angle) * RING_INNER)),
                    Offset(px(240f + cos(angle) * outer), py(MID + sin(angle) * outer)),
                    strokeWidth = 3f * u, cap = StrokeCap.Round
                )
            }
            drawCircle(color.copy(alpha = color.alpha * 0.6f), (RING_INNER - 10f + sum / RING_SPOKES * 10f) * u, Offset(px(240f), py(MID)), style = Stroke(2f * u))
        }
        VoiceStyle.WAVE -> Unit
    }
}

/** Preview helper: draws a style with the lens origin at (0,0). */
internal fun DrawScope.drawSpectrumPreview(style: VoiceStyle, values: FloatArray, peaks: FloatArray, color: Color, unit: Float) =
    drawSpectrum(style, values, peaks, color, 0f, 0f, unit)
