package com.horizon.maxhelmet.agent

import com.horizon.maxhelmet.ui.tr
import com.horizon.maxhelmet.ui.Str

import android.os.Handler
import android.os.Looper
import com.horizon.maxhelmet.BuildConfig
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Talks to the relay's /auth endpoints so riders sign in with username and
 * password instead of pasting a session token. The auth base URL is derived
 * from the relay WebSocket URL (ws→http, wss→https, path dropped), and the
 * self-signed trust toggle applies here exactly as it does to the socket.
 * The Android counterpart of ios/.../Agent/AuthClient.swift.
 */
class AuthClient {

    data class User(val id: String, val username: String, val displayName: String, val role: String)

    data class Login(val token: String, val user: User)

    private val mainHandler = Handler(Looper.getMainLooper())
    private var allowSelfSigned = false
    private var httpClient = buildClient(allowSelfSigned = false)

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /** ws://host:8787/agent → http://host:8787 ; wss://host/agent → https://host */
        fun authBaseUrl(relayUrl: String): String? {
            val trimmed = relayUrl.trim()
            val httpForm = when {
                trimmed.startsWith("ws://", ignoreCase = true) -> "http://" + trimmed.substring(5)
                trimmed.startsWith("wss://", ignoreCase = true) -> "https://" + trimmed.substring(6)
                trimmed.startsWith("http://", ignoreCase = true) ||
                    trimmed.startsWith("https://", ignoreCase = true) -> trimmed
                else -> return null
            }
            val url = httpForm.toHttpUrlOrNull() ?: return null
            return url.newBuilder().encodedPath("/").query(null).fragment(null).build()
                .toString().trimEnd('/')
        }
    }

    /** POST /auth/login. `onResult` always runs on the main thread. */
    fun login(
        relayUrl: String,
        username: String,
        password: String,
        allowSelfSignedTls: Boolean,
        onResult: (login: Login?, error: String?) -> Unit
    ) {
        val base = authBaseUrl(relayUrl)
        if (base == null) {
            onResult(null, tr(Str.ERR_RELAY_BAD))
            return
        }
        ensureClient(allowSelfSignedTls)

        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString()
            .toRequestBody(JSON)
        val request = Request.Builder().url("$base/auth/login").post(body).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                mainHandler.post { onResult(null, tr(Str.ERR_RELAY_UNREACHABLE)) }
            }

            override fun onResponse(call: Call, response: Response) {
                val parsed = runCatching { JSONObject(response.body?.string() ?: "") }.getOrNull()
                response.close()
                val login = parsed?.takeIf { it.optBoolean("ok") }?.let { payload ->
                    val token = payload.optString("token")
                    val user = payload.optJSONObject("user") ?: return@let null
                    val id = user.optString("id")
                    val name = user.optString("username")
                    if (token.isEmpty() || id.isEmpty() || name.isEmpty()) return@let null
                    Login(
                        token = token,
                        user = User(
                            id = id,
                            username = name,
                            displayName = user.optString("displayName").ifEmpty { name },
                            role = user.optString("role").ifEmpty { "tester" }
                        )
                    )
                }
                // The relay reports failures as {ok:false, error:"…"} (wrong
                // password, rate limited) — show its message verbatim.
                val error = if (login == null) {
                    parsed?.optString("error")?.takeIf { it.isNotEmpty() } ?: tr(Str.ERR_LOGIN_FAILED)
                } else {
                    null
                }
                mainHandler.post { onResult(login, error) }
            }
        })
    }

    /** POST /auth/logout — best-effort; the caller drops the token regardless. */
    fun logout(relayUrl: String, token: String, allowSelfSignedTls: Boolean) {
        if (token.isEmpty()) return
        val base = authBaseUrl(relayUrl) ?: return
        ensureClient(allowSelfSignedTls)

        val body = JSONObject().put("token", token).toString().toRequestBody(JSON)
        val request = Request.Builder()
            .url("$base/auth/logout")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) = response.close()
        })
    }

    private fun ensureClient(allowSelfSignedTls: Boolean) {
        val debugTrustEnabled = BuildConfig.DEBUG && allowSelfSignedTls
        if (debugTrustEnabled != allowSelfSigned) {
            allowSelfSigned = debugTrustEnabled
            httpClient = buildClient(allowSelfSigned)
        }
    }

    private fun buildClient(allowSelfSigned: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder()
        if (BuildConfig.DEBUG && allowSelfSigned) {
            // Debug-only, mirroring AgentSession.buildHttpClient. Release
            // binaries cannot install a trust-all manager or hostname verifier.
            val trustAll = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(trustAll), SecureRandom())
            }
            builder.sslSocketFactory(sslContext.socketFactory, trustAll)
            builder.hostnameVerifier { _, _ -> true }
        }
        return builder.build()
    }
}
