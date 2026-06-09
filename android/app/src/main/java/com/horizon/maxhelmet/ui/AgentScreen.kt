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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
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
import com.horizon.maxhelmet.agent.Telemetry
import com.horizon.maxhelmet.agent.TranscriptItem
import com.horizon.maxhelmet.agent.TurnState
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.VoicePersonality
import com.horizon.maxhelmet.agent.Weather
import com.horizon.maxhelmet.agent.networkLabel
import com.horizon.maxhelmet.agent.responseModeLabel
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

@Composable
fun AgentScreen(
    viewModel: MainViewModel,
    onToggleHandsFree: () -> Unit,
    onExportTranscript: () -> Unit
) {
    val state by viewModel.sessionState.collectAsStateWithLifecycle()

    // Cap the HUD width and center it so it reads as a phone-width column on wide
    // tablet screens instead of stretching edge-to-edge. Phones are narrower than
    // the cap, so they are unaffected. Mirrors the web's centered, max-width shell.
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HudColors.Background),
        contentAlignment = Alignment.TopCenter
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 560.dp)
                .fillMaxHeight()
                .padding(horizontal = 16.dp, vertical = 12.dp)
        ) {
            HeaderBar(state)
        Spacer(Modifier.height(10.dp))

        state.hazardAlert?.let {
            HazardBanner(it)
            Spacer(Modifier.height(10.dp))
        }

        // Everything except the header and the hands-free button scrolls.
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            RiderControls(state, viewModel)
            TurnStateRing(
                state,
                modifier = Modifier.align(Alignment.CenterHorizontally),
                onToggle = onToggleHandsFree
            )
            Text(
                text = state.statusText,
                color = HudColors.Muted,
                fontSize = 13.sp,
                modifier = Modifier.align(Alignment.CenterHorizontally)
            )
            RidePulseCard(state)
            state.weather?.let { WeatherCard(it) }
            TelemetryCard(state.latencyMs, state.telemetry)
            TranscriptCard(state.transcript, onExportTranscript)
        }

        Spacer(Modifier.height(10.dp))
        BottomControls(
            state = state,
            relayUrl = viewModel.relayUrl,
            allowSelfSigned = viewModel.allowSelfSigned,
            onRelayUrlChange = viewModel::updateRelayUrl,
            onAllowSelfSignedChange = viewModel::updateAllowSelfSigned,
            onToggleHandsFree = onToggleHandsFree
        )
        }
    }
}

// ---- header ----------------------------------------------------------------

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
                Spacer(Modifier.width(6.dp))
                Text(connectionLabel(state.connection), color = HudColors.Text, fontSize = 13.sp)
            }
            val providerLabel = when {
                state.provider.isEmpty() -> "未连接"
                state.isLive -> "豆包实时语音"
                else -> "模拟语音"
            }
            val bluetooth = if (state.bluetoothRouted) " · 蓝牙耳机" else ""
            val latency = if (state.latencyMs > 0) " · ${state.latencyMs}ms" else ""
            Text(providerLabel + bluetooth + latency, color = HudColors.Muted, fontSize = 11.sp)
        }
    }
}

// ---- rider controls (voice / personality / mode / scenario) -----------------

@Composable
private fun RiderControls(state: AgentSession.State, viewModel: MainViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // 声音 + 语气, like the web topbar voiceToggle groups.
        ChipRow(label = "声音") {
            VoiceGender.entries.forEach { gender ->
                HudChip(
                    label = gender.label,
                    selected = state.voiceGender == gender,
                    onClick = { viewModel.setVoiceGender(gender) }
                )
            }
            Spacer(Modifier.width(10.dp))
            VoicePersonality.entries.forEach { personality ->
                HudChip(
                    label = personality.label,
                    selected = state.voicePersonality == personality,
                    onClick = { viewModel.setVoicePersonality(personality) }
                )
            }
        }
        // 骑行模式, like the web modeToggle group.
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
        // 演示场景, like the web scenarioStrip.
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
    val background = if (selected) selectedColor.copy(alpha = 0.18f) else Color.Transparent
    val border = if (selected) selectedColor else HudColors.Border
    val textColor = if (selected) selectedColor else HudColors.Muted
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .border(1.dp, border, RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Text(label, color = textColor, fontSize = 13.sp)
    }
}

