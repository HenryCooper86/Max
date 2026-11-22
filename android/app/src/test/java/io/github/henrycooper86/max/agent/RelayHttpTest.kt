package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.BuildConfig
import okhttp3.OkHttpClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.security.Principal
import java.security.cert.Certificate
import java.security.cert.X509Certificate
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSessionContext

/** A TLS session that presents no certificate, so only a trust-all verifier accepts it. */
private object NoCertificateSession : SSLSession {
    override fun getId() = ByteArray(0)
    override fun getSessionContext(): SSLSessionContext? = null
    override fun getCreationTime() = 0L
    override fun getLastAccessedTime() = 0L
    override fun invalidate() = Unit
    override fun isValid() = true
    override fun putValue(name: String?, value: Any?) = Unit
    override fun getValue(name: String?): Any? = null
    override fun removeValue(name: String?) = Unit
    override fun getValueNames() = emptyArray<String>()
    override fun getPeerCertificates(): Array<Certificate> = throw SSLPeerUnverifiedException("none")
    override fun getLocalCertificates(): Array<Certificate>? = null
    @Deprecated("Deprecated in Java")
    override fun getPeerCertificateChain(): Array<javax.security.cert.X509Certificate> = throw SSLPeerUnverifiedException("none")
    override fun getPeerPrincipal(): Principal = throw SSLPeerUnverifiedException("none")
    override fun getLocalPrincipal(): Principal? = null
    override fun getCipherSuite() = ""
    override fun getProtocol() = ""
    override fun getPeerHost() = "relay.example.com"
    override fun getPeerPort() = 443
    override fun getPacketBufferSize() = 0
    override fun getApplicationBufferSize() = 0
}

/** True when the client would accept an unverified server: the debug-only test-relay escape hatch. */
internal fun OkHttpClient.trustsAnyServer(): Boolean {
    val hostAccepted = hostnameVerifier.verify("relay.example.com", NoCertificateSession)
    val chainAccepted = runCatching { x509TrustManager!!.checkServerTrusted(arrayOf<X509Certificate>(), "RSA") }.isSuccess
    return hostAccepted && chainAccepted
}

class RelayHttpTest {
    @Test
    fun `self-signed trust needs both a debug build and the rider's opt-in`() {
        assertTrue(selfSignedTrustAllowed(debugBuild = true, requested = true))
        assertFalse(selfSignedTrustAllowed(debugBuild = true, requested = false))
        assertFalse(selfSignedTrustAllowed(debugBuild = false, requested = true))
        assertFalse(selfSignedTrustAllowed(debugBuild = false, requested = false))
    }

    @Test
    fun `a release build never installs the trust-all manager, even when asked`() {
        assertFalse(relayHttpClient(allowSelfSigned = true, debugBuild = false).trustsAnyServer())
        assertFalse(relayHttpClient(allowSelfSigned = false, debugBuild = true).trustsAnyServer())
    }

    @Test
    fun `a debug build trusts the test relay once the rider opts in`() {
        assumeTrue(BuildConfig.DEBUG)
        assertTrue(relayHttpClient(allowSelfSigned = true, debugBuild = true).trustsAnyServer())
    }

    @Test
    fun `release binaries keep the compile-time lock even if a caller claims debug`() {
        assumeFalse(BuildConfig.DEBUG)
        assertFalse(relayHttpClient(allowSelfSigned = true, debugBuild = true).trustsAnyServer())
    }

    @Test
    fun `extra builder settings are kept`() {
        val client = relayHttpClient(allowSelfSigned = false, debugBuild = false) { pingInterval(20, java.util.concurrent.TimeUnit.SECONDS) }
        assertTrue(client.pingIntervalMillis == 20_000)
    }
}
