package com.horizon.maxhelmet.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.horizon.maxhelmet.ui.theme.AppearanceInput
import com.horizon.maxhelmet.ui.theme.TemplateSource
import com.horizon.maxhelmet.ui.theme.VisorScheme
import com.horizon.maxhelmet.ui.theme.VisorTemplates
import com.horizon.maxhelmet.ui.theme.contrastRatio
import com.horizon.maxhelmet.ui.theme.ensureContrast
import com.horizon.maxhelmet.ui.theme.resolveAppearance
import com.horizon.maxhelmet.ui.theme.sanitizeThemeOverrides
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VisorTemplatesTest {
    @Test
    fun `five built-in templates with unique ids and the right schemes`() {
        assertEquals(listOf("visor", "daylight", "beacon", "ember", "holo"), VisorTemplates.ALL.map { it.id })
        assertEquals(VisorScheme.LIGHT, VisorTemplates.DAYLIGHT.scheme)
        listOf("visor", "beacon", "ember", "holo").forEach { assertEquals(VisorScheme.DARK, VisorTemplates.find(it)!!.scheme) }
        assertTrue(VisorTemplates.DAYLIGHT.metrics.isLight)
        assertNull(VisorTemplates.find("nope"))
        assertNull(VisorTemplates.find(null))
    }

    @Test
    fun `every template is complete and readable`() {
        VisorTemplates.ALL.forEach { t ->
            val c = t.colors
            assertTrue(t.id, t.label.isNotBlank() && t.description.isNotBlank())
            listOf(c.bg, c.surface1, c.surface2, c.surface3, c.text, c.textSecondary, c.textTertiary, c.accent, c.onAccent, c.user, c.danger, c.warn, c.ok, c.onDanger, c.onWarn)
                .forEach { assertEquals("${t.id} opaque", 1f, it.alpha, 0f) }
            listOf(c.line, c.lineStrong, c.lineHover, c.scrim, c.accentSoft, c.userSoft, c.dangerSoft, c.warnSoft, c.okSoft)
                .forEach { assertTrue("${t.id} translucent token present", it.alpha > 0f) }
            assertTrue(t.id, t.radii.control < t.radii.card && t.radii.card < t.radii.sheet)
            assertTrue(t.id, t.type.fs12 < t.type.fs13 && t.type.fs13 < t.type.fs15 && t.type.fs15 < t.type.fs17 && t.type.fs17 < t.type.fs22 && t.type.fs22 < t.type.fs32)
            // The text tiers and accent must read on the card surface (WCAG AA for body text).
            assertTrue("${t.id} text", contrastRatio(c.text, c.surface1) >= 7.0)
            assertTrue("${t.id} secondary", contrastRatio(c.textSecondary, c.surface1) >= 4.5)
            assertTrue("${t.id} tertiary", contrastRatio(c.textTertiary, c.bg) >= 3.0)
            assertTrue("${t.id} accent", contrastRatio(c.accent, c.surface1) >= 4.5)
            assertTrue("${t.id} on-accent", contrastRatio(c.onAccent, c.accent) >= 4.5)
        }
    }

    @Test
    fun `visor values match the web template exactly`() {
        val t = VisorTemplates.VISOR
        assertEquals(Color(0xFF0B0C0E), t.colors.bg)
        assertEquals(Color(0xFF1A1D21), t.colors.surface2)
        assertEquals(Color(0xFFC6F432), t.colors.accent)
        assertEquals(Color(0xFF0B0C0E), t.colors.onAccent)
        assertEquals(0.14f, t.colors.softAlpha, 0f)
        assertEquals(16.dp, t.radii.card)
        assertEquals(15f, t.type.fs15, 0f)
        assertEquals(1.dp, t.metrics.lineWidth)
        assertEquals(1f, t.metrics.glow, 0f)
    }

    @Test
    fun `daylight is a light scheme with ink text and cobalt accent`() {
        val t = VisorTemplates.DAYLIGHT
        assertEquals(Color(0xFFF4F5F3), t.colors.bg)
        assertEquals(Color(0xFFFFFFFF), t.colors.surface1)
        assertEquals(Color(0xFF0D1014), t.colors.text)
        assertEquals(Color(0xFF1336E8), t.colors.accent)
        assertEquals(Color.White, t.colors.onAccent)
        assertEquals(Color(0xFFB5121A), t.colors.danger)
        assertEquals(0.12f, t.colors.softAlpha, 0f)
        assertEquals(0.12f, t.colors.line.alpha, 0.005f)
        assertEquals(t.colors.text.red, t.colors.line.red, 0.001f)
        assertEquals(8.dp, t.radii.control)
        assertEquals(0.45f, t.metrics.glow, 0f)
    }

    @Test
    fun `beacon is high contrast with larger type and thicker lines`() {
        val t = VisorTemplates.BEACON
        assertEquals(Color(0xFF000000), t.colors.bg)
        assertEquals(Color(0xFFFFE500), t.colors.accent)
        assertEquals(Color(0xFFD6D6D6), t.colors.textTertiary)
        assertEquals(Color(0xFF8A8A8A), t.colors.line)
        assertEquals(0.2f, t.colors.softAlpha, 0f)
        assertEquals(15f, t.type.fs12, 0f)
        assertEquals(40f, t.type.fs32, 0f)
        assertEquals(2.dp, t.metrics.lineWidth)
        assertEquals(3.dp, t.metrics.focusWidth)
        assertEquals(0f, t.metrics.glow, 0f)
        assertEquals(0.72f, t.metrics.disabledOpacity, 0f)
        assertEquals(12.dp, t.radii.card)
        assertTrue(t.type.fs15 > VisorTemplates.VISOR.type.fs15)
    }

    @Test
    fun `ember and holo spot values`() {
        assertEquals(Color(0xFF14100D), VisorTemplates.EMBER.colors.bg)
        assertEquals(Color(0xFFFFA631), VisorTemplates.EMBER.colors.accent)
        assertEquals(26.dp, VisorTemplates.EMBER.radii.sheet)
        assertEquals(0.8f, VisorTemplates.EMBER.metrics.glow, 0f)
        assertEquals(Color(0xFF4AE3FF), VisorTemplates.HOLO.colors.accent)
        assertEquals(0.16f, VisorTemplates.HOLO.colors.softAlpha, 0f)
        assertEquals(30.dp, VisorTemplates.HOLO.radii.sheet)
    }

    // ---- precedence -------------------------------------------------------------------------

    @Test
    fun `default is visor`() {
        val a = resolveAppearance(AppearanceInput())
        assertEquals("visor", a.base.id)
        assertEquals(TemplateSource.DEFAULT, a.source)
        assertEquals(VisorTemplates.VISOR.colors, a.template.colors)
    }

    @Test
    fun `relay template beats default, unknown relay id falls back`() {
        assertEquals("beacon", resolveAppearance(AppearanceInput(relayTemplate = "beacon")).base.id)
        assertEquals(TemplateSource.RELAY, resolveAppearance(AppearanceInput(relayTemplate = "beacon")).source)
        assertEquals("visor", resolveAppearance(AppearanceInput(relayTemplate = "plaid")).base.id)
    }

    @Test
    fun `wearer choice beats the relay unless pinned`() {
        val free = resolveAppearance(AppearanceInput(relayTemplate = "ember", wearerTemplate = "daylight"))
        assertEquals("daylight", free.base.id)
        assertEquals(TemplateSource.WEARER, free.source)
        val pinned = resolveAppearance(AppearanceInput(relayTemplate = "ember", wearerTemplate = "daylight", templateSwitching = false))
        assertEquals("ember", pinned.base.id)
        assertEquals(TemplateSource.RELAY, pinned.source)
        assertEquals("visor", resolveAppearance(AppearanceInput(wearerTemplate = "daylight", templateSwitching = false)).base.id)
        assertEquals("ember", resolveAppearance(AppearanceInput(relayTemplate = "ember", wearerTemplate = "bogus")).base.id)
    }

    @Test
    fun `relay overrides apply over the wearer template and recompute on-accent`() {
        val a = resolveAppearance(
            AppearanceInput(
                relayTemplate = "ember", wearerTemplate = "daylight",
                theme = mapOf("accent" to "#112233", "radius-card" to "20px", "bg" to "#ff0000")
            )
        )
        assertEquals(Color(0xFF112233), a.template.colors.accent)
        assertEquals(Color.White, a.template.colors.onAccent)
        assertEquals(20.dp, a.template.radii.card)
        // Surface colours are not overridable.
        assertEquals(VisorTemplates.DAYLIGHT.colors.bg, a.template.colors.bg)
        assertEquals(VisorTemplates.DAYLIGHT.radii.control, a.template.radii.control)
        assertEquals(0.12f, a.template.colors.accentSoft.alpha, 0.005f)
    }

    @Test
    fun `brand accent wins over theme accent and is untouched in visor`() {
        val a = resolveAppearance(AppearanceInput(theme = mapOf("accent" to "#112233"), accentHex = "#3366FF"))
        assertEquals(Color(0xFF3366FF), a.template.colors.accent)
        // A pale accent on the light template is nudged toward the ink until it reads at 4.5:1.
        val pale = resolveAppearance(AppearanceInput(relayTemplate = "daylight", accentHex = "#FFE500"))
        val c = pale.template.colors
        assertTrue(contrastRatio(c.accent, c.surface1) >= 4.5)
        assertTrue(c.accent != Color(0xFFFFE500))
        // The visor keeps the brand accent exactly, even when pale.
        assertEquals(Color(0xFFFFE500), resolveAppearance(AppearanceInput(accentHex = "#FFE500")).template.colors.accent)
        // An accent that already passes is unchanged.
        assertEquals(Color(0xFF3366FF), resolveAppearance(AppearanceInput(relayTemplate = "daylight", accentHex = "#3366FF")).template.colors.accent)
    }

    @Test
    fun `ensureContrast leaves passing colours alone`() {
        val ok = Color(0xFF1336E8)
        assertEquals(ok, ensureContrast(ok, Color.White, Color.Black, 4.5))
    }

    // ---- override validation ----------------------------------------------------------------

    @Test
    fun `theme override validation`() {
        val ok = sanitizeThemeOverrides(
            mapOf("accent" to "#AABBCC", "radius-control" to "12px", "radius-card" to "18", "radius-sheet" to "1.5rem", "radius-pill" to "999px")
        )
        assertEquals(Color(0xFFAABBCC), ok.accent)
        assertEquals(12.dp, ok.radiusControl)
        assertEquals(18.dp, ok.radiusCard)
        assertEquals(24.dp, ok.radiusSheet)
        assertEquals(999.dp, ok.radiusPill)

        val bad = sanitizeThemeOverrides(
            mapOf(
                "accent" to "red", "radius-control" to "-4px", "radius-card" to "99px", "radius-sheet" to "calc(1px)",
                "radius-pill" to "10000px", "text" to "#ffffff", "font-display" to "Comic Sans"
            )
        )
        assertTrue(bad.isEmpty)
        assertNull(sanitizeThemeOverrides(mapOf("accent" to "#12345")).accent)
        assertNull(sanitizeThemeOverrides(mapOf("accent" to "112233")).accent)
        assertNull(sanitizeThemeOverrides(mapOf("accent" to "#GGHHII")).accent)
        assertNotNull(sanitizeThemeOverrides(mapOf("radius-card" to "0")).radiusCard)
        assertTrue(sanitizeThemeOverrides(null).isEmpty)
    }
}
