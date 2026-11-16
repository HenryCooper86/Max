package com.horizon.maxhelmet.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * "Visor" design system, dark only. This file is the single source of tokens:
 * surfaces, lines, text, accent, semantic colours, shapes, spacing, type and
 * motion. Composables read them through [Visor] (a CompositionLocal), never
 * from literals, so a branded build only has to change [VisorColors.accent].
 */
@Immutable
data class VisorColors(
    // Surfaces (flat fills, hierarchy by step rather than borders).
    val bg: Color = Color(0xFF0B0C0E),
    val surface1: Color = Color(0xFF131518),
    val surface2: Color = Color(0xFF1A1D21),
    val surface3: Color = Color(0xFF23272C),
    // Hairlines: white at 8% / 14%.
    val line: Color = Color.White.copy(alpha = 0.08f),
    val lineStrong: Color = Color.White.copy(alpha = 0.14f),
    // Text.
    val text: Color = Color(0xFFF2F4F5),
    val textSecondary: Color = Color(0xFFA3ABB3),
    val textTertiary: Color = Color(0xFF6B737C),
    // Accent: primary action, selected state, live voice state only.
    val accent: Color = DEFAULT_ACCENT,
    val onAccent: Color = Color(0xFF0B0C0E),
    // Semantic.
    val user: Color = Color(0xFFFF7A45),
    val danger: Color = Color(0xFFFF5A4D),
    val warn: Color = Color(0xFFFFC53D),
    val ok: Color = Color(0xFF3DDC97)
) {
    /** Accent at 14%: selected backgrounds and soft fills. */
    val accentSoft: Color get() = accent.copy(alpha = 0.14f)

    companion object {
        val DEFAULT_ACCENT = Color(0xFFC6F432)
    }
}

/** Builds the token set for a (possibly branded) accent. */
fun visorColors(accent: Color = VisorColors.DEFAULT_ACCENT): VisorColors = VisorColors(accent = accent)

/** Parses a relay-provided `#RRGGBB` accent; null when malformed. */
fun parseAccentHex(value: String?): Color? {
    val hex = value?.trim()?.removePrefix("#") ?: return null
    if (hex.length != 6) return null
    val rgb = hex.toLongOrNull(16) ?: return null
    return Color(0xFF000000L or rgb)
}

/** 4dp spacing scale. */
object VisorSpace {
    val x1 = 4.dp
    val x2 = 8.dp
    val x3 = 12.dp
    val x4 = 16.dp
    val x5 = 20.dp
    val x6 = 24.dp
    val x8 = 32.dp
}

/** Shapes: 10dp controls, 16dp cards, 24dp sheets, pill. */
object VisorShapes {
    val control = RoundedCornerShape(10.dp)
    val card = RoundedCornerShape(16.dp)
    val sheet = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val sheetAll = RoundedCornerShape(24.dp)
    val pill = RoundedCornerShape(50)
}

/** Type scale 12/13/15/17/22/32sp, default sans; monospace only for numbers, timings, ids. */
object VisorType {
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp)
    val label = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
    val bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
    val body = TextStyle(fontSize = 15.sp, lineHeight = 22.sp)
    val title = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
    val headline = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold)
    val display = TextStyle(fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold)
    val monoCaption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace)
    val mono = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace)
    val monoLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
}

/** Motion: 160-240ms ease-out. */
object VisorMotion {
    const val FAST = 160
    const val BASE = 200
    const val SLOW = 240
    val easeOut = CubicBezierEasing(0f, 0f, 0.2f, 1f)
}

val LocalVisorColors = compositionLocalOf { VisorColors() }

/** Token access: `Visor.colors.accent`. */
object Visor {
    val colors: VisorColors
        @Composable @ReadOnlyComposable get() = LocalVisorColors.current
}

private fun visorColorScheme(c: VisorColors) = darkColorScheme(
    primary = c.accent,
    onPrimary = c.onAccent,
    primaryContainer = c.accentSoft,
    onPrimaryContainer = c.accent,
    secondary = c.textSecondary,
    onSecondary = c.bg,
    secondaryContainer = c.surface3,
    onSecondaryContainer = c.text,
    tertiary = c.user,
    onTertiary = c.bg,
    background = c.bg,
    onBackground = c.text,
    surface = c.bg,
    onSurface = c.text,
    surfaceVariant = c.surface2,
    onSurfaceVariant = c.textSecondary,
    surfaceTint = Color.Transparent,
    surfaceContainerLowest = c.bg,
    surfaceContainerLow = c.surface1,
    surfaceContainer = c.surface1,
    surfaceContainerHigh = c.surface2,
    surfaceContainerHighest = c.surface3,
    outline = c.lineStrong,
    outlineVariant = c.line,
    error = c.danger,
    onError = c.bg,
    errorContainer = c.danger.copy(alpha = 0.16f),
    onErrorContainer = c.danger,
    scrim = Color.Black
)

private val VisorTypography = Typography(
    displayLarge = VisorType.display,
    displayMedium = VisorType.display,
    displaySmall = VisorType.display,
    headlineLarge = VisorType.headline,
    headlineMedium = VisorType.headline,
    headlineSmall = VisorType.title,
    titleLarge = VisorType.title,
    titleMedium = VisorType.body.copy(fontWeight = FontWeight.SemiBold),
    titleSmall = VisorType.label,
    bodyLarge = VisorType.body,
    bodyMedium = VisorType.bodySmall,
    bodySmall = VisorType.caption,
    labelLarge = VisorType.label,
    labelMedium = VisorType.caption.copy(fontWeight = FontWeight.Medium),
    labelSmall = VisorType.caption
)

/** Applies the Visor tokens (with an optionally branded accent) and the mapped Material3 scheme. */
@Composable
fun VisorTheme(accent: Color = VisorColors.DEFAULT_ACCENT, content: @Composable () -> Unit) {
    val colors = remember(accent) { visorColors(accent) }
    CompositionLocalProvider(LocalVisorColors provides colors) {
        MaterialTheme(
            colorScheme = remember(colors) { visorColorScheme(colors) },
            typography = VisorTypography,
            content = content
        )
    }
}

@Composable
fun MaxHelmetTheme(content: @Composable () -> Unit) = VisorTheme(content = content)
