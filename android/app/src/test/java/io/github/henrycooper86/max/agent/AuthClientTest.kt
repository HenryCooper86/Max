package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.ui.AppLanguage
import io.github.henrycooper86.max.ui.Localization
import io.github.henrycooper86.max.ui.Str
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class AuthClientTest {
    private val relay = LocalRelay()
    // Results are delivered on the calling thread instead of Android's main looper.
    private val client = AuthClient(debugBuild = false, deliver = { it() })

    @Before fun english() = Localization.forTest(AppLanguage.EN)
    @After fun cleanUp() { relay.close(); Localization.forTest(AppLanguage.ZH) }

    private fun login(url: String = relay.agentUrl, username: String = "rider", password: String = "pw"): Pair<AuthClient.Login?, String?> {
        val done = CountDownLatch(1)
        var result: Pair<AuthClient.Login?, String?> = null to null
        client.login(url, username, password, allowSelfSignedTls = false) { login, error -> result = login to error; done.countDown() }
        assertTrue("login never answered", done.await(5, TimeUnit.SECONDS))
        return result
    }

    @Test
    fun `auth base drops the agent path, query and fragment and maps ws schemes to http`() {
        assertEquals("http://10.0.2.2:8787", AuthClient.authBaseUrl("ws://10.0.2.2:8787/agent?token=abc#x"))
        assertEquals("https://relay.example.com", AuthClient.authBaseUrl(" wss://relay.example.com/agent "))
        assertEquals("https://relay.example.com", AuthClient.authBaseUrl("https://relay.example.com/anything"))
        assertNull(AuthClient.authBaseUrl("relay.example.com/agent"))
        assertNull(AuthClient.authBaseUrl("ftp://relay.example.com"))
    }

    @Test
    fun `login posts the credentials as JSON in the app language`() {
        relay.reply = { LocalRelay.Reply(200, """{"ok":true,"token":"t1","user":{"id":"u1","username":"rider","displayName":"Rider One","role":"admin"}}""") }

        val (login, error) = login()

        val request = relay.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/auth/login", request.path)
        assertEquals("en-US", request.headers["accept-language"])
        assertTrue(request.headers["content-type"]!!.startsWith("application/json"))
        val body = JSONObject(request.body)
        assertEquals("rider", body.getString("username"))
        assertEquals("pw", body.getString("password"))
        assertNull(error)
        assertEquals(AuthClient.Login("t1", AuthClient.User("u1", "rider", "Rider One", "admin")), login)
    }

    @Test
    fun `missing display name and role fall back to the username and tester`() {
        relay.reply = { LocalRelay.Reply(200, """{"ok":true,"token":"t1","user":{"id":"u1","username":"rider"}}""") }
        assertEquals(AuthClient.User("u1", "rider", "rider", "tester"), login().first!!.user)
    }

    @Test
    fun `the relay's own error message is shown verbatim`() {
        relay.reply = { LocalRelay.Reply(401, """{"ok":false,"error":"Wrong password"}""") }
        assertEquals(null to "Wrong password", login())
    }

    @Test
    fun `an unusable answer maps to the generic sign-in failure`() {
        for (answer in listOf(
            LocalRelay.Reply(500, "<html>oops</html>", "text/html"),
            LocalRelay.Reply(200, """{"ok":true,"token":"","user":{"id":"u1","username":"rider"}}"""),
            LocalRelay.Reply(200, """{"ok":true,"token":"t1"}"""),
            LocalRelay.Reply(200, """{"ok":false}""")
        )) {
            relay.reply = { answer }
            assertEquals(answer.toString(), null to Str.ERR_LOGIN_FAILED.en, login())
        }
    }

    @Test
    fun `an unreachable relay and a malformed address are told apart`() {
        val closedPort = ServerSocket(0).use { it.localPort }
        assertEquals(null to Str.ERR_RELAY_UNREACHABLE.en, login(url = "ws://127.0.0.1:$closedPort/agent"))
        assertEquals(null to Str.ERR_RELAY_BAD.en, login(url = "not a relay"))
    }

    @Test
    fun `logout sends the bearer token and skips an empty one`() {
        val answered = CountDownLatch(1)
        relay.reply = { answered.countDown(); LocalRelay.Reply(200, "{}") }

        client.logout(relay.agentUrl, "", allowSelfSignedTls = false)
        client.logout(relay.agentUrl, "t1", allowSelfSignedTls = false)

        assertTrue(answered.await(5, TimeUnit.SECONDS))
        val request = relay.requests.single()
        assertEquals("/auth/logout", request.path)
        assertEquals("Bearer t1", request.headers["authorization"])
        assertEquals("t1", JSONObject(request.body).getString("token"))
    }

    @Test
    fun `the self-signed toggle is ignored outside debug builds`() {
        assertFalse(AuthClient(debugBuild = false, deliver = { it() }).clientFor(allowSelfSignedTls = true).trustsAnyServer())
        assertFalse(AuthClient(debugBuild = true, deliver = { it() }).clientFor(allowSelfSignedTls = false).trustsAnyServer())
    }

    @Test
    fun `a debug build honours the self-signed toggle and can turn it off again`() {
        assumeTrue(BuildConfig.DEBUG)
        val debug = AuthClient(debugBuild = true, deliver = { it() })
        assertTrue(debug.clientFor(allowSelfSignedTls = true).trustsAnyServer())
        assertFalse(debug.clientFor(allowSelfSignedTls = false).trustsAnyServer())
    }
}
