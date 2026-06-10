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
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
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

/**
 * Production-clean main screen: brand header, hazard alerts, hero ring,
 * glance strip, conversation, hands-free button. Rider preferences live behind
 * the gear; all test settings live in a developer panel revealed by
 * long-pressing the Max logo (persisted across launches).
 */
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
            HeaderBar(
                state = state,
                devMode = viewModel.devMode,
                preferencesShown = viewModel.showPreferences,
                onToggleDevMode = viewModel::toggleDevMode,
                onTogglePreferences = viewModel::togglePreferences
            )
            Spacer(Modifier.height(12.dp))

            state.hazardAlert?.let {
                HazardBanner(it)
                Spacer(Modifier.height(12.dp))
            }

            // Everything except the header and the hands-free button scrolls.
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                AnimatedVisibility(visible = viewModel.showPreferences) {
                    PreferencesPanel(state, viewModel)
                }

                TurnStateRing(
                    state,
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .padding(top = 6.dp),
                    onToggle = onToggleHandsFree
                )

                GlanceStrip(state)

                if (state.transcript.isEmpty()) {
                    Text(
                        text = "点按 Max 圆环开始对话",
                        color = HudColors.Muted,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                } else {
                    ConversationCard(state.transcript)
                }

                AnimatedVisibility(visible = viewModel.devMode) {
                    DevPanel(state, viewModel, onExportTranscript)
                }
            }

            Spacer(Modifier.height(10.dp))
            HandsFreeButton(handsFree = state.handsFree, onClick = onToggleHandsFree)
        }
    }
}

// ---- header ----------------------------------------------------------------

@Composable
private fun HeaderBar(
    state: AgentSession.State,
    devMode: Boolean,
    preferencesShown: Boolean,
    onToggleDevMode: () -> Unit,
    onTogglePreferences: () -> Unit
) {
    val haptics = LocalHapticFeedback.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Hidden gesture: long-press the logo to toggle the developer panel.
        Column(
            modifier = Modifier.pointerInput(Unit) {
                detectTapGestures(onLongPress = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onToggleDevMode()
                })
            }
        ) {
            Text("Max", color = HudColors.Text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(
                text = if (devMode) "摩托车头盔 AI · 开发者模式" else "摩托车头盔 AI",
                color = if (devMode) HudColors.AccentCyan else HudColors.Muted,
                fontSize = 12.sp
            )
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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
                if (devMode) {
                    val providerLabel = when {
                        state.provider.isEmpty() -> "未连接"
                        state.isLive -> "豆包实时语音"
                        else -> "模拟语音"
                    }
                    val bluetooth = if (state.bluetoothRouted) " · 蓝牙耳机" else ""
                    val latency = if (state.latencyMs > 0) " · ${state.latencyMs}ms" else ""
                    Text(providerLabel + bluetooth + latency, color = HudColors.Muted, fontSize = 11.sp)
                } else if (state.bluetoothRouted) {
                    Text("蓝牙耳机", color = HudColors.Muted, fontSize = 11.sp)
                }
            }

            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(HudColors.PanelElevated)
                    .clickable(onClick = onTogglePreferences),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "⚙",
                    color = if (preferencesShown) HudColors.Accent else HudColors.Muted,
                    fontSize = 18.sp
                )
            }
        }
    }
}

// ---- rider preferences (gear) -------------------------------------------------

@Composable
private fun PreferencesPanel(state: AgentSession.State, viewModel: MainViewModel) {
    HudCard {
        Text("偏好设置", color = HudColors.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ChipRow(label = "声音") {
                VoiceGender.entries.forEach { gender ->
                    HudChip(
                        label = gender.label,
                        selected = state.voiceGender == gender,
                        onClick = { viewModel.setVoiceGender(gender) }
                    )
                }
            }
            ChipRow(label = "语气") {
                VoicePersonality.entries.forEach { personality ->
                    HudChip(
                        label = personality.label,
                        selected = state.voicePersonality == personality,
                        onClick = { viewModel.setVoicePersonality(personality) }
                    )
                }
            }
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

// ---- hero ring -----------------------------------------------------------------

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
                .size(210.dp)
                .clip(CircleShape)
                .clickable(onClick = onToggle),
            contentAlignment = Alignment.Center
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                // DrawScope.center is the middle of the drawing area.
                val baseRadius = size.minDimension * 0.36f

                // Soft outer glow ring, breathing with the pulse animation.
                drawCircle(
                    color = color.copy(alpha = 0.10f + 0.10f * pulse),
                    radius = baseRadius + 22.dp.toPx() * (0.6f + 0.4f * pulse),
                    center = center
                )
                // Voice-level ring: expands as the rider speaks.
                drawCircle(
                    color = color.copy(alpha = 0.35f),
                    radius = baseRadius + 16.dp.toPx() * state.voiceLevel,
                    center = center,
                    style = Stroke(width = 2.dp.toPx())
                )
                // Main state ring.
                drawCircle(
                    color = color,
                    radius = baseRadius,
                    center = center,
                    style = Stroke(width = 3.5.dp.toPx())
                )
                // Inner fill.
                drawCircle(
                    color = color.copy(alpha = 0.08f),
                    radius = baseRadius - 3.dp.toPx(),
                    center = center
                )
            }
            Text(
                text = if (state.handsFree) "免提中" else "Max",
                color = color,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold
            )
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(color)
            )
            Spacer(Modifier.width(6.dp))
            Text(caption, color = HudColors.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        }
    }
}

