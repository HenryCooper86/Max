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
    }

    private val queue = LinkedBlockingQueue<ByteArray>()
    private var track: AudioTrack? = null
    private var feederThread: Thread? = null

    @Volatile
    private var running = false

    /** Bumped by barge-in so the feeder abandons the buffer it is writing. */
    @Volatile
    private var generation = 0

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
                    .setUsage(AudioAttributes.USAGE_MEDIA)
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
        queue.put(pcm)
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
