package com.horizon.maxhelmet.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Design tokens ported from src/styles.css (:root variables). */
object HudColors {
    val Background = Color(0xFF101415)
    val Text = Color(0xFFEFF6F8)
    val Muted = Color(0xFFA7B8B6)
    val Accent = Color(0xFF3EE89F)
    val AccentCyan = Color(0xFF5FE9D6)
    val Rider = Color(0xFFF26A3D)
    val Danger = Color(0xFFFF6F57)
    val Warn = Color(0xFFF2C14E)
    val Panel = Color(0xCC0B1112)

    /** Softer raised surface for borderless cards (modern, production look). */
    val PanelElevated = Color(0xFF181F20)
    val Border = Color(0x29C4DAD8)

    // "Night Instrument" voice-HUD palette — mirrors the .voiceShell tokens in
    // src/styles.css. Green = live/ready, ember = the action, amber/red = the
    // safety ladder; the old cyan "listening" hue is retired.
    val Void = Color(0xFF0A0E0D)
    val Lume = Color(0xFF47E39B)
    val Ember = Color(0xFFFF6A3D)
    val Amber = Color(0xFFF5B843)
    val Red = Color(0xFFFF5B47)
    val HudInk = Color(0xFFECF3F0)
    val HudDim = Color(0xFF8A9A94)
    val Tick = Color(0xFF37443F)

    /** Dark ink for labels on the ember action key. */
    val OnEmber = Color(0xFF1A0E08)
}

private val DarkColorScheme = darkColorScheme(
    primary = HudColors.Accent,
    secondary = HudColors.AccentCyan,
    background = HudColors.Background,
    surface = HudColors.Background,
    surfaceVariant = Color(0xFF1A2122),
    onPrimary = Color(0xFF07221A),
    onBackground = HudColors.Text,
    onSurface = HudColors.Text,
    onSurfaceVariant = HudColors.Muted,
    error = HudColors.Danger
)

@Composable
fun MaxHelmetTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColorScheme, content = content)
}