// ---- helmet ring -------------------------------------------------------------

@Composable
private fun TurnStateRing(
    state: AgentSession.State,
    modifier: Modifier = Modifier,
    onToggle: () -> Unit = {}
) {
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
        // Tapping the big ring toggles hands-free — the gesture riders reach for first.
        Box(
            modifier = Modifier
                .size(170.dp)
                .clip(CircleShape)
                .clickable(onClick = onToggle),
            contentAlignment = Alignment.Center
        ) {
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
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold
            )
        }
        Spacer(Modifier.height(2.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(color)
            )
            Spacer(Modifier.width(6.dp))
            Text(caption, color = HudColors.Text, fontSize = 15.sp)
        }
    }
}

// ---- 态势摘要 (ride pulse) ----------------------------------------------------

@Composable
private fun HazardBanner(alert: AgentEvent.HazardAlert) {
    val color = hazardColor(alert.severity)
    HudCard(borderColor = color) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(color.copy(alpha = 0.22f))
                    .padding(horizontal = 10.dp, vertical = 8.dp)
            ) {
                Text(alert.directionLabel, color = HudColors.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
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

@Composable
private fun RidePulseCard(state: AgentSession.State) {
    val fused = state.fusedHazard
    val color = hazardColor(fused)
    val context = state.rideContext
    val memory = state.sessionMemory

    HudCard(borderColor = color.copy(alpha = 0.5f)) {
        CardHeader(title = "态势摘要", value = fused.label, valueColor = color)
        Spacer(Modifier.height(6.dp))
        Text(fused.riderAction, color = HudColors.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        Text(context.glanceableFocus, color = HudColors.Muted, fontSize = 12.sp)
        Spacer(Modifier.height(10.dp))

        // Pulse grid: 模式 / 场景 / 网络 / 电量, like .pulseGrid on the web.
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            PulseCell(context.mode.label, "模式")
            PulseCell(context.scenario.label, "场景")
            PulseCell(networkLabel(context.network), "网络")
            PulseCell("${context.batteryPct}%", "电量")
        }
        Spacer(Modifier.height(10.dp))

        // 骑行情报: speed, route phase, session memory chips.
        Row(verticalAlignment = Alignment.Bottom) {
            Text("${context.speedKmh}", color = HudColors.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(4.dp))
            Text("km/h", color = HudColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(bottom = 3.dp))
            Spacer(Modifier.width(12.dp))
            Text(context.routePhase, color = HudColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(bottom = 3.dp))
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MemoryChip(if (memory.language == "zh") "中文" else "English")
            MemoryChip(responseModeLabel(memory.responseMode))
            MemoryChip(memory.lastIntent ?: "待识别")
            memory.destination?.let { MemoryChip(it) }
        }
    }
}

@Composable
private fun PulseCell(value: String, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = HudColors.Text, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(label, color = HudColors.Muted, fontSize = 11.sp)
    }
}

@Composable
private fun MemoryChip(label: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(HudColors.Border.copy(alpha = 0.3f))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(label, color = HudColors.Muted, fontSize = 11.sp)
    }
}

// ---- weather -----------------------------------------------------------------

@Composable
private fun WeatherCard(weather: Weather) {
    val riskColor = hazardColor(weather.riskLevel)
    HudCard {
        CardHeader(title = "实时天气", value = weather.riskLevel.label, valueColor = riskColor)
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text("${weather.temperatureC}°", color = HudColors.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(8.dp))
            Text(weather.description, color = HudColors.Text, fontSize = 14.sp, modifier = Modifier.padding(bottom = 3.dp))
            Spacer(Modifier.width(12.dp))
            Text(
                "风速 ${weather.windSpeedKmh} km/h",
                color = HudColors.Muted,
                fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 3.dp)
            )
        }
        Spacer(Modifier.height(4.dp))
        Text(weather.riderAdvice, color = HudColors.Muted, fontSize = 12.sp)
    }
}

// ---- telemetry ----------------------------------------------------------------

