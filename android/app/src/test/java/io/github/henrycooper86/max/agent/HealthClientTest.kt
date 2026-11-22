package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.ui.HealthInfo
import org.junit.Assume.assumeTrue
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class HealthClientTest {
    private val relay = LocalRelay()
    private val client = HealthClient(debugBuild = false, deliver = { it() })

    @After fun stop() = relay.close()

    /** Fetches /health and waits for the relay to answer; null means the callback stayed silent. */
    private fun fetch(token: String = ""): HealthInfo? {
        val answered = CountDownLatch(1)
        val requestsBefore = relay.requests.size
        val previous = relay.reply
        relay.reply = { request -> previous(request).also { answered.countDown() } }
        var info: HealthInfo? = null
        val delivered = CountDownLatch(1)
        client.fetch(relay.agentUrl, token, allowSelfSignedTls = false) { info = it; delivered.countDown() }
        assertTrue("relay never asked", answered.await(5, TimeUnit.SECONDS))
        delivered.await(500, TimeUnit.MILLISECONDS)
        assertEquals(requestsBefore + 1, relay.requests.size)
        return info
    }

    @Test
    fun `health is a GET on the relay root with the bearer token`() {
        relay.reply = { LocalRelay.Reply(200, """{"assistant":{"name":"Nova"}}""") }

        val info = fetch(token = " t1 ")

        val request = relay.requests.single()
        assertEquals("GET", request.method)
        assertEquals("/health", request.path)
        assertEquals("Bearer t1", request.headers["authorization"])
        assertEquals("Nova", info!!.assistant!!.name)
    }

    @Test
    fun `no token means no authorization header`() {
        relay.reply = { LocalRelay.Reply(200, "{}") }
        fetch(token = "  ")
        assertNull(relay.requests.single().headers["authorization"])
    }

    @Test
    fun `failures stay silent so the bundled branding is kept`() {
        relay.reply = { LocalRelay.Reply(503, """{"assistant":{"name":"Nova"}}""") }
        assertNull(fetch())
        relay.reply = { LocalRelay.Reply(200, "not json", "text/plain") }
        assertNull(fetch())
    }

    @Test
    fun `an invalid relay address sends nothing`() {
        var called = false
        client.fetch("relay.example.com", "", allowSelfSignedTls = false) { called = true }
        Thread.sleep(100)
        assertFalse(called)
        assertTrue(relay.requests.isEmpty())
    }

    @Test
    fun `an svg logo is reported as unsupported without decoding`() {
        relay.reply = { LocalRelay.Reply(200, "<svg/>", "image/svg+xml") }
        val done = CountDownLatch(1)
        var delivered = false
        client.fetchLogo(relay.agentUrl, "t1", allowSelfSignedTls = false, path = "/brand/logo.svg") { bitmap ->
            delivered = bitmap == null; done.countDown()
        }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertTrue(delivered)
        assertEquals("/brand/logo.svg", relay.requests.single().path)
        assertEquals("Bearer t1", relay.requests.single().headers["authorization"])
    }

    @Test
    fun `the self-signed toggle is ignored outside debug builds`() {
        assertFalse(HealthClient(debugBuild = false, deliver = { it() }).clientFor(allowSelfSignedTls = true).trustsAnyServer())
    }

    @Test
    fun `a debug build honours the self-signed toggle`() {
        assumeTrue(BuildConfig.DEBUG)
        assertTrue(HealthClient(debugBuild = true, deliver = { it() }).clientFor(allowSelfSignedTls = true).trustsAnyServer())
    }
}
