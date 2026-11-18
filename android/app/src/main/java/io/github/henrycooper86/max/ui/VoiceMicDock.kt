package io.github.henrycooper86.max.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorShapes
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorType
import androidx.compose.foundation.shape.CircleShape
import kotlin.math.PI
import kotlin.math.sin

@Composable
internal fun VoiceMicDock(state: AgentSession.State, onClick: () -> Unit) {
    val presentation = micDockPresentation(state)
    val context = LocalContext.current
    val reduceMotion = Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f
    ) == 0f
    val animatedLevel = remember { Animatable(0f) }

    LaunchedEffect(presentation.displayLevel, presentation.mode, reduceMotion) {
        val target = presentation.displayLevel
        if (reduceMotion || presentation.mode != MicDockMode.LIVE) {
            animatedLevel.snapTo(target)
        } else {
            animatedLevel.animateTo(
                target,
                tween(
                    durationMillis = if (target > animatedLevel.value) 80 else 180,
                    easing = LinearEasing
                )
            )
        }
    }

    val connectingPhase = if (presentation.mode == MicDockMode.CONNECTING && !reduceMotion) {
        val transition = rememberInfiniteTransition(label = "micDockConnecting")
        val phase by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
            label = "micDockConnectingPhase"
        )
        phase
    } else {
        0f
    }

    val meterLevel = if (reduceMotion) presentation.displayLevel else animatedLevel.value
    val motionLevel = if (reduceMotion) 0f else animatedLevel.value
    val c = Visor.colors
    val live = presentation.mode == MicDockMode.LIVE
    // Accent is reserved for the primary action (idle) and the live voice state.
    val (container, content) = when (presentation.mode) {
        MicDockMode.IDLE -> c.accent to c.onAccent
        MicDockMode.CONNECTING -> c.surface2 to c.text
        MicDockMode.LIVE -> c.surface2 to c.text
        MicDockMode.MUTED -> c.surface2 to c.text
    }
    val meterColor = when (presentation.mode) {
        MicDockMode.IDLE -> c.onAccent
        MicDockMode.CONNECTING -> c.textSecondary
        else -> c.accent
    }
    val shape = VisorShapes.pill
    val keyScale = 1f + motionLevel * 0.04f

    Surface(
        onClick = onClick,
        modifier = Modifier
            .widthIn(max = 320.dp)
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .semantics {
                contentDescription = presentation.accessibilityLabel
                role = Role.Button
            },
        shape = shape,
        color = container,
        border = if (presentation.mode == MicDockMode.IDLE) null else BorderStroke(1.dp, if (live) c.accent.copy(alpha = 0.35f + 0.4f * motionLevel) else c.lineStrong)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .padding(start = VisorSpace.x2, end = VisorSpace.x5, top = VisorSpace.x2, bottom = VisorSpace.x2),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3)
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .graphicsLayer { scaleX = keyScale; scaleY = keyScale }
                    .background(if (presentation.mode == MicDockMode.IDLE) c.onAccent.copy(alpha = 0.12f) else if (live) c.accentSoft else c.surface3, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = if (presentation.mode == MicDockMode.IDLE) Icons.Filled.Mic else Icons.Filled.Close,
                    contentDescription = null,
                    tint = if (live) c.accent else content,
                    modifier = Modifier.size(22.dp)
                )
            }
            Text(
                text = presentation.label,
                modifier = Modifier.weight(1f),
                color = content,
                style = VisorType.title
            )
            when (presentation.mode) {
                MicDockMode.MUTED -> Icon(
                    imageVector = Icons.Filled.MicOff,
                    contentDescription = null,
                    tint = c.warn,
                    modifier = Modifier.size(20.dp)
                )
                MicDockMode.CONNECTING -> VoiceInputMeter(
                    heights = listOf(6f, 12f, 6f),
                    color = meterColor,
                    level = 0f,
                    phase = if (reduceMotion) null else connectingPhase
                )
                MicDockMode.IDLE, MicDockMode.LIVE -> VoiceInputMeter(
                    heights = micMeterHeights(meterLevel),
                    color = meterColor,
                    level = meterLevel,
                    phase = null
                )
            }
        }
    }
}

@Composable
private fun VoiceInputMeter(heights: List<Float>, color: Color, level: Float, phase: Float?) {
    Row(
        modifier = Modifier.width(24.dp).height(20.dp).semantics { },
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        heights.forEachIndexed { index, height ->
            val shimmer = phase?.let {
                (0.5 + 0.5 * sin(it * 2 * PI - index * 1.7)).toFloat()
            }
            Box(
                Modifier
                    .width(4.dp)
                    .height(height.dp)
                    .background(
                        color.copy(alpha = shimmer?.let { 0.25f + 0.65f * it } ?: 0.28f + 0.72f * level),
                        RoundedCornerShape(4.dp)
                    )
            )
        }
    }
}
