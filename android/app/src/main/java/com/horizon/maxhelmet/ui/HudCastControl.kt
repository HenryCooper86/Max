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
        text = if (state.active) tr(Str.HUD_DISCONNECT) else tr(Str.HUD_CAST),
        onClick = { if (state.active) client.stop() else showing = true },
        style = if (state.active) VisorButtonStyle.DANGER else VisorButtonStyle.GHOST
    )
    if (showing) VisorAlertDialog(
        onDismissRequest = { showing = false; code = "" },
        title = tr(Str.HUD_CAST),
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(VisorSpace.x3)) {
                DialogText(tr(Str.HUD_HELP))
                VisorTextField(address, { address = it }, tr(Str.HUD_ADDRESS), mono = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                VisorTextField(code, { code = it }, tr(Str.HUD_CODE), secret = true, mono = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                Text(state.status, color = c.text, style = VisorType.bodySmall, modifier = Modifier.fillMaxWidth())
                DialogText(tr(Str.HUD_NOTE))
            }
        },
        confirmButton = {
            VisorButton(
                text = if (state.active) tr(Str.HUD_DISCONNECT) else tr(Str.HUD_START),
                enabled = BuildConfig.DEBUG,
                style = VisorButtonStyle.PRIMARY,
                onClick = { if (state.active) client.stop() else { client.connect(address, code); code = "" } }
            )
        },
        dismissButton = { VisorButton(tr(Str.DONE), { showing = false; code = "" }, style = VisorButtonStyle.GHOST) }
    )
}
