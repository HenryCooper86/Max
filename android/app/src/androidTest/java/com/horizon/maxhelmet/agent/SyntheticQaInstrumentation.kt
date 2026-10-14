package com.horizon.maxhelmet.agent

import android.Manifest
import android.app.Instrumentation
import android.content.pm.PackageManager
import android.media.AudioTrack
import android.os.Bundle
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import com.horizon.maxhelmet.BuildConfig
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import okhttp3.WebSocket
import org.json.JSONArray
import org.json.JSONObject

/** Real native session/transport/playback with synthetic-only PCM input. */
class SyntheticQaInstrumentation : Instrumentation() {
    private lateinit var args: Bundle
    private lateinit var dir: File
    private val results = JSONArray()
    private val invocationId = "${System.currentTimeMillis()}-${UUID.randomUUID()}"
    private var serverBuild = "unknown"

    private fun persist(harnessFailure: String? = null) {
        val content =
            JSONObject()
                .put("invocationId", invocationId)
                .put("build", BuildConfig.GIT_COMMIT)
                .put("nativeBundleSourceBuild", BuildConfig.GIT_COMMIT)
                .put("serverBuild", serverBuild)
                .put("source", "Android API34 ARM64 emulator; debug synthetic integration")
                .put(
                    "capture",
                    "synthetic s16le 16000Hz mono; microphone/camera/location permissions denied",
                )
                .put("sessions", results)
                .apply { if (harnessFailure != null) put("harnessFailure", harnessFailure) }
                .toString(2)
        for (name in listOf("android-report-$invocationId.json", "android-report.json")) {
            val destination = File(dir, name)
            val temporary = File(dir, "$name.tmp")
            FileOutputStream(temporary).use { output ->
                output.write(content.toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            check(temporary.renameTo(destination)) { "Could not persist QA evidence" }
        }
    }

    override fun onCreate(arguments: Bundle?) {
        args = arguments ?: Bundle()
        start()
    }

    override fun onStart() {
        val output = Bundle()
        try {
            dir = File(targetContext.filesDir, "synthetic-qa")
            Locale.setDefault(Locale.SIMPLIFIED_CHINESE)
            runBlocking {
                for (p in
                    listOf(
                        Manifest.permission.RECORD_AUDIO,
                        Manifest.permission.CAMERA,
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                    )) check(
                    targetContext.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED
                )
                val config = JSONObject(File(dir, "connection.json").readText())
                serverBuild = config.optString("build", "unknown")
                val manifest = JSONObject(File(dir, "manifest.json").readText())
                check(manifest.getInt("sampleRate") == 16000 && manifest.getInt("channels") == 1)
                check(manifest.getString("sampleFormat") == "s16le")
                // Complete preflight before opening any live session.
                for (name in manifest.getJSONObject("fixtures").keys()) {
                    val fixture = manifest.getJSONObject("fixtures").getJSONObject(name)
                    val pcm = File(dir, fixture.getString("file")).readBytes()
                    check(pcm.isNotEmpty() && pcm.size % 2 == 0)
                    check(
                        kotlin.math.round(fixture.getDouble("durationSeconds") * 16000).toLong() *
                            2 == pcm.size.toLong()
                    )
                    check(
                        MessageDigest.getInstance("SHA-256").digest(pcm).joinToString("") {
                            "%02x".format(it)
                        } == fixture.getString("sha256")
                    )
                }
                if (args.getString("case") == "__preflight__") return@runBlocking
                val cases =
                    listOf(
                        "baseline-live-session",
                        "wake-word-addressed-only",
                        "emergency-safe-guidance",
                        "adas-alert-interrupt",
                        "wind-noise-robustness",
                        "degraded-network-recovery",
                    )
                val selected =
                    cases.filter { args.getString("case") == null || it == args.getString("case") }
                check(selected.isNotEmpty()) { "Unknown QA case" }
                repeat(args.getString("rounds", "1").toInt()) { round ->
                    for (case in selected) {
                        runCase(case, round, config, manifest)
                        persist()
                        delay(600)
                    }
                }
            }
            persist()
            output.putString(
                "result",
                "sessions=${results.length()}; see private android-report.json",
            )
            finish(
                if (
                    (0 until results.length()).all {
                        results.getJSONObject(it).optBoolean("passed")
                    }
                )
                    -1
                else 1,
                output,
            )
        } catch (error: Throwable) {
            if (::dir.isInitialized) {
                runCatching { persist(error.javaClass.simpleName) }
            }
            output.putString("result", "harness-error:${error.javaClass.simpleName}")
            finish(1, output)
        }
    }

    private suspend fun until(ms: Long = 30000, condition: () -> Boolean) {
        withTimeout(ms) { while (!condition()) delay(25) }
    }

    private fun field(obj: Any, name: String): Any? =
        obj.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(obj)

    private fun player(session: AgentSession): PcmPlayer = field(session, "player") as PcmPlayer

    private fun ttsSpeaking(session: AgentSession): Boolean =
        (field(session, "tts") as? TextToSpeech)?.isSpeaking == true

    private suspend fun drain(
        session: AgentSession,
        allowInterrupted: Boolean = false,
    ): PcmPlayer.PlaybackDiagnostics {
        var stableSince = 0L
        var previousQueued = -1L
        until(20000) {
            val playback = player(session).playbackDiagnostics()
            val drained =
                (playback.queuedSamples > 0 ||
                    (allowInterrupted && playback.totalQueuedSamples > 0)) &&
                    playback.queuedSamples == playback.writtenSamples &&
                    playback.playbackSamples >= playback.writtenSamples &&
                    playback.pendingBuffers == 0 &&
                    !ttsSpeaking(session)
            val now = SystemClock.elapsedRealtime()
            if (!drained || playback.queuedSamples != previousQueued) stableSince = 0L
            previousQueued = playback.queuedSamples
            if (drained && stableSince == 0L) stableSince = now
            drained && stableSince > 0 && now - stableSince >= 1000
        }
        return player(session).playbackDiagnostics()
    }

    private fun position(session: AgentSession): Int =
        (field(player(session), "track") as? AudioTrack)?.playbackHeadPosition ?: 0

    private suspend fun runCase(
        case: String,
        round: Int,
        config: JSONObject,
        manifest: JSONObject,
    ) {
        val report =
            JSONObject()
                .put("case", case)
                .put("round", round + 1)
                .put("startAt", System.currentTimeMillis())
        val tester =
            config.optString("testerId").ifBlank {
                "android-native-synthetic-${System.currentTimeMillis()}-$round"
            }
        report
            .put("testerId", tester)
            .put("nativeBundleSourceBuild", BuildConfig.GIT_COMMIT)
            .put("serverBuild", config.optString("build"))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        lateinit var session: AgentSession
        lateinit var capture: SyntheticCapture
        runOnMainSync {
            session =
                AgentSession(
                    targetContext,
                    scope,
                    captureFactory = { frame, level, _ ->
                        SyntheticCapture(scope, frame, level).also { capture = it }
                    },
                )
        }
        val states = JSONArray()
        var oldHazard = 0
        var oldPosition = 0
        var playedSamples = 0L
        var hazardDuringSpeech = false
        var hazardStoppedPlayback = false
        var hazardDiscardedSamples = 0L
        val observeBackground = AtomicBoolean(false)
        val backgroundTts = AtomicBoolean(false)
        val watcher =
            scope.launch {
                while (isActive) {
                    if (observeBackground.get() && ttsSpeaking(session)) backgroundTts.set(true)
                    val pos = runCatching { position(session) }.getOrDefault(0)
                    if (pos > oldPosition) {
                        playedSamples += pos - oldPosition
                    }
                    oldPosition = pos
                    val hazard = field(session, "hazardAlertGeneration") as Int
                    val generation = field(player(session), "generation") as Int
                    if (hazard > oldHazard) {
                        val evidence = session.syntheticHazardPlayback
                        val pending =
                            if (evidence != null)
                                evidence.before.queuedSamples - evidence.before.playbackSamples
                            else 0L
                        val speaking =
                            evidence != null &&
                                evidence.hazardGeneration == hazard &&
                                evidence.before.running &&
                                pending > 0L
                        val flushed =
                            speaking &&
                                evidence != null &&
                                evidence.after.generation > evidence.before.generation &&
                                evidence.after.pendingBuffers == 0 &&
                                evidence.after.queuedSamples == 0L &&
                                evidence.after.writtenSamples == 0L &&
                                evidence.after.lastFlushSucceeded &&
                                evidence.after.totalDiscardedSamples >
                                    evidence.before.totalDiscardedSamples
                        if (evidence != null) {
                            hazardDiscardedSamples +=
                                evidence.after.totalDiscardedSamples -
                                    evidence.before.totalDiscardedSamples
                        }
                        hazardDuringSpeech = hazardDuringSpeech || speaking
                        hazardStoppedPlayback = hazardStoppedPlayback || flushed
                        synchronized(states) {
                            states.put(
                                JSONObject()
                                    .put("type", "native-hazard")
                                    .put("at", System.currentTimeMillis())
                                    .put("hazardGeneration", hazard)
                                    .put("pendingLivePcmSamples", pending)
                                    .put("queuedSamplesBefore", evidence?.before?.queuedSamples)
                                    .put("hardwarePlayedBefore", evidence?.before?.playbackSamples)
                                    .put("livePcmPendingAtHazard", speaking)
                                    .put("sameHazardHardwareFlushSucceeded", flushed)
                            )
                        }
                    }
                    oldHazard = hazard
                    delay(20)
                }
            }
        val collect =
            scope.launch {
                session.state.collect { state ->
                    synchronized(states) {
                        states.put(
                            JSONObject()
                                .put("at", System.currentTimeMillis())
                                .put("connection", state.connection.name)
                                .put("status", state.statusText)
                                .put("turn", state.turnState.name)
                                .put("handsFree", state.handsFree)
                        )
                    }
                }
            }
        try {
            val scenario =
                when (case) {
                    "emergency-safe-guidance" -> DemoScenario.EMERGENCY
                    "adas-alert-interrupt" -> DemoScenario.ADAS
                    "wind-noise-robustness" -> DemoScenario.WIND
                    "degraded-network-recovery" -> DemoScenario.GROUP
                    else -> DemoScenario.COMMUTE
                }
            runOnMainSync {
                session.setScenario(scenario)
                session.start(
                    config.getString("url"),
                    false,
                    config.getString("token"),
                    tester,
                    testingCampaignId =
                        when (case) {
                            "wake-word-addressed-only" -> "wake-word-regression"
                            "emergency-safe-guidance",
                            "adas-alert-interrupt" -> "safety-regression"
                            "wind-noise-robustness" -> "road-noise-field"
                            "degraded-network-recovery" -> "network-resilience"
                            else -> "release-readiness"
                        },
                    testingTestCaseId = case,
                    testingRunId = config.optString("runId"),
                    testingAssignmentId =
                        config.optJSONObject("assignmentIds")?.optString(case) ?: "",
                )
            }
            until {
                session.state.value.connection == ConnectionState.READY &&
                    session.state.value.isLive
            }
            check(capture.running.get())
            check(field(field(session, "sessionLocation")!!, "listener") == null)
            check(
                field(session.crash, "listening") == false && field(session.crash, "timer") == null
            )
            report.put("locationCaptureStarted", false).put("motionCaptureStarted", false)
            report.put("readyAt", System.currentTimeMillis())
            suspend fun feed(name: String) {
                val fixture = manifest.getJSONObject("fixtures").getJSONObject(name)
                report.put("fixture", name).put("fixtureSha256", fixture.getString("sha256"))
                capture.feed(File(dir, fixture.getString("file")).readBytes())
            }
            if (case == "wake-word-addressed-only") {
                val initialPcmSamples = player(session).playbackDiagnostics().totalQueuedSamples
                observeBackground.set(true)
                feed("wake-background")
                delay(9000)
                report.put("unaddressedObservationMs", 9000)
                observeBackground.set(false)
                val backgroundSamples =
                    player(session).playbackDiagnostics().totalQueuedSamples - initialPcmSamples
                report
                    .put("unaddressedPcmSamples", backgroundSamples)
                    .put("unaddressedTtsSpeech", backgroundTts.get())
                check(backgroundSamples == 0L && !backgroundTts.get()) {
                    "Unaddressed speech produced native audio"
                }
                val count = session.state.value.transcript.count { it.speaker == Speaker.AGENT }
                report.put("unaddressedAgentTurns", count)
                check(count == 0)
                feed("wake-addressed")
            } else if (case == "degraded-network-recovery") {
                feed("network")
                until(25000) {
                    session.state.value.transcript.any {
                        it.speaker == Speaker.AGENT && it.final
                    } &&
                        session.state.value.transcript.any {
                            it.speaker == Speaker.RIDER && it.final
                        }
                }
                val checkpoint = drain(session)
                check(
                    checkpoint.totalDiscardedSamples == 0L &&
                        checkpoint.totalQueuedSamples == checkpoint.totalPlayedSamples
                )
                report
                    .put("networkCheckpointQueuedSamples", checkpoint.totalQueuedSamples)
                    .put("networkCheckpointPlayedSamples", checkpoint.totalPlayedSamples)
                    .put("networkCheckpointDiscardedSamples", checkpoint.totalDiscardedSamples)
                delay(6000)
                val firstTurnCount =
                    session.state.value.transcript.count { it.speaker == Speaker.AGENT && it.final }
                report
                    .put("completedExchangeBeforeOutage", true)
                    .put("transportOutageAt", System.currentTimeMillis())
                (field(session, "webSocket") as? WebSocket ?: error("No actual socket")).cancel()
                until(5000) { session.state.value.connection == ConnectionState.OFFLINE }
                report.put("nativeOfflineObserved", true)
                until { session.state.value.connection == ConnectionState.READY }
                report.put("recoveredAt", System.currentTimeMillis())
                feed("network")
                until(25000) {
                    session.state.value.transcript.count {
                        it.speaker == Speaker.AGENT && it.final
                    } > firstTurnCount
                }
            } else
                feed(
                    when (case) {
                        "baseline-live-session" -> "baseline"
                        "emergency-safe-guidance" -> "emergency"
                        "adas-alert-interrupt" -> "adas"
                        else -> "wind"
                    }
                )
            if (case == "adas-alert-interrupt")
                until(35000) { hazardDuringSpeech && hazardStoppedPlayback }
            else
                until(25000) {
                    session.state.value.transcript.any {
                        it.speaker == Speaker.AGENT && it.final
                    } &&
                        session.state.value.transcript.any {
                            it.speaker == Speaker.RIDER && it.final
                        }
                }
            delay(4500)
            if (case == "adas-alert-interrupt") {
                val drained = drain(session, allowInterrupted = true)
                check(drained.totalDiscardedSamples == hazardDiscardedSamples) {
                    "PCM discarded outside ADAS hazard handling"
                }
                check(
                    drained.totalQueuedSamples ==
                        drained.totalPlayedSamples + drained.totalDiscardedSamples
                )
                report
                    .put("adasDiscardedSamples", drained.totalDiscardedSamples)
                    .put("sameHazardDiscardedSamples", hazardDiscardedSamples)
                    .put("totalQueuedSamples", drained.totalQueuedSamples)
                    .put("totalPlayedSamples", drained.totalPlayedSamples)
            } else {
                val drained = drain(session)
                check(drained.totalDiscardedSamples == 0L) { "Ordinary PCM was interrupted" }
                check(drained.totalQueuedSamples == drained.totalPlayedSamples) {
                    "PCM accounting did not drain across generations"
                }
                report
                    .put("nativePlaybackDrained", true)
                    .put("totalQueuedSamples", drained.totalQueuedSamples)
                    .put("totalPlayedSamples", drained.totalPlayedSamples)
                    .put("totalDiscardedSamples", drained.totalDiscardedSamples)
                    .put("queuedSamples", drained.queuedSamples)
                    .put("writtenSamples", drained.writtenSamples)
                    .put("playedSamples", drained.playbackSamples)
                    .put("playbackGeneration", drained.generation)
            }
            val state = session.state.value
            report
                .put("provider", state.provider)
                .put("live", state.isLive)
                .put("latencyMs", state.latencyMs)
                .put("pcmPlaybackSamples", playedSamples)
                .put("hazardDuringLivePcmSpeech", hazardDuringSpeech)
                .put("hazardStoppedPlayback", hazardStoppedPlayback)
            check(state.isLive && playedSamples > 0)
            report.put("passed", true)
        } catch (error: Throwable) {
            report
                .put("passed", false)
                .put("failureClass", error.javaClass.simpleName)
                .put("status", session.state.value.statusText)
                .put("connection", session.state.value.connection.name)
        } finally {
            report.put(
                "transcript",
                JSONArray(
                    session.state.value.transcript.map {
                        JSONObject()
                            .put("speaker", it.speaker.wire)
                            .put("text", it.text)
                            .put("final", it.final)
                    }
                ),
            )
            val beforeStop = player(session).playbackDiagnostics()
            runOnMainSync { session.stop(force = true) }
            val afterStop = player(session).playbackDiagnostics()
            report.put(
                "stopDiscardedSamples",
                afterStop.totalDiscardedSamples - beforeStop.totalDiscardedSamples,
            )
            if (
                afterStop.totalDiscardedSamples > beforeStop.totalDiscardedSamples ||
                    (case != "adas-alert-interrupt" && afterStop.totalDiscardedSamples > 0L)
            ) {
                report.put("passed", false).put("failureClass", "OrdinaryPcmDiscarded")
            }
            var stopped = false
            try {
                until(2500) {
                    stopped =
                        !session.state.value.handsFree &&
                            !capture.running.get() &&
                            !player(session).playbackDiagnostics().active &&
                            !player(session).playbackDiagnostics().running &&
                            !ttsSpeaking(session) &&
                            field(session, "webSocket") == null
                    stopped
                }
            } catch (_: TimeoutCancellationException) {
                stopped = false
            }
            report.put("nativeStopped", stopped)
            if (!stopped) report.put("passed", false).put("failureClass", "NativeTeardownFailure")
            watcher.cancelAndJoin()
            collect.cancelAndJoin()
            report
                .put("framesEmitted", capture.frames)
                .put("events", states)
                .put("endAt", System.currentTimeMillis())
            scope.cancel()
            results.put(report)
            sendStatus(
                0,
                Bundle().apply {
                    putString("case", case)
                    putString(
                        "result",
                        if (report.optBoolean("passed")) "pass"
                        else "fail:${report.optString("failureClass")}",
                    )
                },
            )
        }
    }
}

private class SyntheticCapture(
    private val scope: CoroutineScope,
    private val onFrame: (ByteArray) -> Unit,
    private val onLevel: (Float) -> Unit,
) : PcmCapture {
    val running = AtomicBoolean(false)
    private var job: Job? = null
    private val queue = ConcurrentLinkedQueue<ByteArray>()
    @Volatile var frames = 0L

    override fun start() {
        running.set(true)
        job =
            scope.launch {
                var deadline = SystemClock.elapsedRealtime()
                while (running.get() && isActive) {
                    val frame = queue.poll() ?: ByteArray(MicStreamer.FRAME_BYTES)
                    onLevel(if (frame.any { it != 0.toByte() }) .15f else 0f)
                    onFrame(frame)
                    frames++
                    deadline += 20
                    delay((deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
                }
            }
    }

    suspend fun feed(pcm: ByteArray) {
        check(pcm.size % 2 == 0)
        for (offset in pcm.indices step MicStreamer.FRAME_BYTES) queue.add(
            pcm.copyOfRange(offset, minOf(offset + MicStreamer.FRAME_BYTES, pcm.size))
                .copyOf(MicStreamer.FRAME_BYTES)
        )
        while (queue.isNotEmpty() && running.get()) delay(20)
    }

    override fun stop() {
        running.set(false)
        job?.cancel()
        queue.clear()
    }
}
