package io.github.henrycooper86.max.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import io.github.henrycooper86.max.ui.theme.VisorTemplate
import io.github.henrycooper86.max.ui.theme.VisorTemplates
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
import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.agent.DemoScenario
import io.github.henrycooper86.max.agent.HazardLevel
import io.github.henrycooper86.max.agent.RideMode
import io.github.henrycooper86.max.agent.VoiceGender
import io.github.henrycooper86.max.agent.VoicePersonality
import io.github.henrycooper86.max.agent.responseModeLabel
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorType

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
        Text(tr(Str.LOGIN_HELP), color = Visor.colors.textSecondary, style = VisorType.caption)
        VisorTextField(username, { username = it }, tr(Str.USERNAME))
        VisorTextField(password, { password = it }, tr(Str.PASSWORD), secret = true)
        viewModel.loginError?.let { error ->
            Text(error, color = Visor.colors.danger, style = VisorType.caption)
        }
        VisorButton(
            text = if (viewModel.loginBusy) tr(Str.SIGNING_IN) else tr(Str.SIGN_IN),
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
    SettingsGroup(tr(Str.ACCOUNT)) {
        if (viewModel.isLoggedIn) {
            SettingsRow(
                title = viewModel.authDisplayName.ifEmpty { viewModel.authUsername },
                supporting = "@${viewModel.authUsername} · ${if (viewModel.authRole == "admin") tr(Str.ROLE_ADMIN) else tr(Str.ROLE_TESTER)}"
            ) {
                VisorButton(tr(Str.SIGN_OUT), onClick = viewModel::logout, style = VisorButtonStyle.DANGER)
            }
        } else {
            LoginFields(viewModel)
        }
    }

    AssistantSection(viewModel)

    AppearanceSection(viewModel)

    LanguageSection(viewModel)

    RideSafetySettings(viewModel)

    // Voice preferences.
    SettingsGroup(tr(Str.VOICE)) {
        SettingsRow(tr(Str.VOICE_SOUND)) {
            SegmentedControl(VoiceGender.entries, state.voiceGender, { it.label }, viewModel::setVoiceGender)
        }
        SegmentedRow(tr(Str.VOICE_TONE), VoicePersonality.entries, state.voicePersonality, { it.label }, viewModel::setVoicePersonality)
        SegmentedRow(
            tr(Str.MODE), RideMode.entries, state.rideContext.mode, { it.label }, viewModel::setRideMode,
            selectedColor = { if (it == RideMode.EMERGENCY) c.danger else c.accent }
        )
    }

    // Server / relay connection.
    SettingsGroup(tr(Str.MUSIC)) {
        SettingsRow(
            tr(Str.MUSIC_PLAYER),
            supporting = tr(Str.OPEN_PLAYBACK),
            onClick = {
                viewModel.showPreferences = false
                viewModel.music.show()
            }
        ) { ChevronIcon() }
    }

    SettingsGroup(tr(Str.CONNECTION)) {
        if (state.handsFree) {
            SettingsRow(tr(Str.CURRENT_SERVER), supporting = viewModel.relayUrl, supportingColor = c.textSecondary)
            SettingsBlock {
                Text(tr(Str.SERVER_LOCKED), color = c.textTertiary, style = VisorType.caption)
            }
        } else {
            SettingsBlock {
                VisorTextField(viewModel.relayUrl, viewModel::updateRelayUrl, tr(Str.RELAY_FIELD), mono = true)
                // Optional shared relay secret, sent as the ?token= query parameter.
                VisorTextField(viewModel.authToken, viewModel::updateAuthToken, tr(Str.TOKEN_FIELD), secret = true)
            }
            if (BuildConfig.DEBUG) {
                SettingsSwitchRow(tr(Str.TRUST_SELF), viewModel.allowSelfSigned, viewModel::updateAllowSelfSigned)
            }
        }
    }

    SettingsGroup(tr(Str.QA_GROUP)) {
        SettingsBlock {
            Text(
                tr(Str.QA_HELP),
                color = c.textSecondary,
                style = VisorType.caption
            )
            val qaFields: List<Triple<String, String, (String) -> Unit>> = listOf(
                Triple("Campaign ID", viewModel.testingCampaignId, viewModel::updateTestingCampaignId),
                Triple("Test case ID", viewModel.testingTestCaseId, viewModel::updateTestingTestCaseId),
                Triple(tr(Str.RUN_ID), viewModel.testingRunId, viewModel::updateTestingRunId),
                Triple(tr(Str.ASSIGNMENT_ID), viewModel.testingAssignmentId, viewModel::updateTestingAssignmentId)
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
    SettingsGroup(tr(Str.RIDE_INTEL)) {
        val weather = state.weather
        if (weather != null) {
            SettingsRow(
                title = weather.description,
                supporting = tr(Str.WIND, "n" to weather.windSpeedKmh)
            ) {
                Text("${weather.temperatureC}°", color = c.text, style = VisorType.monoLarge)
                Text(
                    when (weather.riskLevel) {
                        HazardLevel.CRITICAL -> tr(Str.RISK_HIGH)
                        HazardLevel.CAUTION -> tr(Str.RISK_CAUTION)
                        else -> tr(Str.RISK_NORMAL)
                    },
                    color = hazardColor(c, weather.riskLevel),
                    style = VisorType.label
                )
            }
            SettingsBlock { Text(weather.riderAdvice, color = c.textSecondary, style = VisorType.caption) }
        } else {
            SettingsRow(tr(Str.WEATHER), supporting = tr(Str.WEATHER_PENDING))
        }
        SettingsRow(tr(Str.SPEED_SEGMENT), supporting = relocalize(state.rideContext.routePhase)) {
            // Unknown speed is shown as unknown, not as standing still.
            Text("${state.speedKmh?.let { Math.round(it) } ?: "—"} km/h", color = c.text, style = VisorType.mono)
        }
        SettingsRow(tr(Str.BATTERY)) { Text("${state.rideContext.batteryPct}%", color = c.text, style = VisorType.mono) }
        SettingsBlock {
            Row(horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
                VisorTag(if (state.sessionMemory.language == "zh") "中文" else "English")
                VisorTag(responseModeLabel(state.sessionMemory.responseMode))
                VisorTag(state.sessionMemory.lastIntent ?: tr(Str.PENDING_INTENT))
            }
            state.sessionMemory.destination?.let { VisorTag(it, tint = c.text) }
        }
    }

    // Demo scenarios (ADAS hazard injection).
    SettingsGroup(tr(Str.DEMO_SCENARIOS)) {
        SegmentedRow(
            tr(Str.SCENARIO), DemoScenario.entries, state.rideContext.scenario, { it.label }, viewModel::setScenario,
            fill = false,
            selectedColor = { hazardColor(c, it.hazard).let { tone -> if (it.hazard == HazardLevel.NORMAL) c.accent else tone } }
        )
        // Guided tour of every scenario: mock provider only, like the web.
        if (state.provider == "mock") {
            SettingsSwitchRow(tr(Str.GUIDED_TOUR), state.guidedDemo, { viewModel.setGuidedDemo(!state.guidedDemo) })
        }
    }

    // Diagnostics: latency, telemetry, transcript export, raw status.
    SettingsGroup(tr(Str.DIAGNOSTICS)) {
        val toneColor = when {
            state.latencyMs < 140 -> c.ok
            state.latencyMs < 280 -> c.warn
            else -> c.danger
        }
        SettingsRow(tr(Str.LATENCY)) { Text("${state.latencyMs} ms", color = toneColor, style = VisorType.mono) }
        state.telemetry?.let {
            SettingsRow("ASR", supporting = tr(Str.ASR_LINE, "a" to it.thinkMs, "b" to it.firstAudioMs, "c" to it.totalMs)) {
                Text("${it.asrMs} ms", color = c.text, style = VisorType.mono)
            }
        }
        SettingsRow(
            tr(Str.EXPORT_LOG),
            enabled = state.transcript.isNotEmpty(),
            onClick = { if (state.transcript.isNotEmpty()) onExportTranscript() }
        ) { ChevronIcon() }
        SettingsRow(
            tr(Str.CLEAR_LOG),
            titleColor = c.danger,
            enabled = state.transcript.isNotEmpty(),
            onClick = { if (state.transcript.isNotEmpty()) viewModel.clearTranscript() }
        ) { ChevronIcon() }
        SettingsBlock { Text(relocalize(state.statusText), color = c.textSecondary, style = VisorType.caption) }
    }
}

// ---- assistant: identity + voice backend picker ----------------------------------------

@Composable
private fun AssistantSection(viewModel: MainViewModel) {
    val c = Visor.colors
    val backends = viewModel.voiceBackends
    SettingsGroup(tr(Str.ASSISTANT)) {
        SettingsRow(tr(Str.NAME)) {
            DeviceLogo(viewModel.deviceProfile, viewModel.deviceKind, viewModel.logoBitmap, size = 28.dp, contentDescription = tr(Str.LOGO_DESC, "name" to viewModel.assistantName))
            Text(viewModel.assistantName, color = c.textSecondary, style = VisorType.body)
        }
        SettingsRow(tr(Str.DEVICE)) { Text(deviceDisplayName(viewModel.deviceProfile, viewModel.deviceLabel, viewModel.deviceKind), color = c.textSecondary, style = VisorType.body) }
        if (backends != null && backends.providers.isNotEmpty()) {
            if (backends.switching) {
                val selectedId = viewModel.voiceProviderId?.takeIf { id -> backends.providers.any { it.id == id } } ?: backends.active
                backends.providers.forEach { provider ->
                    val configured = provider.configured
                    SettingsRow(
                        title = provider.label,
                        supporting = if (!configured) tr(Str.NEEDS_KEY) else provider.description,
                        supportingColor = if (!configured) c.warn else c.textSecondary,
                        enabled = configured,
                        onClick = { if (provider.id != selectedId) viewModel.selectVoiceProvider(provider.id) }
                    ) {
                        Text(providerKindLabel(provider.kind), color = c.textTertiary, style = VisorType.caption)
                        if (provider.id == selectedId) {
                            Icon(Icons.Filled.Check, contentDescription = tr(Str.CURRENT_BACKEND), tint = c.accent, modifier = Modifier.size(20.dp))
                        } else {
                            Spacer(Modifier.size(20.dp))
                        }
                    }
                }
            } else {
                SettingsRow(tr(Str.VOICE_BACKEND)) { Text(backends.activeLabel, color = c.textSecondary, style = VisorType.body) }
            }
        }
    }
}

internal fun providerKindLabel(kind: String): String = when (kind) {
    "demo" -> tr(Str.KIND_DEMO)
    "live" -> tr(Str.KIND_LIVE)
    "pipeline" -> tr(Str.KIND_PIPELINE)
    else -> kind
}

// ---- appearance: design template + voice display style ----------------------------------

/** A tiny still of a template: its background, a surface bar, a text dot and the accent. */
@Composable
private fun TemplateSwatch(template: VisorTemplate) {
    val sw = template.swatch
    Box(
        Modifier.size(width = 44.dp, height = 32.dp).clip(RoundedCornerShape(8.dp)).background(sw.bg)
            .border(1.dp, Visor.colors.lineStrong, RoundedCornerShape(8.dp)).padding(5.dp)
    ) {
        Box(Modifier.fillMaxSize().clip(RoundedCornerShape(4.dp)).background(sw.surface))
        Box(Modifier.align(Alignment.CenterStart).padding(start = 4.dp).size(width = 14.dp, height = 3.dp).clip(CircleShape).background(sw.text))
        Box(Modifier.align(Alignment.CenterEnd).padding(end = 4.dp).size(9.dp).clip(CircleShape).background(sw.accent))
    }
}

/** A tiny still of a voice style, drawn with the same geometry as the visor from a fixed spectrum. */
@Composable
private fun StylePreview(style: VoiceStyle) {
    val c = Visor.colors
    val spectrum = remember { synthesizeSpectrum(FloatArray(SPECTRUM_BINS), SpectrumMode.SPEAKING, 0f, 1.2f) }
    val peaks = remember { FloatArray(SPECTRUM_BINS) { minOf(1f, spectrum[it] + 0.12f) } }
    val tint = c.accent
    Canvas(Modifier.size(width = 60.dp, height = 25.dp).clip(RoundedCornerShape(12.5.dp)).background(c.surface1)) {
        val u = size.width / 480f
        if (style == VoiceStyle.WAVE) {
            val path = androidx.compose.ui.graphics.Path()
            for (i in 0..48) {
                val x = i / 48f
                val y = size.height / 2f - visorWave(x, 0.8f, 0.2f) * size.height * 0.3f
                if (i == 0) path.moveTo(size.width * 0.12f, y) else path.lineTo(size.width * (0.12f + 0.76f * x), y)
            }
            drawPath(path, tint, style = androidx.compose.ui.graphics.drawscope.Stroke(1.6.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round))
        } else {
            drawSpectrumPreview(style, spectrum, peaks, tint, u)
        }
    }
}

@Composable
private fun AppearanceRow(
    selected: Boolean, enabled: Boolean, title: String, supporting: String, description: String,
    onClick: () -> Unit, leading: @Composable () -> Unit
) {
    val c = Visor.colors
    Row(
        Modifier.fillMaxWidth().background(c.surface1)
            .semantics(mergeDescendants = true) { contentDescription = description; this.selected = selected; role = Role.RadioButton }
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = 56.dp).padding(horizontal = VisorSpace.x4, vertical = VisorSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3)
    ) {
        leading()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = if (selected) c.accent else c.text, style = VisorType.body)
            Text(supporting, color = c.textSecondary, style = VisorType.caption)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = c.accent, modifier = Modifier.size(20.dp))
        else Spacer(Modifier.size(20.dp))
    }
}

