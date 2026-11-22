package io.github.henrycooper86.max.agent

import android.media.AudioDeviceInfo
import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val SPEAKER = 1
private const val EARPIECE = 2
private const val WIRED = 3
private const val USB = 4
private const val SCO = 5
private const val BLE = 6

private fun candidate(id: Int) = RouteCandidate(id, when (id) {
    SPEAKER -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    EARPIECE -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
    WIRED -> AudioDeviceInfo.TYPE_WIRED_HEADSET
    USB -> AudioDeviceInfo.TYPE_USB_HEADSET
    SCO -> AudioDeviceInfo.TYPE_BLUETOOTH_SCO
    else -> AudioDeviceInfo.TYPE_BLE_HEADSET
})

/** Records what the router asks of the platform, with devices that can appear and vanish. */
private class FakeCommunicationAudio(override val modernRouting: Boolean = true) : CommunicationAudio {
    var devices = mutableListOf(candidate(SPEAKER), candidate(EARPIECE))
    var current: Int? = null
    var refuse = false
    var scoAvailable = false
    var wired = false
    var scoStarts = 0
    var scoStops = 0
    override var mode = AudioManager.MODE_NORMAL
    override var speakerphoneOn = false
    override fun communicationCandidates() = devices.toList()
    override fun currentCommunicationDevice() = current
    override fun setCommunicationDevice(id: Int): Boolean = !refuse && devices.any { it.id == id }.also { if (it) current = id }
    override fun clearCommunicationDevice() { current = null }
    override fun bluetoothScoAvailable() = scoAvailable
    override fun wiredHeadsetOn() = wired
    override fun startBluetoothSco() { scoStarts++ }
    override fun stopBluetoothSco() { scoStops++ }
}

class AudioRouterTest {
    @Test
    fun `helmet headset beats a wired headset, which beats the speaker`() {
        val all = listOf(SPEAKER, EARPIECE, WIRED, USB, SCO).map(::candidate)
        assertEquals(SCO, chooseCommunicationDevice(all)!!.id)
        assertEquals(BLE, chooseCommunicationDevice(listOf(candidate(SPEAKER), candidate(BLE), candidate(WIRED)))!!.id)
        assertEquals(WIRED, chooseCommunicationDevice(listOf(candidate(EARPIECE), candidate(WIRED), candidate(SPEAKER)))!!.id)
        assertEquals(USB, chooseCommunicationDevice(listOf(candidate(USB), candidate(SPEAKER)))!!.id)
        assertEquals(SPEAKER, chooseCommunicationDevice(listOf(candidate(EARPIECE), candidate(SPEAKER)))!!.id)
        // The earpiece is inaudible inside a helmet: with nothing better, leave the platform default.
        assertNull(chooseCommunicationDevice(listOf(candidate(EARPIECE))))
    }

    @Test
    fun `older phones pick SCO, then a wired headset, then the speaker`() {
        assertEquals(LegacyRoute.BLUETOOTH_SCO, legacyRoute(bluetoothSco = true, wiredHeadset = true))
        assertEquals(LegacyRoute.WIRED, legacyRoute(bluetoothSco = false, wiredHeadset = true))
        assertEquals(LegacyRoute.SPEAKER, legacyRoute(bluetoothSco = false, wiredHeadset = false))
    }

    @Test
    fun `start routes to the headset and stop restores the rider's previous audio`() {
        val audio = FakeCommunicationAudio().apply { devices += candidate(SCO); speakerphoneOn = true; mode = AudioManager.MODE_RINGTONE }
        val router = AudioRouter(audio)

        assertTrue(router.startVoiceRouting())
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, audio.mode)
        assertEquals(SCO, audio.current)

