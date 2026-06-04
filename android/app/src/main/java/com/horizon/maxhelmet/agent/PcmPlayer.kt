package com.horizon.maxhelmet.agent

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

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
    }

    private val queue = LinkedBlockingQueue<ByteArray>()
    private var track: AudioTrack? = null
    private var feederThread: Thread? = null

    @Volatile
    private var running = false

    /** Bumped by barge-in so the feeder abandons the buffer it is writing. */
    @Volatile
    private var generation = 0

    /**
     * When true the track uses the voice-communication stream so playback
     * follows Bluetooth SCO routing (in-helmet headsets). Set before start().
     */
    @Volatile
    var useVoiceCall = false

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

    /** Queues a 24 kHz PCM16 buffer. Called from the WebSocket reader thread. */
    fun play(pcm: ByteArray) {
        if (!running) start()
        queue.put(applyGain(pcm))
    }

    /**
     * Scales the little-endian PCM16 samples in place by [PLAYBACK_GAIN], clamping
     * to the signed 16-bit range so boosted peaks distort gracefully instead of
     * wrapping around.
     */
    private fun applyGain(pcm: ByteArray): ByteArray {
        if (PLAYBACK_GAIN == 1.0f) return pcm
        var i = 0
        while (i + 1 < pcm.size) {
            val sample = (pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)
            val boosted = (sample * PLAYBACK_GAIN).toInt().coerceIn(-32768, 32767)
            pcm[i] = (boosted and 0xFF).toByte()
            pcm[i + 1] = ((boosted shr 8) and 0xFF).toByte()
            i += 2
        }
        return pcm
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
