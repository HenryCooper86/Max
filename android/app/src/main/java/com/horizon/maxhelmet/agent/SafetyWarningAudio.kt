package com.horizon.maxhelmet.agent

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

internal fun safetySha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

data class WarningClipIdentity(val threat: String, val text: String, val gender: String,
    val wavSha256: String, val pcmSha256: String, val samples: Int)
data class WarningPcmProgress(val playbackEpoch: Long, val playbackGeneration: Int,
    val writtenSamples: Long, val hardwarePlayedSamples: Long, val firstNonzeroSample: Int,
    val actualWrittenPcmSha256: String, val expectedWrittenPcmSha256: String,
    val actualWrittenPcmBase64: String = "", val outputGain: Float = 1f,
    val observedAtNanos: Long = System.nanoTime())
data class WarningOutputState(val active: Boolean = false, val running: Boolean = false,
    val playbackEpoch: Long = 0, val playbackGeneration: Int = 0,
    val totalQueuedSamples: Long = 0, val totalPlayedSamples: Long = 0,
    val totalDiscardedSamples: Long = 0, val queuedSamples: Long = 0,
    val writtenSamples: Long = 0, val hardwarePlayedSamples: Long = 0,
    val pendingBuffers: Int = 0, val progress: WarningPcmProgress? = null)
data class SafetyWarningRequest(val sessionEpoch: Long, val hazardGeneration: Int,
    val clip: WarningClipIdentity, val playbackEpoch: Long, val playbackGeneration: Int,
    val requestedAtNanos: Long = System.nanoTime())
data class SafetyWarningRenderProof(val request: SafetyWarningRequest, val progress: WarningPcmProgress,
    val capturedAtNanos: Long = System.nanoTime())
data class SafetyWarningRetiredRequest(val request: SafetyWarningRequest, val retiredAtNanos: Long)
data class SafetyWarningDiagnostics(val sessionEpoch: Long, val prepared: Boolean,
    val current: SafetyWarningRequest?, val output: WarningOutputState,
    val proofs: List<SafetyWarningRenderProof>, val retiredRequests: List<SafetyWarningRetiredRequest>)

/** Owns immutable verified PCM; playback gain must only touch a fresh copy. */
class SafetyWarningClip(val identity: WarningClipIdentity, pcm: ByteArray) {
    private val bytes = pcm.copyOf()
    fun pcmCopy(): ByteArray = bytes.copyOf()
}

class SafetyWarningCatalog private constructor(private val clips: List<SafetyWarningClip>) {
    val size: Int get() = clips.size
    fun find(threat: String, text: String, gender: String): SafetyWarningClip? = clips.firstOrNull {
        it.identity.threat == threat && it.identity.text == text && it.identity.gender == gender
    }

    companion object {
        private val threats = setOf("rear_approach", "forward_collision", "left_blind_spot", "right_blind_spot",
            "lane_departure", "left_cross_traffic", "right_cross_traffic", "pedestrian_ahead", "tailgating")
        fun load(read: (String) -> ByteArray): SafetyWarningCatalog {
            val manifest = JSONObject(read("manifest.json").toString(Charsets.UTF_8))
            require(manifest.getInt("version") == 1 && manifest.getInt("sampleRate") == 24000 &&
                manifest.getInt("channels") == 1 && manifest.getString("sampleFormat") == "s16le")
            val assets = manifest.getJSONArray("assets")
            require(assets.length() == 18)
            val keys = mutableSetOf<String>()
            val clips = (0 until assets.length()).map { index ->
                val a = assets.getJSONObject(index)
                val threat = a.getString("threat"); val gender = a.getString("gender")
                val text = a.getString("text"); val file = a.getString("file")
                require(threat in threats && gender in setOf("male", "female") && text.isNotBlank())
                require(keys.add("$gender/$threat") && file == "$gender/$threat.wav")
                val wavHash = a.getString("sha256"); val pcmHash = a.getString("pcmSha256")
                require(wavHash.matches(Regex("[0-9a-f]{64}")) && pcmHash.matches(Regex("[0-9a-f]{64}")))
                val samples = a.getInt("samples"); require(samples > 0)
                val wav = read(file)
                require(safetySha256(wav) == wavHash) { "Safety warning WAV hash mismatch" }
                val pcm = decodeWav(wav, samples)
                require(safetySha256(pcm) == pcmHash) { "Safety warning PCM hash mismatch" }
                SafetyWarningClip(WarningClipIdentity(threat, text, gender, wavHash, pcmHash, samples), pcm)
            }
            for (threat in threats) require(clips.filter { it.identity.threat == threat }.map { it.identity.text }.distinct().size == 1)
            return SafetyWarningCatalog(clips)
        }

        private fun decodeWav(bytes: ByteArray, samples: Int): ByteArray {
            val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            fun tag(at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
            require(bytes.size >= 12 && tag(0) == "RIFF" && tag(8) == "WAVE" && b.getInt(4).toLong() + 8 == bytes.size.toLong())
            var at = 12; var format = false; var pcm: ByteArray? = null
            while (at < bytes.size) {
                require(at.toLong() + 8 <= bytes.size)
                val length = b.getInt(at + 4).toLong() and 0xffffffffL
                val start = at + 8; val end = start.toLong() + length
                require(end + length % 2 <= bytes.size)
                when (tag(at)) {
                    "fmt " -> {
                        require(!format && length >= 16 && b.getShort(start).toInt() == 1 &&
                            b.getShort(start + 2).toInt() == 1 && b.getInt(start + 4) == 24000 &&
                            b.getInt(start + 8) == 48000 && b.getShort(start + 12).toInt() == 2 && b.getShort(start + 14).toInt() == 16)
                        format = true
                    }
                    "data" -> { require(pcm == null && length == samples.toLong() * 2); pcm = bytes.copyOfRange(start, end.toInt()) }
                }
                at = (end + length % 2).toInt()
            }
            require(format && pcm != null && pcm.any { it.toInt() != 0 })
            return pcm
        }
    }
}

interface SafetyWarningSink {
    fun prepare()
    fun warmUp(): Boolean
    fun play(pcm: ByteArray)
    fun stop()
    fun release()
    fun diagnostics(): WarningOutputState = WarningOutputState()
}

/** Session ownership protects asynchronous preparation; warnings use warm local bytes only. */
class SafetyWarningAudio(private val load: () -> SafetyWarningCatalog, private val sink: SafetyWarningSink) {
    companion object { private val nextEpoch = AtomicLong(System.nanoTime()) }
    private var epoch = 0L
    private var lifecycleOwner = 0
    private var active = false
    private var ready = false
    private var catalog: SafetyWarningCatalog? = null
    private var current: SafetyWarningRequest? = null
    private val proofs = ArrayDeque<SafetyWarningRenderProof>()
    private val retired = ArrayDeque<SafetyWarningRetiredRequest>()

