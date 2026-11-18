package io.github.henrycooper86.max.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Design templates: complete, named token sets for the Visor design system, one per kind of
// embodied device and light condition. A port of the web client's src/lib/templates.ts: the
// values (surfaces, lines, text tiers, accent, semantic colours, radii, type scale, line
// widths) are copied from there and must stay in step with it.
//
// Precedence, lowest first:
//   built-in default (visor) -> relay assistant.template -> the wearer's own choice
//   (unless the owner pinned the template) -> relay assistant.theme overrides
//   (accent and radius-* only) -> relay assistant.accentColor.

enum class VisorScheme { DARK, LIGHT }

/** Four colours for the picker's thumbnail. */
@Immutable
data class VisorSwatch(val bg: Color, val surface: Color, val text: Color, val accent: Color)

@Immutable
data class VisorTemplate(
    val id: String,
    /** Display name (Chinese, like the rest of the app). */
    /** Chinese display name; use [name] / [blurb] for the current language. */
    val label: String,
    val description: String,
    val scheme: VisorScheme,
    val colors: VisorColors,
    val radii: VisorRadii,
    val type: VisorTypeScale,
    val metrics: VisorMetrics
) {
    val swatch: VisorSwatch get() = VisorSwatch(colors.bg, colors.surface2, colors.text, colors.accent)
}

private fun rgb(hex: Long) = Color(0xFF000000L or hex)

/** The colours a template designs by hand; everything else is derived. */
private class Base(
    val bg: Long, val surface1: Long, val surface2: Long, val surface3: Long,
    val text: Long, val text2: Long, val text3: Long,
    val accent: Long, val user: Long, val danger: Long, val warn: Long, val ok: Long
)

private class Extras(
    val line: Color? = null,
    val lineStrong: Color? = null,
    val lineHover: Color? = null,
    val scrim: Color? = null,
    val radii: VisorRadii = VisorRadii(),
    val type: VisorTypeScale = VisorTypeScale(),
    val lineWidth: Dp = 1.dp,
    val focusWidth: Dp = 2.dp,
    val glow: Float = 1f,
    val disabledOpacity: Float = 0.5f
)

private val WHITE = Color.White

/**
 * Completes a template like the web's defineTemplate: line colours for the scheme, the soft-tint
 * opacity, and the inks that sit on solid accent/danger/warn fills (the template's darkest
 * colour or white, whichever reads better).
 */
private fun define(
    id: String, label: String, description: String, scheme: VisorScheme,
    base: Base, softAlpha: Float? = null, extras: Extras = Extras()
): VisorTemplate {
    val dark = scheme == VisorScheme.DARK
    val soft = softAlpha ?: if (dark) 0.14f else 0.12f
    val bg = rgb(base.bg)
    val text = rgb(base.text)
    val darkInk = if (dark) bg else text
    val accent = rgb(base.accent)
    val danger = rgb(base.danger)
    val warn = rgb(base.warn)
    val colors = VisorColors(
        bg = bg,
        surface1 = rgb(base.surface1),
        surface2 = rgb(base.surface2),
        surface3 = rgb(base.surface3),
        line = extras.line ?: if (dark) Color.White.copy(alpha = 0.08f) else text.copy(alpha = 0.12f),
        lineStrong = extras.lineStrong ?: if (dark) Color.White.copy(alpha = 0.14f) else text.copy(alpha = 0.22f),
        lineHover = extras.lineHover ?: if (dark) Color.White.copy(alpha = 0.22f) else text.copy(alpha = 0.36f),
        text = text,
        textSecondary = rgb(base.text2),
        textTertiary = rgb(base.text3),
        accent = accent,
        onAccent = inkOn(accent, darkInk, WHITE),
        user = rgb(base.user),
        danger = danger,
        onDanger = inkOn(danger, darkInk, WHITE),
        warn = warn,
        onWarn = inkOn(warn, darkInk, WHITE),
        ok = rgb(base.ok),
        scrim = extras.scrim ?: if (dark) Color.Black.copy(alpha = 0.64f) else text.copy(alpha = 0.32f),
        softAlpha = soft
    )
    return VisorTemplate(
        id = id, label = label, description = description, scheme = scheme,
        colors = colors, radii = extras.radii, type = extras.type,
        metrics = VisorMetrics(extras.lineWidth, extras.focusWidth, extras.glow, extras.disabledOpacity, isLight = !dark)
    )
}

