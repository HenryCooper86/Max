package io.github.henrycooper86.max.power

import io.github.henrycooper86.max.actions.DeviceResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingStartTest {
    private var load = DeviceLoad()
    private val calls = mutableListOf<String>()

    @Test
    fun `heat that arrives while the recorder is starting stops it and keeps the clip`() = runTest {
        val result = startRecordingUnderLoad({ load },
            start = { calls += "start"; load = DeviceLoad(HeatLevel.SEVERE); DeviceResult.OK },
            stop = { calls += "stop"; DeviceResult.OK })
        assertEquals(listOf("start", "stop"), calls)
        assertEquals("denied", result.status)
        assertEquals("device.hot", result.reason)
        assertTrue(!result.detail.isNullOrBlank())
    }

    @Test
    fun `battery saver turning on during the start lets the recording run`() = runTest {
        val result = startRecordingUnderLoad({ load },
            start = { calls += "start"; load = DeviceLoad(powerSave = true); DeviceResult.OK },
            stop = { calls += "stop"; DeviceResult.OK })
        assertEquals(listOf("start"), calls)
        assertEquals(DeviceResult.OK, result)
    }

    @Test
    fun `a normal start and a failed start are passed through`() = runTest {
        assertEquals(DeviceResult.OK, startRecordingUnderLoad({ load }, start = { DeviceResult.OK }, stop = { calls += "stop"; DeviceResult.OK }))
        val failed = DeviceResult.failed("capture.failed")
        load = DeviceLoad(HeatLevel.SEVERE)
        assertEquals(failed, startRecordingUnderLoad({ load }, start = { failed }, stop = { calls += "stop"; DeviceResult.OK }))
        assertTrue(calls.isEmpty())
    }
}
