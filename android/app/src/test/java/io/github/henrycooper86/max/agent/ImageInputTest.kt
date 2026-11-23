package io.github.henrycooper86.max.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageInputTest {
    private fun started(capabilities: String) = parseAgentEvent(
        """{"type":"session.started","provider":"openai","mode":"live","capabilities":$capabilities}"""
    ) as AgentEvent.SessionStarted

    private fun ready(capabilities: ProviderCapabilities, speedKmh: Double? = null) = AgentSession.State(
        handsFree = true,
        connection = ConnectionState.READY,
        capabilities = capabilities,
        speedKmh = speedKmh
    )

    @Test
    fun `session started says whether the backend takes pictures`() {
        assertTrue(started("""{"textInput":true,"imageInput":true}""").capabilities.imageInput)
        assertFalse(started("""{"textInput":true,"imageInput":false}""").capabilities.imageInput)
        // A relay older than image input does not say, and does not take them.
        assertFalse(started("""{"textInput":true}""").capabilities.imageInput)
    }

    @Test
    fun `a picture is offered when the backend takes them and a typed turn could be sent`() {
        val both = ProviderCapabilities(textInput = true, imageInput = true)
        assertTrue(imageInputReady(ready(both)))
        assertTrue(imageInputReady(ready(both, speedKmh = 2.0)))
        // Not while riding, like typing.
        assertFalse(imageInputReady(ready(both, speedKmh = 30.0)))
        assertFalse(imageInputReady(ready(ProviderCapabilities(textInput = true))))
        assertFalse(imageInputReady(ready(both).copy(connection = ConnectionState.CONNECTING)))
    }

    @Test
    fun `the event carries a JPEG and the words that go with it`() {
        val silent = JSONObject(buildImageInput("QUJD")!!)
        assertEquals("image.input", silent.getString("type"))
        assertEquals("QUJD", silent.getString("image"))
        assertEquals("image/jpeg", silent.getString("mimeType"))
        assertFalse(silent.has("text"))
        assertEquals("What is this?", JSONObject(buildImageInput("QUJD", "  What is this?  ")!!).getString("text"))
        // Blank words count as none, and long ones are cut like a typed turn.
        assertFalse(JSONObject(buildImageInput("QUJD", "   ")!!).has("text"))
        assertEquals(
            MAX_TEXT_INPUT_CHARS,
            JSONObject(buildImageInput("QUJD", "x".repeat(MAX_TEXT_INPUT_CHARS + 50))!!).getString("text").length
        )
    }

    @Test
    fun `a picture the relay would refuse is not sent`() {
        assertNull(buildImageInput(""))
        assertNull(buildImageInput("A".repeat(MAX_IMAGE_BASE64_CHARS + 1)))
        assertEquals(
            MAX_IMAGE_BASE64_CHARS,
            JSONObject(buildImageInput("A".repeat(MAX_IMAGE_BASE64_CHARS))!!).getString("image").length
        )
    }

    @Test
    fun `a photo is scaled so its longer side is 1024, and a small picture is left its size`() {
        val asked = mutableListOf<Triple<Int, Int, Int>>()
        val encode = { width: Int, height: Int, quality: Int -> asked += Triple(width, height, quality); "ok" }
        assertEquals("ok", encodeImageForInput(4000, 3000, encode = encode))
        assertEquals(listOf(Triple(1024, 768, 85)), asked)
        asked.clear()
        encodeImageForInput(3000, 4000, encode = encode)
        assertEquals(listOf(Triple(768, 1024, 85)), asked)
        asked.clear()
        encodeImageForInput(320, 200, encode = encode)
        assertEquals(listOf(Triple(320, 200, 85)), asked)
        asked.clear()
        // A panorama keeps at least one pixel of its short side.
        encodeImageForInput(10_000, 3, encode = encode)
        assertEquals(listOf(Triple(1024, 1, 85)), asked)
    }

    @Test
    fun `quality is lowered before size, until the picture fits`() {
        val asked = mutableListOf<Triple<Int, Int, Int>>()
        // Fits only at 576 pixels and the lowest quality.
        val encode = { width: Int, height: Int, quality: Int ->
            asked += Triple(width, height, quality)
            if (width <= 576 && quality <= 55) "fits" else "A".repeat(MAX_IMAGE_BASE64_CHARS + 1)
        }
        assertEquals("fits", encodeImageForInput(2048, 2048, encode = encode))
        assertEquals(
            listOf(
                Triple(1024, 1024, 85), Triple(1024, 1024, 70), Triple(1024, 1024, 55),
                Triple(768, 768, 85), Triple(768, 768, 70), Triple(768, 768, 55),
                Triple(576, 576, 85), Triple(576, 576, 70), Triple(576, 576, 55)
            ),
            asked
        )
    }

    @Test
    fun `a picture that never fits, has no pixels or cannot be encoded is given up on`() {
        var tries = 0
        assertNull(encodeImageForInput(2048, 2048) { _, _, _ -> tries += 1; "A".repeat(MAX_IMAGE_BASE64_CHARS + 1) })
        // 1024, 768, 576, 432, 324, 243, 182, 136, 102, 76: ten sizes of three qualities, and no size under 64.
        assertEquals(30, tries)
        assertNull(encodeImageForInput(0, 100) { _, _, _ -> "ok" })
        assertNull(encodeImageForInput(100, -1) { _, _, _ -> "ok" })
        assertNull(encodeImageForInput(100, 100) { _, _, _ -> "" })
    }

    @Test
    fun `the phone keeps the relay's limits, one picture a second and 50 for a connection`() {
        val limiter = ImageInputLimiter()
        assertNull(limiter.refusal(10_000))
        limiter.sent(10_000)
        assertEquals(ImageRefusal.TOO_FAST, limiter.refusal(10_999))
        assertNull(limiter.refusal(11_000))
        for (index in 1 until MAX_IMAGES_PER_CONNECTION) limiter.sent(10_000 + index * 2_000L)
        assertEquals(ImageRefusal.TOO_MANY, limiter.refusal(1_000_000))
        // A new connection starts a new count.
        limiter.reset()
        assertNull(limiter.refusal(1_000_000))
    }
}