object VisorTemplates {
    /** The original look: a calm dark instrument with one lime signal colour. */
    val VISOR = define(
        "visor", "护目镜", "默认深色界面，一种信号色", VisorScheme.DARK,
        Base(
            0x0B0C0E, 0x131518, 0x1A1D21, 0x23272C, 0xF2F4F5, 0xA3ABB3, 0x6B737C,
            0xC6F432, 0xFF7A45, 0xFF5A4D, 0xFFC53D, 0x3DDC97
        )
    )

    /** Bright outdoor use: white surfaces, ink text, deep cobalt; semantic colours darkened to read on white. */
    val DAYLIGHT = define(
        "daylight", "日光", "浅色高亮，适合户外阳光和太阳镜", VisorScheme.LIGHT,
        Base(
            0xF4F5F3, 0xFFFFFF, 0xECEEE9, 0xDFE2DC, 0x0D1014, 0x3D444D, 0x5A626C,
            0x1336E8, 0xA83808, 0xB5121A, 0x7D4A00, 0x08662F
        ),
        extras = Extras(radii = VisorRadii(8.dp, 14.dp, 20.dp), glow = 0.45f)
    )

    /** Low vision: pure black, white text, strong yellow, larger type, 2dp lines, 3dp focus ring, no glow. */
    val BEACON = define(
        "beacon", "灯塔", "高对比、大字号，适合低视力辅助眼镜", VisorScheme.DARK,
        Base(
            0x000000, 0x000000, 0x0D0D0D, 0x2E2E2E, 0xFFFFFF, 0xF0F0F0, 0xD6D6D6,
            0xFFE500, 0x7FE3FF, 0xFF6E61, 0xFFAB4A, 0x5DF5A8
        ),
        softAlpha = 0.2f,
        extras = Extras(
            line = rgb(0x8A8A8A), lineStrong = rgb(0xD6D6D6), lineHover = rgb(0xFFFFFF),
            scrim = Color.Black.copy(alpha = 0.86f),
            radii = VisorRadii(8.dp, 12.dp, 16.dp),
            type = VisorTypeScale(fs12 = 15f, fs13 = 16f, fs15 = 18f, fs17 = 21f, fs22 = 26f, fs32 = 40f),
            lineWidth = 2.dp, focusWidth = 3.dp, glow = 0f, disabledOpacity = 0.72f
        )
    )

    /** Night riding without blue light: warm charcoal, amber accent. */
    val EMBER = define(
        "ember", "余烬", "暖色深色，夜骑时减少蓝光", VisorScheme.DARK,
        Base(
            0x14100D, 0x1C1713, 0x251E19, 0x30271F, 0xF7E9D7, 0xCBB59C, 0x9A846C,
            0xFFA631, 0xFF8F6B, 0xFF6A52, 0xFFD45A, 0xB8D65C
        ),
        extras = Extras(
            line = Color(255, 214, 170).copy(alpha = 0.08f),
            lineStrong = Color(255, 214, 170).copy(alpha = 0.15f),
            lineHover = Color(255, 214, 170).copy(alpha = 0.24f),
            radii = VisorRadii(12.dp, 18.dp, 26.dp), glow = 0.8f
        )
    )

    /** AR/VR headsets: deep blue-black, cyan signal, cool-tinted lines, rounder corners. */
    val HOLO = define(
        "holo", "全息", "冷色深空，适合 AR 与 VR 头显", VisorScheme.DARK,
        Base(
            0x060914, 0x0C1122, 0x121A30, 0x1B2541, 0xEAF2FF, 0xA4B4D3, 0x7282A6,
            0x4AE3FF, 0xB995FF, 0xFF5F7E, 0xFFC95A, 0x4FF0B6
        ),
        softAlpha = 0.16f,
        extras = Extras(
            line = Color(150, 190, 255).copy(alpha = 0.10f),
            lineStrong = Color(150, 190, 255).copy(alpha = 0.18f),
            lineHover = Color(150, 190, 255).copy(alpha = 0.30f),
            radii = VisorRadii(14.dp, 22.dp, 30.dp)
        )
    )

    const val DEFAULT_ID = "visor"
    val ALL: List<VisorTemplate> = listOf(VISOR, DAYLIGHT, BEACON, EMBER, HOLO)

    fun find(id: String?): VisorTemplate? = id?.trim()?.let { key -> ALL.firstOrNull { it.id == key } }
}

// ---- relay theme overrides ----------------------------------------------------------------

