package com.horizon.maxhelmet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.DemoScenario
import com.horizon.maxhelmet.agent.HazardLevel
import com.horizon.maxhelmet.agent.RideMode
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.VoicePersonality
import com.horizon.maxhelmet.agent.responseModeLabel
import com.horizon.maxhelmet.ui.theme.Visor
import com.horizon.maxhelmet.ui.theme.VisorSpace
import com.horizon.maxhelmet.ui.theme.VisorType

// ---- settings sheet scaffold ----------------------------------------------------------

@Composable
internal fun SheetContent(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            // The sections outgrow the sheet on short/landscape screens (e.g.
            // tablets); without this the lower groups are simply unreachable.
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(horizontal = VisorSpace.x4)
            .padding(bottom = VisorSpace.x6),
        verticalArrangement = Arrangement.spacedBy(VisorSpace.x6)
    ) {
        Text(title, color = Visor.colors.text, style = VisorType.headline)
        content()
    }
}

// ---- inline login form (settings -> 账号) ---------------------------------------------

@Composable
private fun LoginFields(viewModel: MainViewModel) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    SettingsBlock {
        Text("使用网页测试平台的账号登录；登录后自动获取会话令牌。", color = Visor.colors.textSecondary, style = VisorType.caption)
        VisorTextField(username, { username = it }, "用户名")
        VisorTextField(password, { password = it }, "密码", secret = true)
        viewModel.loginError?.let { error ->
            Text(error, color = Visor.colors.danger, style = VisorType.caption)
        }
        VisorButton(
            text = if (viewModel.loginBusy) "登录中…" else "登录",
            // Not cleared eagerly: on failure the rider shouldn't retype it;
            // on success this form leaves composition (state discarded) anyway.
            onClick = { viewModel.login(username, password) },
            enabled = !viewModel.loginBusy,
            style = VisorButtonStyle.PRIMARY,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

// ---- settings (account, assistant, voice, connection, demo, diagnostics) ------------

@Composable
internal fun SettingsPanel(
    state: AgentSession.State,
    viewModel: MainViewModel,
    onExportTranscript: () -> Unit
) {
    val c = Visor.colors

    // Account: sign in with the same username/password as the web HUD; the
    // session token then rides the /agent URL automatically. The manual
    // 认证令牌 field below stays as the operator fallback.
    SettingsGroup("账号") {
        if (viewModel.isLoggedIn) {
            SettingsRow(
                title = viewModel.authDisplayName.ifEmpty { viewModel.authUsername },
                supporting = "@${viewModel.authUsername} · ${if (viewModel.authRole == "admin") "管理员" else "测试员"}"
            ) {
                VisorButton("退出登录", onClick = viewModel::logout, style = VisorButtonStyle.DANGER)
            }
        } else {
            LoginFields(viewModel)
        }
    }

    AssistantSection(viewModel)

    RideSafetySettings(viewModel)

    // Voice preferences.
    SettingsGroup("语音") {
        SettingsRow("声音") {
            SegmentedControl(VoiceGender.entries, state.voiceGender, { it.label }, viewModel::setVoiceGender)
        }
        SegmentedRow("语气", VoicePersonality.entries, state.voicePersonality, { it.label }, viewModel::setVoicePersonality)
        SegmentedRow(
            "模式", RideMode.entries, state.rideContext.mode, { it.label }, viewModel::setRideMode,
            selectedColor = { if (it == RideMode.EMERGENCY) c.danger else c.accent }
        )
    }

    // Server / relay connection.
    SettingsGroup("音乐") {
        SettingsRow(
            "音乐播放器",
            supporting = "打开播放控制",
            onClick = {
                viewModel.showPreferences = false
                viewModel.music.show()
            }
        ) { ChevronIcon() }
    }

    SettingsGroup("连接") {
        if (state.handsFree) {
            SettingsRow("当前服务器", supporting = viewModel.relayUrl, supportingColor = c.textSecondary)
            SettingsBlock {
                Text("结束免提后可修改服务器地址。", color = c.textTertiary, style = VisorType.caption)
            }
        } else {
            SettingsBlock {
                VisorTextField(viewModel.relayUrl, viewModel::updateRelayUrl, "语音中继地址（ws:// 或 wss://）", mono = true)
                // Optional shared relay secret, sent as the ?token= query parameter.
                VisorTextField(viewModel.authToken, viewModel::updateAuthToken, "认证令牌（网页「复制令牌」获取）", secret = true)
            }
            if (BuildConfig.DEBUG) {
                SettingsSwitchRow("信任自签名证书（仅调试）", viewModel.allowSelfSigned, viewModel::updateAllowSelfSigned)
            }
        }
    }

    SettingsGroup("QA 任务归因") {
        SettingsBlock {
            Text(
                "从网页管理台的 Release runs 复制任务标识。下一次会话会按构建、平台和任务进入发布证据矩阵。",
                color = c.textSecondary,
                style = VisorType.caption
            )
            val qaFields: List<Triple<String, String, (String) -> Unit>> = listOf(
                Triple("Campaign ID", viewModel.testingCampaignId, viewModel::updateTestingCampaignId),
                Triple("Test case ID", viewModel.testingTestCaseId, viewModel::updateTestingTestCaseId),
                Triple("Run ID（可选）", viewModel.testingRunId, viewModel::updateTestingRunId),
                Triple("Assignment ID（可选）", viewModel.testingAssignmentId, viewModel::updateTestingAssignmentId)
            )
            qaFields.forEach { (label, value, update) ->
                VisorTextField(value, update, label, enabled = !state.handsFree, mono = true)
            }
            Text(
                "Android · ${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE} · commit ${BuildConfig.GIT_COMMIT}",
                color = c.textTertiary,
                style = VisorType.monoCaption
            )
        }
    }

    // Live ride intelligence: weather, route, and session memory.
    SettingsGroup("骑行情报") {
        val weather = state.weather
        if (weather != null) {
            SettingsRow(
                title = weather.description,
                supporting = "风速 ${weather.windSpeedKmh} km/h"
            ) {
                Text("${weather.temperatureC}°", color = c.text, style = VisorType.monoLarge)
                Text(
                    when (weather.riskLevel) {
                        HazardLevel.CRITICAL -> "高风险"
                        HazardLevel.CAUTION -> "注意"
                        else -> "正常"
                    },
                    color = hazardColor(c, weather.riskLevel),
                    style = VisorType.label
                )
            }
            SettingsBlock { Text(weather.riderAdvice, color = c.textSecondary, style = VisorType.caption) }
        } else {
            SettingsRow("天气", supporting = "激活后接入定位天气")
        }
        SettingsRow("车速 · 路段", supporting = state.rideContext.routePhase) {
            Text("${state.rideContext.speedKmh} km/h", color = c.text, style = VisorType.mono)
        }
        SettingsRow("电量") { Text("${state.rideContext.batteryPct}%", color = c.text, style = VisorType.mono) }
        SettingsBlock {
            Row(horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
                VisorTag(if (state.sessionMemory.language == "zh") "中文" else "English")
                VisorTag(responseModeLabel(state.sessionMemory.responseMode))
                VisorTag(state.sessionMemory.lastIntent ?: "待识别")
            }
            state.sessionMemory.destination?.let { VisorTag(it, tint = c.text) }
        }
    }

    // Demo scenarios (ADAS hazard injection).
    SettingsGroup("演示场景") {
        SegmentedRow(
            "场景", DemoScenario.entries, state.rideContext.scenario, { it.label }, viewModel::setScenario,
            fill = false,
            selectedColor = { hazardColor(c, it.hazard).let { tone -> if (it.hazard == HazardLevel.NORMAL) c.accent else tone } }
        )
        // Guided tour of every scenario: mock provider only, like the web.
        if (state.provider == "mock") {
            SettingsSwitchRow("巡游演示", state.guidedDemo, { viewModel.setGuidedDemo(!state.guidedDemo) })
        }
    }

    // Diagnostics: latency, telemetry, transcript export, raw status.
    SettingsGroup("诊断") {
        val toneColor = when {
            state.latencyMs < 140 -> c.ok
            state.latencyMs < 280 -> c.warn
            else -> c.danger
        }
        SettingsRow("延迟") { Text("${state.latencyMs} ms", color = toneColor, style = VisorType.mono) }
        state.telemetry?.let {
            SettingsRow("ASR", supporting = "思考 ${it.thinkMs} · 首音 ${it.firstAudioMs} · 总计 ${it.totalMs}ms") {
                Text("${it.asrMs} ms", color = c.text, style = VisorType.mono)
            }
        }
        SettingsRow(
            "导出日志",
            enabled = state.transcript.isNotEmpty(),
            onClick = { if (state.transcript.isNotEmpty()) onExportTranscript() }
        ) { ChevronIcon() }
        SettingsRow(
            "清空对话记录",
            titleColor = c.danger,
            enabled = state.transcript.isNotEmpty(),
            onClick = { if (state.transcript.isNotEmpty()) viewModel.clearTranscript() }
        ) { ChevronIcon() }
        SettingsBlock { Text(state.statusText, color = c.textSecondary, style = VisorType.caption) }
    }
}

// ---- assistant: identity + voice backend picker ----------------------------------------

@Composable
private fun AssistantSection(viewModel: MainViewModel) {
    val c = Visor.colors
    val backends = viewModel.voiceBackends
    SettingsGroup("助手") {
        SettingsRow("名称") { Text(viewModel.assistantName, color = c.textSecondary, style = VisorType.body) }
        SettingsRow("设备") { Text(viewModel.deviceKind.noun, color = c.textSecondary, style = VisorType.body) }
        if (backends != null && backends.providers.isNotEmpty()) {
            if (backends.switching) {
                val selectedId = viewModel.voiceProviderId?.takeIf { id -> backends.providers.any { it.id == id } } ?: backends.active
                backends.providers.forEach { provider ->
                    val configured = provider.configured
                    SettingsRow(
                        title = provider.label,
                        supporting = if (!configured) "需配置 API 密钥" else provider.description,
                        supportingColor = if (!configured) c.warn else c.textSecondary,
                        enabled = configured,
                        onClick = { if (provider.id != selectedId) viewModel.selectVoiceProvider(provider.id) }
                    ) {
                        Text(providerKindLabel(provider.kind), color = c.textTertiary, style = VisorType.caption)
                        if (provider.id == selectedId) {
                            Icon(Icons.Filled.Check, contentDescription = "当前语音后端", tint = c.accent, modifier = Modifier.size(20.dp))
                        } else {
                            Spacer(Modifier.size(20.dp))
                        }
                    }
                }
            } else {
                SettingsRow("语音后端") { Text(backends.activeLabel, color = c.textSecondary, style = VisorType.body) }
            }
        }
    }
}

internal fun providerKindLabel(kind: String): String = when (kind) {
    "demo" -> "演示"
    "live" -> "实时"
    "pipeline" -> "流水线"
    else -> kind
}