@Composable
private fun AppearanceSection(viewModel: MainViewModel) {
    val c = Visor.colors
    val appearance = remember(
        viewModel.relayTemplate, viewModel.wearerTemplate, viewModel.templateSwitching,
        viewModel.themeOverrides, viewModel.accentHex
    ) { viewModel.appearance }
    val pinned = !viewModel.templateSwitching
    val current = appearance.base
    val style = viewModel.voiceStyle
    SettingsGroup(tr(Str.APPEARANCE), footer = if (pinned) tr(Str.PINNED_FOOTER) else null) {
        if (pinned) {
            SettingsRow(tr(Str.TEMPLATE), supporting = "${current.name} · ${current.blurb}") {
                Text(tr(Str.PINNED), color = c.textTertiary, style = VisorType.caption)
                TemplateSwatch(current)
            }
        } else {
            VisorTemplates.ALL.forEach { template ->
                val selected = template.id == current.id
                AppearanceRow(
                    selected = selected, enabled = true, title = template.name, supporting = template.blurb,
                    description = "${template.name}${tr(Str.SEP)}${template.blurb}${if (selected) tr(Str.SELECTED_SUFFIX) else ""}",
                    onClick = { viewModel.selectTemplate(template.id) }
                ) { TemplateSwatch(template) }
            }
        }
        SettingsBlock { Text(tr(Str.VOICE_DISPLAY), color = c.textTertiary, style = VisorType.caption.copy(fontWeight = FontWeight.SemiBold)) }
        if (pinned) {
            SettingsRow(tr(Str.VOICE_DISPLAY), supporting = "${style.label} · ${style.description}") {
                Text(tr(Str.PINNED), color = c.textTertiary, style = VisorType.caption)
                StylePreview(style)
            }
        } else {
            VoiceStyle.entries.forEach { option ->
                val selected = option == style
                AppearanceRow(
                    selected = selected, enabled = true, title = option.label, supporting = option.description,
                    description = "${tr(Str.VOICE_DISPLAY)} ${option.label}${tr(Str.SEP)}${option.description}${if (selected) tr(Str.SELECTED_SUFFIX) else ""}",
                    onClick = { viewModel.selectVoiceStyle(option) }
                ) { StylePreview(option) }
            }
        }
    }
}

// ---- language: follow system / 中文 / English ------------------------------------------------

@Composable
private fun LanguageSection(viewModel: MainViewModel) {
    SettingsGroup(tr(Str.LANGUAGE_ROW), footer = tr(Str.LANGUAGE_NOTE)) {
        SegmentedRow(
            tr(Str.LANGUAGE_ROW), LanguagePreference.entries, viewModel.languagePreference,
            { when (it) { LanguagePreference.SYSTEM -> tr(Str.LANG_FOLLOW); LanguagePreference.ZH -> tr(Str.LANG_ZH); LanguagePreference.EN -> tr(Str.LANG_EN) } },
            viewModel::selectLanguage
        )
    }
}
