package io.github.henrycooper86.max.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import io.github.henrycooper86.max.power.DeviceLoadSource

private const val TAG = "SessionPorts"

/**
 * Focus for the whole hands-free session, with the same attributes as the
 * assistant's playback (PcmPlayer: voice communication, speech). The
 * transient-may-duck gain is what a two-way voice assistant asks for: the
 * rider's music keeps playing, ducked by the platform under Max, and returns
 * to full volume when hands-free ends. Delayed gain lets a session started
 * during a phone call wait for the call to end.
 */
internal class AndroidVoiceFocus(context: Context) : AudioFocusPort {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var request: AudioFocusRequest? = null

    override fun request(onChange: (Int) -> Unit): FocusGrant {
        val focusRequest = request ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAcceptsDelayedFocusGain(true)
            // A may-duck request (a navigation prompt) must not pause listening. The
            // platform does not lower voice-communication speech for it either, so
            // the prompt simply plays over Max.
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener({ change -> onChange(change) }, handler)
            .build()
            .also { request = it }
        return when (runCatching { manager.requestAudioFocus(focusRequest) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)) {
            AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> FocusGrant.GRANTED
            AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> FocusGrant.DELAYED
            else -> FocusGrant.FAILED
        }
    }

    override fun abandon() {
        request?.let { runCatching { manager.abandonAudioFocusRequest(it) } }
        request = null
    }
}

/**
 * Reports when no app is playing media any more: the natural moment to take
 * audio focus back after yielding it. Android does not say which app a player
 * belongs to, so this watches for media and game playback to stop altogether.
 * The app's own music counts too; its stopping costs at most one focus request.
 */
internal class AndroidMediaPlaybackWatch(context: Context) : MediaPlaybackWatch {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var callback: AudioManager.AudioPlaybackCallback? = null
    private var mediaPlaying = false

    override fun start(onOtherMediaStopped: () -> Unit) {
        if (callback != null) return
        mediaPlaying = isMedia(runCatching { manager.activePlaybackConfigurations }.getOrDefault(emptyList()))
        val playbackCallback = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<android.media.AudioPlaybackConfiguration>) {
                val playing = isMedia(configs)
                if (mediaPlaying && !playing) onOtherMediaStopped()
                mediaPlaying = playing
            }
        }
        runCatching { manager.registerAudioPlaybackCallback(playbackCallback, handler) }
            .onSuccess { callback = playbackCallback }
            .onFailure { Log.w(TAG, "Playback callback unavailable", it) }
    }

    override fun stop() {
        callback?.let { runCatching { manager.unregisterAudioPlaybackCallback(it) } }
        callback = null
        mediaPlaying = false
    }

    private fun isMedia(configs: List<android.media.AudioPlaybackConfiguration>): Boolean = configs.any {
        it.audioAttributes.usage == AudioAttributes.USAGE_MEDIA || it.audioAttributes.usage == AudioAttributes.USAGE_GAME
    }
}

/**
 * Phone calls from the audio mode, which needs no telephony permission: a mode
 * listener on Android 12+, and polling every 1.5 s on older releases (no
 * callback exists there). Reports only changes, plus a call already in
 * progress at start.
 */
internal class AndroidCallStateWatch(private val context: Context) : CallStateWatch {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    // Typed loosely: the listener interface only exists from Android 12.
    private var modeListener: Any? = null
    private var poll: Runnable? = null
    private var lastInCall = false

    override fun inCall(): Boolean = runCatching { isCallMode(manager.mode) }.getOrDefault(false)

    override fun start(onCallChanged: (inCall: Boolean) -> Unit) {
        if (modeListener != null || poll != null) return
        lastInCall = inCall()
        if (lastInCall) onCallChanged(true)
        fun report(inCall: Boolean) {
            if (inCall != lastInCall) { lastInCall = inCall; onCallChanged(inCall) }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val listener = AudioManager.OnModeChangedListener { mode -> report(isCallMode(mode)) }
            runCatching { manager.addOnModeChangedListener(ContextCompat.getMainExecutor(context), listener) }
                .onSuccess { modeListener = listener }
                .onFailure { Log.w(TAG, "Mode listener unavailable", it) }
        } else {
            val tick = object : Runnable {
                override fun run() {
                    report(inCall())
                    handler.postDelayed(this, 1_500)
                }
            }
            poll = tick
            handler.postDelayed(tick, 1_500)
        }
    }

    override fun stop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (modeListener as? AudioManager.OnModeChangedListener)?.let { runCatching { manager.removeOnModeChangedListener(it) } }
        }
        modeListener = null
        poll?.let { handler.removeCallbacks(it) }
        poll = null
        lastInCall = false
    }
}

internal class AndroidAudioDeviceWatch(context: Context) : AudioDeviceWatch {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var callback: AudioDeviceCallback? = null

    override fun start(onChanged: () -> Unit) {
        if (callback != null) return
        val deviceCallback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = onChanged()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = onChanged()
        }
        runCatching { manager.registerAudioDeviceCallback(deviceCallback, handler) }
            .onSuccess { callback = deviceCallback }
            .onFailure { Log.w(TAG, "Audio device callback unavailable", it) }
    }

    override fun stop() {
        callback?.let { runCatching { manager.unregisterAudioDeviceCallback(it) } }
        callback = null
    }
}

internal class AndroidNetworkWatch(context: Context) : NetworkWatch {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun start(onAvailable: (Long) -> Unit, onLost: (Long?) -> Unit) {
        if (callback != null || manager == null) return
        val networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onAvailable(network.networkHandle)
            override fun onLost(network: Network) = onLost(network.networkHandle)
        }
        // Without the callback the session keeps the old behaviour: retries on
        // socket failure only.
        runCatching { manager.registerDefaultNetworkCallback(networkCallback, handler) }
            .onSuccess {
                callback = networkCallback
                // The callback is silent when there is no network at all.
                if (manager.activeNetwork == null) handler.post { if (callback === networkCallback) onLost(null) }
            }
            .onFailure { Log.w(TAG, "Network callback unavailable", it) }
    }

    override fun stop() {
        callback?.let { runCatching { manager?.unregisterNetworkCallback(it) } }
        callback = null
    }
}

/** Thermal status (Android 10+) and battery saver. Older phones report no thermal pressure. */
internal class AndroidDeviceLoadSource(private val context: Context) : DeviceLoadSource {
    private val power = context.getSystemService(PowerManager::class.java)
    // Typed loosely: the listener interface only exists from Android 10.
    private var thermalListener: Any? = null
    private var receiver: BroadcastReceiver? = null
    private var thermalStatus = 0

    override fun start(onChange: (thermalStatus: Int, powerSave: Boolean) -> Unit) {
        if (receiver != null || power == null) return
        fun report() = onChange(thermalStatus, runCatching { power.isPowerSaveMode }.getOrDefault(false))
        val saverReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) = report()
        }
        ContextCompat.registerReceiver(
            context, saverReceiver, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        receiver = saverReceiver
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            thermalStatus = runCatching { power.currentThermalStatus }.getOrDefault(0)
            val listener = PowerManager.OnThermalStatusChangedListener { status -> thermalStatus = status; report() }
            runCatching { power.addThermalStatusListener(ContextCompat.getMainExecutor(context), listener) }
                .onSuccess { thermalListener = listener }
        }
        report()
    }

    override fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            (thermalListener as? PowerManager.OnThermalStatusChangedListener)?.let { runCatching { power?.removeThermalStatusListener(it) } }
        }
        thermalListener = null
        thermalStatus = 0
    }
}
