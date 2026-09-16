package com.horizon.maxhelmet.crash

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.SystemClock
import android.os.PowerManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.sqrt

/** Sensors and monotonic timer share the main dispatcher; no microphone is acquired. */
class CrashRuntime(context: Context, private val scope: CoroutineScope, speed: () -> Double?,
    locate: suspend () -> Pair<Double, Double>?, speak: (String) -> Unit,
    send: (String) -> Unit, resolved: () -> Unit) : SensorEventListener {
    private val prefs = context.getSharedPreferences("max_crash", Context.MODE_PRIVATE)
    private val incidentWakeLock = context.getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MaxHelmet:crash-countdown")
    private fun publishUi(value: CrashUi) {
        val active = value.phase in setOf(CrashPhase.CHECK_IN, CrashPhase.ALARM, CrashPhase.ESCALATED)
        if (active && incidentWakeLock?.isHeld == false) incidentWakeLock.acquire(10 * 60_000L)
        if (!active && incidentWakeLock?.isHeld == true) incidentWakeLock.release()
        mutableUi.value = value
    }
    private val sensors = context.getSystemService(SensorManager::class.java)
    private val accel = sensors?.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val gyro = sensors?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val speedProvider = speed
    private val mutableUi = MutableStateFlow(CrashUi())
    val ui = mutableUi.asStateFlow()
    val available = accel != null && gyro != null
    private var timer: Job? = null
    private var alarm: Job? = null
    private var tone: ToneGenerator? = null
    private var rotation = 0.0
    private var rotationTime = 0L
    private var listening = false
    var settings: CrashSettings
        get() = CrashSettings(prefs.getString("contact", "") ?: "", prefs.getBoolean("optIn", false), prefs.getBoolean("callContact", false), (com.horizon.maxhelmet.BuildConfig.DEBUG && prefs.getBoolean("logOnly", false)))
        set(value) { prefs.edit().putString("contact", value.contact.trim()).putBoolean("optIn", value.optIn && CrashController.validContact(value.contact)).putBoolean("callContact", value.callContact).putBoolean("logOnly", value.logOnly).apply() }
    val controller = CrashController(
        now = { SystemClock.elapsedRealtimeNanos() / 1e9 }, wall = System::currentTimeMillis,
        settings = { settings }, locate = { callback -> scope.launch { callback(withTimeoutOrNull(2500) { locate() }) } },
        speak = speak, siren = ::setSiren, send = send, publish = ::publishUi, resolved = resolved)
    fun arm() {
        controller.arm()
        if (!listening && available) {
            rotation = 0.0; rotationTime = 0
            val a = sensors!!.registerListener(this, accel, 10_000)
            val g = sensors.registerListener(this, gyro, 10_000)
            listening = a && g
            if (!listening) sensors.unregisterListener(this)
        }
        if (timer == null) timer = scope.launch { while (isActive) { controller.tick(); delay(250) } }
    }
    fun sessionEnded() {
        listening = false; sensors?.unregisterListener(this); controller.sessionEnded()
        if (!controller.active) { timer?.cancel(); timer = null; setSiren(false) }
    }
    override fun onSensorChanged(event: SensorEvent) {
        if (!listening) return
        val magnitude = sqrt(event.values.take(3).sumOf { it.toDouble() * it })
        if (event.sensor.type == Sensor.TYPE_GYROSCOPE) { rotation = magnitude; rotationTime = event.timestamp }
        else if (rotationTime > 0 && event.timestamp - rotationTime in 0..100_000_000L) {
            controller.sample(CrashSample(event.timestamp / 1e9, magnitude / SensorManager.GRAVITY_EARTH, rotation, speedProvider()))
        }
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    private fun setSiren(on: Boolean) {
        alarm?.cancel(); alarm = null
        tone?.release(); tone = null
        if (on) {
            tone = runCatching { ToneGenerator(AudioManager.STREAM_ALARM, 90) }.getOrNull()
            alarm = scope.launch { while (isActive) { tone?.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 800); delay(1000) } }
        }
    }
}
