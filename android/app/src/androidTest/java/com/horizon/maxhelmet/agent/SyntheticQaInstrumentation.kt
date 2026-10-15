package com.horizon.maxhelmet.agent

import android.Manifest
import android.app.Instrumentation
import android.content.pm.PackageManager
import android.media.AudioTrack
import android.os.Bundle
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.horizon.maxhelmet.BuildConfig
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.nio.ByteBuffer
import java.nio.ByteOrder
import android.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
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
    private lateinit var warningAssets: QaWarningAssets

    private fun persist(harnessFailure: String? = null) {
        val content =
            JSONObject()
                .put("invocationId", invocationId)
                .put("build", BuildConfig.GIT_COMMIT)
                .put("nativeBundleSourceBuild", BuildConfig.GIT_COMMIT)
                .put("diagnosticOverlaySha256", args.getString("diagnosticOverlaySha256", ""))
                .put("serverBuild", serverBuild)
                .put("source", if (args.getString("diagnosticOverlaySha256", "").isNotEmpty())
                    "Android API34 emulator; uncommitted diagnostic overlay on actual source base; no release QA credit"
                    else "Android API34 ARM64 emulator; debug synthetic integration")
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
        if (args.getString("case") == "__offline_warning__") {
            runNativeSafetyWarningDiagnostic(this)
            return
        }
        if (args.getString("case") == "__pcm_generation__") {
            runNativePcmGenerationDiagnostic(this, args)
            return
        }
        if (args.getString("case") == "__warmup_cancel__") {
            runNativeWarmupStopRaceDiagnostic(this, cancelOwner = true)
            return
        }
        if (args.getString("case") == "__warmup_restart_race__") {
            runNativeWarmupStopRaceDiagnostic(this, restart = true)
            return
        }
        if (args.getString("case") == "__warmup_stop_race__") {
            runNativeWarmupStopRaceDiagnostic(this)
            return
        }
        if (args.getString("case") == "__warmup_lifecycle__") {
            runNativePlaybackWarmupDiagnostic(this)
            return
        }
        if (args.getString("case") == "__pipeline__") {
            runNativePipelineDiagnostic(this, args)
            return
        }
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
                warningAssets = QaWarningAssets { path -> targetContext.assets.open("adas/$path").use { it.readBytes() } }
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
                    (allowInterrupted || !ttsSpeaking(session))
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
        val pipeline = ConcurrentLinkedQueue<JSONObject>()
        val pipelineCount = AtomicLong()
        val pipelineDropped = AtomicLong()
        if (args.getString("tracePipeline") == "true") {
            session.syntheticPipelineObserver = { stage, value ->
                if (pipelineCount.incrementAndGet() <= 16000) {
                    pipeline.add(JSONObject().put("stage", stage).put("value", value)
                        .put("monoNs", SystemClock.elapsedRealtimeNanos())
                        .put("utcMs", System.currentTimeMillis()).put("thread", Thread.currentThread().name))
                } else pipelineDropped.incrementAndGet()
            }
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
        val hazardTtsStarts = AtomicLong()
        val spokenHazardGenerations = ConcurrentLinkedQueue<Int>()
        val observedWarningProofs = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        var expectedWarningSessionEpoch = 0L
        runOnMainSync {
            (field(session, "tts") as? TextToSpeech)?.setOnUtteranceProgressListener(
                object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {
                        if (observeBackground.get()) backgroundTts.set(true)
                        val hazard =
                            utteranceId
                                ?.takeIf { it.startsWith("synthetic-hazard-") }
                                ?.removePrefix("synthetic-hazard-")
                                ?.toIntOrNull()
                        if (case == "adas-alert-interrupt" && hazard != null) {
                            hazardTtsStarts.incrementAndGet()
                            spokenHazardGenerations.add(hazard)
                            synchronized(states) {
                                states.put(
                                    JSONObject()
                                        .put("type", "native-tts-start")
                                        .put("utteranceId", utteranceId)
                                        .put("at", System.currentTimeMillis())
                                        .put("hazardGeneration", hazard)
                                )
                            }
                        }
                    }

                    override fun onDone(utteranceId: String?) = Unit

                    override fun onError(utteranceId: String?) = Unit
                }
            )
        }
        val watcher =
            scope.launch {
                while (isActive) {
                    if (observeBackground.get() && ttsSpeaking(session)) backgroundTts.set(true)
                    val warning = session.syntheticWarningDiagnostics()
                    for (proof in warning.proofs) {
                        val request = proof.request
                        val key = "${request.sessionEpoch}/${request.hazardGeneration}/${request.playbackEpoch}/${request.playbackGeneration}/${request.requestedAtNanos}"
                        if (observedWarningProofs.add(key)) synchronized(states) {
                            states.put(JSONObject().put("type", "native-warning-render-observed")
                                .put("at", System.currentTimeMillis())
                                .put("sessionEpoch", request.sessionEpoch.toString())
                                .put("hazardGeneration", request.hazardGeneration)
                                .put("playbackEpoch", request.playbackEpoch.toString())
                                .put("playbackGeneration", request.playbackGeneration)
                                .put("capturedAtNanos", proof.capturedAtNanos.toString()))
                        }
                    }
                    val pos = runCatching { position(session) }.getOrDefault(0)
                    if (pos > oldPosition) {
                        playedSamples += pos - oldPosition
                    }
                    oldPosition = pos
                    val evidence = session.syntheticHazardPlayback
                    val hazard = evidence?.hazardGeneration ?: 0
                    if (hazard > oldHazard) {
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
                                    .put("warningSessionEpoch", evidence?.warningSessionEpoch?.toString())
                                    .put("warningText", evidence?.warningText)
                                    .put("warningThreat", evidence?.threat)
                                    .put("warningGender", evidence?.voiceGender)
                                    .put("providerPlaybackBefore", evidence?.before?.let { qaProviderPlaybackJson(it) })
                                    .put("providerPlaybackAfter", evidence?.after?.let { qaProviderPlaybackJson(it) })
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
            val warningReady = session.syntheticWarningDiagnostics()
            check(warningReady.prepared && warningReady.output.active && warningReady.output.running) {
                "Bundled warning output was not prewarmed before provider readiness"
            }
            expectedWarningSessionEpoch = warningReady.sessionEpoch
            report.put("warningEvidenceVersion", 2)
                .put("warningProofMechanism", "canonical-asset-accepted-postgain-prefix-and-hardware-playback-head")
                .put("warningSessionEpoch", expectedWarningSessionEpoch.toString())
                .put("warningPreparedAtReady", true)
            check(field(field(session, "sessionLocation")!!, "listener") == null)
            check(
                field(session.crash, "listening") == false && field(session.crash, "timer") == null
            )
            report.put("locationCaptureStarted", false).put("motionCaptureStarted", false)
            report.put("readyAt", System.currentTimeMillis())
            suspend fun feed(name: String) {
                val fixture = manifest.getJSONObject("fixtures").getJSONObject(name)
                report.put("fixture", name).put("fixtureSha256", fixture.getString("sha256"))
                session.syntheticPipelineObserver?.invoke("fixture.feed.begin:$name", 0)
                capture.feed(File(dir, fixture.getString("file")).readBytes())
                session.syntheticPipelineObserver?.invoke("fixture.feed.end:$name", 0)
            }
            if (case == "wake-word-addressed-only") {
                val initialPcmSamples = player(session).playbackDiagnostics().totalQueuedSamples
                val initialWarning = session.syntheticWarningDiagnostics()
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
                val backgroundWarning = session.syntheticWarningDiagnostics()
                val backgroundWarningSamples = backgroundWarning.output.totalQueuedSamples - initialWarning.output.totalQueuedSamples
                report.put("unaddressedWarningQueuedSamples", backgroundWarningSamples)
                    .put("unaddressedWarningProofs", backgroundWarning.proofs.size - initialWarning.proofs.size)
                check(backgroundWarningSamples == 0L && backgroundWarning.proofs.size == initialWarning.proofs.size) {
                    "Unaddressed speech scheduled or rendered a bundled warning"
                }
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
                val diagnostics = session.syntheticWarningDiagnostics()
                val snapshotAtNanos = System.nanoTime()
                val cuts = synchronized(states) { (0 until states.length()).map { states.getJSONObject(it) }
                    .filter { it.optString("type") == "native-hazard" && it.optBoolean("livePcmPendingAtHazard") && it.optBoolean("sameHazardHardwareFlushSucceeded") } }
                check(cuts.isNotEmpty()) { "No actual provider PCM cut to verify" }
                val verified = JSONArray()
                for (cut in cuts) {
                    check(cut.getString("warningSessionEpoch") == expectedWarningSessionEpoch.toString()) { "Provider cut belongs to another warning session" }
                    val expected = warningAssets.identity(cut.getString("warningThreat"), cut.getString("warningText"), cut.getString("warningGender"))
                    val matching = diagnostics.proofs.filter { it.request.sessionEpoch == expectedWarningSessionEpoch && it.request.hazardGeneration == cut.getInt("hazardGeneration") }
                    check(matching.size == 1) { "Every interrupted provider hazard needs its exact single hardware render proof" }
                    verified.put(warningAssets.verify(matching.single(), expectedWarningSessionEpoch, cut.getInt("hazardGeneration"), expected, diagnostics, snapshotAtNanos))
                }
                report
                    .put("hazardTtsStarted", hazardTtsStarts.get()) // Diagnostic only; never credits catalog audio.
                    .put("warningStartedForInterruptedHazard", true)
                    .put("verifiedWarningRenders", verified)
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
                .apply { if (error is QaWarningProofFailure) put("failureDetail", error.message) }
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
            val warningBeforeStop = session.syntheticWarningDiagnostics()
            val warningBeforeStopAtNanos = System.nanoTime()
            report.put("warningDiagnosticsBeforeStop", qaWarningDiagnosticsJson(warningBeforeStop, warningBeforeStopAtNanos))
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
                            field(session, "webSocket") == null &&
                            session.syntheticWarningDiagnostics().let { warning ->
                                !warning.prepared && warning.current == null && !warning.output.active &&
                                    !warning.output.running && warning.output.pendingBuffers == 0
                            }
                    stopped
                }
            } catch (_: TimeoutCancellationException) {
                stopped = false
            }
            val warningAfterStop = session.syntheticWarningDiagnostics()
            report.put("warningDiagnosticsAfterStop", qaWarningDiagnosticsJson(warningAfterStop, System.nanoTime()))
                .put("nativeWarningStopped", !warningAfterStop.prepared && warningAfterStop.current == null &&
                    !warningAfterStop.output.active && !warningAfterStop.output.running && warningAfterStop.output.pendingBuffers == 0)
            report.put("nativeStopped", stopped)
            if (args.getString("tracePipeline") == "true") {
                report.put("nativePipelineObservations", JSONArray(pipeline.toList()))
                    .put("nativePipelineDroppedObservations", pipelineDropped.get())
            }
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

private fun qaProviderPlaybackJson(p: PcmPlayer.PlaybackDiagnostics): JSONObject = JSONObject()
    .put("running", p.running).put("active", p.active).put("generation", p.generation)
    .put("queuedSamples", p.queuedSamples).put("writtenSamples", p.writtenSamples)
    .put("playbackSamples", p.playbackSamples).put("pendingBuffers", p.pendingBuffers)
    .put("totalQueuedSamples", p.totalQueuedSamples).put("totalPlayedSamples", p.totalPlayedSamples)
    .put("totalDiscardedSamples", p.totalDiscardedSamples).put("lastFlushSucceeded", p.lastFlushSucceeded)

private fun qaWarningIdentityJson(clip: WarningClipIdentity): JSONObject = JSONObject()
    .put("threat", clip.threat).put("text", clip.text).put("gender", clip.gender)
    .put("wavSha256", clip.wavSha256).put("pcmSha256", clip.pcmSha256).put("samples", clip.samples)

private fun qaWarningRequestJson(request: SafetyWarningRequest): JSONObject = JSONObject()
    .put("sessionEpoch", request.sessionEpoch.toString()).put("hazardGeneration", request.hazardGeneration)
    .put("clip", qaWarningIdentityJson(request.clip)).put("playbackEpoch", request.playbackEpoch.toString())
    .put("playbackGeneration", request.playbackGeneration).put("requestedAtNanos", request.requestedAtNanos.toString())

private fun qaWarningProgressJson(progress: WarningPcmProgress): JSONObject = JSONObject()
    .put("playbackEpoch", progress.playbackEpoch.toString()).put("playbackGeneration", progress.playbackGeneration)
    .put("writtenSamples", progress.writtenSamples).put("hardwarePlayedSamples", progress.hardwarePlayedSamples)
    .put("firstNonzeroSample", progress.firstNonzeroSample)
    .put("actualWrittenPcmSha256", progress.actualWrittenPcmSha256)
    .put("expectedWrittenPcmSha256", progress.expectedWrittenPcmSha256)
    .put("actualWrittenPcmBase64", progress.actualWrittenPcmBase64).put("outputGain", progress.outputGain)
    .put("observedAtNanos", progress.observedAtNanos.toString())

internal fun qaWarningDiagnosticsJson(d: SafetyWarningDiagnostics, observedAtNanos: Long = System.nanoTime()): JSONObject = JSONObject()
    .put("sessionEpoch", d.sessionEpoch.toString()).put("prepared", d.prepared)
    .put("snapshotAtNanos", observedAtNanos.toString())
    .put("current", d.current?.let { qaWarningRequestJson(it) } ?: JSONObject.NULL)
    .put("output", JSONObject().put("active", d.output.active).put("running", d.output.running)
        .put("playbackEpoch", d.output.playbackEpoch.toString()).put("playbackGeneration", d.output.playbackGeneration)
        .put("totalQueuedSamples", d.output.totalQueuedSamples).put("totalPlayedSamples", d.output.totalPlayedSamples)
        .put("totalDiscardedSamples", d.output.totalDiscardedSamples).put("queuedSamples", d.output.queuedSamples)
        .put("writtenSamples", d.output.writtenSamples).put("hardwarePlayedSamples", d.output.hardwarePlayedSamples)
        .put("pendingBuffers", d.output.pendingBuffers)
        .put("progress", d.output.progress?.let { qaWarningProgressJson(it) } ?: JSONObject.NULL))
    .put("proofs", JSONArray(d.proofs.map { p -> JSONObject().put("request", qaWarningRequestJson(p.request))
        .put("progress", qaWarningProgressJson(p.progress)).put("capturedAtNanos", p.capturedAtNanos.toString()) }))
    .put("retiredRequests", JSONArray(d.retiredRequests.map { r -> JSONObject()
        .put("request", qaWarningRequestJson(r.request)).put("retiredAtNanos", r.retiredAtNanos.toString()) }))

private class QaWarningProofFailure(message: String) : IllegalStateException("Warning proof: $message")
private fun qaWarningRequire(condition: Boolean, message: String) { if (!condition) throw QaWarningProofFailure(message) }

/** Independent test-side asset decoder and gain contract; production verification helpers are never called. */
private class QaWarningAssets(read: (String) -> ByteArray) {
    private data class Asset(val identity: WarningClipIdentity, val pcm: ByteArray)
    private val assets: List<Asset>
    private fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    init {
        val manifest = JSONObject(read("manifest.json").toString(Charsets.UTF_8))
        qaWarningRequire(manifest.getInt("version") == 1 && manifest.getInt("sampleRate") == 24000 &&
            manifest.getInt("channels") == 1 && manifest.getString("sampleFormat") == "s16le", "manifest format")
        val entries = manifest.getJSONArray("assets")
        qaWarningRequire(entries.length() == 18, "all eighteen canonical assets required")
        val threats = setOf("rear_approach", "forward_collision", "left_blind_spot", "right_blind_spot",
            "lane_departure", "left_cross_traffic", "right_cross_traffic", "pedestrian_ahead", "tailgating")
        val keys = mutableSetOf<String>()
        assets = (0 until entries.length()).map { i ->
            val item = entries.getJSONObject(i)
            val threat = item.getString("threat"); val gender = item.getString("gender"); val text = item.getString("text")
            val file = item.getString("file")
            qaWarningRequire(threat in threats && gender in setOf("female", "male") && text.isNotBlank() &&
                file == "$gender/$threat.wav" && keys.add(file), "unknown or duplicate warning identity")
            val identity = WarningClipIdentity(threat, text, gender, item.getString("sha256"), item.getString("pcmSha256"), item.getInt("samples"))
            val wav = read(file)
            qaWarningRequire(sha(wav) == identity.wavSha256, "canonical WAV hash")
            val pcm = decodeWav(wav, identity.samples)
            qaWarningRequire(sha(pcm) == identity.pcmSha256, "canonical PCM hash")
            Asset(identity, pcm)
        }
        for (threat in threats) qaWarningRequire(assets.filter { it.identity.threat == threat }.map { it.identity.text }.distinct().size == 1, "gender text mismatch")
    }

    fun identity(threat: String, text: String, gender: String): WarningClipIdentity =
        assets.singleOrNull { it.identity.threat == threat && it.identity.text == text && it.identity.gender == gender }?.identity
            ?: throw QaWarningProofFailure("hazard does not match canonical exact text/gender/threat")

    fun verify(proof: SafetyWarningRenderProof, sessionEpoch: Long, hazard: Int, expected: WarningClipIdentity,
        diagnostics: SafetyWarningDiagnostics, snapshotAtNanos: Long): JSONObject {
        val r = proof.request; val p = proof.progress
        qaWarningRequire(r.sessionEpoch == sessionEpoch && sessionEpoch > 0 && r.hazardGeneration == hazard && hazard > 0, "stale session or wrong hazard")
        qaWarningRequire(r.clip == expected, "wrong warning identity for exact provider cut")
        val asset = assets.singleOrNull { it.identity == r.clip } ?: throw QaWarningProofFailure("untrusted asset")
        qaWarningRequire(r.playbackEpoch > 0 && r.playbackEpoch == p.playbackEpoch && r.playbackGeneration == p.playbackGeneration, "stale output epoch/generation")
        qaWarningRequire(p.writtenSamples in 1..r.clip.samples.toLong() && p.hardwarePlayedSamples in 1..p.writtenSamples, "accepted/hardware sample counts")
        qaWarningRequire(p.actualWrittenPcmBase64.length.toLong() <= (r.clip.samples.toLong() * 2 + 2) / 3 * 4, "accepted prefix too large")
        val actual = Base64.decode(p.actualWrittenPcmBase64, Base64.NO_WRAP)
        qaWarningRequire(actual.size.toLong() == p.writtenSamples * 2 && Base64.encodeToString(actual, Base64.NO_WRAP) == p.actualWrittenPcmBase64, "accepted prefix length/base64")
        val processed = processPcm(asset.pcm, p.outputGain)
        val expectedPrefix = processed.copyOfRange(0, actual.size)
        val expectedHash = sha(expectedPrefix)
        qaWarningRequire(actual.contentEquals(expectedPrefix) && sha(actual) == p.actualWrittenPcmSha256 &&
            expectedHash == p.expectedWrittenPcmSha256, "actual accepted bytes differ from independently processed prefix")
        var first = -1
        var playedNonzero = 0
        for (i in 0 until actual.size / 2) if (actual[i * 2].toInt() != 0 || actual[i * 2 + 1].toInt() != 0) {
            if (first < 0) first = i
            if (i.toLong() < p.hardwarePlayedSamples) playedNonzero++
        }
        qaWarningRequire(first >= 0 && first == p.firstNonzeroSample && p.hardwarePlayedSamples > first && playedNonzero > 0, "hardware has not passed actual postgain nonzero sample")
        qaWarningRequire(r.requestedAtNanos > 0 && r.requestedAtNanos <= p.observedAtNanos &&
            p.observedAtNanos <= proof.capturedAtNanos && proof.capturedAtNanos <= snapshotAtNanos, "invalid proof time order")
        val retired = diagnostics.retiredRequests.filter { it.request == r }
        qaWarningRequire(retired.size <= 1, "ambiguous request ownership")
        if (retired.isNotEmpty()) qaWarningRequire(proof.capturedAtNanos < retired.single().retiredAtNanos, "progress first observed after supersession")
        else qaWarningRequire(diagnostics.current == r, "proof is neither current nor retired in this session")
        return JSONObject().put("verified", true).put("hazardGeneration", hazard)
            .put("sessionEpoch", sessionEpoch.toString()).put("playbackEpoch", r.playbackEpoch.toString())
            .put("playbackGeneration", r.playbackGeneration).put("clip", qaWarningIdentityJson(expected))
            .put("verifiedPrefixSha256", expectedHash).put("firstNonzeroSample", first)
            .put("hardwarePlayedNonzeroSamples", playedNonzero).put("writtenSamples", p.writtenSamples)
            .put("hardwarePlayedSamples", p.hardwarePlayedSamples)
    }

    private fun decodeWav(wav: ByteArray, samples: Int): ByteArray {
        qaWarningRequire(samples > 0 && wav.size >= 12, "WAV too short")
        val b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        fun tag(at: Int) = String(wav, at, 4, Charsets.US_ASCII)
        qaWarningRequire(tag(0) == "RIFF" && tag(8) == "WAVE" && b.getInt(4).toLong() + 8 == wav.size.toLong(), "WAV header")
        var at = 12; var format = false; var pcm: ByteArray? = null
        while (at < wav.size) {
            qaWarningRequire(at + 8 <= wav.size, "truncated WAV chunk")
            val length = b.getInt(at + 4).toLong() and 0xffffffffL; val start = at + 8; val end = start.toLong() + length
            qaWarningRequire(end + length % 2 <= wav.size, "WAV chunk bounds")
            when (tag(at)) {
                "fmt " -> { qaWarningRequire(!format && length >= 16 && b.getShort(start).toInt() == 1 &&
                    b.getShort(start + 2).toInt() == 1 && b.getInt(start + 4) == 24000 && b.getInt(start + 8) == 48000 &&
                    b.getShort(start + 12).toInt() == 2 && b.getShort(start + 14).toInt() == 16, "WAV PCM format"); format = true }
                "data" -> { qaWarningRequire(pcm == null && length == samples.toLong() * 2, "WAV sample count"); pcm = wav.copyOfRange(start, end.toInt()) }
            }
            at = (end + length % 2).toInt()
        }
        qaWarningRequire(format && pcm != null && pcm.any { it.toInt() != 0 }, "missing or silent source PCM")
        return pcm!!
    }

    private fun processPcm(source: ByteArray, gain: Float): ByteArray {
        qaWarningRequire(gain.isFinite() && gain in 0.5f..4f, "gain outside declared processing contract")
        val bytes = source.copyOf()
        if (gain == 1f) return bytes
        for (at in bytes.indices step 2) {
            val sample = (bytes[at + 1].toInt() shl 8) or (bytes[at].toInt() and 255)
            val scaled = sample / 32768f * gain
            val magnitude = kotlin.math.abs(scaled); val threshold = 0.7f; val headroom = 1f - threshold
            val limited = if (magnitude <= threshold) scaled else {
                val value = threshold + headroom * (1f - kotlin.math.exp(-(magnitude - threshold) / headroom))
                if (scaled < 0f) -value else value
            }
            val output = (limited * 32767f).toInt().coerceIn(-32768, 32767)
            bytes[at] = output.toByte(); bytes[at + 1] = (output shr 8).toByte()
        }
        return bytes
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
