package io.github.henrycooper86.max.agent

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import io.github.henrycooper86.max.BuildConfig
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.LinkedBlockingQueue
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.exp

/**
 * Gapless playback of the 24 kHz PCM16 mono voice frames relayed from Doubao —
 * the Android counterpart of the playback-cursor scheduling in src/main.tsx.
 * AudioTrack streaming mode plus a feeder thread gives the same behavior, and
 * stopPlayback() implements barge-in by flushing everything queued.
 */
class PcmPlayer(private val verifyWarningRender: Boolean = false) {
    companion object {
        const val SAMPLE_RATE = 24_000

        /**
         * Boost agent speech above the raw Doubao level so it is loud enough at the
         * helmet speaker; AudioTrack volume maxes at unity, so the gain is applied to
         * the PCM samples and clamped so peaks don't wrap. Mirrors PLAYBACK_GAIN in
         * src/main.tsx and PcmPlayer.playbackGain on iOS.
         */
        const val PLAYBACK_GAIN = 2.0f

        /**
         * Soft-limiter threshold (≈ -3 dBFS, matching the web's DynamicsCompressor
         * threshold). Samples below this stay linear; louder peaks are compressed
         * smoothly toward full scale instead of hard-clipping, which is what made
         * the boosted Doubao voice sound harsh on Android vs. iOS/web.
         */
        private const val LIMIT_THRESHOLD = 0.7f
    }

    var syntheticPipelineObserver: ((String, Int) -> Unit)? = null
        set(value) {
            check(BuildConfig.DEBUG)
            field = value
        }

    private fun observePipeline(stage: String, value: Int = 0) {
        if (BuildConfig.DEBUG) syntheticPipelineObserver?.invoke(stage, value)
    }

    // Guarded by this player: prewarming alone has no PCM to interrupt.
    private var generationHasAudio = false
    private data class WarningWrite(val epoch: Long, val generation: Int, val expected: ByteArray,
        val gain: Float, val firstNonzero: Int, val accepted: ByteArrayOutputStream = ByteArrayOutputStream(),
        var rendered: WarningPcmProgress? = null)
    private var warningWrite: WarningWrite? = null
    private data class PcmTicket(val pcm: ByteArray, val epoch: Long, val generation: Int)
    private val queue = LinkedBlockingQueue<PcmTicket>()
    private val totalQueuedSamples = AtomicLong()
    private val generationQueuedSamples = AtomicLong()
    private val generationWrittenSamples = AtomicLong()
    private val completedPlayedSamples = AtomicLong()
    private val totalDiscardedSamples = AtomicLong()
    @Volatile private var lastFlushSucceeded = false

    /** Debug-only observations of actual queued/written PCM, never an audio sink. */
    data class PlaybackDiagnostics(
        val totalQueuedSamples: Long,
        val totalPlayedSamples: Long,
        val totalDiscardedSamples: Long,
        val queuedSamples: Long,
        val writtenSamples: Long,
        val playbackSamples: Long,
        val generation: Int,
        val pendingBuffers: Int,
        val active: Boolean,
        val running: Boolean,
        val lastFlushSucceeded: Boolean
    )

    @Synchronized fun playbackDiagnostics(): PlaybackDiagnostics {
        check(BuildConfig.DEBUG)
        return PlaybackDiagnostics(
            totalQueuedSamples.get(),
            completedPlayedSamples.get() + minOf(generationQueuedSamples.get(), track?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0),
            totalDiscardedSamples.get(),
            generationQueuedSamples.get(),
            generationWrittenSamples.get(), track?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0,
            generation, queue.size, active, running, lastFlushSucceeded
        )
    }

    /** A proof is derived from accepted bytes and the actual hardware head, never play()/enqueue. */
    @Synchronized fun warningOutputState(): WarningOutputState {
        val played = if (BuildConfig.DEBUG) runCatching {
            track?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0
        }.getOrDefault(0) else 0
        val w = warningWrite
        val proof = if (BuildConfig.DEBUG && verifyWarningRender && w != null &&
            active && running && w.epoch == playbackEpoch && w.generation == generation &&
            w.firstNonzero >= 0 && w.accepted.size() / 2 > w.firstNonzero &&
            played > w.firstNonzero && played <= w.accepted.size() / 2) {
            w.rendered ?: run {
                val accepted = w.accepted.toByteArray()
                WarningPcmProgress(playbackEpoch, generation, accepted.size.toLong() / 2, played,
                    w.firstNonzero, safetySha256(accepted), safetySha256(w.expected.copyOf(accepted.size)),
                    Base64.getEncoder().encodeToString(accepted), w.gain).also { w.rendered = it }
            }
        } else null
        return WarningOutputState(active, running, playbackEpoch, generation,
            totalQueuedSamples.get(), completedPlayedSamples.get() + minOf(generationQueuedSamples.get(), played),
            totalDiscardedSamples.get(), generationQueuedSamples.get(), generationWrittenSamples.get(),
            played, queue.size, proof)
    }
    private var track: AudioTrack? = null
    private var feederThread: Thread? = null

