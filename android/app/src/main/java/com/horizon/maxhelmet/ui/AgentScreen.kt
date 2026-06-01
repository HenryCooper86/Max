package com.horizon.maxhelmet.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.Speaker
import com.horizon.maxhelmet.agent.TranscriptItem
import com.horizon.maxhelmet.agent.TurnState
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.Weather
import com.horizon.maxhelmet.ui.theme.HudColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Captions and ring palette ported from src/components/HelmetVisual.tsx.
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

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.OFFLINE -> "离线"
    ConnectionState.CONNECTING -> "连接中"
    ConnectionState.RELAY -> "中继已连接"
    ConnectionState.PROVIDER -> "接入语音服务"
    ConnectionState.READY -> "在线"
    ConnectionState.DEGRADED -> "连接异常"
}

@Composable
fun AgentScreen(viewModel: MainViewModel, onToggleHandsFree: () -> Unit) {
    val state by viewModel.sessionState.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(HudColors.Background)
            .padding(horizontal = 20.dp, vertical = 16.dp)
    ) {
        HeaderBar(state)
        Spacer(Modifier.height(16.dp))
        TurnStateRing(state, modifier = Modifier.align(Alignment.CenterHorizontally))
        Spacer(Modifier.height(12.dp))
        Text(
            text = state.statusText,
            color = HudColors.Muted,
            fontSize = 13.sp,
            modifier = Modifier.align(Alignment.CenterHorizontally)
        )
        state.weather?.let { weather ->
            Spacer(Modifier.height(14.dp))
            WeatherCard(weather)
        }
        Spacer(Modifier.height(14.dp))
        TranscriptList(state.transcript, modifier = Modifier.weight(1f))
        Spacer(Modifier.height(14.dp))
        Controls(
            state = state,
            relayUrl = viewModel.relayUrl,
            onRelayUrlChange = viewModel::updateRelayUrl,
            onVoiceGender = viewModel::setVoiceGender,
            onToggleHandsFree = onToggleHandsFree
        )
    }
}

@Composable
private fun HeaderBar(state: AgentSession.State) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text("MAX", color = HudColors.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("摩托车头盔 AI", color = HudColors.Muted, fontSize = 12.sp)
        }
        Column(horizontalAlignment = Alignment.End) {
            val online = state.connection == ConnectionState.READY
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (online) HudColors.Accent else HudColors.Muted)
                )
                Spacer(Modifier.padding(horizontal = 3.dp))
                Text(connectionLabel(state.connection), color = HudColors.Text, fontSize = 13.sp)
            }
            val providerLabel = when {
                state.provider.isEmpty() -> "未连接"
                state.isLive -> "豆包实时语音"
                else -> "模拟语音"
            }
            val latency = if (state.latencyMs > 0) " · ${state.latencyMs}ms" else ""
            Text(providerLabel + latency, color = HudColors.Muted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun TurnStateRing(state: AgentSession.State, modifier: Modifier = Modifier) {
    val connected = state.connection != ConnectionState.OFFLINE && state.connection != ConnectionState.DEGRADED
    val color = ringColor(connected, state.turnState)
    val caption = if (connected) TURN_CAPTIONS.getValue(state.turnState) else "离线"

    val pulse by rememberInfiniteTransition(label = "ring-pulse").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1600, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "ring-pulse"
    )

    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(modifier = Modifier.size(190.dp), contentAlignment = Alignment.Center) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                // DrawScope.center is the middle of the drawing area.
                val baseRadius = size.minDimension * 0.36f

                // Soft outer glow ring, breathing with the pulse animation.
                drawCircle(
                    color = color.copy(alpha = 0.12f + 0.10f * pulse),
                    radius = baseRadius + 18.dp.toPx() * (0.6f + 0.4f * pulse),
                    center = center
                )
                // Voice-level ring: expands as the rider speaks.
                drawCircle(
                    color = color.copy(alpha = 0.35f),
                    radius = baseRadius + 14.dp.toPx() * state.voiceLevel,
                    center = center,
                    style = Stroke(width = 2.dp.toPx())
                )
                // Main state ring.
                drawCircle(
                    color = color,
                    radius = baseRadius,
                    center = center,
                    style = Stroke(width = 4.dp.toPx())
                )
                // Inner fill.
                drawCircle(
                    color = color.copy(alpha = 0.10f),
                    radius = baseRadius - 3.dp.toPx(),
                    center = center
                )
            }
            Text(
                text = if (state.handsFree) "免提中" else "MAX",
                color = color,
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold
            )
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(color)
            )
            Spacer(Modifier.padding(horizontal = 3.dp))
            Text(caption, color = HudColors.Text, fontSize = 15.sp)
        }
    }
}

