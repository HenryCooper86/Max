package com.horizon.maxhelmet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.DemoScenario
import com.horizon.maxhelmet.agent.HazardLevel
import com.horizon.maxhelmet.agent.RideMode
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.VoicePersonality
import com.horizon.maxhelmet.agent.responseModeLabel
import com.horizon.maxhelmet.ui.theme.HudColors

// ---- settings sheet scaffold ----------------------------------------------------------

@Composable
internal fun SheetContent(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            // The sections outgrow the sheet on short/landscape screens (e.g.
            // tablets); without this the lower cards are simply unreachable.
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(horizontal = 18.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text(title, color = HudColors.Text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        content()
    }
}

// ---- inline login form (settings → 账号) ----------------------------------------------

@Composable
private fun LoginFields(viewModel: MainViewModel) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Text("使用网页测试平台的账号登录；登录后自动获取会话令牌。", color = HudColors.Muted, fontSize = 11.sp)
    OutlinedTextField(
        value = username,
        onValueChange = { username = it },
        singleLine = true,
        label = { Text("用户名", fontSize = 12.sp) },
        textStyle = MaterialTheme.typography.bodySmall.copy(color = HudColors.Text),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = HudColors.AccentCyan,
            unfocusedBorderColor = HudColors.Border,
            focusedLabelColor = HudColors.AccentCyan,
            unfocusedLabelColor = HudColors.Muted
        ),
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        singleLine = true,
        label = { Text("密码", fontSize = 12.sp) },
        visualTransformation = PasswordVisualTransformation(),
        textStyle = MaterialTheme.typography.bodySmall.copy(color = HudColors.Text),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = HudColors.AccentCyan,
            unfocusedBorderColor = HudColors.Border,
            focusedLabelColor = HudColors.AccentCyan,
            unfocusedLabelColor = HudColors.Muted
        ),
        modifier = Modifier.fillMaxWidth()
    )
    viewModel.loginError?.let { error ->
        Text(error, color = HudColors.Danger, fontSize = 12.sp)
    }
    Button(
        onClick = {
            // Not cleared eagerly: on failure the rider shouldn't retype it;
            // on success this form leaves composition (state discarded) anyway.
            viewModel.login(username, password)
        },
        enabled = !viewModel.loginBusy,
        colors = ButtonDefaults.buttonColors(containerColor = HudColors.Accent),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(if (viewModel.loginBusy) "登录中…" else "登录", color = Color(0xFF07221A), fontSize = 14.sp)
    }
}

// ---- settings (account · voice · connection · demo · diagnostics) ---------------------

