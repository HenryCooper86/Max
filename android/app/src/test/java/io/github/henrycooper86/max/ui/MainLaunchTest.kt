package io.github.henrycooper86.max.ui

import android.content.Context
import android.provider.Settings
import android.view.ViewGroup
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.henrycooper86.max.MainActivity
import io.github.henrycooper86.max.installAndroidKeyStoreStandIn
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Starts the app the way a tap on its icon does, on the JVM: Robolectric stands in for Android, so
 * no emulator is needed. [ActivityScenario] opens [MainActivity], which builds [MainViewModel]
 * with its initialisers and collectors and composes the HUD, then closes it again.
 *
 * Android 15 rather than the app's target 16: Robolectric's Android 16 runtime needs Java 21, and
 * CI runs the unit tests on 17.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class MainLaunchTest {
    /**
     * What ends the app on a device. Robolectric's JVM only prints an uncaught exception, so it is
     * kept here to fail the test: a collector that throws while the view model is built does not
     * reach the launch.
     */
    private val crashes = CopyOnWriteArrayList<Throwable>()
    private var earlierUncaughtHandler: Thread.UncaughtExceptionHandler? = null

    @Before
    fun prepareDevice() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        // The visor and the hummingbird animate for as long as the screen is up, and Robolectric
        // draws every frame the start asks for before it returns: with animations on, the launch
        // would never finish. This is the system's "remove animations" setting, which the HUD
        // honours by staying still.
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        // The tokens are kept in the Android Keystore, which only a device has.
        installAndroidKeyStoreStandIn()
        earlierUncaughtHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, error -> crashes += error }
    }

    @After
    fun nothingCrashed() {
        Thread.setDefaultUncaughtExceptionHandler(earlierUncaughtHandler)
        if (crashes.isEmpty()) return
        throw AssertionError("Uncaught exception while the app ran", crashes.first()).also { crash ->
            crashes.drop(1).forEach(crash::addSuppressed)
        }
    }

    @Test
    fun `launching the app builds its view model and lays out the HUD`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
            scenario.onActivity { activity ->
                // The activity's own view model, built by onStart.
                val model = ViewModelProvider(activity)[MainViewModel::class.java]
                assertFalse(model.sessionState.value.handsFree)

                // setContent's ComposeView holds the composed view once its content has run.
                val content = activity.findViewById<ViewGroup>(android.R.id.content)
                val hud = content.getChildAt(0) as ComposeView
                assertEquals("the HUD was not composed", 1, hud.childCount)
                assertTrue("the HUD was not laid out (${hud.width}x${hud.height})", hud.width > 0 && hud.height > 0)
            }
        }
    }
}
