package com.horizon.maxhelmet.ui

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.AgentSessionHolder
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.service.VoiceAgentService
import kotlinx.coroutines.flow.StateFlow

/** Bridges the process-wide AgentSession and rider preferences to the Compose HUD. */
class MainViewModel(application: Application) : AndroidViewModel(application) {

    companion object {
        /**
         * 10.0.2.2 is the Android emulator's alias for the host machine. On a
         * physical phone, replace the host with the dev machine's LAN IP (the
         * relay listens on 0.0.0.0:8787) or the test server.
         */
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:8787/agent"
        private const val PREFS = "max_helmet"
        private const val KEY_RELAY_URL = "relay_url"
    }

    private val session: AgentSession = AgentSessionHolder.get(application)
    private val prefs = application.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val sessionState: StateFlow<AgentSession.State> = session.state

    var relayUrl by mutableStateOf(prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL)
        private set

    fun updateRelayUrl(url: String) {
        relayUrl = url
        prefs.edit().putString(KEY_RELAY_URL, url).apply()
    }

    /** One toggle, like the web HUD's 开启免提 / 结束免提 button. */
    fun toggleHandsFree() {
        val app = getApplication<Application>()
        if (session.state.value.handsFree) {
            session.stop()
            VoiceAgentService.stop(app)
        } else {
            VoiceAgentService.start(app)
            session.start(relayUrl.trim(), session.state.value.voiceGender)
        }
    }

    fun setVoiceGender(gender: VoiceGender) = session.setVoiceGender(gender)
}
