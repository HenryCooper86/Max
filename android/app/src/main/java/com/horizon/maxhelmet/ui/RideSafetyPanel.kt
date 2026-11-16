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
    SettingsGroup("RDK 头盔骑行") {
        SettingsRow(
            title = when (companion.status) {
                "signedOut" -> if (vm.isLoggedIn) "尚未连接头盔" else "登录后可配对头盔"
                "connecting" -> "正在连接 / 等待头盔确认"
                "unpaired" -> "未配对"
                "paired" -> "已配对"
                "helmetOffline" -> "头盔离线"
                "ready" -> "头盔已就绪"
                "sharing" -> "正在共享位置"
                else -> companion.detail ?: "连接失败"
            },
            supporting = "仅开始头盔骑行后共享精确位置；停止、退出账号或连接失败后停止。手机免提与头盔骑行分别使用。"
        ) {
            if (companion.status == "sharing") Text("${companion.fixes} 次", color = c.textSecondary, style = VisorType.mono)
        }
        SettingsBlock { VisorTextField(code, { code = it.take(120) }, "头盔配对码", mono = true) }
        SettingsRow("配对", enabled = vm.isLoggedIn && !companion.riding, onClick = { vm.pairHelmet(code) }) { ChevronIcon() }
        SettingsRow(
            if (scanning) "停止搜索" else "搜索附近头盔",
            enabled = vm.isLoggedIn,
            onClick = { scanning = !scanning; if (scanning) vm.helmetDiscovery.start() else vm.helmetDiscovery.stop() }
        ) { ChevronIcon() }
        tokens.forEachIndexed { index, token ->
            SettingsRow("配对附近头盔 ${index + 1}", enabled = !companion.riding, onClick = { vm.pairHelmet(token, true) }) { ChevronIcon() }
        }
        if (scanning) SettingsBlock {
            Text("手机与头盔需在同一网络。选择后，对头盔说“确认配对”。也可以输入配对码。", color = c.textSecondary, style = VisorType.caption)
        }
        SettingsRow(
            if (companion.riding) "停止头盔骑行" else "开始头盔骑行",
            enabled = vm.isLoggedIn,
            onClick = { if (companion.riding) vm.companion.stopRide() else vm.startHelmetRide() }
        ) { ChevronIcon() }
        SettingsRow("解除配对", titleColor = c.danger, enabled = vm.isLoggedIn, onClick = { unpair = true }) { ChevronIcon() }
    }

    var config by remember { mutableStateOf(vm.crash.settings) }
    SettingsGroup(
        "摔车检测与求助",
        footer = "通知会包含事故位置（如可用）。未收到服务器确认时，需手动拨打求助电话。"
    ) {
        SettingsBlock {
            Text(
                if (vm.crash.available) "手机免提期间检测；疑似摔车后先询问，再报警。" else "本机缺少所需运动传感器，无法自动检测摔车。",
                color = c.textSecondary, style = VisorType.caption
            )
            VisorTextField(
                config.contact,
                { value -> config = config.copy(contact = value.take(24), optIn = false); vm.crash.settings = config },
                "紧急联系人电话（含国家区号）", mono = true
            )
        }
        SettingsSwitchRow(
            "允许中继通知该联系人", config.optIn,
            { config = config.copy(optIn = it); vm.crash.settings = config },
            enabled = CrashController.validContact(config.contact)
        )
        SettingsRow("求助电话") {
            SegmentedControl(
                listOf(true, false), config.callContact,
                { if (it) "联系人" else "120" },
                { config = config.copy(callContact = it); vm.crash.settings = config }
            )
        }
        if (BuildConfig.DEBUG && vm.devMode) {
            SettingsSwitchRow("仅记录检测（不报警）", config.logOnly, { config = config.copy(logOnly = it); vm.crash.settings = config })
            SettingsRow(
                "本地摔车演练（不通知联系人）",
                enabled = vm.sessionState.value.handsFree,
                onClick = { vm.crash.controller.simulate() }
            ) { ChevronIcon() }
        }
    }
    if (unpair) VisorAlertDialog(
        onDismissRequest = { unpair = false }, title = "解除头盔配对？",
        text = { DialogText("将停止位置共享，并解除账号与头盔的绑定。") },
        confirmButton = { VisorButton("解除配对", { unpair = false; vm.unpairHelmet() }, style = VisorButtonStyle.DANGER) },
        dismissButton = { VisorButton("取消", { unpair = false }, style = VisorButtonStyle.GHOST) })
}

@Composable
internal fun CrashOverlay(vm: MainViewModel) {
    val state by vm.crash.ui.collectAsStateWithLifecycle()
    val session by vm.sessionState.collectAsStateWithLifecycle()
    if (state.phase !in setOf(CrashPhase.CHECK_IN, CrashPhase.ALARM, CrashPhase.ESCALATED)) return
    val context = LocalContext.current
    val insets = WindowInsets.safeDrawing.asPaddingValues()
    Dialog(onDismissRequest = {}, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnBackPress = false, dismissOnClickOutside = false)) {
        Surface(Modifier.fillMaxSize(), color = Visor.colors.bg) {
            Column(Modifier.fillMaxSize().padding(insets).padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text(if (state.phase == CrashPhase.CHECK_IN) "你还好吗？" else "疑似摔车 · 求助", style = VisorType.headline, color = Visor.colors.danger)
                if (state.phase != CrashPhase.ESCALATED) Text("${state.remaining} 秒", style = VisorType.display.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace), color = Visor.colors.text)
                Text(state.message ?: if (state.phase == CrashPhase.CHECK_IN) "没事请说“我没事”，或点击下方按钮。" else "正在报警；倒计时结束后请求中继通知。", color = Visor.colors.text, style = VisorType.body)
                state.coordinate?.let { Text(it, color = Visor.colors.textSecondary, style = VisorType.mono) }
                VisorButton("我没事 · 取消报警", { vm.crash.controller.cancel() }, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp), style = VisorButtonStyle.PRIMARY)
                if (session.handsFree) VisorButton("结束免提（保持报警）", { vm.toggleHandsFree() }, style = VisorButtonStyle.GHOST, modifier = Modifier.fillMaxWidth())
                val config = vm.crash.settings
                val number = if (config.callContact) config.contact.trim().takeIf(CrashController::validContact) else "120"
                VisorButton(if (config.callContact) "打开联系人拨号" else "打开 120 拨号", { if (number != null) runCatching { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))) } }, enabled = number != null, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp), style = VisorButtonStyle.DANGER)
            }
        }
    }
}