    @Synchronized fun prepare(owner: Int = 0) {
        lifecycleOwner = owner
        epoch = nextEpoch.incrementAndGet(); active = true; ready = false; current = null; proofs.clear(); retired.clear(); sink.prepare()
    }

    fun warmUp(): Boolean {
        val owner = synchronized(this) { if (!active) return false; epoch }
        val loaded = synchronized(this) { catalog } ?: load()
        synchronized(this) { if (!active || owner != epoch) return false; catalog = loaded }
        val warmed = sink.warmUp()
        return synchronized(this) { if (!active || owner != epoch) false else { ready = warmed; warmed } }
    }

    @Synchronized fun <T> withCurrentOwner(owner: Int, acceptsSource: () -> Boolean = { true }, action: () -> T): T? =
        if (active && ready && lifecycleOwner == owner && acceptsSource()) action() else null

    @Synchronized fun play(threat: String, text: String, gender: String, hazardGeneration: Int, expectedOwner: Int): Boolean {
        if (!active || !ready || lifecycleOwner != expectedOwner) return false
        val clip = catalog?.find(threat, text, gender) ?: return false
        retireCurrent(); sink.stop()
        val output = sink.diagnostics()
        current = SafetyWarningRequest(epoch, hazardGeneration, clip.identity, output.playbackEpoch, output.playbackGeneration)
        sink.play(clip.pcmCopy())
        collectProof()
        return true
    }

    @Synchronized fun isKnown(threat: String, text: String, gender: String): Boolean =
        catalog?.find(threat, text, gender) != null

    private fun collectProof(): WarningOutputState {
        val output = sink.diagnostics()
        val request = current
        val p = output.progress
        if (request != null && p != null && request.sessionEpoch == epoch &&
            request.playbackEpoch == p.playbackEpoch && request.playbackGeneration == p.playbackGeneration &&
            p.firstNonzeroSample >= 0 && p.writtenSamples > p.firstNonzeroSample &&
            p.hardwarePlayedSamples > p.firstNonzeroSample && p.hardwarePlayedSamples <= p.writtenSamples &&
            p.observedAtNanos >= request.requestedAtNanos &&
            p.actualWrittenPcmSha256.matches(Regex("[0-9a-f]{64}")) &&
            p.actualWrittenPcmSha256 == p.expectedWrittenPcmSha256 &&
            proofs.none { it.request == request }) {
            proofs.addLast(SafetyWarningRenderProof(request, p))
            if (proofs.size > 64) proofs.removeFirst()
        }
        return output
    }

    private fun retireCurrent() {
        // Observation is never allowed to prevent the real stop/release. A failed
        // read earns no render proof; explicit diagnostics still propagate errors.
        try { collectProof() } catch (_: Exception) { }
        current?.let { retired.addLast(SafetyWarningRetiredRequest(it, System.nanoTime())) }
        if (retired.size > 64) retired.removeFirst()
        current = null
    }
    @Synchronized fun stop() { retireCurrent(); sink.stop() }
    @Synchronized fun release() {
        retireCurrent(); active = false; ready = false; epoch = nextEpoch.incrementAndGet(); sink.release()
    }
    @Synchronized fun diagnostics(): SafetyWarningDiagnostics =
        SafetyWarningDiagnostics(epoch, ready, current, collectProof(), proofs.toList(), retired.toList())
}
