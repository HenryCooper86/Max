package com.horizon.maxhelmet.agent

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.ui.HealthInfo
import com.horizon.maxhelmet.ui.parseHealth
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Best-effort GET /health against the relay (same base-URL derivation and
 * debug-only self-signed trust as [AuthClient]). Failures are silent: the
 * callback simply never fires, so branding and voice defaults stay in place.
 */
class HealthClient {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var allowSelfSigned = false
    private var httpClient = buildClient(false)

    fun fetch(relayUrl: String, token: String, allowSelfSignedTls: Boolean, onResult: (HealthInfo) -> Unit) {
        val base = AuthClient.authBaseUrl(relayUrl) ?: return
        val trust = BuildConfig.DEBUG && allowSelfSignedTls
        if (trust != allowSelfSigned) {
            allowSelfSigned = trust
            httpClient = buildClient(trust)
        }
        val request = runCatching {
            Request.Builder().url("$base/health").apply {
                if (token.isNotBlank()) header("Authorization", "Bearer ${token.trim()}")
            }.build()
        }.getOrNull() ?: return
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) {
                val body = response.use { if (it.isSuccessful) it.body?.string() else null }
                val info = body?.let(::parseHealth) ?: return
                mainHandler.post { onResult(info) }
            }
        })
    }

    /**
     * Downloads the owner's logo (a path on the relay, never another host) and decodes it when
     * the relay serves it as image/png. SVG (or anything else) yields null: the bundled device
     * mark is shown instead. Best-effort and silent like [fetch]; [onResult] runs on the main thread.
     */
    fun fetchLogo(relayUrl: String, token: String, allowSelfSignedTls: Boolean, path: String, onResult: (Bitmap?) -> Unit) {
        val base = AuthClient.authBaseUrl(relayUrl) ?: return
        val trust = BuildConfig.DEBUG && allowSelfSignedTls
        if (trust != allowSelfSigned) {
            allowSelfSigned = trust
            httpClient = buildClient(trust)
        }
        val request = runCatching {
            Request.Builder().url(base + path).apply {
                if (token.isNotBlank()) header("Authorization", "Bearer ${token.trim()}")
            }.build()
        }.getOrNull() ?: return
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) {
                val bitmap = response.use { r ->
                    if (!r.isSuccessful || logoFormat(r.header("Content-Type")) != LogoFormat.PNG) return@use null
                    val body = r.body ?: return@use null
                    if (body.contentLength() > MAX_LOGO_BYTES) return@use null
                    val bytes = body.source().let { src -> src.request(MAX_LOGO_BYTES + 1); src.buffer.readByteArray() }
                    if (bytes.size > MAX_LOGO_BYTES) null else decodeLogo(bytes)
                }
                mainHandler.post { onResult(bitmap) }
            }
        })
    }

    private fun buildClient(trustAll: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder()
        if (BuildConfig.DEBUG && trustAll) {
            val manager = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
            val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), SecureRandom()) }
            builder.sslSocketFactory(context.socketFactory, manager)
            builder.hostnameVerifier { _, _ -> true }
        }
        return builder.build()
    }
}

enum class LogoFormat { PNG, SVG, OTHER }

internal const val MAX_LOGO_BYTES = 2L * 1024 * 1024

/** Classifies a Content-Type header: only PNG can be decoded without an extra dependency. */
fun logoFormat(contentType: String?): LogoFormat = when (contentType?.substringBefore(';')?.trim()?.lowercase()) {
    "image/png" -> LogoFormat.PNG
    "image/svg+xml" -> LogoFormat.SVG
    else -> LogoFormat.OTHER
}

/** Decodes at no more than ~256px a side so a large upload cannot hold much memory. */
private fun decodeLogo(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= 256 && bounds.outHeight / (sample * 2) >= 256) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}

/** Process-wide in-memory logo cache keyed by relay base + logo path; remembers unsupported (SVG) logos so they are not refetched. */
object LogoCache {
    private val bitmaps = LinkedHashMap<String, Bitmap>()
    private val unsupported = HashSet<String>()

    @Synchronized fun get(key: String): Bitmap? = bitmaps[key]
    @Synchronized fun isUnsupported(key: String): Boolean = key in unsupported
    @Synchronized fun put(key: String, bitmap: Bitmap?) {
        if (bitmap == null) { unsupported += key; return }
        bitmaps[key] = bitmap
        while (bitmaps.size > 4) bitmaps.remove(bitmaps.keys.first())
    }
}
