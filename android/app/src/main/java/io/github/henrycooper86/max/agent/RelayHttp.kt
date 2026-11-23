package io.github.henrycooper86.max.agent

import android.os.Handler
import android.os.Looper
import io.github.henrycooper86.max.BuildConfig
import okhttp3.OkHttpClient
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Trust device-installed CAs only when the rider opts in on a debug build. */
fun selfSignedTrustAllowed(debugBuild: Boolean, requested: Boolean): Boolean = debugBuild && requested

/** The opt-in adds device-installed CAs for local test relays. OkHttp always verifies the hostname. */
internal fun relayHttpClient(
    allowSelfSigned: Boolean,
    debugBuild: Boolean = BuildConfig.DEBUG,
    installedCaStore: () -> KeyStore = { KeyStore.getInstance("AndroidCAStore").apply { load(null) } },
    configure: OkHttpClient.Builder.() -> Unit = {}
): OkHttpClient {
    val builder = OkHttpClient.Builder().apply(configure)
    if (BuildConfig.DEBUG && selfSignedTrustAllowed(debugBuild, allowSelfSigned)) {
        // Without an accessible device store, keep the normal application TLS policy.
        val store = try {
            installedCaStore()
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IOException) {
            null
        }
        if (store != null) {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(store)
            val trust = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
            val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
            builder.sslSocketFactory(tls.socketFactory, trust)
        }
    }
    return builder.build()
}

/** Posts relay HTTP results to the main thread; created lazily so JVM tests never touch the Looper. */
internal object MainThread {
    private val handler by lazy { Handler(Looper.getMainLooper()) }
    fun post(block: () -> Unit) { handler.post(block) }
}
