package com.horizon.maxhelmet.ui.theme

import android.app.Activity
import android.graphics.drawable.ColorDrawable
import android.view.View
import android.view.Window
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import com.horizon.maxhelmet.ui.LocalAppLanguage
import com.horizon.maxhelmet.ui.Localization
import kotlin.math.roundToInt

/**
 * "Visor" design system. This file is the single source of tokens: surfaces,
 * lines, text, accent, semantic colours, shapes, spacing, type and motion. A
 * [VisorTemplate] (see VisorTemplates.kt) supplies a complete set of them
 * (dark or light); [VisorTheme] publishes the active template's colours, shapes,
 * type and metrics through CompositionLocals, so composables read them through
 * [Visor], [VisorShapes] and [VisorType] and never from literals. Switching the
 * template recomposes every screen.
 */
@Immutable
data class VisorColors(
    // Surfaces (flat fills, hierarchy by step rather than borders).
    val bg: Color = Color(0xFF0B0C0E),
    val surface1: Color = Color(0xFF131518),
    val surface2: Color = Color(0xFF1A1D21),
    val surface3: Color = Color(0xFF23272C),
    // Hairlines: white at 8% / 14% in the dark templates.
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
    val ok: Color = Color(0xFF3DDC97),
    // Added with the templates; defaults equal the original dark values.
    val lineHover: Color = Color.White.copy(alpha = 0.22f),
    val onDanger: Color = Color(0xFF0B0C0E),
    val onWarn: Color = Color(0xFF0B0C0E),
    val scrim: Color = Color.Black.copy(alpha = 0.64f),
    /** Opacity of the -soft tints (selected states, banners, chips): 14% dark, 12% light. */
    val softAlpha: Float = 0.14f
) {
    /** Accent at [softAlpha]: selected backgrounds and soft fills. */
    val accentSoft: Color get() = accent.copy(alpha = softAlpha)
    val userSoft: Color get() = user.copy(alpha = softAlpha)
    val dangerSoft: Color get() = danger.copy(alpha = softAlpha)
    val warnSoft: Color get() = warn.copy(alpha = softAlpha)
    val okSoft: Color get() = ok.copy(alpha = softAlpha)

    /** A translucent tint of any semantic colour, for chips, banners and selected fills. */
    fun soft(color: Color): Color = color.copy(alpha = softAlpha)

    companion object {
        val DEFAULT_ACCENT = Color(0xFFC6F432)
    }
}

/** Builds the token set for a (possibly branded) accent over the default (visor) palette. */
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

/** Corner radii of a template: controls, cards, sheets and pills. */
@Immutable
data class VisorRadii(
    val control: Dp = 10.dp,
    val card: Dp = 16.dp,
    val sheet: Dp = 24.dp,
    val pill: Dp = 999.dp
)

/** The template's shapes, built from its [VisorRadii]. */
@Immutable
data class VisorShapeSet(
    val control: RoundedCornerShape,
    val card: RoundedCornerShape,
    val sheet: RoundedCornerShape,
    val sheetAll: RoundedCornerShape,
    val pill: RoundedCornerShape
) {
    companion object {
        fun of(r: VisorRadii) = VisorShapeSet(
            control = RoundedCornerShape(r.control),
            card = RoundedCornerShape(r.card),
            sheet = RoundedCornerShape(topStart = r.sheet, topEnd = r.sheet),
            sheetAll = RoundedCornerShape(r.sheet),
            pill = RoundedCornerShape(r.pill)
        )
    }
}

/** Shapes of the active template: control, card, sheet (top corners) and pill. */
object VisorShapes {
    val control: RoundedCornerShape @Composable @ReadOnlyComposable get() = LocalVisorShapes.current.control
    val card: RoundedCornerShape @Composable @ReadOnlyComposable get() = LocalVisorShapes.current.card
    val sheet: RoundedCornerShape @Composable @ReadOnlyComposable get() = LocalVisorShapes.current.sheet
    val sheetAll: RoundedCornerShape @Composable @ReadOnlyComposable get() = LocalVisorShapes.current.sheetAll
    val pill: RoundedCornerShape @Composable @ReadOnlyComposable get() = LocalVisorShapes.current.pill
}

