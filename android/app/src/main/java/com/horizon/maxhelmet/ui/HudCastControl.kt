package com.horizon.maxhelmet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.navigation.HudCastClient
import com.horizon.maxhelmet.ui.theme.Visor
import com.horizon.maxhelmet.ui.theme.VisorSpace
import com.horizon.maxhelmet.ui.theme.VisorType

@Composable
fun HudCastControl(client: HudCastClient) {
    val c = Visor.colors
    val state by client.state.collectAsState()
    var showing by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf(client.savedAddress) }
    var code by remember { mutableStateOf("") }
    VisorButton(
        text = if (state.active) "断开 HUD" else "投屏到 HUD",
        onClick = { if (state.active) client.stop() else showing = true },
        style = if (state.active) VisorButtonStyle.DANGER else VisorButtonStyle.GHOST
    )
    if (showing) VisorAlertDialog(
        onDismissRequest = { showing = false; code = "" },
        title = "投屏到 HUD",
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                DialogText("手机与 RDK 连接同一 Wi-Fi，输入 RDK HUD 屏幕上的地址和连接码。")
                VisorTextField(address, { address = it }, "RDK 地址，例如 192.168.1.20:8080", mono = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                VisorTextField(code, { code = it }, "六位连接码", secret = true, mono = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                Text(state.status, color = c.text, style = VisorType.bodySmall, modifier = Modifier.fillMaxWidth())
                DialogText("开发版 Wi-Fi 原型：仅在可信网络使用。退出到后台会断开 HUD；连接中断后请手动重连。")
            }
        },
        confirmButton = {
            VisorButton(
                text = if (state.active) "断开 HUD" else "开始投屏",
                enabled = BuildConfig.DEBUG,
                style = VisorButtonStyle.PRIMARY,
                onClick = { if (state.active) client.stop() else { client.connect(address, code); code = "" } }
            )
        },
        dismissButton = { VisorButton("完成", { showing = false; code = "" }, style = VisorButtonStyle.GHOST) }
    )
}
