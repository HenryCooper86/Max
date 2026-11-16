package com.horizon.maxhelmet.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.crash.*
import com.horizon.maxhelmet.ui.theme.Visor
import com.horizon.maxhelmet.ui.theme.VisorType

@Composable
internal fun RideSafetySettings(vm: MainViewModel) {
    val c = Visor.colors
    val companion by vm.companion.state.collectAsStateWithLifecycle()
    val tokens by vm.helmetDiscovery.tokens.collectAsStateWithLifecycle()
    var code by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    var unpair by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { vm.helmetDiscovery.stop() } }
    SettingsGroup(tr(Str.RDK_RIDE)) {
        SettingsRow(
            title = when (companion.status) {
                "signedOut" -> if (vm.isLoggedIn) tr(Str.RIDE_SIGNED_IN) else tr(Str.RIDE_SIGNED_OUT)
                "connecting" -> tr(Str.RIDE_CONNECTING)
                "unpaired" -> tr(Str.RIDE_UNPAIRED)
                "paired" -> tr(Str.RIDE_PAIRED)
                "helmetOffline" -> tr(Str.RIDE_OFFLINE)
                "ready" -> tr(Str.RIDE_READY)
                "sharing" -> tr(Str.RIDE_SHARING)
                else -> companion.detail ?: tr(Str.RIDE_FAILED)
            },
            supporting = tr(Str.RIDE_PRIVACY)
        ) {
            if (companion.status == "sharing") Text(tr(Str.RIDE_FIXES, "n" to companion.fixes), color = c.textSecondary, style = VisorType.mono)
        }
        SettingsBlock { VisorTextField(code, { code = it.take(120) }, tr(Str.PAIR_CODE), mono = true) }
        SettingsRow(tr(Str.PAIR), enabled = vm.isLoggedIn && !companion.riding, onClick = { vm.pairHelmet(code) }) { ChevronIcon() }
        SettingsRow(
            if (scanning) tr(Str.STOP_SEARCH) else tr(Str.SEARCH_HELMETS),
            enabled = vm.isLoggedIn,
            onClick = { scanning = !scanning; if (scanning) vm.helmetDiscovery.start() else vm.helmetDiscovery.stop() }
        ) { ChevronIcon() }
        tokens.forEachIndexed { index, token ->
            SettingsRow(tr(Str.PAIR_NEARBY, "n" to index + 1), enabled = !companion.riding, onClick = { vm.pairHelmet(token, true) }) { ChevronIcon() }
        }
        if (scanning) SettingsBlock {
            Text(tr(Str.PAIR_HELP), color = c.textSecondary, style = VisorType.caption)
        }
        SettingsRow(
            if (companion.riding) tr(Str.STOP_RIDE) else tr(Str.START_RIDE),
            enabled = vm.isLoggedIn,
            onClick = { if (companion.riding) vm.companion.stopRide() else vm.startHelmetRide() }
        ) { ChevronIcon() }
        SettingsRow(tr(Str.UNPAIR), titleColor = c.danger, enabled = vm.isLoggedIn, onClick = { unpair = true }) { ChevronIcon() }
    }

    var config by remember { mutableStateOf(vm.crash.settings) }
    SettingsGroup(
        tr(Str.CRASH_GROUP),
        footer = tr(Str.CRASH_FOOTER)
    ) {
        SettingsBlock {
            Text(
                if (vm.crash.available) tr(Str.CRASH_AVAILABLE) else tr(Str.CRASH_NO_SENSOR),
                color = c.textSecondary, style = VisorType.caption
            )
            VisorTextField(
                config.contact,
                { value -> config = config.copy(contact = value.take(24), optIn = false); vm.crash.settings = config },
                tr(Str.EMERGENCY_CONTACT), mono = true
            )
        }
        SettingsSwitchRow(
            tr(Str.ALLOW_NOTIFY), config.optIn,
            { config = config.copy(optIn = it); vm.crash.settings = config },
            enabled = CrashController.validContact(config.contact)
        )
        SettingsRow(tr(Str.HELP_NUMBER)) {
            SegmentedControl(
                listOf(true, false), config.callContact,
                { if (it) tr(Str.CONTACT) else "120" },
                { config = config.copy(callContact = it); vm.crash.settings = config }
            )
        }
        if (BuildConfig.DEBUG && vm.devMode) {
            SettingsSwitchRow(tr(Str.LOG_ONLY), config.logOnly, { config = config.copy(logOnly = it); vm.crash.settings = config })
            SettingsRow(
                tr(Str.CRASH_DRILL),
                enabled = vm.sessionState.value.handsFree,
                onClick = { vm.crash.controller.simulate() }
            ) { ChevronIcon() }
        }
    }
    if (unpair) VisorAlertDialog(
        onDismissRequest = { unpair = false }, title = tr(Str.UNPAIR_TITLE),
        text = { DialogText(tr(Str.UNPAIR_BODY)) },
        confirmButton = { VisorButton(tr(Str.UNPAIR), { unpair = false; vm.unpairHelmet() }, style = VisorButtonStyle.DANGER) },
        dismissButton = { VisorButton(tr(Str.CANCEL), { unpair = false }, style = VisorButtonStyle.GHOST) })
}

@Composable
internal fun CrashOverlay(vm: MainViewModel) {
    val state by vm.crash.ui.collectAsStateWithLifecycle()
    val session by vm.sessionState.collectAsStateWithLifecycle()
    if (state.phase !in setOf(CrashPhase.CHECK_IN, CrashPhase.ALARM, CrashPhase.ESCALATED)) return
    val context = LocalContext.current
    val insets = WindowInsets.safeDrawing.asPaddingValues()
    Dialog(onDismissRequest = {}, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnBackPress = false, dismissOnClickOutside = false)) {
        com.horizon.maxhelmet.ui.theme.DialogSystemBars()
        Surface(Modifier.fillMaxSize(), color = Visor.colors.bg) {
            Column(Modifier.fillMaxSize().padding(insets).padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text(if (state.phase == CrashPhase.CHECK_IN) tr(Str.ARE_YOU_OK) else tr(Str.CRASH_HELP), style = VisorType.headline, color = Visor.colors.danger)
                if (state.phase != CrashPhase.ESCALATED) Text(tr(Str.SECONDS, "n" to state.remaining), style = VisorType.display.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace), color = Visor.colors.text)
                Text(state.message ?: if (state.phase == CrashPhase.CHECK_IN) tr(Str.CRASH_CHECK_BODY) else tr(Str.CRASH_ALARM_BODY), color = Visor.colors.text, style = VisorType.body)
                state.coordinate?.let { Text(it, color = Visor.colors.textSecondary, style = VisorType.mono) }
                VisorButton(tr(Str.IM_OK_CANCEL), { vm.crash.controller.cancel() }, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp), style = VisorButtonStyle.PRIMARY)
                if (session.handsFree) VisorButton(tr(Str.END_HF_KEEP_ALARM), { vm.toggleHandsFree() }, style = VisorButtonStyle.GHOST, modifier = Modifier.fillMaxWidth())
                val config = vm.crash.settings
                val number = if (config.callContact) config.contact.trim().takeIf(CrashController::validContact) else "120"
                VisorButton(if (config.callContact) tr(Str.OPEN_CONTACT_DIAL) else tr(Str.OPEN_120_DIAL), { if (number != null) runCatching { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))) } }, enabled = number != null, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp), style = VisorButtonStyle.DANGER)
            }
        }
    }
}
