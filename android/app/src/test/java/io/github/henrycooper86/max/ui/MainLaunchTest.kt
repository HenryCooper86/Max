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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStoreException
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.Security
import java.security.cert.Certificate
import java.util.Collections
import java.util.Date
import java.util.Enumeration
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
        // The tokens are kept in the Android Keystore, which only a device has: Robolectric starts
        // without the security provider that answers to its name.
        if (Security.getProvider("AndroidKeyStore") == null) Security.addProvider(AndroidKeyStoreStandIn())
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

/**
 * Answers to the Android Keystore's name for Robolectric, which starts without that provider. The
 * compile-time class is the SDK's, whose only constructor takes the version as a double.
 */
private class AndroidKeyStoreStandIn : Provider("AndroidKeyStore", 1.0, "Empty Android Keystore for Robolectric") {
    init { put("KeyStore.AndroidKeyStore", EmptyAndroidKeyStore::class.java.name) }
}

/**
 * A public class with a public constructor, because java.security creates it by name. It loads
 * and holds nothing: no key can be made without the provider's own generator, so adding one is
 * refused.
 */
class EmptyAndroidKeyStore : KeyStoreSpi() {
    override fun engineLoad(stream: InputStream?, password: CharArray?) {
        if (stream != null) throw IOException("the empty Android Keystore cannot be loaded from a stream")
    }

    override fun engineGetKey(alias: String, password: CharArray?): Key? = null
    override fun engineGetCertificateChain(alias: String): Array<Certificate>? = null
    override fun engineGetCertificate(alias: String): Certificate? = null
    override fun engineGetCreationDate(alias: String): Date? = null
    override fun engineAliases(): Enumeration<String> = Collections.emptyEnumeration()
    override fun engineContainsAlias(alias: String): Boolean = false
    override fun engineSize(): Int = 0
    override fun engineIsKeyEntry(alias: String): Boolean = false
    override fun engineIsCertificateEntry(alias: String): Boolean = false
    override fun engineGetCertificateAlias(cert: Certificate): String? = null

    override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<Certificate>?) = refused()
    override fun engineSetKeyEntry(alias: String, key: ByteArray, chain: Array<Certificate>?) = refused()
    override fun engineSetCertificateEntry(alias: String, cert: Certificate) = refused()
    override fun engineDeleteEntry(alias: String) = refused()
    override fun engineStore(stream: OutputStream, password: CharArray?) = refused()

    private fun refused(): Nothing = throw KeyStoreException("the Android Keystore stand-in is empty")
}