        router.stopVoiceRouting()
        assertNull(audio.current)
        assertTrue(audio.speakerphoneOn)
        assertEquals(AudioManager.MODE_RINGTONE, audio.mode)
    }

    @Test
    fun `refresh follows a headset that connects and then drops`() {
        val audio = FakeCommunicationAudio()
        val router = AudioRouter(audio)
        assertFalse(router.startVoiceRouting())
        assertEquals(SPEAKER, audio.current)

        assertEquals(RouteChange(changed = false, bluetooth = false), router.refreshRouting())

        audio.devices += candidate(SCO)
        assertEquals(RouteChange(changed = true, bluetooth = true), router.refreshRouting())
        assertEquals(SCO, audio.current)

        audio.devices.removeAll { it.id == SCO }
        assertEquals(RouteChange(changed = true, bluetooth = false), router.refreshRouting())
        assertEquals(SPEAKER, audio.current)
    }

    @Test
    fun `refresh restores routing another app or a phone call reset`() {
        val audio = FakeCommunicationAudio().apply { devices += candidate(SCO) }
        val router = AudioRouter(audio)
        router.startVoiceRouting()

        // A cellular call leaves the phone in normal mode with no communication device.
        audio.mode = AudioManager.MODE_NORMAL
        audio.current = null

        assertEquals(RouteChange(changed = true, bluetooth = true), router.refreshRouting())
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, audio.mode)
        assertEquals(SCO, audio.current)
    }

    @Test
    fun `refresh leaves a ringing or active phone call alone`() {
        for (callMode in listOf(AudioManager.MODE_IN_CALL, AudioManager.MODE_RINGTONE, AudioManager.MODE_CALL_SCREENING)) {
            val audio = FakeCommunicationAudio()
            val router = AudioRouter(audio)
            router.startVoiceRouting()
            audio.mode = callMode
            audio.current = null
            audio.devices += candidate(SCO)

            assertEquals(RouteChange(changed = false, bluetooth = false), router.refreshRouting())
            assertEquals(callMode, audio.mode)
            assertNull(audio.current)
        }
    }

    @Test
    fun `older phones never switch a call to the loudspeaker`() {
        val audio = FakeCommunicationAudio(modernRouting = false).apply { scoAvailable = true }
        val router = AudioRouter(audio)
        assertTrue(router.startVoiceRouting())
        audio.mode = AudioManager.MODE_IN_CALL
        audio.speakerphoneOn = false
        audio.scoAvailable = false // the headset drops mid-call

        assertEquals(RouteChange(changed = false, bluetooth = true), router.refreshRouting())
        assertFalse(audio.speakerphoneOn)
        assertEquals(0, audio.scoStops)
        assertEquals(AudioManager.MODE_IN_CALL, audio.mode)

        // After the call the resume re-route catches up.
        audio.mode = AudioManager.MODE_NORMAL
        assertEquals(RouteChange(changed = true, bluetooth = false), router.refreshRouting())
        assertTrue(audio.speakerphoneOn)
    }

    @Test
    fun `refresh does nothing outside a session`() {
        val audio = FakeCommunicationAudio()
        assertNull(AudioRouter(audio).refreshRouting())
        assertEquals(AudioManager.MODE_NORMAL, audio.mode)
    }

    @Test
    fun `a refused headset falls back to phone audio instead of claiming bluetooth`() {
        val audio = FakeCommunicationAudio().apply { devices += candidate(SCO); refuse = true }
        assertFalse(AudioRouter(audio).startVoiceRouting())
    }

    @Test
    fun `older phones start and stop SCO as the headset comes and goes`() {
        val audio = FakeCommunicationAudio(modernRouting = false)
        val router = AudioRouter(audio)
        assertFalse(router.startVoiceRouting())
        assertTrue(audio.speakerphoneOn)

        audio.scoAvailable = true
        assertEquals(RouteChange(changed = true, bluetooth = true), router.refreshRouting())
        assertEquals(1, audio.scoStarts)
        assertFalse(audio.speakerphoneOn)
        assertEquals(RouteChange(changed = false, bluetooth = true), router.refreshRouting())

        audio.scoAvailable = false
        assertEquals(RouteChange(changed = true, bluetooth = false), router.refreshRouting())
        assertEquals(1, audio.scoStops)
        assertTrue(audio.speakerphoneOn)

        router.stopVoiceRouting()
        assertFalse(audio.speakerphoneOn)
    }
}
