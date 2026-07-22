package com.horizon.maxhelmet.ui

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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
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
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.ui.theme.HudColors
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
    val accent = when (presentation.mode) {
        MicDockMode.IDLE -> HudColors.Ember
        MicDockMode.CONNECTING -> HudColors.Amber
        MicDockMode.LIVE, MicDockMode.MUTED -> HudColors.Lume
    }
    val shape = RoundedCornerShape(19.dp)
    val keyScale = 1f + motionLevel * 0.04f

    Surface(
        onClick = onClick,
        modifier = Modifier
            .widthIn(max = 300.dp)
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .shadow(
                elevation = (12f + 8f * motionLevel).dp,
                shape = shape,
                ambientColor = accent.copy(alpha = 0.20f + 0.22f * motionLevel),
                spotColor = accent.copy(alpha = 0.20f + 0.22f * motionLevel)
            )
            .semantics {
                contentDescription = presentation.accessibilityLabel
                role = Role.Button
            },
        shape = shape,
        color = Color(0xFF11100E),
        border = BorderStroke(1.dp, accent.copy(alpha = 0.34f + 0.28f * motionLevel))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .background(
                    Brush.verticalGradient(listOf(Color(0x0DFFFFFF), Color.Transparent, Color(0x22110E0D)))
                )
                .padding(start = 8.dp, end = 15.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .graphicsLayer { scaleX = keyScale; scaleY = keyScale }
                    .background(accent.copy(alpha = 0.13f), RoundedCornerShape(13.dp))
                    .border(1.dp, accent.copy(alpha = 0.30f + 0.25f * motionLevel), RoundedCornerShape(13.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = if (presentation.mode == MicDockMode.IDLE) Icons.Filled.Mic else Icons.Filled.Close,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(25.dp)
                )
            }
            Box(Modifier.width(1.dp).height(28.dp).background(Color(0x24C4DAD8)))
            Text(
                text = presentation.label,
                modifier = Modifier.weight(1f),
                color = HudColors.HudInk,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.64.sp
            )
            when (presentation.mode) {
                MicDockMode.MUTED -> Icon(
                    imageVector = Icons.Filled.MicOff,
                    contentDescription = null,
                    tint = HudColors.Amber,
                    modifier = Modifier.size(20.dp)
                )
                MicDockMode.CONNECTING -> VoiceInputMeter(
                    heights = listOf(6f, 12f, 6f),
                    color = HudColors.Amber,
                    level = 0f,
                    phase = if (reduceMotion) null else connectingPhase
                )
                MicDockMode.IDLE, MicDockMode.LIVE -> VoiceInputMeter(
                    heights = micMeterHeights(meterLevel),
                    color = accent,
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

@Composable
internal fun MuteUtilityPill(muted: Boolean, onClick: () -> Unit) {
    val tint = if (muted) HudColors.Amber else HudColors.HudDim
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = if (muted) HudColors.Amber.copy(alpha = 0.16f) else HudColors.PanelElevated
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(
                imageVector = if (muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(16.dp)
            )
            Text(if (muted) "取消静音" else "静音", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        }
    }
}
