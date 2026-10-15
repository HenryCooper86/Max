package com.horizon.maxhelmet.agent

import android.Manifest
import android.app.Instrumentation
import android.content.pm.PackageManager
import android.os.Bundle
import com.horizon.maxhelmet.BuildConfig
import java.io.File
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import org.json.JSONObject

/** Local real AudioTrack controls only: no relay, TTS engine, device capture, or QA credit. */
internal fun runNativeSafetyWarningDiagnostic(instrumentation: Instrumentation) {
    val result = JSONObject().put("sourceBaseBuild", BuildConfig.GIT_COMMIT)
        .put("scope", "Local bundled warning/hardware ownership control; no release QA credit")
    val output = Bundle()
    val player = PcmPlayer(verifyWarningRender = true).apply { level = 1f }
    val read: (String) -> ByteArray = { path -> instrumentation.targetContext.assets.open("adas/$path").use { it.readBytes() } }
    val audio = SafetyWarningAudio({ SafetyWarningCatalog.load(read) }, object : SafetyWarningSink {
        override fun prepare() = player.prepare()
        override fun warmUp() = player.warmUp()
        override fun play(pcm: ByteArray) = player.play(pcm)
        override fun stop() = player.stopPlayback()
        override fun release() = player.release()
        override fun diagnostics() = player.warningOutputState()
    })
    val resume = CountDownLatch(1)
    try {
        for (permission in listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            check(instrumentation.targetContext.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
        runBlocking {
            audio.prepare()
            withContext(Dispatchers.IO) { check(audio.warmUp()) }
            check(audio.diagnostics().proofs.isEmpty())
            val text = "前车急刹，注意保持车距！ 立即收油，平稳减速。"
            check(audio.play("forward_collision", text, "female", 3, expectedOwner = 0))
            withTimeout(10000) { while (audio.diagnostics().proofs.isEmpty()) delay(5) }
            val proof = audio.diagnostics().proofs.single()
            val p = proof.progress
            val accepted = Base64.getDecoder().decode(p.actualWrittenPcmBase64)
            // These canonical generated WAVs have a 44-byte header. The catalog
            // parser is deliberately not reused for this accepted-byte comparison.
            val wav = read("female/forward_collision.wav")
            check(String(wav, 36, 4, Charsets.US_ASCII) == "data")
            check(accepted.contentEquals(wav.copyOfRange(44, 44 + accepted.size)))
            check(p.outputGain == 1f && p.writtenSamples * 2 == accepted.size.toLong())
            check(p.hardwarePlayedSamples > p.firstNonzeroSample && p.writtenSamples > p.firstNonzeroSample)
            check(proof.request.hazardGeneration == 3 && proof.request.clip.text == text)
            result.put("realNonzeroHardwareProgress", true).put("actualAcceptedPrefixMatchesAsset", true)
                .put("writtenSamples", p.writtenSamples).put("hardwarePlayedSamples", p.hardwarePlayedSamples)
                .put("actualWrittenPcmSha256", p.actualWrittenPcmSha256)

            // Hold the real feeder before its next write, supersede that warning,
            // then prove the stale ticket never earns a start from the old head.
            val reached = CountDownLatch(1); val first = AtomicBoolean(true)
            player.syntheticPipelineObserver = { stage, _ ->
                if (stage == "pcm.write.begin" && first.compareAndSet(true, false)) {
                    reached.countDown(); check(resume.await(5, TimeUnit.SECONDS))
                }
            }
            check(audio.play("forward_collision", text, "male", 4, expectedOwner = 0))
            check(reached.await(5, TimeUnit.SECONDS))
            check(audio.diagnostics().proofs.none { it.request.hazardGeneration == 4 })
            audio.stop()
            check(audio.play("forward_collision", text, "female", 5, expectedOwner = 0))
            resume.countDown()
            withTimeout(10000) { while (audio.diagnostics().proofs.none { it.request.hazardGeneration == 5 }) delay(5) }
            check(audio.diagnostics().proofs.none { it.request.hazardGeneration == 4 })
            val beforeStop = audio.diagnostics()
            result.put("warningDiagnosticsBeforeStop", qaWarningDiagnosticsJson(beforeStop))
            for (render in beforeStop.proofs) {
                val retired = beforeStop.retiredRequests.firstOrNull { it.request == render.request }
                check(render.progress.observedAtNanos >= render.request.requestedAtNanos)
                if (retired != null) check(render.capturedAtNanos <= retired.retiredAtNanos)
            }
            result.put("supersededUnwrittenWarningHasNoProof", true)
            audio.release()
            val stopped = audio.diagnostics()
            result.put("warningDiagnosticsAfterStop", qaWarningDiagnosticsJson(stopped))
            check(!stopped.prepared && !stopped.output.active && !stopped.output.running)
            check(!audio.play("forward_collision", text, "female", 6, expectedOwner = 0))
            check(!player.warmUp())
            result.put("stopReleasesAndFencesLatePlayback", true)
            verifyStaleHazardIngress(instrumentation, result)
            result.put("passed", true)
        }
    } catch (error: Throwable) {
        result.put("passed", false).put("failureClass", error.javaClass.simpleName)
        output.putString("failureClass", error.javaClass.simpleName)
    } finally {
        resume.countDown(); player.syntheticPipelineObserver = null; audio.release()
        val dir = File(instrumentation.targetContext.filesDir, "synthetic-pipeline").apply { mkdirs() }
        val file = File(dir, "offline-warning-${System.currentTimeMillis()}-${UUID.randomUUID()}.json")
        file.writeText(result.toString(2)); output.putString("report", file.name)
        instrumentation.finish(if (result.optBoolean("passed")) -1 else 1, output)
    }
}

/** Exercises the real production dispatch boundary with an already-parsed old
 * socket event. Fake sockets never connect; all output is local synthetic PCM. */
private suspend fun verifyStaleHazardIngress(instrumentation: Instrumentation, result: JSONObject) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    lateinit var session: AgentSession
    instrumentation.runOnMainSync {
        session = AgentSession(instrumentation.targetContext, scope, captureFactory = { _, _, _ ->
            object : PcmCapture {
                override fun start(): Unit = error("This ingress control must never start capture")
                override fun stop() = Unit
            }
        })
    }
    fun field(name: String) = session.javaClass.getDeclaredField(name).apply { isAccessible = true }
    val lifecycle = field("lifecycle").get(session) as SessionLifecycle
    val warnings = field("warningAudio").get(session) as SafetyWarningAudio
    val provider = field("player").get(session) as PcmPlayer
    val socketField = field("webSocket")
    fun socket() = object : okhttp3.WebSocket {
        override fun request() = okhttp3.Request.Builder().url("http://127.0.0.1/local-control-only").build()
        override fun queueSize() = 0L
        override fun send(text: String) = true
        override fun send(bytes: okio.ByteString) = true
        override fun close(code: Int, reason: String?) = true
        override fun cancel() = Unit
    }
    val oldSocket = socket()
    val dispatch = session.javaClass.getDeclaredMethod("handleEvent", AgentEvent::class.java, okhttp3.WebSocket::class.java)
        .apply { isAccessible = true }
    val hazard = AgentEvent.HazardAlert("forward_collision", "front", HazardLevel.CRITICAL,
        "local control", "前车急刹，注意保持车距！", "立即收油，平稳减速。", 2, true)
    try {
        val firstOwner = lifecycle.begin()!!
        warnings.prepare(firstOwner); provider.prepare()
        withContext(Dispatchers.IO) { check(warnings.warmUp() && provider.warmUp()) }
        socketField.set(session, oldSocket)
        // A parsed old message resumes after a transport-only restart.
        socketField.set(session, socket())
        val before = provider.playbackDiagnostics()
        dispatch.invoke(session, hazard, oldSocket)
        check(provider.playbackDiagnostics().generation == before.generation)
        check(session.syntheticHazardPlayback == null && session.state.value.hazardAlert == null)
        check(warnings.diagnostics().current == null && warnings.diagnostics().output.totalQueuedSamples == 0L)
        result.put("parsedOldSocketRejectedAfterTransportRestart", true)
        // The same parsed old source cannot borrow a new lifecycle owner either.
        lifecycle.stop(); warnings.release()
        val newOwner = lifecycle.begin()!!
        warnings.prepare(newOwner)
        withContext(Dispatchers.IO) { check(warnings.warmUp()) }
        socketField.set(session, socket())
        dispatch.invoke(session, hazard, oldSocket)
        check(provider.playbackDiagnostics().generation == before.generation)
        check(session.syntheticHazardPlayback == null && session.state.value.hazardAlert == null)
        check(warnings.diagnostics().current == null && warnings.diagnostics().output.totalQueuedSamples == 0L)
        result.put("parsedOldSocketRejectedAfterLifecycleRestart", true)
            .put("ingressControlBoundary", "Actual handleEvent with previously parsed original sourceSocket; no transport opened")
    } finally {
        instrumentation.runOnMainSync { session.stop(force = true) }
        (field("tts").get(session) as? android.speech.tts.TextToSpeech)?.shutdown()
        warnings.release(); provider.release(); scope.cancel()
    }
}