/** A template's type scale in sp (the web's fs-12 ... fs-32). */
@Immutable
data class VisorTypeScale(
    val fs12: Float = 12f,
    val fs13: Float = 13f,
    val fs15: Float = 15f,
    val fs17: Float = 17f,
    val fs22: Float = 22f,
    val fs32: Float = 32f
)

/** Text styles derived from a [VisorTypeScale]; default sans, monospace only for numbers, timings, ids. */
@Immutable
data class VisorTypeSet(
    val caption: TextStyle,
    val label: TextStyle,
    val bodySmall: TextStyle,
    val body: TextStyle,
    val title: TextStyle,
    val headline: TextStyle,
    val display: TextStyle,
    val monoCaption: TextStyle,
    val mono: TextStyle,
    val monoLarge: TextStyle
) {
    companion object {
        // Line height follows the size at the original 12/16, 13/18, 15/22, 17/24, 22/28, 32/38 ratios.
        private fun lh(size: Float, ratio: Float) = (size * ratio).roundToInt().sp

        fun of(s: VisorTypeScale) = VisorTypeSet(
            caption = TextStyle(fontSize = s.fs12.sp, lineHeight = lh(s.fs12, 16f / 12f)),
            label = TextStyle(fontSize = s.fs13.sp, lineHeight = lh(s.fs13, 18f / 13f), fontWeight = FontWeight.Medium),
            bodySmall = TextStyle(fontSize = s.fs13.sp, lineHeight = lh(s.fs13, 18f / 13f)),
            body = TextStyle(fontSize = s.fs15.sp, lineHeight = lh(s.fs15, 22f / 15f)),
            title = TextStyle(fontSize = s.fs17.sp, lineHeight = lh(s.fs17, 24f / 17f), fontWeight = FontWeight.SemiBold),
            headline = TextStyle(fontSize = s.fs22.sp, lineHeight = lh(s.fs22, 28f / 22f), fontWeight = FontWeight.SemiBold),
            display = TextStyle(fontSize = s.fs32.sp, lineHeight = lh(s.fs32, 38f / 32f), fontWeight = FontWeight.SemiBold),
            monoCaption = TextStyle(fontSize = s.fs12.sp, lineHeight = lh(s.fs12, 16f / 12f), fontFamily = FontFamily.Monospace),
            mono = TextStyle(fontSize = s.fs13.sp, lineHeight = lh(s.fs13, 18f / 13f), fontFamily = FontFamily.Monospace),
            monoLarge = TextStyle(fontSize = s.fs22.sp, lineHeight = lh(s.fs22, 28f / 22f), fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
        )
    }
}

/** Type scale of the active template (visor: 12/13/15/17/22/32sp). */
object VisorType {
    val caption: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.caption
    val label: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.label
    val bodySmall: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.bodySmall
    val body: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.body
    val title: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.title
    val headline: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.headline
    val display: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.display
    val monoCaption: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.monoCaption
    val mono: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.mono
    val monoLarge: TextStyle @Composable @ReadOnlyComposable get() = LocalVisorType.current.monoLarge
}

/** Non-colour, non-shape numbers of a template: stroke widths, glow, disabled fade, scheme. */
@Immutable
data class VisorMetrics(
    /** Hairline width (web `line-w`): 1dp, 2dp in beacon. */
    val lineWidth: Dp = 1.dp,
    /** Focus ring width (web `focus-w`). */
    val focusWidth: Dp = 2.dp,
    /** Scale of the visor's accent vignette, 0..1 (0 = none). */
    val glow: Float = 1f,
    /** How far disabled controls fade: their remaining opacity. */
    val disabledOpacity: Float = 0.5f,
    val isLight: Boolean = false
)

/** Motion: 160-240ms ease-out. */
object VisorMotion {
    const val FAST = 160
    const val BASE = 200
    const val SLOW = 240
    val easeOut = CubicBezierEasing(0f, 0f, 0.2f, 1f)
}

val LocalVisorColors = compositionLocalOf { VisorColors() }
val LocalVisorShapes = compositionLocalOf { VisorShapeSet.of(VisorRadii()) }
val LocalVisorType = compositionLocalOf { VisorTypeSet.of(VisorTypeScale()) }
val LocalVisorMetrics = compositionLocalOf { VisorMetrics() }

/** Token access: `Visor.colors.accent`, `Visor.metrics.lineWidth`. */
object Visor {
    val colors: VisorColors
        @Composable @ReadOnlyComposable get() = LocalVisorColors.current
    val metrics: VisorMetrics
        @Composable @ReadOnlyComposable get() = LocalVisorMetrics.current
}

/** The Material3 colour scheme mapped from a template's tokens (light scheme for light templates). */
internal fun visorColorScheme(c: VisorColors, light: Boolean): ColorScheme {
    val scheme = if (light) lightColorScheme() else darkColorScheme()
    return scheme.copy(
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
        onError = c.onDanger,
        errorContainer = c.dangerSoft,
        onErrorContainer = c.danger,
        inverseSurface = c.text,
        inverseOnSurface = c.bg,
        scrim = if (light) c.text else Color.Black
    )
}

private fun visorTypography(t: VisorTypeSet) = Typography(
    displayLarge = t.display,
    displayMedium = t.display,
    displaySmall = t.display,
    headlineLarge = t.headline,
    headlineMedium = t.headline,
    headlineSmall = t.title,
    titleLarge = t.title,
    titleMedium = t.body.copy(fontWeight = FontWeight.SemiBold),
    titleSmall = t.label,
    bodyLarge = t.body,
    bodyMedium = t.bodySmall,
    bodySmall = t.caption,
    labelLarge = t.label,
    labelMedium = t.caption.copy(fontWeight = FontWeight.Medium),
    labelSmall = t.caption
)

/**
 * Makes the status and navigation bars follow the template: bar colour (pre-edge-to-edge
 * devices and the window background) and light/dark icons through the insets controller.
 */
@Composable
private fun SystemBarsEffect(bg: Color, light: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return
    SideEffect {
        val window = (view.context as? Activity)?.window ?: return@SideEffect
        applySystemBars(window, view, bg, light)
    }
}

@Suppress("DEPRECATION")
internal fun applySystemBars(window: Window, view: View, bg: Color, light: Boolean) {
    window.setBackgroundDrawable(ColorDrawable(bg.toArgb()))
    window.statusBarColor = bg.toArgb()
    window.navigationBarColor = bg.toArgb()
    val controller = WindowCompat.getInsetsController(window, view)
    controller.isAppearanceLightStatusBars = light
    controller.isAppearanceLightNavigationBars = light
}

/**
 * Dialog windows (gallery, navigation details, crash overlay) are separate windows with their
 * own system-bar appearance; call this inside the dialog content so they follow the template too.
 */
@Composable
fun DialogSystemBars() {
    val view = LocalView.current
    val bg = Visor.colors.bg
    val light = Visor.metrics.isLight
    if (view.isInEditMode) return
    SideEffect {
        val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
        applySystemBars(window, view, bg, light)
    }
}

/**
 * Applies a template: its colours, shapes, type and metrics through the CompositionLocals,
 * the mapped Material3 scheme (light for light templates) and the system bars.
 */
@Composable
fun VisorTheme(template: VisorTemplate = VisorTemplates.VISOR, content: @Composable () -> Unit) {
    val shapes = remember(template.radii) { VisorShapeSet.of(template.radii) }
    val type = remember(template.type) { VisorTypeSet.of(template.type) }
    val scheme = remember(template.colors, template.metrics.isLight) { visorColorScheme(template.colors, template.metrics.isLight) }
    val typography = remember(type) { visorTypography(type) }
    SystemBarsEffect(template.colors.bg, template.metrics.isLight)
    CompositionLocalProvider(
        LocalVisorColors provides template.colors,
        LocalVisorShapes provides shapes,
        LocalVisorType provides type,
        LocalVisorMetrics provides template.metrics,
        LocalAppLanguage provides Localization.language
    ) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}

@Composable
fun MaxHelmetTheme(content: @Composable () -> Unit) = VisorTheme(content = content)
