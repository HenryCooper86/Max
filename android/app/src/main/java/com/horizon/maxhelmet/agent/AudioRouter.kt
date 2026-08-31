package com.horizon.maxhelmet.agent

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * Routes voice audio to an in-helmet Bluetooth headset when one is connected.
 * Uses the communication-device API on Android 12+ and legacy SCO on older
 * versions. Falls back silently to the phone mic/speaker when no headset is
 * paired — routing is always best-effort and never blocks the session.
 */
class AudioRouter(context: Context) {

    companion object {
        private const val TAG = "AudioRouter"
    }

    private val audioManager: AudioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var routed = false
    private var previousMode = AudioManager.MODE_NORMAL

    /** True when a Bluetooth headset (SCO profile) is available for voice. */
    val hasBluetoothHeadset: Boolean
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.availableCommunicationDevices.any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            }
        } else {
            @Suppress("DEPRECATION")
            audioManager.isBluetoothScoAvailableOffCall
        }

    /**
     * Routes mic and playback to the Bluetooth headset if one is present.
     * Returns true when headset routing is active.
     */
    fun startVoiceRouting(): Boolean {
        if (routed) return true
        if (!hasBluetoothHeadset) return false

        previousMode = audioManager.mode
        val result = runCatching {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val scoDevice = audioManager.availableCommunicationDevices.first {
                    it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                }
                audioManager.setCommunicationDevice(scoDevice)
                Log.i(TAG, "Voice routed to Bluetooth headset: ${scoDevice.productName}")
            } else {
                @Suppress("DEPRECATION")
                audioManager.startBluetoothSco()
                @Suppress("DEPRECATION")
                audioManager.isBluetoothScoOn = true
                Log.i(TAG, "Voice routed via legacy Bluetooth SCO")
            }
        }

        routed = result.isSuccess
        result.onFailure {
            Log.w(TAG, "Bluetooth routing failed; using phone mic/speaker", it)
            audioManager.mode = previousMode
        }
        return routed
    }

    /** Restores default audio routing. */
    fun stopVoiceRouting() {
        if (!routed) return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                audioManager.stopBluetoothSco()
                @Suppress("DEPRECATION")
                audioManager.isBluetoothScoOn = false
            }
            audioManager.mode = previousMode
        }.onFailure { Log.w(TAG, "Restoring audio routing failed", it) }
        routed = false
    }
}
