package io.github.henrycooper86.max

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

/**
 * Makes the Android Keystore's name answer for Robolectric tests that build something keeping tokens
 * there (the view model, an AgentSession). The keystore itself is only on a device: Robolectric
 * starts without the security provider that answers to its name.
 */
fun installAndroidKeyStoreStandIn() {
    if (Security.getProvider("AndroidKeyStore") == null) Security.addProvider(AndroidKeyStoreStandIn())
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
