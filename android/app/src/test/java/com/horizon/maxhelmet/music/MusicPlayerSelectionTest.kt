package com.horizon.maxhelmet.music

import org.junit.Assert.*
import org.junit.Test

class MusicPlayerSelectionTest {
    @Test fun `named player must match the selected media app`() {
        assertTrue(matchesMusicApp("Apple Music", "com.apple.android.music", "音乐"))
        assertTrue(matchesMusicApp("网易云音乐", "com.netease.cloudmusic", "网易云音乐"))
        assertFalse(matchesMusicApp("QQ音乐", "com.apple.android.music", "音乐"))
        assertFalse(matchesMusicApp("音乐", "com.netease.cloudmusic", "网易云音乐"))
    }
}
