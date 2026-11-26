package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.ui.AppLanguage
import io.github.henrycooper86.max.ui.Localization
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The relay's final closes (docs/protocol.md, Close codes) as AgentSession.handleSocketClosed classifies them. */
class FinalRelayCloseTest {
    @After
    fun resetLanguage() = Localization.forTest(AppLanguage.ZH)

    @Test
    fun `idle, used-up minutes and refused credentials end hands-free instead of reconnecting`() {
        assertEquals(FinalRelayClose.IDLE_ENDED, FinalRelayClose.from(4001, crashActive = false))
        assertEquals(FinalRelayClose.MINUTES_USED_UP, FinalRelayClose.from(4003, crashActive = false))
        assertEquals(FinalRelayClose.CREDENTIALS_REJECTED, FinalRelayClose.from(1008, crashActive = false))
    }

    @Test
    fun `every other close goes to the reconnect budget`() {
        // 0: the socket dropped without a close frame, as onFailure reports it.
        for (closeCode in listOf(0, 1000, 1001, 1002, 1005, 1006, 1007, 1009, 1011, 1015, 4000, 4002, 4004)) {
            assertNull("close code $closeCode", FinalRelayClose.from(closeCode, crashActive = false))
        }
    }

    @Test
    fun `only an idle close keeps retrying under a crash incident`() {
        assertNull(FinalRelayClose.from(4001, crashActive = true))
        assertEquals(FinalRelayClose.MINUTES_USED_UP, FinalRelayClose.from(4003, crashActive = true))
        assertEquals(FinalRelayClose.CREDENTIALS_REJECTED, FinalRelayClose.from(1008, crashActive = true))
    }

    @Test
    fun `the HUD says why the session ended and only refused credentials ask for a sign-in`() {
        assertEquals(tr(Str.STATUS_IDLE_ENDED), tr(FinalRelayClose.IDLE_ENDED.status))
        assertEquals("本月语音时长已用完，下月恢复", tr(FinalRelayClose.MINUTES_USED_UP.status))
        assertEquals("登录已失效，请重新登录", tr(FinalRelayClose.CREDENTIALS_REJECTED.status))
        Localization.forTest(AppLanguage.EN)
        assertEquals("Voice minutes used up for this month. Back next month.", tr(FinalRelayClose.MINUTES_USED_UP.status))
        assertEquals("Sign-in expired or revoked. Sign in again.", tr(FinalRelayClose.CREDENTIALS_REJECTED.status))

        assertFalse(FinalRelayClose.IDLE_ENDED.failed)
        assertTrue(FinalRelayClose.MINUTES_USED_UP.failed)
        assertTrue(FinalRelayClose.CREDENTIALS_REJECTED.failed)
        assertEquals(FinalRelayClose.CREDENTIALS_REJECTED, FinalRelayClose.entries.single { it.authRequired })
    }

    @Test
    fun `a conversation the relay ends is final and says which reason it gave`() {
        assertEquals(FinalRelayClose.IDLE_ENDED, FinalRelayClose.forSessionEnd("idle", crashActive = false))
        assertEquals(FinalRelayClose.ENDED_BY_AGENT, FinalRelayClose.forSessionEnd("agent", crashActive = false))
        assertEquals(FinalRelayClose.ENDED_AT_MAX_DURATION, FinalRelayClose.forSessionEnd("max_duration", crashActive = false))
        // A reason from a newer relay is still an end, worded generally.
        assertEquals(FinalRelayClose.ENDED, FinalRelayClose.forSessionEnd("something new", crashActive = false))
        assertEquals(FinalRelayClose.ENDED, FinalRelayClose.forSessionEnd("ended", crashActive = false))
    }

    @Test
    fun `under a crash incident the relay ending the conversation leaves the reconnect budget in charge`() {
        // Its alert still needs the relay, as with a bare idle close.
        for (reason in listOf("idle", "agent", "max_duration", "something new")) {
            assertNull(reason, FinalRelayClose.forSessionEnd(reason, crashActive = true))
        }
    }

    @Test
    fun `a relay-ended conversation says why without showing the relay's text and is not a failure`() {
        assertEquals("对话已结束，需要时请重新开启免提", tr(FinalRelayClose.ENDED_BY_AGENT.status))
        assertEquals("对话已到最长时长，请重新开启免提", tr(FinalRelayClose.ENDED_AT_MAX_DURATION.status))
        assertEquals("对话已结束，请重新开启免提", tr(FinalRelayClose.ENDED.status))
        assertEquals(tr(Str.STATUS_IDLE_ENDED), tr(FinalRelayClose.forSessionEnd("idle", crashActive = false)!!.status))
        Localization.forTest(AppLanguage.EN)
        assertEquals("The assistant ended the conversation. Start hands-free again to talk", tr(FinalRelayClose.ENDED_BY_AGENT.status))
        assertEquals("The conversation reached its time limit. Start hands-free again", tr(FinalRelayClose.ENDED_AT_MAX_DURATION.status))
        assertEquals("The conversation ended. Start hands-free again", tr(FinalRelayClose.ENDED.status))
        val ended = listOf(
            FinalRelayClose.IDLE_ENDED, FinalRelayClose.ENDED_BY_AGENT,
            FinalRelayClose.ENDED_AT_MAX_DURATION, FinalRelayClose.ENDED
        )
        ended.forEach { assertFalse(it.name, it.failed) }
        assertEquals(ended, FinalRelayClose.entries.filterNot { it.failed })
    }
}
