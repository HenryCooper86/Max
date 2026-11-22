package io.github.henrycooper86.max.power

import android.os.PowerManager
import io.github.henrycooper86.max.actions.DeviceResult
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr

/** Three tiers are enough to decide what to shed; the platform's finer levels collapse onto them. */
enum class HeatLevel { NORMAL, SEVERE, CRITICAL }

/** PowerManager.THERMAL_STATUS_*: MODERATE and below still allow everything. */
fun heatLevel(thermalStatus: Int): HeatLevel = when {
    thermalStatus >= PowerManager.THERMAL_STATUS_CRITICAL -> HeatLevel.CRITICAL
    thermalStatus >= PowerManager.THERMAL_STATUS_SEVERE -> HeatLevel.SEVERE
    else -> HeatLevel.NORMAL
}

/**
 * What the phone can afford right now. The voice session, crash detection and
 * navigation guidance are never shed: they are the safety features. Video and
 * multi-frame vision decoding are the largest sustained heat sources, so severe
 * heat stops them while a one-shot photo stays; battery saver only refuses new
 * video (the rider asked for less drain, not for a recording to be cut); at
 * critical heat photos, the torch, music, HUD casting and the map go too. The
 * same tiers as iOS's ThermalGovernor.
 */
data class DeviceLoad(val heat: HeatLevel = HeatLevel.NORMAL, val powerSave: Boolean = false) {
    val videoAllowed: Boolean get() = heat == HeatLevel.NORMAL && !powerSave
    val photoAllowed: Boolean get() = heat != HeatLevel.CRITICAL
    val visionAllowed: Boolean get() = heat == HeatLevel.NORMAL
    val extrasAllowed: Boolean get() = heat != HeatLevel.CRITICAL
    /** Only heat stops a recording already running; battery saver lets it finish. */
    val recordingMustStop: Boolean get() = heat != HeatLevel.NORMAL

    internal fun stricterThan(other: DeviceLoad): Boolean =
        (!videoAllowed && other.videoAllowed) || (!photoAllowed && other.photoAllowed) ||
            (!visionAllowed && other.visionAllowed) || (!extrasAllowed && other.extrasAllowed)
}

/** Thermal status and battery-saver changes; reports the current values on start. */
interface DeviceLoadSource {
    fun start(onChange: (thermalStatus: Int, powerSave: Boolean) -> Unit)
    fun stop()
}

/** The same notice is not repeated within this long (as on iOS): a status hovering at a boundary would nag. */
const val LOAD_NOTICE_QUIET_MS = 300_000L

enum class LoadNotice {
    HOT, CRITICAL, POWER_SAVE, RESTORED;

    /** Only the warnings that change what Max can do are spoken; the rest go to the status line. */
    val spoken: Boolean get() = this == HOT || this == CRITICAL
}

/** The rider-facing line for a notice. */
fun loadNoticeText(notice: LoadNotice): String = when (notice) {
    LoadNotice.HOT -> tr(Str.LOAD_HOT)
    LoadNotice.CRITICAL -> tr(Str.LOAD_CRITICAL)
    LoadNotice.POWER_SAVE -> tr(Str.LOAD_POWER_SAVE)
    LoadNotice.RESTORED -> tr(Str.LOAD_RESTORED)
}

/**
 * Follows the phone's heat and battery saver for a hands-free session, with
 * the announcement rules of iOS's ThermalGovernor: a notice when heat rises
 * into severe or critical, or battery saver turns on while not hot, each kind
 * at most once per [LOAD_NOTICE_QUIET_MS]; "cooled down" only after a heat
 * warning the rider actually heard. [onShed] runs whenever the load newly
 * forbids something, so the session can stop what is already running;
 * [onLoad] runs on every change, easing included, for state the UI shows.
 * Callbacks arrive on the main thread.
 */
class DeviceLoadGuard(
    private val source: DeviceLoadSource,
    private val onNotice: (LoadNotice) -> Unit,
    private val onShed: (DeviceLoad) -> Unit,
    private val onLoad: (DeviceLoad) -> Unit = {},
    private val clock: () -> Long = { android.os.SystemClock.elapsedRealtime() }
) {
    // Read by device commands on other threads.
    @Volatile
    var load: DeviceLoad = DeviceLoad()
        private set
    private var active = false
    private val lastAnnounced = mutableMapOf<LoadNotice, Long>()
    private var warnedThisSpell = false

    fun start() {
        if (active) return
        active = true
        source.start(::report)
    }

    fun stop() {
        if (!active) return
        active = false
        runCatching { source.stop() }
        load = DeviceLoad()
        warnedThisSpell = false
    }

    private fun report(thermalStatus: Int, powerSave: Boolean) {
        if (!active) return
        val previous = load
        val next = DeviceLoad(heatLevel(thermalStatus), powerSave)
        if (next == previous) return
        load = next
        onLoad(next)
        if (next.stricterThan(previous)) onShed(next)
        if (next.heat == HeatLevel.CRITICAL && previous.heat < HeatLevel.CRITICAL) {
            announce(LoadNotice.CRITICAL)
        } else if (next.heat == HeatLevel.SEVERE && previous.heat < HeatLevel.SEVERE) {
            announce(LoadNotice.HOT)
        } else if (next.heat < HeatLevel.SEVERE && previous.heat >= HeatLevel.SEVERE) {
            if (warnedThisSpell) onNotice(LoadNotice.RESTORED)
            warnedThisSpell = false
        }
        if (next.powerSave && !previous.powerSave && next.heat < HeatLevel.SEVERE) announce(LoadNotice.POWER_SAVE)
    }

    private fun announce(notice: LoadNotice) {
        val now = clock()
        val last = lastAnnounced[notice]
        if (last != null && now - last < LOAD_NOTICE_QUIET_MS) return
        lastAnnounced[notice] = now
        if (notice.spoken) warnedThisSpell = true
        onNotice(notice)
    }
}

/**
 * Refuses a device command the phone cannot afford, with a spoken reason (the
 * relay reads `detail` aloud). Stopping a recording, turning the torch off and
 * pausing music are always allowed: they are how load is shed.
 */
fun loadRefusal(action: String, args: Map<String, Any?>, load: DeviceLoad): DeviceResult? {
    val refused = when (action) {
        "camera.record" -> args["start"] == true && !load.videoAllowed
        "camera.photo" -> !load.photoAllowed
        "gallery.describe" -> !load.visionAllowed
        "torch.set" -> args["on"] == true && !load.extrasAllowed
        "music.control" -> args["control"] != "pause" && !load.extrasAllowed
        else -> false
    }
    if (!refused) return null
    val hot = load.heat != HeatLevel.NORMAL
    return DeviceResult("denied", if (hot) "device.hot" else "device.powerSave",
        tr(if (hot) Str.LOAD_REFUSED_HOT else Str.LOAD_REFUSED_POWER_SAVE))
}

/**
 * Starts a recording and then re-checks the load: heat that arrived while the
 * recorder was starting would otherwise be missed (the session only stops
 * recordings it already knows are running). The short clip is kept, as on iOS.
 */
suspend fun startRecordingUnderLoad(
    load: () -> DeviceLoad,
    start: suspend () -> DeviceResult,
    stop: suspend () -> DeviceResult
): DeviceResult {
    val started = start()
    if (started != DeviceResult.OK || !load().recordingMustStop) return started
    stop()
    return DeviceResult("denied", "device.hot", tr(Str.LOAD_REFUSED_HOT))
}
