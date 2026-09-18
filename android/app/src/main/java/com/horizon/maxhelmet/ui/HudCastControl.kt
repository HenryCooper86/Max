package com.horizon.maxhelmet.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.navigation.HudCastClient

@Composable
fun HudCastControl(client: HudCastClient) {
    val state by client.state.collectAsState()
    var showing by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf(client.savedAddress) }
    var code by remember { mutableStateOf("") }
    TextButton(onClick = { if (state.active) client.stop() else showing = true }) {
        Text(if (state.active) "断开 HUD" else "投屏到 HUD")
    }
    if (showing) AlertDialog(
        onDismissRequest = { showing = false; code = "" },
        title = { Text("投屏到 HUD") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("手机与 RDK 连接同一 Wi-Fi，输入 RDK HUD 屏幕上的地址和连接码。")
                OutlinedTextField(address, { address = it }, label = { Text("RDK 地址，例如 192.168.1.20:8080") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                OutlinedTextField(code, { code = it }, label = { Text("六位连接码") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                Text(state.status)
                Text("开发版 Wi-Fi 原型：仅在可信网络使用。退出到后台会断开 HUD；连接中断后请手动重连。")
            }
        },
        confirmButton = {
            TextButton(enabled = BuildConfig.DEBUG, onClick = {
                if (state.active) client.stop() else { client.connect(address, code); code = "" }
            }) { Text(if (state.active) "断开 HUD" else "开始投屏") }
        },
        dismissButton = { TextButton(onClick = { showing = false; code = "" }) { Text("完成") } }
    )
}
