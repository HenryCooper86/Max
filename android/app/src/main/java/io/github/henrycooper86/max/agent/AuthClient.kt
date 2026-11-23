package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.AppLanguage
import io.github.henrycooper86.max.ui.Localization

import io.github.henrycooper86.max.BuildConfig
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

/**
 * Talks to the relay's /auth endpoints so riders sign in with username and
 * password instead of pasting a session token. The auth base URL is derived
 * from the relay WebSocket URL (ws→http, wss→https, path dropped), and the
 * device-installed CA toggle applies here exactly as it does to the socket.
 * The Android counterpart of ios/.../Agent/AuthClient.swift.
 */
class AuthClient(
    /** BuildConfig.DEBUG in the app; tests pass the build type they exercise. */
    private val debugBuild: Boolean = BuildConfig.DEBUG,
    /** Where results are delivered: the main thread in the app, inline in tests. */
    private val deliver: (() -> Unit) -> Unit = MainThread::post
) {

    data class User(val id: String, val username: String, val displayName: String, val role: String)

    data class Login(val token: String, val user: User)

    private var allowSelfSigned = false
    private var httpClient = relayHttpClient(allowSelfSigned = false, debugBuild = debugBuild)

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
        val client = clientFor(allowSelfSignedTls)

        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString()
            .toRequestBody(JSON)
        // The relay words its errors in the app's language, not the phone's.
        val request = Request.Builder()
            .url("$base/auth/login")
            .header("Accept-Language", if (Localization.language == AppLanguage.EN) "en-US" else "zh-CN")
            .post(body)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                deliver { onResult(null, tr(Str.ERR_RELAY_UNREACHABLE)) }
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
                deliver { onResult(login, error) }
            }
        })
    }

    /** POST /auth/logout — best-effort; the caller drops the token regardless. */
    fun logout(relayUrl: String, token: String, allowSelfSignedTls: Boolean) {
        if (token.isEmpty()) return
        val base = authBaseUrl(relayUrl) ?: return
        val client = clientFor(allowSelfSignedTls)

        val body = JSONObject().put("token", token).toString().toRequestBody(JSON)
        val request = Request.Builder()
            .url("$base/auth/logout")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) = response.close()
        })
    }

    /** The client for this request, rebuilt only when the effective trust setting changes. */
    @Synchronized
    internal fun clientFor(allowSelfSignedTls: Boolean): OkHttpClient {
        val trust = selfSignedTrustAllowed(debugBuild, allowSelfSignedTls)
        if (trust != allowSelfSigned) {
            allowSelfSigned = trust
            httpClient = relayHttpClient(trust, debugBuild)
        }
        return httpClient
    }
}
