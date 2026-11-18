package io.github.henrycooper86.max.agent

import android.Manifest
import android.app.Instrumentation
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import io.github.henrycooper86.max.BuildConfig
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.json.JSONObject

/** Failure injection into actual AudioTrack startup; never opens capture hardware. */
internal fun runNativePlaybackWarmupDiagnostic(instrumentation: Instrumentation) {
    val result = JSONObject().put("sourceBaseBuild", BuildConfig.GIT_COMMIT)
        .put("scope", "Uncommitted native lifecycle diagnostic; no release QA credit")
    val output = Bundle()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    var session: AgentSession? = null
    val captureStarts = AtomicInteger()
    try {
        for (permission in listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            check(instrumentation.targetContext.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
        instrumentation.runOnMainSync {
            session = AgentSession(instrumentation.targetContext, scope, captureFactory = { _, _, _ ->
                object : PcmCapture {
                    override fun start() { captureStarts.incrementAndGet() }
                    override fun stop() = Unit
                }
            })
        }
        val idlePlayer = PcmPlayer()
        try {
            idlePlayer.prepare()
            runBlocking { withContext(Dispatchers.IO) { check(idlePlayer.warmUp()) } }
            idlePlayer.stopPlayback()
            check(!idlePlayer.playbackDiagnostics().lastFlushSucceeded) {
                "An empty prewarmed output should not invoke a hardware flush"
            }
            result.put("emptyPrewarmedOutputDoesNotFlushHardware", true)
            idlePlayer.play(ByteArray(48000))
            check(idlePlayer.playbackDiagnostics().queuedSamples > 0)
            idlePlayer.stopPlayback()
            val interrupted = idlePlayer.playbackDiagnostics()
            check(interrupted.lastFlushSucceeded && interrupted.totalDiscardedSamples > 0 && interrupted.pendingBuffers == 0)
            result.put("queuedPcmStillRequiresHardwareFlush", true)
        } finally { idlePlayer.release() }
        val current = session!!
        val injectedFailure = AtomicBoolean(false)
        current.syntheticPipelineObserver = { stage, _ ->
            if (stage == "pcm.track.start.end" && injectedFailure.compareAndSet(false, true)) {
                throw IllegalStateException("Controlled failure after real AudioTrack creation")
            }
        }
        runBlocking {
            instrumentation.runOnMainSync { current.start("ws://10.0.2.2:18765/agent", false) }
            withTimeout(10000) {
                while (current.state.value.connection != ConnectionState.DEGRADED || current.state.value.handsFree) delay(10)
            }
            val player = current.javaClass.getDeclaredField("player").apply { isAccessible = true }.get(current) as PcmPlayer
            val socket = current.javaClass.getDeclaredField("webSocket").apply { isAccessible = true }
            check(injectedFailure.get() && captureStarts.get() == 0 && socket.get(current) == null)
            check(!player.playbackDiagnostics().active && !player.playbackDiagnostics().running)
            result.put("startupFailureReleasedActualTrack", true).put("captureStartedOnFailure", false)
            current.syntheticPipelineObserver = null
            instrumentation.runOnMainSync { current.start("ws://10.0.2.2:18765/agent", false) }
            withTimeout(10000) { while (current.state.value.connection != ConnectionState.READY) delay(10) }
            check(current.state.value.handsFree && captureStarts.get() == 1)
            result.put("newGenerationStartsAfterFailure", true)
            delay(2500)
            instrumentation.runOnMainSync { current.stop(force = true) }
            check(!player.warmUp()) { "A late warm-up reopened the stopped AudioTrack" }
            check(!player.playbackDiagnostics().active && !player.playbackDiagnostics().running)
            result.put("lateWarmupCannotReopenStoppedTrack", true)
            // A frame already delivered when stop won cannot rebuild the track either.
            player.play(ByteArray(640))
            check(!player.playbackDiagnostics().active && !player.playbackDiagnostics().running)
            result.put("latePcmCannotReopenStoppedTrack", true).put("passed", true)
        }
    } catch (error: Throwable) {
        result.put("passed", false).put("failureClass", error.javaClass.simpleName)
        output.putString("failureClass", error.javaClass.simpleName)
    } finally {
        instrumentation.runOnMainSync { session?.stop(force = true) }
        (session?.javaClass?.getDeclaredField("tts")?.apply { isAccessible = true }?.get(session) as? TextToSpeech)?.shutdown()
        scope.cancel()
        val dir = File(instrumentation.targetContext.filesDir, "synthetic-pipeline").apply { mkdirs() }
        val file = File(dir, "warmup-${System.currentTimeMillis()}-${UUID.randomUUID()}.json")
        file.writeText(result.toString(2))
        output.putString("report", file.name)
        instrumentation.finish(if (result.optBoolean("passed")) -1 else 1, output)
    }
}

/** A deterministic barrier proves that GUI Stop never waits for output construction. */
internal fun runNativeWarmupStopRaceDiagnostic(instrumentation: Instrumentation, restart: Boolean = false, cancelOwner: Boolean = false) {
    val result = JSONObject().put("sourceBaseBuild", BuildConfig.GIT_COMMIT)
        .put("scope", "Local native initialization/GUI-stop barrier; no release QA credit")
    val output = Bundle()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val constructed = java.util.concurrent.CountDownLatch(1)
    val allowInstall = java.util.concurrent.CountDownLatch(1)
    val candidateReleased = java.util.concurrent.CountDownLatch(1)
    val fallbackReleasedBarrier = AtomicBoolean(false)
    val captureStarts = AtomicInteger()
    val firstCandidate = AtomicBoolean(true)
    var session: AgentSession? = null
    var fallback: Thread? = null
    try {
        for (permission in listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            check(instrumentation.targetContext.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
        instrumentation.runOnMainSync {
            session = AgentSession(instrumentation.targetContext, scope, captureFactory = { _, _, _ ->
                object : PcmCapture {
                    override fun start() { captureStarts.incrementAndGet() }
                    override fun stop() = Unit
                }
            })
        }
        val current = session!!
        current.syntheticPipelineObserver = { stage, _ ->
            if (stage == "pcm.track.start.end" && firstCandidate.compareAndSet(true, false)) {
                constructed.countDown()
                check(allowInstall.await(5, java.util.concurrent.TimeUnit.SECONDS))
            }
            if (stage == "pcm.track.candidate.released") candidateReleased.countDown()
        }
        instrumentation.runOnMainSync { current.start("ws://10.0.2.2:18765/agent", false) }
        check(constructed.await(10, java.util.concurrent.TimeUnit.SECONDS))
        if (cancelOwner) {
            scope.cancel()
            allowInstall.countDown()
            runBlocking { withTimeout(10000) { scope.coroutineContext[Job]!!.join() } }
            val player = current.javaClass.getDeclaredField("player").apply { isAccessible = true }.get(current) as PcmPlayer
            result.put("outputActiveAfterOwnerCancellation", player.playbackDiagnostics().active)
                .put("outputRunningAfterOwnerCancellation", player.playbackDiagnostics().running)
                .put("handsFreeAfterOwnerCancellation", current.state.value.handsFree)
                .put("captureStarts", captureStarts.get())
            check(!player.playbackDiagnostics().active && !player.playbackDiagnostics().running && !current.state.value.handsFree)
            check(captureStarts.get() == 0)
            result.put("passed", true)
            return
        }
        // A bounded escape prevents a broken implementation from hanging the test.
        // The assertion is causal (whether Stop needed this escape), not a latency SLA.
        fallback = Thread {
            try {
                Thread.sleep(400)
                fallbackReleasedBarrier.set(true)
                allowInstall.countDown()
            } catch (_: InterruptedException) { }
        }.also { it.start() }
        val began = android.os.SystemClock.elapsedRealtimeNanos()
        instrumentation.runOnMainSync { current.stop(force = true) }
        result.put("mainThreadStopMs", (android.os.SystemClock.elapsedRealtimeNanos() - began) / 1e6)
            .put("stopWaitedForConstructionBarrier", fallbackReleasedBarrier.get())
        check(!fallbackReleasedBarrier.get()) { "GUI Stop waited for AudioTrack construction" }
        val player = current.javaClass.getDeclaredField("player").apply { isAccessible = true }.get(current) as PcmPlayer
        val trackField = player.javaClass.getDeclaredField("track").apply { isAccessible = true }
        var nextTrack: Any? = null
        if (restart) {
            instrumentation.runOnMainSync { current.start("ws://10.0.2.2:18765/agent", false) }
            runBlocking { withTimeout(10000) { while (current.state.value.connection != ConnectionState.READY) delay(10) } }
            nextTrack = trackField.get(player)
            check(nextTrack != null && captureStarts.get() == 1)
        }
        allowInstall.countDown()
        check(candidateReleased.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
            "A late AudioTrack was not released after Stop"
        }
        if (restart) {
            check(trackField.get(player) === nextTrack)
            check(player.playbackDiagnostics().active && player.playbackDiagnostics().running && current.state.value.handsFree)
            result.put("oldCandidateCannotReplaceOrReleaseNewGeneration", true)
            runBlocking {
                withTimeout(10000) { while (current.state.value.statusText != "controlled-pipeline-complete") delay(10) }
                delay(1000)
            }
        } else {
            check(!player.playbackDiagnostics().active && !player.playbackDiagnostics().running)
            check(captureStarts.get() == 0 && !current.state.value.handsFree)
            check(current.javaClass.getDeclaredField("webSocket").apply { isAccessible = true }.get(current) == null)
        }
        result.put("lateCandidateReleasedWithoutInstallation", true)
            .put("oldGenerationCaptureStarted", false).put("passed", true)
    } catch (error: Throwable) {
        result.put("passed", false).put("failureClass", error.javaClass.simpleName)
        output.putString("failureClass", error.javaClass.simpleName)
    } finally {
        allowInstall.countDown()
        fallback?.interrupt()
        instrumentation.runOnMainSync { session?.stop(force = true) }
        (session?.javaClass?.getDeclaredField("tts")?.apply { isAccessible = true }?.get(session) as? TextToSpeech)?.shutdown()
        scope.cancel()
        val dir = File(instrumentation.targetContext.filesDir, "synthetic-pipeline").apply { mkdirs() }
        val file = File(dir, "warmup-stop-race-${System.currentTimeMillis()}-${UUID.randomUUID()}.json")
        file.writeText(result.toString(2))
        output.putString("report", file.name)
        instrumentation.finish(if (result.optBoolean("passed")) -1 else 1, output)
    }
}
