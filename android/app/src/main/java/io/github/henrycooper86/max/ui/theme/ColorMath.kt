package io.github.henrycooper86.max.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

// Colour arithmetic for the design templates: a port of the web client's
// src/lib/color.ts (WCAG relative luminance and contrast, the ink that reads best
// on a fill, and the "nudge toward the text colour" legibility fix), so the three
// clients derive the same on-accent inks and brand-accent adjustments.

private fun channel255(v: Float): Int = (v * 255f).roundToInt().coerceIn(0, 255)

private fun linear(channel: Int): Double {
    val c = channel / 255.0
    return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
}

private fun luminance(color: Color): Double =
    0.2126 * linear(channel255(color.red)) + 0.7152 * linear(channel255(color.green)) + 0.0722 * linear(channel255(color.blue))

/** [top] flattened onto an opaque [backdrop]. */
private fun composite(top: Color, backdrop: Color): Color {
    val a = top.alpha
    fun mix(front: Float, back: Float) = front * a + back * (1f - a)
    return Color(mix(top.red, backdrop.red), mix(top.green, backdrop.green), mix(top.blue, backdrop.blue), 1f)
}

/** WCAG contrast ratio of [foreground] over [background] (translucent colours are flattened onto [backdrop], default black). */
fun contrastRatio(foreground: Color, background: Color, backdrop: Color = Color.Black): Double {
    val solidBack = composite(background, backdrop)
    val solidFront = composite(foreground, solidBack)
    val lf = luminance(solidFront)
    val lb = luminance(solidBack)
    return (max(lf, lb) + 0.05) / (min(lf, lb) + 0.05)
}

/** Whichever ink reads with more contrast on [fill]. Ties go to the dark ink. */
fun inkOn(fill: Color, darkInk: Color, lightInk: Color): Color =
    if (contrastRatio(darkInk, fill) >= contrastRatio(lightInk, fill)) darkInk else lightInk

/**
 * Moves [color] toward [target] in 5% steps until it reaches [minimum] contrast on
 * [background], keeping as much of the original hue as it can. Returns the colour
 * unchanged when it already passes.
 */
fun ensureContrast(color: Color, background: Color, target: Color, minimum: Double): Color {
    if (contrastRatio(color, background) >= minimum) return color
    for (step in 1..20) {
        val t = step / 20f
        val mixed = Color(
            channel255(color.red + (target.red - color.red) * t) / 255f,
            channel255(color.green + (target.green - color.green) * t) / 255f,
            channel255(color.blue + (target.blue - color.blue) * t) / 255f,
            1f
        )
        if (contrastRatio(mixed, background) >= minimum) return mixed
    }
    return Color(channel255(target.red) / 255f, channel255(target.green) / 255f, channel255(target.blue) / 255f, 1f)
}