// ---- ADAS hazard banner ---------------------------------------------------------

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

// ---- glance strip (speed · risk · weather · battery) ------------------------------

@Composable
private fun GlanceStrip(state: AgentSession.State) {
    val fused = state.fusedHazard
    val context = state.rideContext
    val weather = state.weather

    HudCard {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            GlanceCell(value = "${context.speedKmh}", unit = "km/h", label = "速度")
            GlanceCell(value = fused.label, label = "风险", valueColor = hazardColor(fused))
            if (weather != null) {
                GlanceCell(value = "${weather.temperatureC}°", label = weather.description)
            } else {
                GlanceCell(value = "--", label = "天气")
            }
            GlanceCell(value = "${context.batteryPct}%", label = "电量")
        }

        if (fused != HazardLevel.NORMAL) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = fused.riderAction,
                color = hazardColor(fused),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold
            )
        }
        if (weather != null && weather.riskLevel != HazardLevel.NORMAL) {
            Spacer(Modifier.height(2.dp))
            Text(weather.riderAdvice, color = HudColors.Muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun GlanceCell(
    value: String,
    label: String,
    unit: String = "",
    valueColor: Color = HudColors.Text
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(value, color = valueColor, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            if (unit.isNotEmpty()) {
                Spacer(Modifier.width(2.dp))
                Text(unit, color = HudColors.Muted, fontSize = 10.sp, modifier = Modifier.padding(bottom = 2.dp))
            }
        }
        Text(label, color = HudColors.Muted, fontSize = 11.sp, maxLines = 1)
    }
}

// ---- conversation -----------------------------------------------------------------

@Composable
private fun ConversationCard(items: List<TranscriptItem>) {
    val listState = rememberLazyListState()
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

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
            Text("对话", color = HudColors.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text("${items.size}", color = HudColors.Muted, fontSize = 11.sp)
        }
        Spacer(Modifier.height(8.dp))
        LazyColumn(
            state = listState,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(250.dp)
        ) {
            items(items, key = { it.id }) { item ->
                ChatBubble(item = item, time = timeFormat.format(Date(item.at)))
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

// ---- developer panel (long-press the logo) -------------------------------------------

@Composable
private fun DevPanel(
    state: AgentSession.State,
    viewModel: MainViewModel,
    onExportTranscript: () -> Unit
) {
    HudCard(borderColor = HudColors.AccentCyan.copy(alpha = 0.4f)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("开发者模式", color = HudColors.AccentCyan, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            HudChip(
                label = "导出日志",
                selected = state.transcript.isNotEmpty(),
                onClick = { if (state.transcript.isNotEmpty()) onExportTranscript() },
                selectedColor = HudColors.AccentCyan
            )
        }
        Spacer(Modifier.height(6.dp))

        Text(state.statusText, color = HudColors.Muted, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))

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
        Spacer(Modifier.height(8.dp))

        // latencyTone in src/main.tsx: <140 good, <280 warn, else alert.
        val toneColor = when {
            state.latencyMs < 140 -> HudColors.Accent
            state.latencyMs < 280 -> HudColors.Warn
            else -> HudColors.Danger
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("延迟", color = HudColors.Muted, fontSize = 11.sp)
            Text("${state.latencyMs}ms", color = toneColor, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            state.telemetry?.let {
                Text(
                    "ASR ${it.asrMs} · 思考 ${it.thinkMs} · 首音 ${it.firstAudioMs} · 总计 ${it.totalMs}ms",
                    color = HudColors.Muted,
                    fontSize = 11.sp
                )
            }
        }

        // Connection settings: editable only while disconnected.
        if (!state.handsFree) {
            Spacer(Modifier.height(8.dp))
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
}

// ---- hands-free button ----------------------------------------------------------

@Composable
private fun HandsFreeButton(handsFree: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (handsFree) HudColors.Danger else HudColors.Accent,
            contentColor = if (handsFree) HudColors.Text else Color(0xFF07221A)
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            if (handsFree) "结束免提" else "开启免提",
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(vertical = 7.dp)
        )
    }
}

// ---- shared card scaffolding -------------------------------------------------------

@Composable
private fun HudCard(
    borderColor: Color = Color.Transparent,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(HudColors.Panel)
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
