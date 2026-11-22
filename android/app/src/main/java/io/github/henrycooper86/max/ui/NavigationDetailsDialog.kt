package io.github.henrycooper86.max.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.henrycooper86.max.music.MusicController
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorShapes
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorType
import io.github.henrycooper86.max.navigation.NavGuidanceState
import java.text.DateFormat
import java.util.Date
import kotlin.math.ceil

@Composable
fun NavigationDetailsDialog(
    guidance: NavGuidanceState,
    music: MusicController,
    hudCast: io.github.henrycooper86.max.navigation.HudCastClient? = null,
    mapPaused: Boolean = false,
    onDismiss: () -> Unit
) {
    var following by remember { mutableStateOf(true) }
    var showSteps by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        io.github.henrycooper86.max.ui.theme.DialogSystemBars()
        Surface(Modifier.fillMaxSize().safeDrawingPadding(), color = Visor.colors.bg) {
            Column(Modifier.fillMaxSize().padding(VisorSpace.x3), verticalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    VisorButton(tr(Str.MUSIC), { music.chooseMusic() }, style = VisorButtonStyle.GHOST)
                    Text(guidance.destinationName, Modifier.weight(1f), color = Visor.colors.text, style = VisorType.title,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (hudCast != null) HudCastControl(hudCast)
                    VisorButton(tr(Str.COLLAPSE), onDismiss, style = VisorButtonStyle.GHOST)
                }
                BoxWithConstraints(Modifier.weight(1f)) {
                    val stepsHeight = (maxHeight * 0.22f).coerceIn(96.dp, 160.dp)
                    val railWidth = minOf(340.dp, maxWidth * 0.42f)
                    val controls: @Composable () -> Unit = {
                        RidingTripSummary(guidance, showSteps, stepsHeight) { showSteps = !showSteps }
                        MusicPlaybackCard(music, compact = true)
                    }
                    if (maxWidth > maxHeight * 1.2f) {
                        Row(horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                            RidingMap(guidance, following, { following = !following }, Modifier.weight(1f).fillMaxHeight(), mapPaused)
                            Column(Modifier.width(railWidth).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                    RidingManeuver(guidance)
                                    RidingTripSummary(guidance, showSteps) { showSteps = !showSteps }
                                }
                                MusicPlaybackCard(music, compact = true)
                            }
                        }
                    } else {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            RidingManeuver(guidance)
                            RidingMap(guidance, following, { following = !following }, Modifier.height(300.dp).fillMaxWidth(), mapPaused)
                            controls()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RidingMap(guidance: NavGuidanceState, following: Boolean, onToggle: () -> Unit, modifier: Modifier, mapPaused: Boolean) {
    Box(modifier.clip(VisorShapes.card).background(Visor.colors.surface1)) {
        GuidanceRouteMap(guidance, detailed = true, followsRider = following, viewportModifier = Modifier.fillMaxSize(), paused = mapPaused)
        VisorButton(
            if (following) tr(Str.FULL_ROUTE) else tr(Str.FOLLOW_ME), onToggle,
            modifier = Modifier.align(Alignment.TopEnd).padding(VisorSpace.x3)
        )
    }
}

@Composable
private fun RidingManeuver(guidance: NavGuidanceState) {
    val instruction = guidance.currentInstruction ?: tr(Str.DEFAULT_INSTRUCTION)
    val shown = guidance.displayInstruction ?: instruction
    val direction = when {
        instruction.contains("掉头") || instruction.contains("u-turn", true) -> "↶"
        instruction.contains("左") || instruction.contains("left", true) -> "↰"
        instruction.contains("右") || instruction.contains("right", true) -> "↱"
        else -> "↑"
    }
    val c = Visor.colors
    Surface(shape = VisorShapes.card, color = c.surface1) {
        Row(Modifier.fillMaxWidth().padding(VisorSpace.x4), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(VisorSpace.x4)) {
            Text(direction, fontSize = 44.sp, fontWeight = FontWeight.Bold, color = if (guidance.offRoute) c.warn else c.accent)
            Column(Modifier.weight(1f)) {
                Text(if (guidance.offRoute) tr(Str.REROUTING) else tr(Str.DIST_AHEAD, "distance" to formatDistanceMeters(guidance.distanceToManeuverMeters)),
                    color = c.text, style = VisorType.display.copy(fontSize = 32.sp))
                Text(shown, color = c.textSecondary, style = VisorType.title)
            }
        }
    }
}

@Composable
private fun RidingTripSummary(guidance: NavGuidanceState, showSteps: Boolean, stepsHeight: Dp = 160.dp, onToggle: () -> Unit) {
    val c = Visor.colors
    Surface(shape = VisorShapes.card, color = c.surface1) {
        Column(Modifier.fillMaxWidth().padding(VisorSpace.x3), verticalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(tr(Str.MINUTES_LEFT, "n" to ceil(guidance.remainingSeconds / 60).toInt()), style = VisorType.monoLarge, color = c.text)
                    Text(tr(Str.REMAINING_SUFFIX, "distance" to formatDistanceMeters(guidance.remainingMeters)), color = c.textSecondary, style = VisorType.caption)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(System.currentTimeMillis() + (guidance.remainingSeconds * 1000).toLong())), color = c.text, style = VisorType.mono)
                    Text(tr(Str.ETA), color = c.textSecondary, style = VisorType.caption)
                }
                VisorButton(if (showSteps) tr(Str.COLLAPSE) else tr(Str.ROUTE), onToggle, style = VisorButtonStyle.GHOST)
            }
            if (showSteps) {
                VisorDivider()
                Column(Modifier.height(stepsHeight).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
                    val steps = guidance.route?.steps.orEmpty().drop(guidance.maneuverIndex.coerceAtLeast(0))
                    val traveled = ((guidance.route?.distanceMeters ?: 0.0) - guidance.remainingMeters).coerceAtLeast(0.0)
                    if (steps.isEmpty()) Text(tr(Str.NO_STEPS), color = c.textSecondary, style = VisorType.bodySmall)
                    steps.forEach { step ->
                        Text(step.spoken, color = c.text, style = VisorType.bodySmall)
                        Text(tr(Str.FROM_HERE, "distance" to formatDistanceMeters((step.alongRouteMeters - traveled).coerceAtLeast(0.0))), color = c.textTertiary, style = VisorType.monoCaption)
                    }
                }
            }
        }
    }
}
