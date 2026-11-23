package io.github.henrycooper86.max.companion

import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.agent.relayHttpClient
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Cache the companion socket clients with the same certificate policy as voice and login. */
object CompanionTransport {
    private fun build(allowSelfSigned: Boolean) = relayHttpClient(allowSelfSigned) {
        pingInterval(20, TimeUnit.SECONDS)
    }

    private val verified = build(false)
    private val development by lazy { build(true) }

    fun client(allowSelfSigned: Boolean): OkHttpClient = if (BuildConfig.DEBUG && allowSelfSigned) development else verified
}
