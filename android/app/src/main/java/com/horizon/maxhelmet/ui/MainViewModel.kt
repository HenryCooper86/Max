package com.horizon.maxhelmet.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.viewModelScope
import androidx.core.content.ContextCompat
import android.Manifest
import android.content.pm.PackageManager
import kotlinx.coroutines.launch
import com.horizon.maxhelmet.companion.*
import androidx.lifecycle.AndroidViewModel
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.AgentSessionHolder
import com.horizon.maxhelmet.agent.AuthClient
import com.horizon.maxhelmet.agent.DemoScenario
import com.horizon.maxhelmet.agent.RideMode
import com.horizon.maxhelmet.agent.TranscriptItem
import com.horizon.maxhelmet.agent.VoiceGender
import com.horizon.maxhelmet.agent.VoicePersonality
import com.horizon.maxhelmet.security.SecureTokenStore
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
        private const val KEY_SESSION_TOKEN = "auth_session_token"
        private const val KEY_AUTH_USER_ID = "auth_user_id"
        private const val KEY_AUTH_USERNAME = "auth_username"
        private const val KEY_AUTH_DISPLAY_NAME = "auth_display_name"
        private const val KEY_AUTH_ROLE = "auth_role"
        private const val KEY_ALLOW_SELF_SIGNED = "allow_self_signed"
        private const val KEY_DEV_MODE = "dev_mode"
        private const val KEY_TESTING_CAMPAIGN_ID = "testing_campaign_id"
        private const val KEY_TESTING_TEST_CASE_ID = "testing_test_case_id"
        private const val KEY_TESTING_RUN_ID = "testing_run_id"
        private const val KEY_TESTING_ASSIGNMENT_ID = "testing_assignment_id"
    }

    private val session: AgentSession = AgentSessionHolder.get(application)
    private val prefs = application.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val secureTokens = SecureTokenStore(prefs)
    private val authClient = AuthClient()
    private var loginGeneration = 0L

    val sessionState: StateFlow<AgentSession.State> = session.state
    val crash = session.crash
    val companion = CompanionHolder.get(application)
    val helmetDiscovery = HelmetDiscovery(application)
    fun pairHelmet(code: String, discovery: Boolean = false) {
        if (!isLoggedIn) { companion.fail("请先登录账号"); return }
        if (session.state.value.handsFree) { companion.fail("请先结束手机免提，再连接头盔"); return }
        val action = if (discovery) CompanionProtocol.discover(code) else CompanionProtocol.pair(code)
        if (action == null) { companion.fail("配对码无效"); return }
        companion.connect(relayUrl.trim(), sessionToken, action, transport = CompanionTransport.client(allowSelfSigned))
    }
    fun startHelmetRide() {
        val owner = sessionToken
        val host = deviceActions.host ?: return
        viewModelScope.launch {
            if (!isLoggedIn || session.state.value.handsFree) { companion.fail("请登录账号并结束手机免提"); return@launch }
            if (!host.requestPermission(Manifest.permission.ACCESS_FINE_LOCATION)) { companion.fail("骑行定位需要精确位置权限"); return@launch }
            if (deviceActions.host !== host || owner != sessionToken || !isLoggedIn) return@launch
            companion.connect(relayUrl.trim(), sessionToken, ride = true, transport = CompanionTransport.client(allowSelfSigned))
            runCatching { ContextCompat.startForegroundService(getApplication(), Intent(getApplication(), HelmetRideService::class.java)) }
                .onFailure { companion.fail("无法启动骑行，请在应用内重试") }
        }
    }
    fun unpairHelmet() { if (isLoggedIn) companion.unpair(relayUrl.trim(), sessionToken, CompanionTransport.client(allowSelfSigned)) }
    val music = session.music
    val captures = session.captures
    val camera = session.camera
    val deviceActions = session.deviceActions
    var showGallery by mutableStateOf(false)

    var relayUrl by mutableStateOf(prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL)
        private set

    /** Optional shared relay auth token, sent as the `token` query parameter. */
    var authToken by mutableStateOf(secureTokens.read(KEY_AUTH_TOKEN))
        private set

    /** Trust the test relay's self-signed certificate for wss:// (prototype only). */
    var allowSelfSigned by mutableStateOf(BuildConfig.DEBUG && prefs.getBoolean(KEY_ALLOW_SELF_SIGNED, false))
        private set

    var testingCampaignId by mutableStateOf(prefs.getString(KEY_TESTING_CAMPAIGN_ID, "release-readiness") ?: "release-readiness")
        private set
    var testingTestCaseId by mutableStateOf(prefs.getString(KEY_TESTING_TEST_CASE_ID, "baseline-live-session") ?: "baseline-live-session")
        private set
    var testingRunId by mutableStateOf(prefs.getString(KEY_TESTING_RUN_ID, "") ?: "")
        private set
    var testingAssignmentId by mutableStateOf(prefs.getString(KEY_TESTING_ASSIGNMENT_ID, "") ?: "")
        private set

    fun updateRelayUrl(url: String) {
        if (url != relayUrl) { loginGeneration++; loginBusy = false; companion.disconnect(); helmetDiscovery.stop(); session.detachCrashAccount() }
        relayUrl = url
        prefs.edit().putString(KEY_RELAY_URL, url).apply()
    }

    fun updateAuthToken(token: String) {
        authToken = token
        secureTokens.write(KEY_AUTH_TOKEN, token)
    }

    fun updateAllowSelfSigned(allow: Boolean) {
        if (allowSelfSigned != (BuildConfig.DEBUG && allow)) companion.disconnect()
        allowSelfSigned = BuildConfig.DEBUG && allow
        prefs.edit().putBoolean(KEY_ALLOW_SELF_SIGNED, allowSelfSigned).apply()
    }

    fun updateTestingCampaignId(value: String) {
        testingCampaignId = value.take(80)
        prefs.edit().putString(KEY_TESTING_CAMPAIGN_ID, testingCampaignId).apply()
    }

    fun updateTestingTestCaseId(value: String) {
        testingTestCaseId = value.take(80)
        prefs.edit().putString(KEY_TESTING_TEST_CASE_ID, testingTestCaseId).apply()
    }

    fun updateTestingRunId(value: String) {
        testingRunId = value.take(80)
        prefs.edit().putString(KEY_TESTING_RUN_ID, testingRunId).apply()
    }

    fun updateTestingAssignmentId(value: String) {
        testingAssignmentId = value.take(80)
        prefs.edit().putString(KEY_TESTING_ASSIGNMENT_ID, testingAssignmentId).apply()
    }

    /**
     * The login session token, stored SEPARATELY from the manual 认证令牌 field
     * so signing in/out never destroys a pasted operator relay token.
     */
    var sessionToken by mutableStateOf(secureTokens.read(KEY_SESSION_TOKEN))
        private set

    /**
     * What the WebSocket presents: the login session first (a dead one is
     * cleared on 401 by handleAuthRequired, so it can't shadow a valid manual
     * token for long), the manual field as fallback.
     */
    val effectiveToken: String
        get() = sessionToken.trim().ifEmpty { authToken.trim() }

    /** Set when a 401 interrupted hands-free; a successful login then restarts
     *  the session automatically instead of demanding another helmet tap. */
    private var pendingHandsFreeRetry = false

    // The signed-in account (empty when signed out). Persisted so the identity
    // row survives relaunches, like the web HUD's stored session.
    var authUserId by mutableStateOf(prefs.getString(KEY_AUTH_USER_ID, "") ?: "")
        private set
    var authUsername by mutableStateOf(prefs.getString(KEY_AUTH_USERNAME, "") ?: "")
        private set
    var authDisplayName by mutableStateOf(prefs.getString(KEY_AUTH_DISPLAY_NAME, "") ?: "")
        private set
    var authRole by mutableStateOf(prefs.getString(KEY_AUTH_ROLE, "") ?: "")
        private set
    var loginBusy by mutableStateOf(false)
        private set
    var loginError by mutableStateOf<String?>(null)
        private set

    val isLoggedIn: Boolean get() = authUsername.isNotEmpty() && sessionToken.isNotEmpty()

    init {
        session.selectTranscriptOwner(authUserId.takeIf { isLoggedIn && it.isNotEmpty() })
    }

    /**
     * A 401 from the relay: the session (if any) is dead — drop the stale
     * identity so the login form shows, consume the flag, and open settings
     * on the 账号 section. Called by the screen when authRequired flips on.
     */
    fun handleAuthRequired() {
        loginGeneration++; loginBusy = false
        companion.disconnect(); helmetDiscovery.stop(); session.detachCrashAccount()
        session.acknowledgeAuthRequired()
        if (isLoggedIn) {
            sessionToken = ""
            secureTokens.remove(KEY_SESSION_TOKEN)
            authUserId = ""
            authUsername = ""
            authDisplayName = ""
            authRole = ""
            prefs.edit()
                .remove(KEY_AUTH_USER_ID)
                .remove(KEY_AUTH_USERNAME)
                .remove(KEY_AUTH_DISPLAY_NAME)
                .remove(KEY_AUTH_ROLE)
                .apply()
        }
        session.selectTranscriptOwner(null)
        pendingHandsFreeRetry = true
        showPreferences = true
    }

    /**
     * POST /auth/login against the configured relay; on success the session
     * token lands in `authToken`, so the WebSocket connect just works.
     */
    fun login(username: String, password: String) {
        val name = username.trim()
        if (name.isEmpty() || password.isEmpty()) {
            loginError = "请输入用户名和密码"
            return
        }
        val owner = ++loginGeneration
        loginBusy = true
        loginError = null
        authClient.login(relayUrl.trim(), name, password, allowSelfSigned) { login, error ->
            if (owner != loginGeneration) return@login
            loginBusy = false
            if (login != null) {
                companion.disconnect(); helmetDiscovery.stop()
                sessionToken = login.token
                secureTokens.write(KEY_SESSION_TOKEN, login.token)
                authUserId = login.user.id
                authUsername = login.user.username
                authDisplayName = login.user.displayName
                authRole = login.user.role
                prefs.edit()
                    .putString(KEY_AUTH_USER_ID, login.user.id)
                    .putString(KEY_AUTH_USERNAME, login.user.username)
                    .putString(KEY_AUTH_DISPLAY_NAME, login.user.displayName)
                    .putString(KEY_AUTH_ROLE, login.user.role)
                    .apply()
                session.selectTranscriptOwner(login.user.id)
                loginError = null
                // A 401 cut the last attempt short — resume hands-free with
                // the fresh session instead of demanding another tap.
                if (pendingHandsFreeRetry && !session.state.value.handsFree) {
                    pendingHandsFreeRetry = false
                    toggleHandsFree()
                }
            } else {
                loginError = error ?: "登录失败，请重试"
            }
        }
    }

    /**
     * Invalidates the session on the relay (best-effort) and drops the local
     * identity + token. An active hands-free session is stopped — the login
     * that authorized it just ended.
     */
    fun logout() {
        loginGeneration++; loginBusy = false
        companion.stopRide(); companion.disconnect(); helmetDiscovery.stop(); session.detachCrashAccount()
        authClient.logout(relayUrl.trim(), sessionToken, allowSelfSigned)
        sessionToken = ""
        secureTokens.remove(KEY_SESSION_TOKEN)
        authUserId = ""
        authUsername = ""
        authDisplayName = ""
        authRole = ""
        loginError = null
        pendingHandsFreeRetry = false
        prefs.edit()
            .remove(KEY_AUTH_USER_ID)
            .remove(KEY_AUTH_USERNAME)
            .remove(KEY_AUTH_DISPLAY_NAME)
            .remove(KEY_AUTH_ROLE)
            .apply()
        session.selectTranscriptOwner(null)
        if (session.state.value.handsFree) {
            session.stop()

        }
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

        } else {
            if (companion.state.value.riding || crash.controller.active) return
            companion.disconnect()
            pendingHandsFreeRetry = false
            VoiceAgentService.start(app)
            session.start(
                relayUrl.trim(),
                allowSelfSigned,
                effectiveToken,
                testerId = authUsername.ifEmpty { "android-native" },
                testingCampaignId = testingCampaignId,
                testingTestCaseId = testingTestCaseId,
                testingRunId = testingRunId,
                testingAssignmentId = testingAssignmentId
            )
        }
    }

    /** Mutes/unmutes the mic mid-session (bottom mute control). */
    fun toggleMute() = session.toggleMute()
    override fun onCleared() { helmetDiscovery.stop(); super.onCleared() }

    fun setVoiceGender(gender: VoiceGender) = session.setVoiceGender(gender)

    fun setVoicePersonality(personality: VoicePersonality) = session.setVoicePersonality(personality)

    fun setRideMode(mode: RideMode) = session.setRideMode(mode)

    fun setScenario(scenario: DemoScenario) = session.setScenario(scenario)

    fun setGuidedDemo(enabled: Boolean) = session.setGuidedDemo(enabled)

    /** 清空对话记录: drops both the live and the persisted conversation log. */
    fun clearTranscript() = session.clearTranscript()

    /** Tester flags a bad turn in the captions overlay (字幕 → 有问题?). */
    fun flagTurn(item: TranscriptItem, reason: String) = session.sendTurnFeedback(item, reason)

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
