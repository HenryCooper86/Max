package io.github.henrycooper86.max.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceDisplayTest {
    @Test
    fun `five styles with web ids`() {
        assertEquals(listOf("wave", "bars", "mirror", "dots", "ring"), VoiceStyle.entries.map { it.wire })
        assertEquals(VoiceStyle.BARS, VoiceStyle.fromWire(" Bars "))
        assertNull(VoiceStyle.fromWire("equalizer"))
        assertNull(VoiceStyle.fromWire(null))
    }

    @Test
    fun `visualizer precedence and pinning`() {
        assertEquals(VoiceStyle.WAVE, resolveVoiceStyle(null, null))
        assertEquals(VoiceStyle.DOTS, resolveVoiceStyle("dots", null))
        assertEquals(VoiceStyle.RING, resolveVoiceStyle("dots", "ring"))
        assertEquals(VoiceStyle.DOTS, resolveVoiceStyle("dots", "ring", templateSwitching = false))
        assertEquals(VoiceStyle.WAVE, resolveVoiceStyle("bogus", "bogus"))
        assertEquals(VoiceStyle.DOTS, resolveVoiceStyle("dots", "bogus"))
        assertEquals(VoiceStyle.WAVE, resolveVoiceStyle(null, "ring", templateSwitching = false))
    }

    @Test
    fun `spectrum is always within 0 to 1 for every state level and time`() {
        val out = FloatArray(SPECTRUM_BINS)
        for (mode in SpectrumMode.entries) for (level in listOf(-1f, 0f, 0.3f, 1f, 5f, Float.NaN)) for (t in listOf(0f, 0.37f, 1.2f, 42.5f, 1000f)) {
            synthesizeSpectrum(out, mode, level, t)
            out.forEach { assertTrue("$mode $level $t -> $it", it in 0f..1f) }
        }
    }

    private fun sum(mode: SpectrumMode, level: Float = 0f, t: Float = 1.2f) =
        synthesizeSpectrum(FloatArray(SPECTRUM_BINS), mode, level, t).sum()

    @Test
    fun `spectrum differs by state`() {
        val offline = sum(SpectrumMode.OFFLINE)
        assertEquals(0.02f * SPECTRUM_BINS, offline, 1e-4f)
        assertTrue(sum(SpectrumMode.SPEAKING) > sum(SpectrumMode.THINKING))
        assertTrue(sum(SpectrumMode.SPEAKING) > sum(SpectrumMode.READY))
        assertTrue(sum(SpectrumMode.READY) > sum(SpectrumMode.IDLE))
        assertTrue(sum(SpectrumMode.LISTENING, level = 0.9f) > sum(SpectrumMode.LISTENING, level = 0f))
        // Connecting sweeps: the hump moves.
        val a = synthesizeSpectrum(FloatArray(SPECTRUM_BINS), SpectrumMode.CONNECTING, 0f, 0.3f)
        val b = synthesizeSpectrum(FloatArray(SPECTRUM_BINS), SpectrumMode.CONNECTING, 0f, 1.5f)
        assertFalse(a.indices.maxBy { a[it] } == b.indices.maxBy { b[it] })
        // Thinking is one hump.
        val th = synthesizeSpectrum(FloatArray(SPECTRUM_BINS), SpectrumMode.THINKING, 0f, 0.5f)
        assertTrue(th.max() > th.min() + 0.05f)
    }

    @Test
    fun `peak caps jump up and decay slowly`() {
        val peaks = FloatArray(SPECTRUM_BINS)
        val high = FloatArray(SPECTRUM_BINS) { 0.9f }
        updatePeaks(peaks, high, 0.016f)
        assertEquals(0.9f, peaks[0], 1e-6f)
        val low = FloatArray(SPECTRUM_BINS)
        updatePeaks(peaks, low, 0.5f)
        assertEquals(0.9f - 0.275f, peaks[3], 1e-4f)
        repeat(10) { updatePeaks(peaks, low, 0.5f) }
        assertEquals(0f, peaks[3], 0f)
        // Never below the live value, and a negative dt is ignored.
        updatePeaks(peaks, FloatArray(SPECTRUM_BINS) { 0.4f }, -1f)
        assertEquals(0.4f, peaks[5], 1e-6f)
    }

    @Test
    fun `smoothing rises faster than it falls`() {
        val up = FloatArray(1)
        smoothSpectrum(up, floatArrayOf(1f), 0.016f)
        val down = floatArrayOf(1f)
        smoothSpectrum(down, floatArrayOf(0f), 0.016f)
        assertTrue(up[0] > 1f - down[0])
    }

    @Test
    fun `visor mode maps to spectrum mode`() {
        assertEquals(SpectrumMode.IDLE, spectrumModeOf(VisorMode.IDLE, handsFree = false))
        assertEquals(SpectrumMode.READY, spectrumModeOf(VisorMode.IDLE, handsFree = true))
        assertEquals(SpectrumMode.SPEAKING, spectrumModeOf(VisorMode.SPEAKING, true))
        assertEquals(SpectrumMode.OFFLINE, spectrumModeOf(VisorMode.OFFLINE, true))
    }
}
