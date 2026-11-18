package io.github.henrycooper86.max.agent

import android.Manifest
import android.app.Instrumentation
import android.content.pm.PackageManager
import android.os.Bundle
import io.github.henrycooper86.max.BuildConfig
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.json.JSONObject

/** Real AudioTrack barriers at transform/dequeue/write, never a replacement audio sink. */
internal fun runNativePcmGenerationDiagnostic(instrumentation: Instrumentation, args: Bundle) {
    val phase = args.getString("phase", "gain")
    val blockedStage = when (phase) {
        "gain" -> "pcm.gain.begin"
        "dequeue" -> "pcm.dequeued"
        "write" -> "pcm.write.begin"
        else -> error("Unknown PCM race")
    }
    val result = JSONObject().put("sourceBaseBuild", BuildConfig.GIT_COMMIT)
        .put("scope", "Local synthetic PCM ownership barrier; no release QA credit")
        .put("phase", phase)
    val output = Bundle()
    val player = PcmPlayer()
    val reached = CountDownLatch(1)
    val resume = CountDownLatch(1)
    val first = AtomicBoolean(true)
    val stopped = AtomicBoolean(false)
    val staleWrites = AtomicInteger()
    var producer: Thread? = null
    try {
        for (permission in listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            check(instrumentation.targetContext.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
        player.prepare()
        runBlocking { withContext(Dispatchers.IO) { check(player.warmUp()) } }
        player.syntheticPipelineObserver = { stage, value ->
            if (stage == blockedStage && first.compareAndSet(true, false)) {
                reached.countDown()
                check(resume.await(5, TimeUnit.SECONDS))
            }
            if (stage == "pcm.write.end" && value > 0 && stopped.get()) staleWrites.addAndGet(value)
        }
        val pcm = ByteArray(4800)
        for (sample in 0 until pcm.size / 2) {
            val value = (1000 * kotlin.math.sin(sample * 2 * Math.PI * 440 / 24000)).toInt()
            pcm[sample * 2] = value.toByte()
            pcm[sample * 2 + 1] = (value shr 8).toByte()
        }
        producer = Thread { player.play(pcm) }.also { it.start() }
        check(reached.await(5, TimeUnit.SECONDS))
        val receivedBeforeStop = player.playbackDiagnostics().totalQueuedSamples
        player.stopPlayback()
        stopped.set(true)
        val discardedByStop = player.playbackDiagnostics().totalDiscardedSamples
        resume.countDown()
        producer.join(5000)
        check(!producer.isAlive)
        // Let the actual feeder finish or reject the released barrier.
        runBlocking { delay(150) }
        val after = player.playbackDiagnostics()
        player.stopPlayback() // another empty ASR partial must not be needed to catch stale PCM
        result.put("receivedSamplesBeforeInterrupt", receivedBeforeStop)
            .put("discardedSamplesAtInterrupt", discardedByStop)
            .put("queuedSamplesAfterResume", after.queuedSamples)
            .put("staleHardwareWriteBytes", staleWrites.get())
            .put("totalReceivedSamples", after.totalQueuedSamples)
            .put("totalPlayedSamples", after.totalPlayedSamples)
            .put("totalDiscardedSamples", after.totalDiscardedSamples)
        check(receivedBeforeStop == 2400L && discardedByStop == 2400L) {
            "Received PCM cancelled during processing was not accounted as discarded"
        }
        check(after.queuedSamples == 0L && staleWrites.get() == 0) {
            "An interrupted PCM ticket was queued or written after the hardware flush"
        }
        check(after.totalQueuedSamples == after.totalPlayedSamples + after.totalDiscardedSamples)
        result.put("passed", true)
    } catch (error: Throwable) {
        result.put("passed", false).put("failureClass", error.javaClass.simpleName)
        output.putString("failureClass", error.javaClass.simpleName)
    } finally {
        resume.countDown()
        producer?.join(5000)
        player.syntheticPipelineObserver = null
        player.release()
        val dir = File(instrumentation.targetContext.filesDir, "synthetic-pipeline").apply { mkdirs() }
        val file = File(dir, "pcm-race-$phase-${System.currentTimeMillis()}-${UUID.randomUUID()}.json")
        file.writeText(result.toString(2))
        output.putString("report", file.name)
        instrumentation.finish(if (result.optBoolean("passed")) -1 else 1, output)
    }
}
