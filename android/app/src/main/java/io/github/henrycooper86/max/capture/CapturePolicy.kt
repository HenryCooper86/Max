package io.github.henrycooper86.max.capture

import androidx.camera.video.VideoRecordEvent

/** CameraX still finalizes a usable partial movie when a limit is reached or
 * the activity closes. Encoding/recorder/no-data errors must never be indexed. */
fun finalizedVideoCanBeSaved(error: Int, durationNanos: Long, bytes: Long): Boolean =
    durationNanos > 0 && bytes > 0 && error in setOf(
        VideoRecordEvent.Finalize.ERROR_NONE,
        VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED,
        VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED,
        VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE,
        VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE
    )
