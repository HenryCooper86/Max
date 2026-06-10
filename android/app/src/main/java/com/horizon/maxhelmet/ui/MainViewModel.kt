package com.horizon.maxhelmet.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.AgentSessionHolder
import com.horizon.maxhelmet.agent.DemoScenario
import com.horizon.maxhelmet.agent.RideMode
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.VoicePersonality
import com.horizon.maxhelmet.service.VoiceAgentService
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Bridges the process-wide AgentSession and rider preferences to the Compose HUD. */
class MainViewModel(application: Application) : AndroidViewModel(application) {

    companion object {
        /**
         * 10.0.2.2 is the Android emulator's alias for the host machine. On a
         * physical phone, replace the host with the dev machine's LAN IP (the
         * relay listens on 0.0.0.0:8787) or the wss:// test server.
         */
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:8787/agent"
        private const val PREFS = "max_helmet"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_AUTH_TOKEN = "relay_auth_token"
        private const val KEY_ALLOW_SELF_SIGNED = "allow_self_signed"
        private const val KEY_DEV_MODE = "dev_mode"
    }

    private val session: AgentSession = AgentSessionHolder.get(application)
    private val prefs = application.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val sessionState: StateFlow<AgentSession.State> = session.state

    var relayUrl by mutableStateOf(prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL)
        private set

    /** Optional shared relay auth token, sent as the `token` query parameter. */
    var authToken by mutableStateOf(prefs.getString(KEY_AUTH_TOKEN, "") ?: "")
        private set

    /** Trust the test relay's self-signed certificate for wss:// (prototype only). */
    var allowSelfSigned by mutableStateOf(prefs.getBoolean(KEY_ALLOW_SELF_SIGNED, false))
        private set

    fun updateRelayUrl(url: String) {
        relayUrl = url
        prefs.edit().putString(KEY_RELAY_URL, url).apply()
    }

    fun updateAuthToken(token: String) {
        authToken = token
        prefs.edit().putString(KEY_AUTH_TOKEN, token).apply()
    }

    fun updateAllowSelfSigned(allow: Boolean) {
        allowSelfSigned = allow
        prefs.edit().putBoolean(KEY_ALLOW_SELF_SIGNED, allow).apply()
    }

    /**
     * Developer mode reveals the test settings (relay URL, self-signed trust,
     * demo scenarios, telemetry, raw status, log export). Toggled by
     * long-pressing the Max logo; persisted so demos survive relaunch.
     */
    var devMode by mutableStateOf(prefs.getBoolean(KEY_DEV_MODE, false))
        private set

    /** Rider preferences sheet (voice / tone / ride mode), opened by the gear. */
    var showPreferences by mutableStateOf(false)

    /**
     * Captions overlay under the orb. Off by default for the clean voice-mode
     * look; toggled by the 字幕 button (like ChatGPT's optional captions).
     */
    var showCaptions by mutableStateOf(false)
        private set

    /** Developer panel sheet, opened from the wrench (only shown when devMode is on). */
    var showDevPanel by mutableStateOf(false)

    fun toggleDevMode() {
        devMode = !devMode
        prefs.edit().putBoolean(KEY_DEV_MODE, devMode).apply()
    }

    fun togglePreferences() {
        showPreferences = !showPreferences
    }

    fun toggleCaptions() {
        showCaptions = !showCaptions
    }

    /** One toggle, like the web HUD's 开启免提 / 结束免提 button. */
    fun toggleHandsFree() {
        val app = getApplication<Application>()
        if (session.state.value.handsFree) {
            session.stop()
            VoiceAgentService.stop(app)
        } else {
            VoiceAgentService.start(app)
            session.start(relayUrl.trim(), allowSelfSigned, authToken.trim())
        }
    }

    /** Mutes/unmutes the mic mid-session (bottom mute control). */
    fun toggleMute() = session.toggleMute()

    fun setVoiceGender(gender: VoiceGender) = session.setVoiceGender(gender)

    fun setVoicePersonality(personality: VoicePersonality) = session.setVoicePersonality(personality)

    fun setRideMode(mode: RideMode) = session.setRideMode(mode)

    fun setScenario(scenario: DemoScenario) = session.setScenario(scenario)

    /** 清空对话记录: drops both the live and the persisted conversation log. */
    fun clearTranscript() = session.clearTranscript()

    /**
     * Exports the conversation log as JSON and opens the system share sheet —
     * the Android counterpart of exportTranscriptLog's file download.
     */
    fun exportTranscript(activity: Context) {
        val transcript = session.state.value.transcript
        if (transcript.isEmpty()) return

        val json = session.buildTranscriptExport()
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.US).format(Date())
        val exportDir = File(activity.cacheDir, "exports").apply { mkdirs() }
        val file = File(exportDir, "max-session-log-$stamp.json").apply { writeText(json) }

        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "application/json"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, file.name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(sendIntent, "导出对话记录"))
    }
}
