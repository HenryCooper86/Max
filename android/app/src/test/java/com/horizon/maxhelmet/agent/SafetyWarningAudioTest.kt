package com.horizon.maxhelmet.agent

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SafetyWarningAudioTest {
    private val assets = File("../../public/audio/adas").takeIf { it.isDirectory }
        ?: File("../public/audio/adas")
    private fun catalog(read: (String) -> ByteArray = { File(assets, it).readBytes() }) =
        SafetyWarningCatalog.load(read)

    @Test fun `all packaged voices resolve exact text and preserve cached PCM across gain mutation`() {
        val catalog = catalog()
        val manifest = JSONObject(File(assets, "manifest.json").readText()).getJSONArray("assets")
        assertEquals(18, catalog.size)
        for (i in 0 until manifest.length()) {
            val a = manifest.getJSONObject(i)
            val clip = catalog.find(a.getString("threat"), a.getString("text"), a.getString("gender"))!!
            assertEquals(a.getString("pcmSha256"), safetySha256(clip.pcmCopy()))
            val copy = clip.pcmCopy(); copy.fill(0)
            assertEquals(a.getString("pcmSha256"), safetySha256(clip.pcmCopy()))
            assertNull(catalog.find(a.getString("threat"), a.getString("text") + "wrong", a.getString("gender")))
        }
    }

    @Test fun `corrupt WAV PCM metadata missing asset and duplicate identity block preparation`() {
        val rawManifest = File(assets, "manifest.json").readText()
        val first = JSONObject(rawManifest).getJSONArray("assets").getJSONObject(0)
        val corruptions: List<(String) -> ByteArray> = listOf(
            { path -> File(assets, path).readBytes().also { if (path == first.getString("file")) it[it.lastIndex] = (it.last().toInt() xor 1).toByte() } },
            { path -> if (path == first.getString("file")) error("missing asset") else File(assets, path).readBytes() },
            { path -> if (path == "manifest.json") JSONObject(rawManifest).apply { getJSONArray("assets").getJSONObject(0).put("pcmSha256", "0".repeat(64)) }.toString().toByteArray() else File(assets, path).readBytes() },
            { path -> if (path == "manifest.json") JSONObject(rawManifest).apply { getJSONArray("assets").put(1, first) }.toString().toByteArray() else File(assets, path).readBytes() }
        )
        for (read in corruptions) assertThrows(Exception::class.java) { catalog(read) }
    }

    @Test fun `hash valid but wrong PCM format or sample count is rejected before playback`() {
        for (offset in listOf(20, 22, 24, 32, 34)) {
            val manifest = JSONObject(File(assets, "manifest.json").readText())
            val asset = manifest.getJSONArray("assets").getJSONObject(0)
            val file = asset.getString("file")
            val bad = File(assets, file).readBytes().also { it[offset] = (it[offset].toInt() xor 2).toByte() }
            asset.put("sha256", safetySha256(bad))
            assertThrows(IllegalArgumentException::class.java) {
                catalog { path -> when (path) { "manifest.json" -> manifest.toString().toByteArray(); file -> bad; else -> File(assets, path).readBytes() } }
            }
        }
    }

    @Test fun `different sessions never reuse warning evidence epoch`() {
        val first = SafetyWarningAudio({ catalog() }, Sink())
        val second = SafetyWarningAudio({ catalog() }, Sink())
        first.prepare(); second.prepare()
        assertNotEquals(first.diagnostics().sessionEpoch, second.diagnostics().sessionEpoch)
        first.release(); second.release()
    }

    @Test fun `delayed old hazard caller cannot play or publish into a restarted owner`() {
        val sink = Sink(); val audio = SafetyWarningAudio({ catalog() }, sink)
        audio.prepare(1); assertTrue(audio.warmUp())
        val oldOwner = 1
        audio.release(); audio.prepare(2); assertTrue(audio.warmUp())
        assertFalse(audio.play("forward_collision", "前车急刹，注意保持车距！ 立即收油，平稳减速。", "female", 3, oldOwner))
        var published = false
        audio.withCurrentOwner(oldOwner) { published = true }
        assertFalse(published)
        assertEquals(0, sink.played)
        assertNull(audio.diagnostics().current)
        audio.withCurrentOwner(2) { published = true }
        assertTrue(published)
        assertTrue(audio.play("forward_collision", "前车急刹，注意保持车距！ 立即收油，平稳减速。", "female", 4, 2))
        assertEquals(1, sink.played)
    }

    @Test fun `old owner side effects are rejected after restart before touching current HUD or provider`() {
        val audio = SafetyWarningAudio({ catalog() }, Sink())
        audio.prepare(1); assertTrue(audio.warmUp())
        audio.release(); audio.prepare(2); assertTrue(audio.warmUp())
        var providerStops = 0; var hud = "new session"
        audio.withCurrentOwner(1) { providerStops++; hud = "old hazard" }
        assertEquals(0, providerStops)
        assertEquals("new session", hud)
    }

    @Test fun `parsed old socket cannot borrow current owner after transport or lifecycle restart`() {
        val audio = SafetyWarningAudio({ catalog() }, Sink())
        val oldSocket = Any(); var currentSocket: Any? = oldSocket
        audio.prepare(1); assertTrue(audio.warmUp())
        val capturedSocket = oldSocket
        currentSocket = Any() // transport-only restart keeps the lifecycle owner
        var effects = 0
        audio.withCurrentOwner(1, { capturedSocket === currentSocket }) { effects++ }
        assertEquals(0, effects)
        audio.release(); audio.prepare(2); assertTrue(audio.warmUp())
        audio.withCurrentOwner(2, { capturedSocket === currentSocket }) { effects++ }
        assertEquals(0, effects)
        val newSocket = currentSocket
        audio.withCurrentOwner(2, { newSocket === currentSocket }) { effects++ }
        assertEquals(1, effects)
    }

    private class Sink : SafetyWarningSink {
        var active = false; var played = 0; var stops = 0
        var output = WarningOutputState(); var unreadable = false
        override fun prepare() { active = true }
        override fun warmUp() = active
        override fun play(pcm: ByteArray) { check(active); played++; pcm.fill(0) }
        override fun stop() { stops++ }
        override fun release() { active = false }
        override fun diagnostics(): WarningOutputState { check(!unreadable); return output }
    }

    @Test fun `diagnostic read failure cannot prevent production warning release`() {
        val sink = Sink(); val audio = SafetyWarningAudio({ catalog() }, sink)
        audio.prepare(); assertTrue(audio.warmUp())
        sink.unreadable = true
        audio.release()
        assertFalse(sink.active)
    }

    @Test fun `request play and unverified progress cannot manufacture render credit`() {
        val sink = Sink(); val audio = SafetyWarningAudio({ catalog() }, sink)
        audio.prepare(); assertTrue(audio.warmUp())
        assertTrue(audio.play("forward_collision", "前车急刹，注意保持车距！ 立即收油，平稳减速。", "female", 7, expectedOwner = 0))
        assertTrue(audio.diagnostics().proofs.isEmpty())
        sink.output = WarningOutputState(progress = WarningPcmProgress(0, 0, 20, 10, 0, "", ""))
        assertTrue("Absent accepted-byte hashes cannot prove rendering", audio.diagnostics().proofs.isEmpty())
    }

    @Test fun `only matching actual accepted nonzero prefix and current hardware epoch prove exact hazard`() {
        val sink = Sink(); val audio = SafetyWarningAudio({ catalog() }, sink)
        audio.prepare(); assertTrue(audio.warmUp())
        audio.play("forward_collision", "前车急刹，注意保持车距！ 立即收油，平稳减速。", "male", 3, expectedOwner = 0)
        val valid = WarningPcmProgress(0, 0, 20, 10, 2, "a".repeat(64), "a".repeat(64))
        for (bad in listOf(valid.copy(hardwarePlayedSamples = 2), valid.copy(writtenSamples = 2),
            valid.copy(hardwarePlayedSamples = 21), valid.copy(firstNonzeroSample = -1),
            valid.copy(playbackEpoch = 1), valid.copy(playbackGeneration = 1),
            valid.copy(actualWrittenPcmSha256 = "b".repeat(64)))) {
            sink.output = WarningOutputState(progress = bad)
            assertTrue(audio.diagnostics().proofs.isEmpty())
        }
        sink.output = WarningOutputState(progress = valid)
        val proof = audio.diagnostics().proofs.single()
        assertEquals(3, proof.request.hazardGeneration)
        assertEquals("male", proof.request.clip.gender)
        audio.stop(); sink.output = WarningOutputState(progress = valid.copy(playbackGeneration = 9))
        assertEquals(listOf(proof), audio.diagnostics().proofs)
        val retired = audio.diagnostics().retiredRequests.single()
        assertEquals(proof.request, retired.request)
        assertTrue(proof.progress.observedAtNanos <= proof.capturedAtNanos)
        assertTrue(proof.capturedAtNanos <= retired.retiredAtNanos)
    }

    @Test fun `only prepared exact warnings play and supersession stop release fence playback`() {
        val sink = Sink(); val audio = SafetyWarningAudio({ catalog() }, sink)
        val text = "前车急刹，注意保持车距！ 立即收油，平稳减速。"
        assertFalse(audio.play("forward_collision", text, "female", 1, expectedOwner = 0))
        audio.prepare(); assertTrue(audio.warmUp())
        assertTrue(audio.play("forward_collision", text, "female", 1, expectedOwner = 0))
        assertTrue(audio.play("forward_collision", text, "male", 2, expectedOwner = 0))
        assertEquals(2, sink.played)
        assertFalse(audio.play("forward_collision", "unknown text", "female", 3, expectedOwner = 0))
        audio.stop(); audio.release()
        assertFalse(audio.play("forward_collision", text, "female", 4, expectedOwner = 0))
        assertFalse(sink.active)
        assertEquals(2, sink.played)
    }

    @Test fun `asset failure is retryable and stopped load cannot install or play after restart`() {
        val sink = Sink(); var fail = true
        val audio = SafetyWarningAudio({ if (fail) error("missing") else catalog() }, sink)
        audio.prepare(); assertThrows(Exception::class.java) { audio.warmUp() }
        audio.release(); fail = false; audio.prepare(); assertTrue(audio.warmUp())
        audio.release()
        val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        val delayed = SafetyWarningAudio({ entered.countDown(); check(resume.await(5, TimeUnit.SECONDS)); catalog() }, sink)
        delayed.prepare()
        var ready = true
        val loader = Thread { ready = delayed.warmUp() }.apply { start() }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        delayed.release(); delayed.prepare(); resume.countDown(); loader.join(5000)
        assertFalse(ready)
        assertFalse(delayed.play("forward_collision", "前车急刹，注意保持车距！ 立即收油，平稳减速。", "female", 1, expectedOwner = 0))
        assertEquals(0, sink.played)
        delayed.release()
    }
}
