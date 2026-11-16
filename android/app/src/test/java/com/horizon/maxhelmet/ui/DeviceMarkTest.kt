package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.LogoFormat
import com.horizon.maxhelmet.agent.logoFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceMarkTest {
    @Test
    fun `profile selects its own mark`() {
        assertEquals(8, DEVICE_PROFILES.size)
        DEVICE_PROFILES.forEach {
            assertEquals(it, deviceMarkProfile(it, DeviceKind.OTHER))
            assertNotEquals("mark resource for $it", 0, deviceMarkRes(it))
        }
        assertEquals(8, DEVICE_PROFILES.map(::deviceMarkRes).toSet().size)
        assertEquals("vr-headset", deviceMarkProfile(" VR-Headset ", DeviceKind.HELMET))
    }

    @Test
    fun `falls back by device family`() {
        assertEquals("motorcycle-helmet", deviceMarkProfile(null, DeviceKind.HELMET))
        assertEquals("smart-glasses", deviceMarkProfile(null, DeviceKind.GLASSES))
        assertEquals("wearable", deviceMarkProfile(null, DeviceKind.OTHER))
        assertEquals("wearable", deviceMarkProfile(null, null))
        assertEquals("smart-glasses", deviceMarkProfile("drone", DeviceKind.GLASSES))
    }

    @Test
    fun `logo content types and paths`() {
        assertEquals(LogoFormat.PNG, logoFormat("image/png"))
        assertEquals(LogoFormat.PNG, logoFormat("Image/PNG; charset=binary"))
        assertEquals(LogoFormat.SVG, logoFormat("image/svg+xml"))
        assertEquals(LogoFormat.OTHER, logoFormat("text/html"))
        assertEquals(LogoFormat.OTHER, logoFormat(null))
        assertEquals("/brand/logo?v=abc", safeLogoPath("/brand/logo?v=abc"))
        assertNull(safeLogoPath("https://evil.example/logo.png"))
        assertNull(safeLogoPath("//evil.example/logo.png"))
        assertNull(safeLogoPath(""))
        assertTrue(safeLogoPath("/a b") == null)
    }

    @Test
    fun `health parses the template, device and visualizer fields`() {
        val a = parseHealth(
            """{"assistant":{"name":"Aria","device":"glasses","deviceProfile":"Assistive-Glasses","deviceLabel":"Assistive glasses",
              "template":"beacon","templateSwitching":false,"visualizer":"ring",
              "theme":{"accent":"#112233","radius-card":"20px","bad":5},"logoUrl":"/brand/logo?v=1"}}"""
        )!!.assistant!!
        assertEquals("assistive-glasses", a.deviceProfile)
        assertEquals("Assistive glasses", a.deviceLabel)
        assertEquals("beacon", a.template)
        assertEquals(false, a.templateSwitching)
        assertEquals("ring", a.visualizer)
        assertEquals(mapOf("accent" to "#112233", "radius-card" to "20px"), a.theme)
        assertEquals("/brand/logo?v=1", a.logoUrl)
    }

    @Test
    fun `old relays leave the new fields at defaults`() {
        val a = parseHealth("""{"assistant":{"name":"Max","device":"helmet"}}""")!!.assistant!!
        assertNull(a.deviceProfile); assertNull(a.template); assertNull(a.visualizer); assertNull(a.logoUrl)
        assertEquals(true, a.templateSwitching)
        assertTrue(a.theme.isEmpty())
        assertNull(parseHealth("""{"assistant":{"logoUrl":"http://x/y.png"}}""")!!.assistant!!.logoUrl)
    }
}
