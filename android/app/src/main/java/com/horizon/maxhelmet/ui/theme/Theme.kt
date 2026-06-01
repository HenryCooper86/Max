package com.horizon.maxhelmet.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Design tokens ported from src/styles.css (:root variables). */
object HudColors {
    val Background = Color(0xFF101415)
    val Text = Color(0xFFEFF6F8)
    val Muted = Color(0xFF99AAA8)
    val Accent = Color(0xFF3EE89F)
    val AccentCyan = Color(0xFF5FE9D6)
    val Rider = Color(0xFFF26A3D)
    val Danger = Color(0xFFFF6F57)
    val Warn = Color(0xFFF2C14E)
    val Panel = Color(0xCC0B1112)
    val Border = Color(0x29C4DAD8)
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
