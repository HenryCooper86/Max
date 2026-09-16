package com.horizon.maxhelmet.ui

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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.horizon.maxhelmet.music.MusicController
import com.horizon.maxhelmet.ui.theme.HudColors
import com.horizon.maxhelmet.navigation.NavGuidanceState
import java.text.DateFormat
import java.util.Date
import kotlin.math.ceil

@Composable
fun NavigationDetailsDialog(guidance: NavGuidanceState, music: MusicController, onDismiss: () -> Unit) {
    var following by remember { mutableStateOf(true) }
    var showSteps by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { music.chooseMusic() }) { Text("音乐") }
                    Text(guidance.destinationName, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = onDismiss) { Text("收起") }
                }
                BoxWithConstraints(Modifier.weight(1f)) {
                    val largeText = LocalDensity.current.fontScale >= 1.5f
                    val stepsHeight = (maxHeight * 0.22f).coerceIn(96.dp, 160.dp)
                    val railWidth = minOf(340.dp, maxWidth * 0.42f)
                    val controls: @Composable () -> Unit = {
                        RidingTripSummary(guidance, showSteps, stepsHeight) { showSteps = !showSteps }
                        MusicPlaybackCard(music, compact = true)
                    }
                    if (maxWidth > maxHeight * 1.2f) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            RidingMap(guidance, following, { following = !following }, Modifier.weight(1f).fillMaxHeight())
                            Column(Modifier.width(railWidth).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                    RidingManeuver(guidance)
                                    RidingTripSummary(guidance, showSteps) { showSteps = !showSteps }
                                }
                                MusicPlaybackCard(music, compact = true)
                            }
                        }
                    } else if (largeText || maxHeight < 400.dp) {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            RidingManeuver(guidance)
                            RidingMap(guidance, following, { following = !following }, Modifier.height(300.dp).fillMaxWidth())
                            controls()
                        }
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            RidingManeuver(guidance)
                            RidingMap(guidance, following, { following = !following }, Modifier.weight(1f).fillMaxWidth())
                            controls()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RidingMap(guidance: NavGuidanceState, following: Boolean, onToggle: () -> Unit, modifier: Modifier) {
    Box(modifier.clip(RoundedCornerShape(20.dp)).background(MaterialTheme.colorScheme.surfaceContainer)) {
        GuidanceRouteMap(guidance, detailed = true, followsRider = following, viewportModifier = Modifier.fillMaxSize())
        FilledTonalButton(onClick = onToggle, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp).heightIn(min = 48.dp)) {
            Text(if (following) "全程" else "跟随位置")
        }
    }
}

@Composable
private fun RidingManeuver(guidance: NavGuidanceState) {
    val instruction = guidance.currentInstruction ?: "沿路线前往目的地"
    val direction = when {
        instruction.contains("掉头") || instruction.contains("u-turn", true) -> "↶"
        instruction.contains("左") || instruction.contains("left", true) -> "↰"
        instruction.contains("右") || instruction.contains("right", true) -> "↱"
        else -> "↑"
    }
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(direction, fontSize = 44.sp, fontWeight = FontWeight.Bold, color = if (guidance.offRoute) HudColors.Amber else HudColors.Lume)
            Column(Modifier.weight(1f)) {
                Text(if (guidance.offRoute) "重新规划中" else "${formatDistanceMeters(guidance.distanceToManeuverMeters)} 后",
                    style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
                Text(instruction, style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

@Composable
private fun RidingTripSummary(guidance: NavGuidanceState, showSteps: Boolean, stepsHeight: Dp = 160.dp, onToggle: () -> Unit) {
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${ceil(guidance.remainingSeconds / 60).toInt()} 分钟", style = MaterialTheme.typography.titleLarge, color = HudColors.Lume)
                    Text("${formatDistanceMeters(guidance.remainingMeters)} · 剩余", style = MaterialTheme.typography.bodySmall)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(System.currentTimeMillis() + (guidance.remainingSeconds * 1000).toLong())), style = MaterialTheme.typography.titleMedium)
                    Text("预计到达", style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = onToggle) { Text(if (showSteps) "收起" else "路线") }
            }
            if (showSteps) {
                HorizontalDivider()
                Column(Modifier.height(stepsHeight).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val steps = guidance.route?.steps.orEmpty().drop(guidance.maneuverIndex.coerceAtLeast(0))
                    val traveled = ((guidance.route?.distanceMeters ?: 0.0) - guidance.remainingMeters).coerceAtLeast(0.0)
                    if (steps.isEmpty()) Text("暂无更多路口信息，请按当前路线行驶。")
                    steps.forEach { step ->
                        Text(step.instruction, style = MaterialTheme.typography.bodyMedium)
                        Text("距当前位置 ${formatDistanceMeters((step.alongRouteMeters - traveled).coerceAtLeast(0.0))}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
