package io.github.henrycooper86.max.security

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Stores bearer tokens with an Android Keystore-backed AES-GCM key.
 * Existing plaintext preference values are migrated on first read. */
class SecureTokenStore(private val preferences: SharedPreferences) {
    companion object {
        private const val KEY_ALIAS = "max_helmet_token_key_v1"
        private const val SECURE_PREFIX = "secure_v1_"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }

    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun read(preferenceKey: String): String {
        val secureKey = SECURE_PREFIX + preferenceKey
        val encoded = preferences.getString(secureKey, null)
        if (encoded != null) {
            return decrypt(encoded) ?: run {
                preferences.edit().remove(secureKey).apply()
                ""
            }
        }

        val legacy = preferences.getString(preferenceKey, null) ?: return ""
        if (legacy.isEmpty()) {
            preferences.edit().remove(preferenceKey).apply()
            return ""
        }
        if (write(preferenceKey, legacy)) preferences.edit().remove(preferenceKey).apply()
        return legacy
    }

    fun write(preferenceKey: String, value: String): Boolean {
        if (value.isEmpty()) {
            remove(preferenceKey)
            return true
        }
        val cipher = runCatching {
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, secretKey()) }
        }.getOrNull() ?: return false
        val encrypted = runCatching { cipher.doFinal(value.toByteArray(Charsets.UTF_8)) }.getOrNull() ?: return false
        val payload = listOf(cipher.iv, encrypted).joinToString(".") { Base64.encodeToString(it, Base64.NO_WRAP) }
        preferences.edit().putString(SECURE_PREFIX + preferenceKey, payload).remove(preferenceKey).apply()
        return true
    }

    fun remove(preferenceKey: String) {
        preferences.edit().remove(SECURE_PREFIX + preferenceKey).remove(preferenceKey).apply()
    }

    private fun decrypt(payload: String): String? {
        val parts = payload.split('.', limit = 2)
        if (parts.size != 2) return null
        return runCatching {
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            }
            cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
        }.getOrNull()
    }

    private fun secretKey(): SecretKey {
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
    }
}
