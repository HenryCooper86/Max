package io.github.henrycooper86.max.agent

import android.os.Handler
import android.os.Looper
import io.github.henrycooper86.max.BuildConfig
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** The test relay's self-signed certificate may be trusted only in debug builds, and only when the rider opts in. */
fun selfSignedTrustAllowed(debugBuild: Boolean, requested: Boolean): Boolean = debugBuild && requested

/**
 * One OkHttp client for every relay connection (WebSocket, /auth, /health), so
 * the debug-only trust-all path exists once. A release build passes
 * debugBuild = false, which can never install the trust-all manager or
 * hostname verifier, whatever stale preferences ask for.
 */
fun relayHttpClient(
    allowSelfSigned: Boolean,
    debugBuild: Boolean = BuildConfig.DEBUG,
    configure: OkHttpClient.Builder.() -> Unit = {}
): OkHttpClient {
    val builder = OkHttpClient.Builder().apply(configure)
    if (BuildConfig.DEBUG && selfSignedTrustAllowed(debugBuild, allowSelfSigned)) {
        // BuildConfig.DEBUG is a compile-time constant: R8 or not, the release
        // build carries no reachable path into this block.
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val sslContext = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustAll), SecureRandom()) }
        builder.sslSocketFactory(sslContext.socketFactory, trustAll)
        builder.hostnameVerifier { _, _ -> true }
    }
    return builder.build()
}

/** Posts relay HTTP results to the main thread; created lazily so JVM tests never touch the Looper. */
internal object MainThread {
    private val handler by lazy { Handler(Looper.getMainLooper()) }
    fun post(block: () -> Unit) { handler.post(block) }
}
