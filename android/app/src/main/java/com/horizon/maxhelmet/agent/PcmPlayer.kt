package com.horizon.maxhelmet.agent

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.exp

/**
 * Gapless playback of the 24 kHz PCM16 mono voice frames relayed from Doubao —
 * the Android counterpart of the playback-cursor scheduling in src/main.tsx.
 * AudioTrack streaming mode plus a feeder thread gives the same behavior, and
 * stopPlayback() implements barge-in by flushing everything queued.
 */
class PcmPlayer {
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

    private val queue = LinkedBlockingQueue<ByteArray>()
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

    @Synchronized
    fun start() {
        if (running) return
        val minBuffer = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        val audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(
                        if (useVoiceCall) AudioAttributes.USAGE_VOICE_COMMUNICATION
                        else AudioAttributes.USAGE_MEDIA
                    )
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
            .setBufferSizeInBytes(maxOf(minBuffer, SAMPLE_RATE)) // ~0.5 s of headroom
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        track = audioTrack
        running = true
        audioTrack.play()

        feederThread = thread(name = "pcm-player") {
            while (running) {
                val buffer = try {
                    queue.take()
                } catch (_: InterruptedException) {
                    continue
                }
                val startGeneration = generation
                var offset = 0
                while (running && offset < buffer.size && startGeneration == generation) {
                    val written = audioTrack.write(buffer, offset, buffer.size - offset)
                    if (written < 0) break
                    offset += written
                }
            }
        }
    }

    /** Arms the player for a new session so [play] may lazily (re)start the track.
     *  Paired with [release]; called by AgentSession.start(). */
    @Synchronized
    fun prepare() {
        active = true
    }

    /** Queues a 24 kHz PCM16 buffer. Called from the WebSocket reader thread. */
    fun play(pcm: ByteArray) {
        val buffer = applyGain(pcm)
        // Gate the check-and-start under the same lock release() holds. A frame on
        // the reader thread and a main-thread release() otherwise race: a play()
        // that lands after release() would see !running, start(), and rebuild an
        // orphaned track + feeder thread. The `active` gate closes that window
        // while still allowing the next session to arm and lazily start again.
        synchronized(this) {
            if (!active) return
            if (!running) start()
            queue.put(buffer)
        }
    }

    /**
     * Boosts the little-endian PCM16 samples in place by [PLAYBACK_GAIN] and runs
     * them through a soft limiter so loud peaks compress smoothly instead of
     * hard-clipping — the PCM-domain equivalent of the web's DynamicsCompressor.
     */
    private fun applyGain(pcm: ByteArray): ByteArray {
        val gain = level.coerceIn(0.5f, 4f)
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
    fun stopPlayback() {
        generation += 1
        queue.clear()
        track?.let {
            runCatching {
                it.pause()
                it.flush()
                it.play()
            }
        }
    }

    @Synchronized
    fun release() {
        active = false
        running = false
        generation += 1
        queue.clear()
        feederThread?.interrupt()
        feederThread?.join(500)
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
