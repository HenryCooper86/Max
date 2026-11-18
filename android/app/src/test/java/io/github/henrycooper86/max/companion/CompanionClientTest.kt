package io.github.henrycooper86.max.companion

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import okhttp3.*
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CompanionClientTest {
    private class Socket(private val req: Request, val listener: WebSocketListener) : WebSocket {
        val sent = mutableListOf<String>(); var closed = false
        override fun request() = req
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { sent.add(text); return !closed }
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?): Boolean { closed = true; return true }
        override fun cancel() { closed = true }
        fun open() = listener.onOpen(this, Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(101).message("ok").build())
        fun state(status: String) = listener.onMessage(this, """{"type":"companion.status","state":"$status","deviceId":"helmet"}""")
        fun error(code: String) = listener.onMessage(this, """{"type":"companion.error","code":"$code","detail":"error"}""")
        fun drop() = listener.onFailure(this, Exception("offline"), null)
    }
    private class Factory : WebSocket.Factory {
        val sockets = mutableListOf<Socket>()
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket = Socket(request, listener).also { sockets.add(it) }
    }
    @Test fun bindSurvivesInitialUnpairedAndClosesAfterPaired() = runTest {
        val f = Factory(); val c = CompanionClient(backgroundScope, {}, f)
        c.connect("wss://example.org/agent", "account", CompanionProtocol.pair("123456"))
        val s = f.sockets.single(); s.open(); runCurrent(); s.state("unpaired"); runCurrent()
        assertFalse(s.closed); assertEquals("connecting", c.state.value.status)
        s.state("paired"); runCurrent(); assertTrue(s.closed); assertEquals("paired", c.state.value.status)
        advanceTimeBy(70_000); runCurrent(); assertEquals("paired", c.state.value.status)
    }
    @Test fun rideRequiresReadyAndStopRevokesLateCallbacksAndFixes() = runTest {
        val f = Factory(); var stops = 0; val c = CompanionClient(backgroundScope, { stops++ }, f)
        c.connect("wss://example.org/agent", "account", ride = true)
        val s = f.sockets.single(); s.open(); runCurrent()
        val fix = CompanionFix(1.0, 2.0, 5.0, 1000)
        c.sendFix(fix, 1000, 1000); assertTrue(s.sent.isEmpty())
        s.state("ready"); runCurrent(); assertTrue(s.sent.single().contains("companion.start"))
        s.state("sharing"); runCurrent(); c.sendFix(fix, 1000, 1000); assertEquals(1, c.state.value.fixes)
        val before = s.sent.size; c.stopRide(); s.state("sharing"); runCurrent(); c.sendFix(fix, 2000, 2000)
        assertFalse(c.state.value.riding); assertEquals(before + 1, s.sent.size); assertTrue(stops > 0)
    }
    @Test fun recoverableFixErrorDoesNotCloseGateAndReconnectNeverResetsSequence() = runTest {
        val f = Factory(); val c = CompanionClient(backgroundScope, {}, f)
        c.connect("wss://example.org/agent", "account", ride = true)
        var s = f.sockets.last(); s.open(); s.state("ready"); runCurrent()
        c.sendFix(CompanionFix(1.0, 2.0, 5.0, 1000), 1000, 1000)
        s.error("location.timestamp"); runCurrent(); assertTrue(c.state.value.riding)
        s.drop(); runCurrent(); advanceTimeBy(1000); runCurrent()
        assertEquals(2, f.sockets.size); s = f.sockets.last(); s.open(); s.state("ready"); runCurrent()
        c.sendFix(CompanionFix(1.0, 2.0, 5.0, 2000), 2000, 2000)
        assertTrue(s.sent.last().contains("\"sequence\":2"))
    }
    @Test fun logoutInvalidatesReconnectAndOldSocketCannotPublish() = runTest {
        val f = Factory(); val c = CompanionClient(backgroundScope, {}, f)
        c.connect("wss://example.org/agent", "account", ride = true)
        val s = f.sockets.single(); s.open(); runCurrent(); s.drop(); runCurrent(); c.disconnect()
        advanceTimeBy(10_000); runCurrent(); s.state("sharing"); runCurrent()
        assertEquals(1, f.sockets.size); assertEquals("signedOut", c.state.value.status)
    }
    @Test fun authErrorStopsSharingAndUnpairAcceptsUnpaired() = runTest {
        val f = Factory(); val c = CompanionClient(backgroundScope, {}, f)
        c.connect("wss://example.org/agent", "account", ride = true)
        var s = f.sockets.last(); s.open(); s.state("ready"); runCurrent(); s.error("auth"); runCurrent()
        assertFalse(c.state.value.riding); assertEquals("error", c.state.value.status)
        c.unpair("wss://example.org/agent", "account"); s = f.sockets.last(); s.open(); runCurrent(); s.state("unpaired"); runCurrent(); s.state("unpaired"); runCurrent()
        assertEquals("unpaired", c.state.value.status); assertTrue(s.closed)
    }
    @Test fun oldReadyAttachCannotConfirmNewPairAndActualReadyClosesPairOnly() = runTest {
        val f = Factory(); val c = CompanionClient(backgroundScope, {}, f)
        c.connect("wss://example.org/agent", "account", CompanionProtocol.pair("123456"))
        val s = f.sockets.single(); s.open(); runCurrent(); assertTrue(s.sent.isEmpty())
        s.state("ready"); runCurrent(); assertFalse(s.closed); assertTrue(s.sent.single().contains("companion.pair"))
        s.state("ready"); runCurrent(); assertTrue(s.closed); assertFalse(c.state.value.riding)
    }
    @Test fun pairingTimeoutStopsAndLateSuccessCannotRestoreIt() = runTest {
        val f = Factory(); val c = CompanionClient(backgroundScope, {}, f)
        c.connect("wss://example.org/agent", "account", CompanionProtocol.discover("a".repeat(32)))
        val s = f.sockets.last(); s.open(); s.state("unpaired"); runCurrent()
        advanceTimeBy(65_001); runCurrent(); s.state("paired"); runCurrent()
        assertEquals("error", c.state.value.status); assertTrue(s.closed)
    }
}
