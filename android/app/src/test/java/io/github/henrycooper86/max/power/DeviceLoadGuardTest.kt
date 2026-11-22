package io.github.henrycooper86.max.power

import android.os.PowerManager
import io.github.henrycooper86.max.actions.DeviceResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeLoadSource : DeviceLoadSource {
    var listener: ((Int, Boolean) -> Unit)? = null
    override fun start(onChange: (thermalStatus: Int, powerSave: Boolean) -> Unit) { listener = onChange }
    override fun stop() { listener = null }
    fun report(status: Int, powerSave: Boolean = false) = listener!!.invoke(status, powerSave)
}

class DeviceLoadGuardTest {
    private val source = FakeLoadSource()
    private val notices = mutableListOf<LoadNotice>()
    private val shed = mutableListOf<DeviceLoad>()
    private var now = 0L
    private val guard = DeviceLoadGuard(source, onNotice = { notices += it }, onShed = { shed += it }, clock = { now })

    @Test
    fun `platform thermal levels map onto three tiers`() {
        assertEquals(HeatLevel.NORMAL, heatLevel(PowerManager.THERMAL_STATUS_NONE))
        assertEquals(HeatLevel.NORMAL, heatLevel(PowerManager.THERMAL_STATUS_LIGHT))
        assertEquals(HeatLevel.NORMAL, heatLevel(PowerManager.THERMAL_STATUS_MODERATE))
        assertEquals(HeatLevel.SEVERE, heatLevel(PowerManager.THERMAL_STATUS_SEVERE))
        assertEquals(HeatLevel.CRITICAL, heatLevel(PowerManager.THERMAL_STATUS_CRITICAL))
        assertEquals(HeatLevel.CRITICAL, heatLevel(PowerManager.THERMAL_STATUS_EMERGENCY))
        assertEquals(HeatLevel.CRITICAL, heatLevel(PowerManager.THERMAL_STATUS_SHUTDOWN))
    }

    @Test
    fun `what each load still allows`() {
        assertTrue(DeviceLoad().videoAllowed)
        val hot = DeviceLoad(HeatLevel.SEVERE)
        // As on iOS: severe heat keeps a one-shot photo but stops multi-frame vision decoding.
        assertFalse(hot.videoAllowed); assertTrue(hot.photoAllowed); assertFalse(hot.visionAllowed); assertTrue(hot.extrasAllowed)
        val critical = DeviceLoad(HeatLevel.CRITICAL)
        assertFalse(critical.videoAllowed); assertFalse(critical.photoAllowed); assertFalse(critical.visionAllowed); assertFalse(critical.extrasAllowed)
        val saver = DeviceLoad(powerSave = true)
        assertFalse(saver.videoAllowed); assertTrue(saver.photoAllowed); assertTrue(saver.extrasAllowed)
    }

    @Test
    fun `getting hot stops video once and says so once`() {
        guard.start()
        source.report(PowerManager.THERMAL_STATUS_MODERATE)
        assertTrue(notices.isEmpty() && shed.isEmpty())

        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        source.report(PowerManager.THERMAL_STATUS_MODERATE)
        source.report(PowerManager.THERMAL_STATUS_SEVERE)

        // The second swing is inside the quiet period: neither re-warned nor re-cooled.
        assertEquals(listOf(LoadNotice.HOT, LoadNotice.RESTORED), notices)
        assertEquals(2, shed.size)
        assertEquals(HeatLevel.SEVERE, guard.load.heat)
    }

    @Test
    fun `a thermal status hovering at severe is announced once per quiet period`() {
        guard.start()
        repeat(40) { swing ->
            now = swing * 30_000L
            source.report(if (swing % 2 == 0) PowerManager.THERMAL_STATUS_SEVERE else PowerManager.THERMAL_STATUS_MODERATE)
        }
        // 20 minutes of swings every 30 s: warned at 0, 300, 600 and 900 s only.
        assertEquals(4, notices.count { it == LoadNotice.HOT })
        assertEquals(300_000L, LOAD_NOTICE_QUIET_MS)
    }

    @Test
    fun `cooling is only reported after a warning the rider heard`() {
        guard.start()
        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        source.report(PowerManager.THERMAL_STATUS_NONE)
        now = 60_000
        source.report(PowerManager.THERMAL_STATUS_SEVERE) // quiet period: not warned
        source.report(PowerManager.THERMAL_STATUS_NONE)
        assertEquals(listOf(LoadNotice.HOT, LoadNotice.RESTORED), notices)
    }

    @Test
    fun `only heat is spoken, the rest goes to the status line`() {
        assertTrue(LoadNotice.HOT.spoken)
        assertTrue(LoadNotice.CRITICAL.spoken)
        assertFalse(LoadNotice.POWER_SAVE.spoken)
        assertFalse(LoadNotice.RESTORED.spoken)
    }

    @Test
    fun `battery saver refuses new video but never stops a recording already running`() {
        assertFalse(DeviceLoad(powerSave = true).recordingMustStop)
        assertFalse(DeviceLoad().recordingMustStop)
        assertTrue(DeviceLoad(HeatLevel.SEVERE).recordingMustStop)
        assertTrue(DeviceLoad(HeatLevel.CRITICAL, powerSave = true).recordingMustStop)
        assertEquals("device.powerSave", loadRefusal("camera.record", mapOf("start" to true), DeviceLoad(powerSave = true))!!.reason)
    }

