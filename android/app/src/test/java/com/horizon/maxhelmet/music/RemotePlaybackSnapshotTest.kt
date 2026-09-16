package com.horizon.maxhelmet.music

import org.junit.Assert.*
import org.junit.Test

class RemotePlaybackSnapshotTest {
    private val before = RemotePlaybackSnapshot("one", 1L, "Song", "Artist", true)
    @Test fun unchangedTrackCannotConfirmSkip() {
        assertFalse(remoteControlCompleted("next", before, before))
        assertFalse(remoteControlCompleted("previous", before, before.copy(playing = false)))
    }
    @Test fun changedTrackMustResumePlayback() {
        val changed = before.copy(mediaId = "two", queueId = 2L, playing = false)
        assertFalse(remoteControlCompleted("next", before, changed))
        assertTrue(remoteControlCompleted("next", before, changed.copy(playing = true)))
    }
    @Test fun queueIdentityDistinguishesRepeatedTitles() {
        assertTrue(remoteControlCompleted("next", before, before.copy(queueId = 2L)))
    }
    @Test fun missingMetadataDoesNotConfirmSkip() {
        assertFalse(remoteControlCompleted("next", before, RemotePlaybackSnapshot(null, null, null, null, true)))
    }
}