@Composable
private fun WeatherCard(weather: Weather) {
    val riskColor = when (weather.riskLevel) {
        "critical" -> HudColors.Danger
        "caution" -> HudColors.Warn
        else -> HudColors.Accent
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(HudColors.Panel)
            .border(1.dp, HudColors.Border, RoundedCornerShape(12.dp))
            .padding(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "${weather.description} · ${weather.temperatureC}°C · 风速 ${weather.windSpeedKmh} km/h",
                color = HudColors.Text,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )
            Box(
                modifier = Modifier
                    .size(9.dp)
                    .clip(CircleShape)
                    .background(riskColor)
            )
        }
        Spacer(Modifier.height(4.dp))
        Text(weather.riderAdvice, color = HudColors.Muted, fontSize = 12.sp)
    }
}

@Composable
private fun TranscriptList(items: List<TranscriptItem>, modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()
    val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    // Keep the latest turn in view as the conversation grows.
    LaunchedEffect(items.size, items.lastOrNull()?.text) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.lastIndex)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(HudColors.Panel)
            .border(1.dp, HudColors.Border, RoundedCornerShape(12.dp))
            .padding(12.dp)
    ) {
        Text("对话记录", color = HudColors.Muted, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        if (items.isEmpty()) {
            Text("开启免提后，对话会显示在这里。", color = HudColors.Muted, fontSize = 13.sp)
        } else {
            LazyColumn(state = listState, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(items, key = { it.id }) { item ->
                    val speakerColor = if (item.speaker == Speaker.RIDER) HudColors.Rider else HudColors.Accent
                    val speakerLabel = if (item.speaker == Speaker.RIDER) "骑手" else "Max"
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(speakerLabel, color = speakerColor, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.padding(horizontal = 4.dp))
                            Text(timeFormat.format(Date(item.at)), color = HudColors.Muted, fontSize = 10.sp)
                            if (!item.final) {
                                Spacer(Modifier.padding(horizontal = 4.dp))
                                Text("…", color = HudColors.Muted, fontSize = 12.sp)
                            }
                        }
                        Text(item.text, color = HudColors.Text, fontSize = 14.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun Controls(
    state: AgentSession.State,
    relayUrl: String,
    onRelayUrlChange: (String) -> Unit,
    onVoiceGender: (VoiceGender) -> Unit,
    onToggleHandsFree: () -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        // Relay address: editable only while disconnected.
        OutlinedTextField(
            value = relayUrl,
            onValueChange = onRelayUrlChange,
            enabled = !state.handsFree,
            singleLine = true,
            label = { Text("语音中继地址", fontSize = 12.sp) },
            textStyle = MaterialTheme.typography.bodySmall.copy(color = HudColors.Text),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = HudColors.AccentCyan,
                unfocusedBorderColor = HudColors.Border,
                disabledBorderColor = HudColors.Border,
                disabledTextColor = HudColors.Muted,
                focusedLabelColor = HudColors.AccentCyan,
                unfocusedLabelColor = HudColors.Muted
            ),
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(10.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // 女声 / 男声 toggle — switching mid-session restarts the realtime session.
            VoiceGender.entries.forEach { gender ->
                val selected = state.voiceGender == gender
                OutlinedButton(
                    onClick = { onVoiceGender(gender) },
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        containerColor = if (selected) HudColors.Accent.copy(alpha = 0.18f) else Color.Transparent,
                        contentColor = if (selected) HudColors.Accent else HudColors.Muted
                    )
                ) {
                    Text(gender.label, fontSize = 13.sp)
                }
            }
            Spacer(Modifier.weight(1f))
            // The one hands-free toggle, like 开启免提 / 结束免提 on the web HUD.
            Button(
                onClick = onToggleHandsFree,
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (state.handsFree) HudColors.Danger else HudColors.Accent,
                    contentColor = if (state.handsFree) HudColors.Text else Color(0xFF07221A)
                )
            ) {
                Text(
                    if (state.handsFree) "结束免提" else "开启免提",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
