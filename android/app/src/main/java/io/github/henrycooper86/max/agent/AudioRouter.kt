package io.github.henrycooper86.max.agent

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log

/** Keeps capture and agent playback on the communication path on speaker as
 * well as headsets. Music retains its separate media playback path. */
class AudioRouter(context: Context) {
    private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var active = false
    private var bluetooth = false
    private var previousMode = AudioManager.MODE_NORMAL
    private var previousSpeaker = false

    val hasBluetoothHeadset: Boolean
        get() = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.availableCommunicationDevices.any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            } else {
                manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            }
        }.getOrDefault(false)

    @Suppress("DEPRECATION")
    fun startVoiceRouting(): Boolean {
        if (active) return bluetooth
        previousMode = manager.mode
        previousSpeaker = manager.isSpeakerphoneOn
        return runCatching {
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            active = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val devices = manager.availableCommunicationDevices
                val chosen = devices.firstOrNull { it.type in setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET) }
                    ?: devices.firstOrNull { it.type in setOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET) }
                    ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                bluetooth = chosen != null && manager.setCommunicationDevice(chosen) &&
                    chosen.type in setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET)
            } else if (hasBluetoothHeadset) {
                manager.startBluetoothSco(); manager.isBluetoothScoOn = true; bluetooth = true
            } else {
                manager.isSpeakerphoneOn = !manager.isWiredHeadsetOn
            }
            bluetooth
        }.getOrElse {
            Log.w("AudioRouter", "Headset unavailable; using phone voice audio", it)
            false
        }
    }

    @Suppress("DEPRECATION")
    fun stopVoiceRouting() {
        if (!active) return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.clearCommunicationDevice()
            else if (bluetooth) { manager.stopBluetoothSco(); manager.isBluetoothScoOn = false }
            manager.isSpeakerphoneOn = previousSpeaker
            manager.mode = previousMode
        }
        active = false; bluetooth = false
    }
}
