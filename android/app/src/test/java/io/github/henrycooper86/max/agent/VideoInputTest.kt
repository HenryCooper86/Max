package io.github.henrycooper86.max.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoInputTest {
    private fun started(capabilities: String) = parseAgentEvent(
        """{"type":"session.started","provider":"openai","mode":"live","capabilities":$capabilities}"""
    ) as AgentEvent.SessionStarted

    /** A live video with a clock the test moves, and a log of what went to the socket. */
    private class Rig(
        var connected: Boolean = true,
        var takesVideo: Boolean = true,
        var encoded: (String) -> String? = { "JPEG-$it" }
    ) {
        var time = 10_000L
        val sent = mutableListOf<String>()
        val released = mutableListOf<String>()
        val video = LiveVideo<String>(
            connected = { connected },
            takesVideo = { takesVideo },
            send = { sent += it; true },
            encode = { encoded(it) },
            now = { time },
            release = { released += it }
        )
        val types get() = sent.map { JSONObject(it).getString("type") }
    }

    @Test
    fun `session started says whether the session takes video`() {
        assertTrue(started("""{"textInput":true,"imageInput":true,"videoInput":true}""").capabilities.videoInput)
        assertFalse(started("""{"textInput":true,"imageInput":true,"videoInput":false}""").capabilities.videoInput)
        // A relay older than live video does not say, and does not take it.
        assertFalse(started("""{"textInput":true,"imageInput":true}""").capabilities.videoInput)
    }

    @Test
    fun `a frame is a JPEG with no words, and video stop is a bare event`() {
        val frame = JSONObject(buildVideoFrame("QUJD")!!)
        assertEquals("video.frame", frame.getString("type"))
        assertEquals("QUJD", frame.getString("image"))
        assertEquals("image/jpeg", frame.getString("mimeType"))
        assertFalse(frame.has("text"))
        assertEquals("video.stop", JSONObject(VIDEO_STOP_EVENT).getString("type"))
        assertEquals(1, JSONObject(VIDEO_STOP_EVENT).length())
    }

    @Test
    fun `a frame the relay would refuse is not built`() {
        assertNull(buildVideoFrame(""))
        assertNull(buildVideoFrame("A".repeat(MAX_IMAGE_BASE64_CHARS + 1)))
        assertEquals(MAX_IMAGE_BASE64_CHARS, JSONObject(buildVideoFrame("A".repeat(MAX_IMAGE_BASE64_CHARS))!!).getString("image").length)
    }

    @Test
    fun `a frame is scaled to 768 on its longer side and never made larger`() {
        assertEquals(768 to 432, videoFrameSize(1920, 1080))
        assertEquals(432 to 768, videoFrameSize(1080, 1920))
        assertEquals(640 to 480, videoFrameSize(640, 480))
        assertEquals(768 to 1, videoFrameSize(10_000, 3))
        assertNull(videoFrameSize(0, 480))
    }

    @Test
    fun `quality 60 is tried first, then 45, and a frame that fits at neither is skipped`() {
        val asked = mutableListOf<Int>()
        assertEquals("small", encodeVideoFrame { asked += it; "small" })
        assertEquals(listOf(60), asked)
        asked.clear()
        assertEquals("fits", encodeVideoFrame { asked += it; if (it == 45) "fits" else "A".repeat(MAX_IMAGE_BASE64_CHARS + 1) })
        assertEquals(listOf(60, 45), asked)
        asked.clear()
        assertNull(encodeVideoFrame { asked += it; "A".repeat(MAX_IMAGE_BASE64_CHARS + 1) })
        assertEquals(listOf(60, 45), asked)
        assertNull(encodeVideoFrame { "" })
    }

    @Test
    fun `the newest frame is sent, one a second, and the older ones are let go`() {
        val rig = Rig()
        assertTrue(rig.video.start())
        rig.video.offer("a")
        rig.video.offer("b")
        assertEquals(VideoStep.SENT, rig.video.sendNewest())
        assertEquals("JPEG-b", JSONObject(rig.sent.single()).getString("image"))
        assertEquals(listOf("a", "b"), rig.released)
        // Another frame under a second later waits, and is still the one sent when its time comes.
        rig.video.offer("c")
        rig.time += 400
        assertEquals(VideoStep.TOO_SOON, rig.video.sendNewest())
        rig.time += 599
        assertEquals(VideoStep.TOO_SOON, rig.video.sendNewest())
        rig.time += 1
        assertEquals(VideoStep.SENT, rig.video.sendNewest())
        assertEquals(listOf("video.frame", "video.frame"), rig.types)
        // With no new frame there is nothing to send.
        rig.time += 5_000
        assertEquals(VideoStep.NO_FRAME, rig.video.sendNewest())
        assertEquals(2, rig.sent.size)
    }

    @Test
    fun `never faster than the relay takes, whatever interval is asked for`() {
        val rig = Rig()
        val fast = LiveVideo<String>({ true }, { true }, { rig.sent += it; true }, { "x" }, { rig.time }, intervalMs = 100)
        fast.start()
        fast.offer("a")
        assertEquals(VideoStep.SENT, fast.sendNewest())
        fast.offer("b")
        rig.time += 499
        assertEquals(VideoStep.TOO_SOON, fast.sendNewest())
        rig.time += 1
        assertEquals(VideoStep.SENT, fast.sendNewest())
    }

    @Test
    fun `frames do not touch the picture budget or its pacing`() {
        val limiter = ImageInputLimiter()
        val rig = Rig()
        rig.video.start()
        // A hundred frames, a second apart: more than the 50 pictures a connection may send.
        repeat(100) {
            rig.video.offer("f$it")
            assertEquals(VideoStep.SENT, rig.video.sendNewest())
            rig.time += 1_000
        }
        assertEquals(100, rig.sent.size)
        // A picture is still as welcome as before, and the frames did not make the next one too fast.
        assertNull(limiter.refusal(rig.time))
        limiter.sent(rig.time)
        rig.video.offer("g")
        assertEquals(VideoStep.SENT, rig.video.sendNewest())
        assertEquals(ImageRefusal.TOO_FAST, limiter.refusal(rig.time + 1))
    }

    @Test
    fun `a frame that cannot be made to fit is skipped and the next is a second away`() {
        val rig = Rig(encoded = { null })
        rig.video.start()
        rig.video.offer("a")
        assertEquals(VideoStep.SKIPPED, rig.video.sendNewest())
        assertTrue(rig.sent.isEmpty())
        assertEquals(listOf("a"), rig.released)
        rig.encoded = { "ok" }
        rig.video.offer("b")
        rig.time += 999
        assertEquals(VideoStep.TOO_SOON, rig.video.sendNewest())
        rig.time += 1
        assertEquals(VideoStep.SENT, rig.video.sendNewest())
    }

    @Test
    fun `nothing is sent while the socket is not ready, and the video does not start`() {
        val rig = Rig(connected = false)
        assertFalse(rig.video.start())
        assertFalse(rig.video.active)
        rig.connected = true
        rig.takesVideo = false
        assertFalse(rig.video.start())
        rig.takesVideo = true
        assertTrue(rig.video.start())
        // The socket drops while the video is on: frames wait, and the stale one is let go.
        rig.video.offer("old")
        rig.connected = false
        assertEquals(VideoStep.NOT_READY, rig.video.sendNewest())
        assertEquals(listOf("old"), rig.released)
        rig.video.offer("fresh")
        rig.time += 5_000
        assertEquals(VideoStep.NOT_READY, rig.video.sendNewest())
        assertTrue(rig.sent.isEmpty())
        // The video stays on across the drop, and frames go out again once the session is back.
        assertTrue(rig.video.active)
        rig.connected = true
        rig.video.offer("new")
        assertEquals(VideoStep.SENT, rig.video.sendNewest())
        assertEquals("JPEG-new", JSONObject(rig.sent.single()).getString("image"))
    }

    @Test
    fun `turning the video off sends video stop once, and no frame goes after it`() {
        val rig = Rig()
        rig.video.start()
        rig.video.offer("a")
        assertTrue(rig.video.stop())
        assertEquals(listOf("video.stop"), rig.types)
        assertEquals(listOf("a"), rig.released)
        assertFalse(rig.video.active)
        // A late frame from the camera's thread is let go, and nothing is sent.
        rig.video.offer("late")
        assertEquals(VideoStep.OFF, rig.video.sendNewest())
        assertEquals(listOf("a", "late"), rig.released)
        // Stopping again says nothing more.
        assertFalse(rig.video.stop())
        assertEquals(1, rig.sent.size)
    }

    @Test
    fun `a stop while the socket is closed sends nothing`() {
        val rig = Rig()
        rig.video.start()
        rig.connected = false
        assertTrue(rig.video.stop())
        assertTrue(rig.sent.isEmpty())
    }

    @Test
    fun `a frame being encoded when the video stops is not sent`() {
        val rig = Rig()
        rig.encoded = { rig.video.stop(); "late" }
        rig.video.start()
        rig.video.offer("a")
        assertEquals(VideoStep.OFF, rig.video.sendNewest())
        assertEquals(listOf("video.stop"), rig.types)
    }

    @Test
    fun `a reconnect without videoInput turns the video off, one with it leaves it on`() {
        val rig = Rig()
        rig.video.start()
        assertFalse(rig.video.sessionStarted(started("""{"videoInput":true}""").capabilities.videoInput))
        assertTrue(rig.video.active)
        assertTrue(rig.sent.isEmpty())
        assertTrue(rig.video.sessionStarted(started("""{"textInput":true,"imageInput":true}""").capabilities.videoInput))
        assertFalse(rig.video.active)
        assertEquals(listOf("video.stop"), rig.types)
        // Nothing left to turn off.
        assertFalse(rig.video.sessionStarted(false))
        assertEquals(1, rig.sent.size)
    }

    @Test
    fun `the end of the conversation turns the video off and tells the relay`() {
        val rig = Rig()
        rig.video.start()
        rig.video.offer("a")
        rig.video.stop()
        assertEquals(listOf("video.stop"), rig.types)
        assertFalse(rig.video.active)
    }
}
