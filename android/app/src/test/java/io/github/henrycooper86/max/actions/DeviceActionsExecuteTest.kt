package io.github.henrycooper86.max.actions

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.henrycooper86.max.agent.AgentEvent
import io.github.henrycooper86.max.agent.PcmPlayer
import io.github.henrycooper86.max.capture.CaptureStore
import io.github.henrycooper86.max.capture.CameraController
import io.github.henrycooper86.max.installAndroidKeyStoreStandIn
import io.github.henrycooper86.max.music.MusicController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/**
 * [DeviceActions.execute] as the session calls it. Robolectric stands in for Android: no activity
 * host is attached unless a test attaches one, so there is nothing to ask for a permission or to
 * open an app with.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class DeviceActionsExecuteTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Before
    fun prepareDevice() {
        installAndroidKeyStoreStandIn()
    }

    @After
    fun finish() {
        shadowOf(Looper.getMainLooper()).idle()
        scope.cancel()
    }

    private fun deviceActions() = DeviceActions(
        ApplicationProvider.getApplicationContext<Context>(),
        PcmPlayer(),
        MusicController(ApplicationProvider.getApplicationContext<Context>(), scope),
        CameraController(ApplicationProvider.getApplicationContext<Context>(), CaptureStore(ApplicationProvider.getApplicationContext<Context>()), scope),
        speed = { null }
    )

    private suspend fun DeviceActions.outcome(action: String, args: Map<String, Any?> = emptyMap()) = execute(
        AgentEvent.DeviceCommand("c", action, args["query"] as? String, args), isCurrent = { true }, send = { true }
    )

    /**
     * The relay counts a command with no answer as a failure after 8 s, so one this app cannot carry
     * out is refused as sent before anything is unlocked, asked for or switched. A torch with no `on`
     * must not switch off; a recording with no `start` must not stop.
     */
    @Test
    fun `unknown and malformed commands are answered before anything is unlocked or asked for`() = runBlocking {
        val actions = deviceActions()

        assertEquals(DeviceResult("unsupported", "action.unknown"), actions.outcome("camera.look", mapOf("on" to true)))
        assertEquals(DeviceResult("unsupported", "action.unknown"), actions.outcome("system.shutdown"))
        assertEquals(DeviceResult("unsupported", "action.invalid"), actions.outcome("torch.set"))
        assertEquals(DeviceResult("unsupported", "action.invalid"), actions.outcome("camera.record", mapOf("start" to "false")))
        assertEquals(DeviceResult("unsupported", "action.invalid"), actions.outcome("music.control", mapOf("control" to "play", "app" to 3)))
    }

    /**
     * Only a command the app cannot carry out is answered before the lock. A valid one on a locked
     * phone is still refused as it always was, and nothing is asked for or opened.
     */
    @Test
    fun `a valid command on a locked phone is still refused with device locked`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        shadowOf(context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).setKeyguardLocked(true)
        val asked = AtomicInteger()
        val actions = deviceActions().apply {
            host = object : DeviceActivityHost {
                override suspend fun requestPermission(permission: String): Boolean {
                    asked.incrementAndGet()
                    return true
                }

                override fun launch(intent: Intent): Boolean {
                    asked.incrementAndGet()
                    return true
                }
            }
        }

        val locked = DeviceResult("failed", "device.locked")
        assertEquals(locked, actions.outcome("torch.set", mapOf("on" to true)))
        assertEquals(locked, actions.outcome("camera.record", mapOf("start" to true)))
        assertEquals(locked, actions.outcome("camera.photo"))
        assertEquals(locked, actions.outcome("call.dial", mapOf("number" to "120")))
        assertEquals(locked, actions.outcome("music.control", mapOf("control" to "play")))
        assertEquals("nothing is asked for or opened while locked", 0, asked.get())
        // What cannot run anywhere is still said so, locked or not.
        assertEquals(DeviceResult("unsupported", "action.unknown"), actions.outcome("camera.look", mapOf("on" to true)))
        assertEquals(0, asked.get())
    }
}
