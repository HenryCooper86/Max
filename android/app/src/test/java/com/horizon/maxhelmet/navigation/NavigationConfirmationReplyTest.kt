package com.horizon.maxhelmet.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NavigationConfirmationReplyTest {
    @Test
    fun `accepts English and Chinese phrases`() {
        for (phrase in listOf(
            "confirm navigation", "Confirm navigation.", "Confirm", "yes", "Yes!", "OK", "okay",
            "start navigation", "That's right", "correct",
            "确认导航", "确认", "开始导航", "是的", "好的", "确认导航。"
        )) assertEquals(phrase, true, navigationConfirmationReply(phrase, "Max"))
    }

    @Test
    fun `declines in both languages`() {
        for (phrase in listOf("cancel", "Cancel navigation", "no", "No.", "wrong", "取消", "取消导航", "不是", "不对")) {
            assertEquals(phrase, false, navigationConfirmationReply(phrase, "Max"))
        }
    }

    @Test
    fun `ignores a call to the assistant in front`() {
        assertEquals(true, navigationConfirmationReply("Max, confirm navigation", "Max"))
        assertEquals(true, navigationConfirmationReply("Hey Max, yes", "Max"))
        assertEquals(true, navigationConfirmationReply("Max，确认导航", "Max"))
        assertEquals(false, navigationConfirmationReply("Nova cancel", "Nova"))
        // Saying only the name is not an answer.
        assertNull(navigationConfirmationReply("Max", "Max"))
    }

    @Test
    fun `ignores everything else`() {
        for (phrase in listOf("", "yes I think the weather is nice", "what time is it", "confirm the booking for tomorrow", "不知道", "navigation")) {
            assertNull(phrase, navigationConfirmationReply(phrase, "Max"))
        }
    }
}