    @Test
    fun `critical sheds the extras, and easing to severe is not a fresh warning`() {
        guard.start()
        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        source.report(PowerManager.THERMAL_STATUS_CRITICAL)
        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        source.report(PowerManager.THERMAL_STATUS_EMERGENCY)

        assertEquals(listOf(LoadNotice.HOT, LoadNotice.CRITICAL), notices)
        assertEquals(listOf(HeatLevel.SEVERE, HeatLevel.CRITICAL, HeatLevel.CRITICAL), shed.map { it.heat })
        assertFalse(guard.load.extrasAllowed)
    }

    @Test
    fun `cooling down restores eligibility and tells the rider`() {
        guard.start()
        source.report(PowerManager.THERMAL_STATUS_CRITICAL)
        source.report(PowerManager.THERMAL_STATUS_LIGHT)
        assertEquals(listOf(LoadNotice.CRITICAL, LoadNotice.RESTORED), notices)
        assertTrue(guard.load.videoAllowed)
    }

    @Test
    fun `battery saver turns video off with its own notice`() {
        guard.start()
        source.report(PowerManager.THERMAL_STATUS_NONE, powerSave = true)
        source.report(PowerManager.THERMAL_STATUS_NONE, powerSave = true)
        assertEquals(listOf(LoadNotice.POWER_SAVE), notices)
        assertEquals(1, shed.size)
        // Already told video is off: getting hot on top of it still warns about the heat.
        source.report(PowerManager.THERMAL_STATUS_SEVERE, powerSave = true)
        assertEquals(listOf(LoadNotice.POWER_SAVE, LoadNotice.HOT), notices)
        source.report(PowerManager.THERMAL_STATUS_NONE, powerSave = false)
        assertEquals(LoadNotice.RESTORED, notices.last())
    }

    @Test
    fun `every change is published, including easing that needs no notice`() {
        val loads = mutableListOf<DeviceLoad>()
        val observed = DeviceLoadGuard(source, onNotice = { notices += it }, onShed = { shed += it }, onLoad = { loads += it }, clock = { now })
        observed.start()
        source.report(PowerManager.THERMAL_STATUS_CRITICAL)
        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        source.report(PowerManager.THERMAL_STATUS_SEVERE)
        assertEquals(listOf(DeviceLoad(HeatLevel.CRITICAL), DeviceLoad(HeatLevel.SEVERE)), loads)
        assertTrue(loads.last().extrasAllowed)
        assertEquals(listOf(LoadNotice.CRITICAL), notices)
    }

    @Test
    fun `stop unregisters, resets and ignores late reports`() {
        guard.start()
        val late = source.listener!!
        source.report(PowerManager.THERMAL_STATUS_CRITICAL)
        guard.stop()
        assertNull(source.listener)
        assertEquals(DeviceLoad(), guard.load)
        late(PowerManager.THERMAL_STATUS_SEVERE, false)
        assertEquals(listOf(LoadNotice.CRITICAL), notices)
        assertEquals(DeviceLoad(), guard.load)
    }

    @Test
    fun `hot or saving phones refuse the camera commands they cannot afford`() {
        val hot = DeviceLoad(HeatLevel.SEVERE)
        val critical = DeviceLoad(HeatLevel.CRITICAL)
        val saver = DeviceLoad(powerSave = true)
        val startVideo = mapOf<String, Any?>("start" to true)
        val stopVideo = mapOf<String, Any?>("start" to false)

        assertNull(loadRefusal("camera.record", startVideo, DeviceLoad()))
        assertEquals("device.hot", loadRefusal("camera.record", startVideo, hot)!!.reason)
        assertEquals("device.powerSave", loadRefusal("camera.record", startVideo, saver)!!.reason)
        // Stopping a recording always works; it is what the rider should do when hot.
        assertNull(loadRefusal("camera.record", stopVideo, critical))
        assertNull(loadRefusal("camera.photo", emptyMap(), hot))
        assertEquals("device.hot", loadRefusal("gallery.describe", emptyMap(), hot)!!.reason)
        assertEquals("device.hot", loadRefusal("camera.photo", emptyMap(), critical)!!.reason)
        assertEquals("device.hot", loadRefusal("gallery.describe", emptyMap(), critical)!!.reason)
        assertEquals("device.hot", loadRefusal("torch.set", mapOf("on" to true), critical)!!.reason)
        assertNull(loadRefusal("torch.set", mapOf("on" to false), critical))
        assertEquals("device.hot", loadRefusal("music.control", mapOf("control" to "play"), critical)!!.reason)
        assertNull(loadRefusal("music.control", mapOf("control" to "pause"), critical))
        // Voice-level actions the rider may need in an emergency are never refused.
        assertNull(loadRefusal("call.dial", mapOf("number" to "120"), critical))
        assertNull(loadRefusal("volume.set", mapOf("direction" to "up"), critical))
        assertEquals("denied", loadRefusal("camera.photo", emptyMap(), critical)!!.status)
        assertTrue(loadRefusal("camera.photo", emptyMap(), critical)!!.detail!!.isNotBlank())
        assertEquals(DeviceResult::class, loadRefusal("camera.photo", emptyMap(), critical)!!::class)
    }
}
