package io.github.henrycooper86.max.agent

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log

/** A device the phone could use for two-way voice: AudioDeviceInfo id and type. */
data class RouteCandidate(val id: Int, val type: Int)

/** What a routing refresh did: whether the active device changed, and whether it is now a Bluetooth headset. */
data class RouteChange(val changed: Boolean, val bluetooth: Boolean)

enum class LegacyRoute { BLUETOOTH_SCO, WIRED, SPEAKER }

private val HEADSET_TYPES = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET)
private val WIRED_TYPES = setOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET)

/** The telephony modes: a ringing, active or screened phone call owns the route. */
private val CALL_MODES = setOf(AudioManager.MODE_IN_CALL, AudioManager.MODE_RINGTONE, AudioManager.MODE_CALL_SCREENING)

internal fun isCallMode(mode: Int): Boolean = mode in CALL_MODES

/**
 * The helmet headset first, then a wired headset, then the loudspeaker. Never
 * the earpiece: held away from the ear inside a helmet it is inaudible, so with
 * nothing better the platform default is left alone (null).
 */
fun chooseCommunicationDevice(available: List<RouteCandidate>): RouteCandidate? =
    available.firstOrNull { it.type in HEADSET_TYPES }
        ?: available.firstOrNull { it.type in WIRED_TYPES }
        ?: available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }

/** The same preference for Android 8-11, which only offer SCO on/off and the speakerphone switch. */
fun legacyRoute(bluetoothSco: Boolean, wiredHeadset: Boolean): LegacyRoute = when {
    bluetoothSco -> LegacyRoute.BLUETOOTH_SCO
    wiredHeadset -> LegacyRoute.WIRED
    else -> LegacyRoute.SPEAKER
}

/** The slice of AudioManager routing uses, so the decisions can be tested without a phone. */
interface CommunicationAudio {
    /** Android 12+ (setCommunicationDevice); older releases use SCO and the speakerphone switch. */
    val modernRouting: Boolean
    var mode: Int
    var speakerphoneOn: Boolean
    fun communicationCandidates(): List<RouteCandidate>
    fun currentCommunicationDevice(): Int?
    fun setCommunicationDevice(id: Int): Boolean
    fun clearCommunicationDevice()
    fun bluetoothScoAvailable(): Boolean
    fun wiredHeadsetOn(): Boolean
    fun startBluetoothSco()
    fun stopBluetoothSco()
}

@Suppress("DEPRECATION")
private class AndroidCommunicationAudio(private val manager: AudioManager) : CommunicationAudio {
    override val modernRouting = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    override var mode: Int
        get() = manager.mode
        set(value) { manager.mode = value }
    override var speakerphoneOn: Boolean
        get() = manager.isSpeakerphoneOn
        set(value) { manager.isSpeakerphoneOn = value }

    override fun communicationCandidates(): List<RouteCandidate> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager.availableCommunicationDevices.map { RouteCandidate(it.id, it.type) }
        } else emptyList()

    override fun currentCommunicationDevice(): Int? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.communicationDevice?.id else null

    override fun setCommunicationDevice(id: Int): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val device = manager.availableCommunicationDevices.firstOrNull { it.id == id } ?: return false
        return manager.setCommunicationDevice(device)
    }

    override fun clearCommunicationDevice() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.clearCommunicationDevice()
    }

    override fun bluetoothScoAvailable(): Boolean =
        manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }

    override fun wiredHeadsetOn(): Boolean = manager.isWiredHeadsetOn

    override fun startBluetoothSco() {
        manager.startBluetoothSco(); manager.isBluetoothScoOn = true
    }

    override fun stopBluetoothSco() {
        manager.stopBluetoothSco(); manager.isBluetoothScoOn = false
    }
}

/**
 * Keeps capture and agent playback on the communication path on speaker as
 * well as headsets. Music retains its separate media playback path. Every
 * method runs on the main thread (AgentSession and its device callback).
 */
class AudioRouter(private val audio: CommunicationAudio) {
    constructor(context: Context) : this(AndroidCommunicationAudio(context.getSystemService(Context.AUDIO_SERVICE) as AudioManager))

