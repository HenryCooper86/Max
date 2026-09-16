package com.horizon.maxhelmet.capture

import androidx.camera.video.VideoRecordEvent
import org.junit.Assert.*
import org.junit.Test

class CapturePolicyTest {
    @Test fun `background and recording limits preserve completed video frames`() {
        listOf(VideoRecordEvent.Finalize.ERROR_NONE,
            VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE,
            VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED,
            VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED,
            VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE).forEach {
            assertTrue(finalizedVideoCanBeSaved(it, 1_000_000_000L, 10000))
        }
    }
    @Test fun `empty or corrupt recording is never published to gallery`() {
        assertFalse(finalizedVideoCanBeSaved(VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE, 0, 100))
        assertFalse(finalizedVideoCanBeSaved(VideoRecordEvent.Finalize.ERROR_NONE, 100, 0))
        listOf(VideoRecordEvent.Finalize.ERROR_ENCODING_FAILED,
            VideoRecordEvent.Finalize.ERROR_RECORDER_ERROR,
            VideoRecordEvent.Finalize.ERROR_UNKNOWN,
            VideoRecordEvent.Finalize.ERROR_NO_VALID_DATA).forEach {
            assertFalse(finalizedVideoCanBeSaved(it, 100, 10000))
        }
    }
}