    @Volatile
    private var running = false

    /**
     * Whether the player is armed for the current hands-free session. [prepare]
     * sets it, [release] clears it, and [play] only lazily starts the track while
     * armed — so a frame that arrives after the session stopped cannot resurrect
     * an AudioTrack + feeder thread that nothing would ever release.
     */
    @Volatile
    private var active = false

    /** Changes when a session arms/releases output, fencing unfinished construction. */
    @Volatile
    private var playbackEpoch = 0L

    /** Bumped by barge-in so the feeder abandons the buffer it is writing. */
    @Volatile
    private var generation = 0

    /**
     * When true the track uses the voice-communication stream so playback
     * follows Bluetooth SCO routing (in-helmet headsets). Set before start().
     */
    @Volatile
    var useVoiceCall = false
    @Volatile var level: Float = PLAYBACK_GAIN

    /** AudioTrack construction/play can block in the platform: never hold our monitor here. */
    private fun createTrack(voiceCall: Boolean): AudioTrack {
        observePipeline("pcm.track.start.begin")
        val minBuffer = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        val audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(if (voiceCall) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuffer, SAMPLE_RATE))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        try {
            audioTrack.play()
            observePipeline("pcm.track.start.end")
            return audioTrack
        } catch (error: Throwable) {
            runCatching { releaseCandidate(audioTrack) }
            throw error
        }
    }

    private fun releaseCandidate(candidate: AudioTrack) {
        runCatching { candidate.pause(); candidate.flush() }
        candidate.release()
        observePipeline("pcm.track.candidate.released")
    }

    /** Installs only an output belonging to the still-active session. */
    private fun ensureStarted(epoch: Long): Boolean {
        val voiceCall = synchronized(this) {
            if (!active || playbackEpoch != epoch) return false
            if (running) return true
            useVoiceCall
        }
        val candidate = createTrack(voiceCall)
        val installed = synchronized(this) {
            if (!active || playbackEpoch != epoch || running) false else {
                track = candidate
                running = true
                startFeeder(candidate, epoch)
                true
            }
        }
        if (!installed) releaseCandidate(candidate)
        return synchronized(this) { active && playbackEpoch == epoch && running }
    }

    private fun startFeeder(audioTrack: AudioTrack, epoch: Long) {
        feederThread = thread(name = "pcm-player") {
            while (running && playbackEpoch == epoch) {
                val ticket = try {
                    queue.take()
                } catch (_: InterruptedException) {
                    continue
                }
                // Observers can block in controlled tests; never invoke them while
                // holding the hardware/generation fence used by an interruption.
                observePipeline("pcm.dequeued", ticket.pcm.size)
                var offset = 0
                while (offset < ticket.pcm.size) {
                    observePipeline("pcm.write.begin", ticket.pcm.size - offset)
                    val written = synchronized(this@PcmPlayer) {
                        if (!active || !running || playbackEpoch != ticket.epoch ||
                            generation != ticket.generation || track !== audioTrack) null else {
                            // The check and nonblocking write are atomic with pause/flush.
                            // No interrupted ticket can write behind the hardware flush.
                            audioTrack.write(ticket.pcm, offset, ticket.pcm.size - offset,
                                AudioTrack.WRITE_NON_BLOCKING).also {
                                if (BuildConfig.DEBUG && it > 0) generationWrittenSamples.addAndGet(it.toLong() / 2)
                                if (BuildConfig.DEBUG && verifyWarningRender && it > 0) {
                                    warningWrite?.takeIf { w -> w.epoch == ticket.epoch && w.generation == ticket.generation }
                                        ?.accepted?.write(ticket.pcm, offset, it)
                                }
                            }
                        }
                    }
                    if (written == null) {
                        observePipeline("pcm.write.cancelled", ticket.pcm.size - offset)
                        break
                    }
                    observePipeline("pcm.write.end", written)
                    if (written < 0) break
                    offset += written
                    if (written == 0) {
                        // Only the feeder waits for hardware capacity, never GUI Stop.
                        try { Thread.sleep(5) } catch (_: InterruptedException) { }
                    }
                }
            }
        }
    }

    /** Arms playback; unfinished work from an older session cannot install here. */
    @Synchronized
    fun prepare() {
        playbackEpoch += 1
        active = true
    }

    /** Completes output preparation off the reader/main threads before connecting. */
    fun warmUp(): Boolean {
        val epoch = synchronized(this) {
            if (!active) return false
            playbackEpoch
        }
        return ensureStarted(epoch)
    }

    /** Accepts a PCM ticket before transforming it, so interruption accounts
     * for every received sample even if gain processing has not finished. */
    @JvmOverloads fun play(pcm: ByteArray, acceptsSource: () -> Boolean = { true }) {
        val ticket = synchronized(this) {
            if (!active || !acceptsSource()) return
            if (pcm.isNotEmpty()) generationHasAudio = true
            if (BuildConfig.DEBUG) {
                totalQueuedSamples.addAndGet(pcm.size.toLong() / 2)
                generationQueuedSamples.addAndGet(pcm.size.toLong() / 2)
            }
            PcmTicket(pcm, playbackEpoch, generation)
        }
        observePipeline("pcm.gain.begin", pcm.size)
        val gain = level.coerceIn(0.5f, 4f)
        val buffer = applyGain(pcm, gain)
        observePipeline("pcm.gain.end", buffer.size)
        if (!ensureStarted(ticket.epoch)) return
        val enqueued = synchronized(this) {
            if (!active || playbackEpoch != ticket.epoch || generation != ticket.generation || !running) false else {
                if (BuildConfig.DEBUG && verifyWarningRender) {
                    val first = (0 until buffer.size / 2).firstOrNull { i -> buffer[i * 2].toInt() != 0 || buffer[i * 2 + 1].toInt() != 0 } ?: -1
                    warningWrite = WarningWrite(ticket.epoch, ticket.generation, buffer.copyOf(), gain, first)
                }
                queue.put(if (buffer === ticket.pcm) ticket else ticket.copy(pcm = buffer))
                true
            }
        }
        if (enqueued) observePipeline("pcm.queued", buffer.size)
        else observePipeline("pcm.enqueue.cancelled", buffer.size)
    }

    /**
     * Boosts the little-endian PCM16 samples in place by [PLAYBACK_GAIN] and runs
     * them through a soft limiter so loud peaks compress smoothly instead of
     * hard-clipping — the PCM-domain equivalent of the web's DynamicsCompressor.
     */
    private fun applyGain(pcm: ByteArray, gain: Float): ByteArray {
        if (gain == 1.0f) return pcm
        var i = 0
        while (i + 1 < pcm.size) {
            // High byte shl 8 sign-extends; low byte masked → signed Int16.
            val sample = (pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)
            val limited = softLimit(sample / 32768f * gain)
            val out = (limited * 32767f).toInt().coerceIn(-32768, 32767)
            pcm[i] = (out and 0xFF).toByte()
            pcm[i + 1] = ((out shr 8) and 0xFF).toByte()
            i += 2
        }
        return pcm
    }

    /**
     * Soft-knee limiter: linear up to [LIMIT_THRESHOLD], then the overshoot is
     * compressed exponentially toward ±1, so the signal never hard-clips.
     */
    private fun softLimit(x: Float): Float {
        val magnitude = abs(x)
        if (magnitude <= LIMIT_THRESHOLD) return x
        val headroom = 1f - LIMIT_THRESHOLD
        val compressed = LIMIT_THRESHOLD + headroom * (1f - exp(-(magnitude - LIMIT_THRESHOLD) / headroom))
        return if (x < 0f) -compressed else compressed
    }

    /** Barge-in: drop queued audio and cut the current utterance immediately. */
    @Synchronized
    fun stopPlayback() {
        if (BuildConfig.DEBUG) {
            val queued = generationQueuedSamples.get()
            val played = minOf(queued, track?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0)
            completedPlayedSamples.addAndGet(played)
            totalDiscardedSamples.addAndGet(queued - played)
        }
        generation += 1
        warningWrite = null
        generationQueuedSamples.set(0)
        generationWrittenSamples.set(0)
        queue.clear()
        val flushSucceeded = if (generationHasAudio) track?.let {
            runCatching {
                it.pause()
                it.flush()
                it.play()
            }.isSuccess
        } ?: false else false
        generationHasAudio = false
        if (BuildConfig.DEBUG) lastFlushSucceeded = flushSucceeded
    }

    @Synchronized
    fun release() {
        playbackEpoch += 1
        active = false
        running = false
        if (BuildConfig.DEBUG) {
            val queued = generationQueuedSamples.get()
            val played = minOf(queued, track?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0)
            completedPlayedSamples.addAndGet(played)
            totalDiscardedSamples.addAndGet(queued - played)
        }
        generation += 1
        warningWrite = null
        generationQueuedSamples.set(0)
        generationWrittenSamples.set(0)
        queue.clear()
        generationHasAudio = false
        // No join on the GUI thread. The epoch and locked nonblocking-write
        // fence prevent the interrupted feeder from touching this track again.
        feederThread?.interrupt()
        feederThread = null
        track?.let {
            runCatching {
                it.pause()
                it.flush()
            }
            it.release()
        }
        track = null
    }
}
