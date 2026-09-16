package com.horizon.maxhelmet.companion

import com.horizon.maxhelmet.BuildConfig
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** The explicit development TLS preference matches voice/login; release always verifies TLS. */
object CompanionTransport {
    private val verified = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val development by lazy {
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        verified.newBuilder().sslSocketFactory(tls.socketFactory, trust).hostnameVerifier { _, _ -> true }.build()
    }
    fun client(allowSelfSigned: Boolean): OkHttpClient = if (BuildConfig.DEBUG && allowSelfSigned) development else verified
}
