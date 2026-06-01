package com.horizon.maxhelmet.agent

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Captures mic audio as 16 kHz PCM16 mono and emits 320-sample (20 ms) frames —
 * the Android counterpart of public/pcm-worklet.js. AudioRecord resamples for
 * us, so unlike the worklet there is no manual downsample step.
 */
class MicStreamer(
    private val onFrame: (ByteArray) -> Unit,
    private val onLevel: (Float) -> Unit
) {
    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_SAMPLES = 320 // 20 ms, matches the worklet frame size
        const val FRAME_BYTES = FRAME_SAMPLES * 2
    }

    private var record: AudioRecord? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var captureThread: Thread? = null

    @Volatile
    private var running = false

    /** Starts capture. The caller must already hold RECORD_AUDIO permission. */
    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        val audioRecord = AudioRecord(
            // VOICE_COMMUNICATION enables the device echo canceller / noise
            // suppressor, mirroring the browser getUserMedia constraints.
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuffer, FRAME_BYTES * 16)
        )
        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            audioRecord.release()
            throw IllegalStateException("microphone unavailable")
        }

        if (AcousticEchoCanceler.isAvailable()) {
            echoCanceler = AcousticEchoCanceler.create(audioRecord.audioSessionId)?.apply { enabled = true }
        }
        if (NoiseSuppressor.isAvailable()) {
            noiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)?.apply { enabled = true }
        }

        record = audioRecord
        running = true
        audioRecord.startRecording()

        captureThread = thread(name = "mic-streamer") {
            val frame = ByteArray(FRAME_BYTES)
            while (running) {
                var offset = 0
                while (offset < FRAME_BYTES && running) {
                    val read = audioRecord.read(frame, offset, FRAME_BYTES - offset)
                    if (read <= 0) {
                        running = false
                        break
                    }
                    offset += read
                }
                if (offset == FRAME_BYTES) {
                    onLevel(frameRms(frame))
                    onFrame(frame.copyOf())
                }
            }
        }
    }

    fun stop() {
        if (!running && record == null) return
        running = false
        // stop() unblocks a capture thread waiting inside read().
        record?.let { runCatching { it.stop() } }
        captureThread?.join(500)
        captureThread = null
        echoCanceler?.release()
        echoCanceler = null
        noiseSuppressor?.release()
        noiseSuppressor = null
        record?.release()
        record = null
    }

    /** RMS of a PCM16 frame normalized to 0..1; drives the HUD voice visualizer. */
    private fun frameRms(frame: ByteArray): Float {
        var sum = 0.0
        var i = 0
        while (i + 1 < frame.size) {
            val sample = ((frame[i + 1].toInt() shl 8) or (frame[i].toInt() and 0xFF)).toShort().toInt()
            sum += sample.toDouble() * sample
            i += 2
        }
        val rms = sqrt(sum / (frame.size / 2)) / Short.MAX_VALUE
        return (rms * 4).coerceIn(0.0, 1.0).toFloat()
    }
}