/** The overrides the Android client honours from `assistant.theme`: accent and the radii. */
data class ThemeOverrides(
    val accent: Color? = null,
    val radiusControl: Dp? = null,
    val radiusCard: Dp? = null,
    val radiusSheet: Dp? = null,
    val radiusPill: Dp? = null
) {
    val isEmpty: Boolean get() = this == ThemeOverrides()
}

private val HEX6 = Regex("^#[0-9a-fA-F]{6}$")
private val LENGTH = Regex("^(\\d{1,4}(?:\\.\\d{1,3})?)(px|rem)?$")

/** A px number (`12`, `12px`, `0.75rem` = 12px) within 0..[max]; null when malformed or too large. */
internal fun parseRadius(raw: String?, max: Float): Dp? {
    val value = raw?.trim()?.lowercase() ?: return null
    if (value.isEmpty() || value.length > 48) return null
    val m = LENGTH.matchEntire(value) ?: return null
    val number = m.groupValues[1].toFloatOrNull() ?: return null
    val px = if (m.groupValues[2] == "rem") number * 16f else number
    return if (px.isFinite() && px in 0f..max) px.dp else null
}

/** Keeps only `accent` (a #RRGGBB) and the `radius-*` keys whose values are valid; everything else is dropped. */
fun sanitizeThemeOverrides(theme: Map<String, String>?): ThemeOverrides {
    if (theme.isNullOrEmpty()) return ThemeOverrides()
    val accent = theme["accent"]?.trim()?.takeIf { HEX6.matches(it) }?.let { parseAccentHex(it) }
    return ThemeOverrides(
        accent = accent,
        radiusControl = parseRadius(theme["radius-control"], 64f),
        radiusCard = parseRadius(theme["radius-card"], 64f),
        radiusSheet = parseRadius(theme["radius-sheet"], 64f),
        radiusPill = parseRadius(theme["radius-pill"], 9999f)
    )
}

// ---- precedence -----------------------------------------------------------------------------

enum class TemplateSource { DEFAULT, RELAY, WEARER }

data class AppearanceInput(
    val relayTemplate: String? = null,
    val wearerTemplate: String? = null,
    /** False when the owner pinned the template (and the voice display). */
    val templateSwitching: Boolean = true,
    val theme: Map<String, String> = emptyMap(),
    /** Relay `accentColor`, `#RRGGBB`. */
    val accentHex: String? = null
)

data class Appearance(
    /** The template before overrides: what the picker shows as selected. */
    val base: VisorTemplate,
    val source: TemplateSource,
    /** The template with theme overrides and the brand accent applied: what the UI renders. */
    val template: VisorTemplate
)

/** Resolves the effective template and its final token values (see the precedence list above). */
fun resolveAppearance(input: AppearanceInput): Appearance {
    val relay = VisorTemplates.find(input.relayTemplate)
    val owner = relay ?: VisorTemplates.VISOR
    val wearer = if (input.templateSwitching) VisorTemplates.find(input.wearerTemplate) else null
    val base = wearer ?: owner
    val source = when {
        wearer != null -> TemplateSource.WEARER
        relay != null -> TemplateSource.RELAY
        else -> TemplateSource.DEFAULT
    }
    var colors = base.colors
    var radii = base.radii
    val dark = base.scheme == VisorScheme.DARK
    val darkInk = if (dark) colors.bg else colors.text

    val overrides = sanitizeThemeOverrides(input.theme)
    overrides.accent?.let { colors = colors.copy(accent = it, onAccent = inkOn(it, darkInk, Color.White)) }
    radii = radii.copy(
        control = overrides.radiusControl ?: radii.control,
        card = overrides.radiusCard ?: radii.card,
        sheet = overrides.radiusSheet ?: radii.sheet,
        pill = overrides.radiusPill ?: radii.pill
    )

    parseAccentHex(input.accentHex)?.let { brand ->
        // The visor keeps its original behaviour. Every other template holds its contrast floor:
        // the accent doubles as text on surface-1 (selected segments, live values), so a brand
        // colour that would fail 4.5:1 there is nudged toward the template's text colour.
        val legible = if (base.id == VisorTemplates.DEFAULT_ID) brand else ensureContrast(brand, colors.surface1, colors.text, 4.5)
        colors = colors.copy(accent = legible, onAccent = inkOn(legible, darkInk, Color.White))
    }
    return Appearance(base, source, base.copy(colors = colors, radii = radii))
}
