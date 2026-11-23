package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.companion.CompanionTransport
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit

private val relayCa: X509Certificate by lazy {
    RelayHttpTest::class.java.getResourceAsStream("/test-relay-ca.pem")!!.use {
        CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
    }
}

/** The fixture is a self-signed CA absent from the default trust store. */
internal fun OkHttpClient.assertRejectsUninstalledRelay() {
    assertSame(OkHttpClient().hostnameVerifier, hostnameVerifier)
    val chain = arrayOf(relayCa)
    assertThrows(CertificateException::class.java) {
        x509TrustManager!!.checkServerTrusted(chain, "RSA")
    }
}

class RelayHttpTest {
    @Test
    fun `installed test CAs need a debug build and an explicit opt-in`() {
        for (debug in listOf(false, true)) {
            for (requested in listOf(false, true)) {
                var readStore = false
                val client = relayHttpClient(requested, debug, installedCaStore = {
                    readStore = true
                    KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                        load(null)
                        setCertificateEntry("test relay", relayCa)
                    }
                })
                assertSame(OkHttpClient().hostnameVerifier, client.hostnameVerifier)
                if (BuildConfig.DEBUG && debug && requested) {
                    assertTrue(readStore)
                    client.x509TrustManager!!.checkServerTrusted(arrayOf(relayCa), "RSA")
                } else {
                    assertFalse(readStore)
                    client.assertRejectsUninstalledRelay()
                }
            }
        }
    }

    @Test
    fun `an unavailable device store falls back to normal verification`() {
        relayHttpClient(true, installedCaStore = { throw java.security.KeyStoreException("unavailable") })
            .assertRejectsUninstalledRelay()
    }

    @Test
    fun `both companion clients enforce relay identity and keep their heartbeat`() {
        for (requested in listOf(false, true)) {
            val client = CompanionTransport.client(requested)
            client.assertRejectsUninstalledRelay()
            assertEquals(20_000, client.pingIntervalMillis)
        }
    }

    @Test
    fun `extra builder settings are kept`() {
        val client = relayHttpClient(allowSelfSigned = false, debugBuild = false) { pingInterval(20, TimeUnit.SECONDS) }
        assertEquals(20_000, client.pingIntervalMillis)
    }
}
