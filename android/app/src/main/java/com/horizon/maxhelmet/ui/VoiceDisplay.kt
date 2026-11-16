package com.horizon.maxhelmet.ui

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// The live voice display's styles and the spectrum that drives them: a port of the web
// client's src/lib/visualizer.ts. One signal, several looks. Android has no analyser tap,
// so the spectrum is always synthesised from the session state and the microphone level.

/** The five looks of the visor's live display. [wire] is the id the relay's /health uses. */
enum class VoiceStyle(val wire: String, private val text: Str, private val blurb: Str) {
    WAVE("wave", Str.VS_WAVE, Str.VS_WAVE_D),
    BARS("bars", Str.VS_BARS, Str.VS_BARS_D),
    MIRROR("mirror", Str.VS_MIRROR, Str.VS_MIRROR_D),
    DOTS("dots", Str.VS_DOTS, Str.VS_DOTS_D),
    RING("ring", Str.VS_RING, Str.VS_RING_D);

    val label: String get() = tr(text)
    val description: String get() = tr(blurb)

    companion object {
        val DEFAULT = WAVE
        fun fromWire(value: String?): VoiceStyle? = entries.firstOrNull { it.wire == value?.trim()?.lowercase() }
    }
}

/**
 * Default "wave" -> the relay's `assistant.visualizer` -> the wearer's own choice, which is
 * ignored when the owner pinned the look (`templateSwitching == false`). Invalid ids are dropped.
 */
fun resolveVoiceStyle(relay: String?, wearer: String?, templateSwitching: Boolean = true): VoiceStyle {
    if (templateSwitching) VoiceStyle.fromWire(wearer)?.let { return it }
    return VoiceStyle.fromWire(relay) ?: VoiceStyle.DEFAULT
}

/** What the lens shows; mirrors the web's SpectrumMode (READY = connected and waiting). */
enum class SpectrumMode { IDLE, CONNECTING, READY, LISTENING, THINKING, SPEAKING, OFFLINE }

/** Bars across the lens. */
const val SPECTRUM_BINS = 24

private fun bump(x: Float, center: Float, width: Float): Float {
    val d = x - center
    return exp(-(d * d) / (2f * width * width))
}

/** A speech-like envelope over the bins: strong low formants, a presence hump, little at the top. */
private fun voiceEnvelope(x: Float): Float =
    0.12f + 0.62f * bump(x, 0.16f, 0.1f) + 0.46f * bump(x, 0.38f, 0.12f) + 0.28f * bump(x, 0.62f, 0.1f)

/** Per-bin wobble 0..1, deterministic in (bin, time) so frames are smooth. */
private fun wobble(index: Int, t: Float, speed: Float): Float {
    val rate = speed * (0.7f + ((index * 37) % 11) / 10f)
    val phase = (index * 2.399f) % (2f * PI.toFloat())
    return 0.5f + 0.25f * sin(t * rate + phase) + 0.25f * sin(t * rate * 1.73f + phase * 2.1f)
}

private fun clamp01(v: Float): Float = if (v.isNaN() || v <= 0f) 0f else if (v >= 1f) 1f else v

/**
 * A plausible spectrum for [mode] at time [t] (seconds), written into [out] (every value 0..1).
 * [level] is the live microphone level (0..1) and scales the listening state. Idle and ready
 * breathe low, connecting sweeps across, listening follows the voice, speaking is full and
 * rhythmic, thinking drifts a single hump, offline is flat.
 */
fun synthesizeSpectrum(out: FloatArray, mode: SpectrumMode, level: Float, t: Float): FloatArray {
    val n = out.size
    val voice = clamp01(level)
    for (i in 0 until n) {
        val x = if (n > 1) i.toFloat() / (n - 1) else 0f
        val value = when (mode) {
            SpectrumMode.SPEAKING -> {
                val syllable = 0.55f + 0.45f * abs(sin(t * 5.3f + sin(t * 1.7f)))
                voiceEnvelope(x) * (0.5f + 0.5f * wobble(i, t, 7f)) * syllable
            }
            SpectrumMode.LISTENING -> {
                val amplitude = 0.1f + min(1f, voice * 2.4f) * 0.85f
                voiceEnvelope(x) * amplitude * (0.55f + 0.45f * wobble(i, t, 6f))
            }
            SpectrumMode.CONNECTING -> {
                val center = ((t * 0.65f) % 1.3f) - 0.15f
                0.05f + 0.55f * bump(x, center, 0.07f)
            }
            SpectrumMode.THINKING -> 0.04f + 0.2f * bump(x, 0.5f + 0.32f * sin(t * 1.4f), 0.12f)
            SpectrumMode.READY -> 0.05f + 0.1f * voiceEnvelope(x) * wobble(i, t, 1.6f)
            SpectrumMode.IDLE -> 0.03f + 0.07f * voiceEnvelope(x) * wobble(i, t, 0.8f)
            SpectrumMode.OFFLINE -> 0.02f
        }
        out[i] = clamp01(value)
    }
    return out
}

/** Peak caps that jump up with the signal and fall back slowly. [dt] in seconds. */
fun updatePeaks(peaks: FloatArray, values: FloatArray, dt: Float, fallPerSecond: Float = 0.55f) {
    val fall = max(0f, dt) * fallPerSecond
    for (i in peaks.indices) peaks[i] = max(values.getOrElse(i) { 0f }, peaks[i] - fall)
}

/** Ease displayed values toward the target so bars rise fast and fall soft. */
fun smoothSpectrum(display: FloatArray, target: FloatArray, dt: Float) {
    val rise = 1f - exp(-dt * 30f)
    val fall = 1f - exp(-dt * 9f)
    for (i in display.indices) {
        val next = target.getOrElse(i) { 0f }
        display[i] += (next - display[i]) * (if (next > display[i]) rise else fall)
    }
}

/** The spectrum mode for a visor mode: a connected session that is not listening/speaking is READY. */
internal fun spectrumModeOf(mode: VisorMode, handsFree: Boolean): SpectrumMode = when (mode) {
    VisorMode.IDLE -> if (handsFree) SpectrumMode.READY else SpectrumMode.IDLE
    VisorMode.CONNECTING -> SpectrumMode.CONNECTING
    VisorMode.LISTENING -> SpectrumMode.LISTENING
    VisorMode.THINKING -> SpectrumMode.THINKING
    VisorMode.SPEAKING -> SpectrumMode.SPEAKING
    VisorMode.OFFLINE -> SpectrumMode.OFFLINE
}
