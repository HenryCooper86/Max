package com.horizon.maxhelmet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.horizon.maxhelmet.navigation.NavGuidanceState
import java.text.DateFormat
import java.util.Date

@Composable
fun NavigationDetailsDialog(guidance: NavGuidanceState, onDismiss: () -> Unit) {
    var following by remember { mutableStateOf(true) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.fillMaxSize().padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("详细导航", style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onDismiss) { Text("收起") }
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(if (guidance.offRoute) "偏离路线，正在重新规划…" else "${formatDistanceMeters(guidance.distanceToManeuverMeters)} 后", style = MaterialTheme.typography.headlineMedium)
                    Text(guidance.currentInstruction ?: "沿路线前往目的地", style = MaterialTheme.typography.titleLarge)
                    Text("前往 ${guidance.destinationName}", style = MaterialTheme.typography.titleMedium)
                    Text("剩余 ${formatRemaining(guidance.remainingMeters, guidance.remainingSeconds)} · ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(System.currentTimeMillis() + (guidance.remainingSeconds * 1000).toLong()))} 到达")
                    GuidanceRouteMap(guidance, detailed = true, followsRider = following)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        FilterChip(selected = following, onClick = { following = true }, label = { Text("跟随位置") })
                        FilterChip(selected = !following, onClick = { following = false }, label = { Text("全程 · 自由浏览") })
                    }
                    Text(if (following) "地图随位置更新，显示附近道路和下一路口。" else "可缩放、拖动地图，点击标记查看说明。", style = MaterialTheme.typography.bodySmall)
                    Text("接下来的路线", style = MaterialTheme.typography.titleLarge)
                    val steps = guidance.route?.steps.orEmpty().drop(guidance.maneuverIndex.coerceAtLeast(0))
                    if (steps.isEmpty()) Text("暂无更多路口信息，请按当前路线行驶。")
                    val traveled = ((guidance.route?.distanceMeters ?: 0.0) - guidance.remainingMeters).coerceAtLeast(0.0)
                    steps.forEach { step ->
                        Text(step.instruction, style = MaterialTheme.typography.titleMedium)
                        Text("距当前位置 ${formatDistanceMeters((step.alongRouteMeters - traveled).coerceAtLeast(0.0))}", style = MaterialTheme.typography.bodyMedium)
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