@Composable
private fun TelemetryCard(latencyMs: Int, telemetry: Telemetry?) {
    // latencyTone in src/main.tsx: <140 good, <280 warn, else alert.
    val toneColor = when {
        latencyMs < 140 -> HudColors.Accent
        latencyMs < 280 -> HudColors.Warn
        else -> HudColors.Danger
    }
    HudCard {
        CardHeader(title = "延迟", value = "${latencyMs}ms", valueColor = toneColor)
        if (telemetry != null) {
            Spacer(Modifier.height(8.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                PulseCell("${telemetry.asrMs}ms", "ASR")
                PulseCell("${telemetry.thinkMs}ms", "思考")
                PulseCell("${telemetry.firstAudioMs}ms", "首音")
                PulseCell("${telemetry.totalMs}ms", "总计")
            }
        }
    }
}

// ---- transcript ----------------------------------------------------------------

@Composable
private fun TranscriptCard(items: List<TranscriptItem>, onExportTranscript: () -> Unit) {
    val listState = rememberLazyListState()
    val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    // Keep the latest turn in view as the conversation grows.
    LaunchedEffect(items.size, items.lastOrNull()?.text) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.lastIndex)
    }

    HudCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("对话记录", color = HudColors.Muted, fontSize = 12.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (items.isNotEmpty()) {
                    Text("实时 · ${items.size}", color = HudColors.Muted, fontSize = 11.sp)
                }
                // 导出日志, like the web transcript panel action.
                HudChip(
                    label = "导出日志",
                    selected = items.isNotEmpty(),
                    onClick = { if (items.isNotEmpty()) onExportTranscript() },
                    selectedColor = HudColors.AccentCyan
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        if (items.isEmpty()) {
            Text("开启免提后，对话会显示在这里。", color = HudColors.Muted, fontSize = 13.sp)
        } else {
            LazyColumn(
                state = listState,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(240.dp)
            ) {
                items(items, key = { it.id }) { item ->
                    val speakerColor = if (item.speaker == Speaker.RIDER) HudColors.Rider else HudColors.Accent
                    val speakerLabel = if (item.speaker == Speaker.RIDER) "骑手" else "Max"
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(speakerLabel, color = speakerColor, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.width(8.dp))
                            Text(timeFormat.format(Date(item.at)), color = HudColors.Muted, fontSize = 10.sp)
                            if (!item.final) {
                                Spacer(Modifier.width(8.dp))
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

// ---- bottom controls -------------------------------------------------------------

@Composable
private fun BottomControls(
    state: AgentSession.State,
    relayUrl: String,
    allowSelfSigned: Boolean,
    onRelayUrlChange: (String) -> Unit,
    onAllowSelfSignedChange: (Boolean) -> Unit,
    onToggleHandsFree: () -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Connection settings: editable only while disconnected.
        if (!state.handsFree) {
            OutlinedTextField(
                value = relayUrl,
                onValueChange = onRelayUrlChange,
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
                    checked = allowSelfSigned,
                    onCheckedChange = onAllowSelfSignedChange,
                    colors = SwitchDefaults.colors(
                        checkedTrackColor = HudColors.Accent,
                        checkedThumbColor = Color(0xFF07221A)
                    )
                )
            }
        }

        // The one hands-free toggle, like 开启免提 / 结束免提 on the web HUD.
        Button(
            onClick = onToggleHandsFree,
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (state.handsFree) HudColors.Danger else HudColors.Accent,
                contentColor = if (state.handsFree) HudColors.Text else Color(0xFF07221A)
            ),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                if (state.handsFree) "结束免提" else "开启免提",
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(vertical = 4.dp)
            )
        }
    }
}

// ---- shared card scaffolding -------------------------------------------------------

@Composable
private fun HudCard(
    borderColor: Color = HudColors.Border,
    content: @Composable () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(HudColors.Panel)
            .border(1.dp, borderColor, RoundedCornerShape(12.dp))
            .padding(14.dp)
    ) {
        content()
    }
}

@Composable
private fun CardHeader(title: String, value: String, valueColor: Color) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(title, color = HudColors.Muted, fontSize = 12.sp)
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.Bold)
    }
}
