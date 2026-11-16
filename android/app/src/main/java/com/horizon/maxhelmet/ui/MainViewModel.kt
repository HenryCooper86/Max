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
import com.horizon.maxhelmet.agent.HealthClient
import com.horizon.maxhelmet.agent.LogoCache
import com.horizon.maxhelmet.ui.theme.VisorTemplates
import com.horizon.maxhelmet.ui.theme.parseAccentHex
import com.horizon.maxhelmet.ui.theme.Appearance
import com.horizon.maxhelmet.ui.theme.AppearanceInput
import com.horizon.maxhelmet.ui.theme.resolveAppearance
import org.json.JSONObject
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
        private const val KEY_ASSISTANT_NAME = "assistant_name"
        private const val KEY_DEVICE_KIND = "assistant_device"
        private const val KEY_WAKE_PHRASE = "assistant_wake_phrase"
        private const val KEY_ACCENT_HEX = "assistant_accent_hex"
        private const val KEY_VOICE_PROVIDER = "voice_provider"
        private const val KEY_DEVICE_PROFILE = "assistant_device_profile"
        private const val KEY_DEVICE_LABEL = "assistant_device_label"
        private const val KEY_RELAY_TEMPLATE = "assistant_template"
        private const val KEY_TEMPLATE_SWITCHING = "assistant_template_switching"
        private const val KEY_THEME_OVERRIDES = "assistant_theme"
        private const val KEY_RELAY_VISUALIZER = "assistant_visualizer"
        private const val KEY_LANGUAGE = "ui_language"
        private const val KEY_WEARER_TEMPLATE = "wearer_template"
        private const val KEY_WEARER_VISUALIZER = "wearer_visualizer"
    }

    private val session: AgentSession = AgentSessionHolder.get(application)
    private val prefs = application.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val secureTokens = SecureTokenStore(prefs)
    private val authClient = AuthClient()
    private val healthClient = HealthClient()
    private var loginGeneration = 0L

    fun confirmNavigation(id: String, accepted: Boolean) { session.confirmNavigation(id, accepted) }

    val sessionState: StateFlow<AgentSession.State> = session.state
    val crash = session.crash
    val companion = CompanionHolder.get(application)
    val helmetDiscovery = HelmetDiscovery(application)
    fun pairHelmet(code: String, discovery: Boolean = false) {
        if (!isLoggedIn) { companion.fail(tr(Str.ERR_LOGIN_FIRST)); return }
        if (session.state.value.handsFree) { companion.fail(tr(Str.ERR_END_HF_FIRST)); return }
        val action = if (discovery) CompanionProtocol.discover(code) else CompanionProtocol.pair(code)
        if (action == null) { companion.fail(tr(Str.ERR_BAD_PAIR_CODE)); return }
        companion.connect(relayUrl.trim(), sessionToken, action, transport = CompanionTransport.client(allowSelfSigned))
    }
    fun startHelmetRide() {
        val owner = sessionToken
        val host = deviceActions.host ?: return
        viewModelScope.launch {
            if (!isLoggedIn || session.state.value.handsFree) { companion.fail(tr(Str.ERR_LOGIN_AND_END_HF)); return@launch }
            if (!host.requestPermission(Manifest.permission.ACCESS_FINE_LOCATION)) { companion.fail(tr(Str.ERR_PRECISE_LOCATION)); return@launch }
            if (deviceActions.host !== host || owner != sessionToken || !isLoggedIn) return@launch
            companion.connect(relayUrl.trim(), sessionToken, ride = true, transport = CompanionTransport.client(allowSelfSigned))
            runCatching { ContextCompat.startForegroundService(getApplication(), Intent(getApplication(), HelmetRideService::class.java)) }
                .onFailure { companion.fail(tr(Str.ERR_RIDE_START)) }
        }
    }
    fun unpairHelmet() { if (isLoggedIn) companion.unpair(relayUrl.trim(), sessionToken, CompanionTransport.client(allowSelfSigned)) }
    fun refreshPhoneLocation() = session.refreshPhoneLocation()

    val hudCast = session.hudCast
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
        refreshHealth(delayMs = 700)
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

    // ---- white-label branding (defaults apply until the relay's /health says otherwise) ----

    /** What the assistant is called everywhere user-visible. Default "Max". */
    var assistantName by mutableStateOf(
        (prefs.getString(KEY_ASSISTANT_NAME, null) ?: DEFAULT_ASSISTANT_NAME).ifBlank { DEFAULT_ASSISTANT_NAME }
    )
        private set

    /** helmet / glasses / other: wording only, the visuals are device-agnostic. */
    var deviceKind by mutableStateOf(DeviceKind.fromWire(prefs.getString(KEY_DEVICE_KIND, null)) ?: DeviceKind.HELMET)
        private set

    var wakePhrase by mutableStateOf(prefs.getString(KEY_WAKE_PHRASE, null))
        private set

    /** The relay's brand accent (#RRGGBB), applied last over the template; null = none. */
    var accentHex by mutableStateOf(prefs.getString(KEY_ACCENT_HEX, null)?.takeIf { parseAccentHex(it) != null })
        private set

    /** Specific device (motorcycle-helmet ... wearable) and its label, from /health. */
    var deviceProfile by mutableStateOf(prefs.getString(KEY_DEVICE_PROFILE, null))
        private set
    var deviceLabel by mutableStateOf(prefs.getString(KEY_DEVICE_LABEL, null))
        private set

    /** The owner's template id, whether the wearer may switch, and the owner's token overrides. */
    var relayTemplate by mutableStateOf(prefs.getString(KEY_RELAY_TEMPLATE, null))
        private set
    var templateSwitching by mutableStateOf(prefs.getBoolean(KEY_TEMPLATE_SWITCHING, true))
        private set
    var themeOverrides by mutableStateOf(decodeTheme(prefs.getString(KEY_THEME_OVERRIDES, null)))
        private set
    var relayVisualizer by mutableStateOf(prefs.getString(KEY_RELAY_VISUALIZER, null))
        private set

    /** The wearer's own choices from Settings (ignored while the owner pins the look). */
    var wearerTemplate by mutableStateOf(prefs.getString(KEY_WEARER_TEMPLATE, null))
        private set
    var wearerVisualizer by mutableStateOf(prefs.getString(KEY_WEARER_VISUALIZER, null))
        private set

    /** The owner's PNG logo once downloaded (in memory only); null = show the bundled device mark. */
    var logoBitmap by mutableStateOf<android.graphics.Bitmap?>(null)
        private set
    private var logoKey: String? = null

    /** Default -> relay -> wearer -> relay overrides -> relay accent, resolved. */
    val appearance: Appearance
        get() = resolveAppearance(
            AppearanceInput(relayTemplate, wearerTemplate, templateSwitching, themeOverrides, accentHex)
        )

    val voiceStyle: VoiceStyle
        get() = resolveVoiceStyle(relayVisualizer, wearerVisualizer, templateSwitching)

    fun selectTemplate(id: String) {
        if (!templateSwitching || VisorTemplates.find(id) == null) return
        wearerTemplate = id
        prefs.edit().putString(KEY_WEARER_TEMPLATE, id).apply()
    }

    fun selectVoiceStyle(style: VoiceStyle) {
        if (!templateSwitching) return
        wearerVisualizer = style.wire
        prefs.edit().putString(KEY_WEARER_VISUALIZER, style.wire).apply()
    }

    /** Voice backends advertised by the relay (null until /health reports `voice`). */
    var voiceBackends by mutableStateOf<VoiceBackends?>(null)
        private set

    /** The rider's persisted backend choice (null = relay default). */
    var voiceProviderId by mutableStateOf(prefs.getString(KEY_VOICE_PROVIDER, null))
        private set

    private var healthJob: Job? = null

    /** The wearer's language choice (follow system / 中文 / English), applied live. */
    var languagePreference by mutableStateOf(LanguagePreference.fromStored(prefs.getString(KEY_LANGUAGE, null)))
        private set

    fun selectLanguage(preference: LanguagePreference) {
        languagePreference = preference
        prefs.edit().apply { if (preference.stored == null) remove(KEY_LANGUAGE) else putString(KEY_LANGUAGE, preference.stored) }.apply()
        applyLanguage()
    }

    private fun applyLanguage() {
        val before = Localization.language
        Localization.apply(languagePreference)
        if (Localization.language != before) session.languageChanged()
    }

    /** Re-reads the system language (call when the activity starts or the configuration changes). */
    fun syncLanguage() = applyLanguage()

    init {
        Localization.apply(languagePreference)
        AssistantBranding.name = assistantName
        session.setVoiceProvider(voiceProviderId)
        session.selectTranscriptOwner(authUserId.takeIf { isLoggedIn && it.isNotEmpty() })
        refreshHealth()
    }

    /** Best-effort GET /health: applies optional assistant branding and the voice backend list. */
    fun refreshHealth(delayMs: Long = 0) {
        healthJob?.cancel()
        val url = relayUrl.trim()
        healthJob = viewModelScope.launch {
            if (delayMs > 0) delay(delayMs)
            healthClient.fetch(url, effectiveToken, allowSelfSigned) { info -> applyHealth(info) }
        }
    }

    private fun applyHealth(info: HealthInfo) {
        info.assistant?.let { a ->
            a.name?.let { assistantName = it; AssistantBranding.name = it }
            a.device?.let { deviceKind = it }
            a.wakePhrase?.let { wakePhrase = it }
            // The assistant block is authoritative for the look: an absent field clears it.
            accentHex = a.accentHex?.takeIf { parseAccentHex(it) != null }
            deviceProfile = a.deviceProfile
            deviceLabel = a.deviceLabel
            relayTemplate = a.template
            templateSwitching = a.templateSwitching
            themeOverrides = a.theme
            relayVisualizer = a.visualizer
            applyLogo(a.logoUrl)
            prefs.edit().apply {
                putString(KEY_ACCENT_HEX, accentHex)
                putString(KEY_DEVICE_PROFILE, a.deviceProfile)
                putString(KEY_DEVICE_LABEL, a.deviceLabel)
                putString(KEY_RELAY_TEMPLATE, a.template)
                putBoolean(KEY_TEMPLATE_SWITCHING, a.templateSwitching)
                putString(KEY_THEME_OVERRIDES, JSONObject(a.theme).toString())
                putString(KEY_RELAY_VISUALIZER, a.visualizer)
            }.apply()
            prefs.edit().apply {
                a.name?.let { putString(KEY_ASSISTANT_NAME, it) }
                a.device?.let { putString(KEY_DEVICE_KIND, it.wire) }
                a.wakePhrase?.let { putString(KEY_WAKE_PHRASE, it) }
            }.apply()
        }
        voiceBackends = info.voice
    }

    /** Shows the owner's PNG logo for [path] (cached in memory); SVG and failures keep the bundled mark. */
    private fun applyLogo(path: String?) {
        val base = AuthClient.authBaseUrl(relayUrl.trim())
        if (path == null || base == null) { logoKey = null; logoBitmap = null; return }
        val key = base + path
        if (key == logoKey) return
        logoKey = key
        logoBitmap = LogoCache.get(key)
        if (logoBitmap != null || LogoCache.isUnsupported(key)) return
        healthClient.fetchLogo(relayUrl.trim(), effectiveToken, allowSelfSigned, path) { bitmap ->
            LogoCache.put(key, bitmap)
            if (logoKey == key) logoBitmap = bitmap
        }
    }

    private fun decodeTheme(json: String?): Map<String, String> {
        val obj = runCatching { JSONObject(json ?: return emptyMap()) }.getOrNull() ?: return emptyMap()
        return buildMap { obj.keys().forEach { k -> (obj.opt(k) as? String)?.let { put(k, it) } } }
    }

    /** Picks a voice backend; persists it and restarts a live session like a gender change. */
    fun selectVoiceProvider(id: String) {
        voiceProviderId = id
        prefs.edit().putString(KEY_VOICE_PROVIDER, id).apply()
        session.setVoiceProvider(id)
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
            loginError = tr(Str.ERR_ENTER_CREDENTIALS)
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
                refreshHealth()
                // A 401 cut the last attempt short — resume hands-free with
                // the fresh session instead of demanding another tap.
                if (pendingHandsFreeRetry && !session.state.value.handsFree) {
                    pendingHandsFreeRetry = false
                    toggleHandsFree()
                }
            } else {
                loginError = error ?: tr(Str.ERR_LOGIN_FAILED)
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
            refreshHealth()
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
        activity.startActivity(Intent.createChooser(sendIntent, tr(Str.EXPORT_CHOOSER)))
    }
}