    private var active = false
    private var bluetooth = false
    private var legacy: LegacyRoute? = null
    private var previousMode = AudioManager.MODE_NORMAL
    private var previousSpeaker = false

    val hasBluetoothHeadset: Boolean
        get() = runCatching {
            if (audio.modernRouting) audio.communicationCandidates().any { it.type in HEADSET_TYPES }
            else audio.bluetoothScoAvailable()
        }.getOrDefault(false)

    fun startVoiceRouting(): Boolean {
        if (active) return bluetooth
        previousMode = audio.mode
        previousSpeaker = audio.speakerphoneOn
        return runCatching {
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            active = true
            if (audio.modernRouting) {
                val chosen = chooseCommunicationDevice(audio.communicationCandidates())
                bluetooth = chosen != null && audio.setCommunicationDevice(chosen.id) && chosen.type in HEADSET_TYPES
            } else {
                applyLegacy(legacyRoute(audio.bluetoothScoAvailable(), audio.wiredHeadsetOn()))
            }
            bluetooth
        }.getOrElse {
            Log.w("AudioRouter", "Headset unavailable; using phone voice audio", it)
            false
        }
    }

    /**
     * Re-applies the preferred route after a headset connects or drops, or after
     * a phone call or another app reset the audio mode. Returns null outside a
     * voice session, and changes nothing while a phone call has the audio.
     */
    fun refreshRouting(): RouteChange? {
        if (!active) return null
        // Re-asserting communication mode or the speakerphone over a phone call
        // can move the rider's call to the loudspeaker (Android 8-11 especially).
        // Leave the call alone; the resume after it re-routes.
        if (runCatching { audio.mode in CALL_MODES }.getOrDefault(false)) return RouteChange(false, bluetooth)
        return runCatching {
            // A cellular call ends by putting the phone back in normal mode.
            val modeRestored = audio.mode != AudioManager.MODE_IN_COMMUNICATION
            if (modeRestored) audio.mode = AudioManager.MODE_IN_COMMUNICATION
            val wasBluetooth = bluetooth
            val changed = if (audio.modernRouting) {
                val chosen = chooseCommunicationDevice(audio.communicationCandidates())
                val current = audio.currentCommunicationDevice()
                when {
                    chosen == null -> {
                        if (current != null) audio.clearCommunicationDevice()
                        bluetooth = false
                        current != null
                    }
                    chosen.id == current -> {
                        bluetooth = chosen.type in HEADSET_TYPES
                        false
                    }
                    else -> {
                        bluetooth = audio.setCommunicationDevice(chosen.id) && chosen.type in HEADSET_TYPES
                        true
                    }
                }
            } else {
                val route = legacyRoute(audio.bluetoothScoAvailable(), audio.wiredHeadsetOn())
                val moved = route != legacy
                if (moved) applyLegacy(route)
                moved
            }
            RouteChange(changed || modeRestored || wasBluetooth != bluetooth, bluetooth)
        }.getOrElse {
            Log.w("AudioRouter", "Re-routing failed; keeping the current route", it)
            RouteChange(false, bluetooth)
        }
    }

    fun stopVoiceRouting() {
        if (!active) return
        runCatching {
            if (audio.modernRouting) audio.clearCommunicationDevice()
            else if (legacy == LegacyRoute.BLUETOOTH_SCO) audio.stopBluetoothSco()
            audio.speakerphoneOn = previousSpeaker
            audio.mode = previousMode
        }
        active = false; bluetooth = false; legacy = null
    }

    private fun applyLegacy(route: LegacyRoute) {
        if (legacy == LegacyRoute.BLUETOOTH_SCO && route != LegacyRoute.BLUETOOTH_SCO) audio.stopBluetoothSco()
        when (route) {
            LegacyRoute.BLUETOOTH_SCO -> { if (legacy != LegacyRoute.BLUETOOTH_SCO) audio.startBluetoothSco(); audio.speakerphoneOn = false }
            LegacyRoute.WIRED -> audio.speakerphoneOn = false
            LegacyRoute.SPEAKER -> audio.speakerphoneOn = true
        }
        legacy = route
        bluetooth = route == LegacyRoute.BLUETOOTH_SCO
    }
}