@Composable
internal fun SettingsPanel(
    state: AgentSession.State,
    viewModel: MainViewModel,
    onExportTranscript: () -> Unit
) {
    // Account: sign in with the same username/password as the web HUD; the
    // session token then rides the /agent URL automatically. The manual
    // 认证令牌 field below stays as the operator fallback.
    SectionCard("账号") {
        if (viewModel.isLoggedIn) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        viewModel.authDisplayName.ifEmpty { viewModel.authUsername },
                        color = HudColors.Text,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        "@${viewModel.authUsername} · ${if (viewModel.authRole == "admin") "管理员" else "测试员"}",
                        color = HudColors.Muted,
                        fontSize = 12.sp
                    )
                }
                TextButton(onClick = viewModel::logout) {
                    Text("退出登录", color = HudColors.Danger, fontSize = 13.sp)
                }
            }
        } else {
            LoginFields(viewModel)
        }
    }

    RideSafetySettings(viewModel)

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
                visualTransformation = PasswordVisualTransformation(),
                label = { Text("认证令牌（网页「复制令牌」获取）", fontSize = 12.sp) },
                textStyle = MaterialTheme.typography.bodySmall.copy(color = HudColors.Text),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = HudColors.AccentCyan,
                    unfocusedBorderColor = HudColors.Border,
                    focusedLabelColor = HudColors.AccentCyan,
                    unfocusedLabelColor = HudColors.Muted
                ),
                modifier = Modifier.fillMaxWidth()
            )
            if (BuildConfig.DEBUG) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("信任自签名证书（仅调试）", color = HudColors.Muted, fontSize = 12.sp)
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

    SectionCard("QA 任务归因") {
        Text(
            "从网页管理台的 Release runs 复制任务标识。下一次会话会按构建、平台和任务进入发布证据矩阵。",
            color = HudColors.Muted,
            fontSize = 11.sp
        )
        val qaFields: List<Triple<String, String, (String) -> Unit>> = listOf(
            Triple("Campaign ID", viewModel.testingCampaignId, viewModel::updateTestingCampaignId),
            Triple("Test case ID", viewModel.testingTestCaseId, viewModel::updateTestingTestCaseId),
            Triple("Run ID（可选）", viewModel.testingRunId, viewModel::updateTestingRunId),
            Triple("Assignment ID（可选）", viewModel.testingAssignmentId, viewModel::updateTestingAssignmentId)
        )
        qaFields.forEach { (label, value, update) ->
            OutlinedTextField(
                value = value,
                onValueChange = update,
                enabled = !state.handsFree,
                singleLine = true,
                label = { Text(label, fontSize = 11.sp) },
                textStyle = MaterialTheme.typography.bodySmall.copy(color = HudColors.Text),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = HudColors.AccentCyan,
                    unfocusedBorderColor = HudColors.Border,
                    focusedLabelColor = HudColors.AccentCyan,
                    unfocusedLabelColor = HudColors.Muted
                ),
                modifier = Modifier.fillMaxWidth()
            )
        }
        Text(
            "Android · ${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE} · commit ${BuildConfig.GIT_COMMIT}",
            color = HudColors.Muted,
            fontSize = 10.sp
        )
    }

    // Live ride intelligence: weather, route, and session memory. The data
    // already flows over the protocol (weather / ride.context / session.memory
    // events); this surfaces it like the web HUD instruments.
    SectionCard("骑行情报") {
        val weather = state.weather
        if (weather != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${weather.temperatureC}°", color = HudColors.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Text(weather.description, color = HudColors.Text, fontSize = 14.sp)
                Text("风速 ${weather.windSpeedKmh} km/h", color = HudColors.Muted, fontSize = 12.sp)
                Spacer(Modifier.weight(1f))
                Text(
                    when (weather.riskLevel) {
                        HazardLevel.CRITICAL -> "高风险"
                        HazardLevel.CAUTION -> "注意"
                        else -> "正常"
                    },
                    color = hazardColor(weather.riskLevel),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold
                )
            }
            Text(weather.riderAdvice, color = HudColors.Muted, fontSize = 12.sp)
        } else {
            Text("激活后接入定位天气", color = HudColors.Muted, fontSize = 12.sp)
        }
        Text(
            "${state.rideContext.speedKmh} km/h · ${state.rideContext.routePhase}",
            color = HudColors.Muted,
            fontSize = 12.sp
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            InfoChip(if (state.sessionMemory.language == "zh") "中文" else "English")
            InfoChip(responseModeLabel(state.sessionMemory.responseMode))
            InfoChip(state.sessionMemory.lastIntent ?: "待识别")
            state.sessionMemory.destination?.let { InfoChip(it, tint = HudColors.AccentCyan) }
            Spacer(Modifier.weight(1f))
            InfoChip("电量 ${state.rideContext.batteryPct}%")
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
        // Guided tour of every scenario — mock provider only, like the web.
        if (state.provider == "mock") {
            ChipRow(label = "巡游") {
                HudChip(
                    if (state.guidedDemo) "■ 巡游中" else "▶ 巡游演示",
                    state.guidedDemo,
                    { viewModel.setGuidedDemo(!state.guidedDemo) },
                    selectedColor = HudColors.AccentCyan
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

/** Small read-only status chip (session memory / battery readouts). */
@Composable
private fun InfoChip(label: String, tint: Color = HudColors.Muted) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(HudColors.Panel)
            .padding(horizontal = 9.dp, vertical = 5.dp)
    ) {
        Text(label, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

// ---- shared card scaffolding -----------------------------------------------------------
