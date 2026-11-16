package com.horizon.maxhelmet.agent

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
