package io.github.henrycooper86.max.agent

import android.Manifest
import android.app.Instrumentation
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import io.github.henrycooper86.max.BuildConfig
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/** Private measurement only: real AgentSession/OkHttp/AudioTrack, local controlled relay. */
internal fun runNativePipelineDiagnostic(instrumentation: Instrumentation, args: Bundle) {
    val output = Bundle()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val observations = ConcurrentLinkedQueue<JSONObject>()
    var session: AgentSession? = null
    val report = JSONObject()
        .put("nativeBundleSourceBaseBuild", BuildConfig.GIT_COMMIT)
        .put("source", "Uncommitted Android diagnostic overlay; not release QA evidence")
        .put("capture", "Synthetic silence only, no microphone/location/camera")
    try {
        for (permission in listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) {
            check(instrumentation.targetContext.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
        }
        instrumentation.runOnMainSync {
            session = AgentSession(instrumentation.targetContext, scope, captureFactory = { frame, _, _ ->
                object : PcmCapture {
                    private val running = AtomicBoolean(false)
                    private var job: Job? = null
                    override fun start() {
                        running.set(true)
                        job = scope.launch {
                            while (running.get() && isActive) { frame(ByteArray(640)); delay(20) }
                        }
                    }
                    override fun stop() { running.set(false); job?.cancel() }
                }
            })
        }
        val current = session!!
        val observer: (String, Int) -> Unit = { stage, value ->
            observations.add(JSONObject().put("stage", stage).put("value", value)
                .put("monoNs", SystemClock.elapsedRealtimeNanos())
                .put("utcMs", System.currentTimeMillis()).put("thread", Thread.currentThread().name))
        }
        // Opt-in observations of the actual pipeline; this does not replace its transport or player.
        current.syntheticPipelineObserver = observer
        runBlocking {
            instrumentation.runOnMainSync {
                current.start(args.getString("url") ?: "ws://10.0.2.2:18765/agent", false, "", "android-local-pipeline")
            }
            withTimeout(20000) {
                while (current.state.value.connection != ConnectionState.READY) delay(10)
            }
            withTimeout(20000) {
                while (current.state.value.statusText != "controlled-pipeline-complete") delay(10)
            }
            delay(2500)
            val stages = observations.map { it.getString("stage") }
            check(stages.contains("socket.binary.received") && stages.contains("pcm.write.end")) {
                "Native PCM receive/write boundaries were not observed"
            }
            val start = observations.first { it.getString("stage") == "pcm.track.start.begin" }
            val binary = observations.first { it.getString("stage") == "socket.binary.received" }
            check(!start.getString("thread").startsWith("OkHttp")) {
                "AudioTrack setup blocked the WebSocket reader"
            }
            check(start.getLong("monoNs") < binary.getLong("monoNs")) {
                "AudioTrack was not ready before first PCM"
            }
            report.put("passed", true)
        }
    } catch (error: Throwable) {
        report.put("passed", false).put("failureClass", error.javaClass.simpleName)
        output.putString("failureClass", error.javaClass.simpleName)
    } finally {
        instrumentation.runOnMainSync { session?.stop(force = true) }
        val tts = session?.javaClass?.getDeclaredField("tts")?.apply { isAccessible = true }?.get(session) as? TextToSpeech
        tts?.shutdown()
        scope.cancel()
        report.put("observations", JSONArray(observations.toList()))
        val dir = File(instrumentation.targetContext.filesDir, "synthetic-pipeline").apply { mkdirs() }
        val file = File(dir, "pipeline-${System.currentTimeMillis()}-${UUID.randomUUID()}.json")
        file.outputStream().use { it.write(report.toString(2).toByteArray()) }
        output.putString("report", file.name)
        instrumentation.finish(if (report.optBoolean("passed")) -1 else 1, output)
    }
}
