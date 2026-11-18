package io.github.henrycooper86.max.ui

import io.github.henrycooper86.max.agent.DemoScenario
import io.github.henrycooper86.max.agent.RideMode
import io.github.henrycooper86.max.agent.VoiceGender
import io.github.henrycooper86.max.agent.VoicePersonality
import io.github.henrycooper86.max.agent.buildSessionStart
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class LocalizationTest {
    @After
    fun reset() = Localization.forTest(AppLanguage.ZH)

    private val placeholder = Regex("\\{(\\w+)\\}")

    @Test
    fun `every key has both languages with the same parameters`() {
        assertTrue(Str.entries.size > 250)
        Str.entries.forEach { key ->
            assertTrue("$key zh", key.zh.isNotBlank())
            assertTrue("$key en", key.en.isNotBlank())
            assertEquals("$key params", placeholder.findAll(key.zh).map { it.groupValues[1] }.toSet(), placeholder.findAll(key.en).map { it.groupValues[1] }.toSet())
        }
        // English never contains Han characters (the Chinese-named rows 中文 / 语言 are exempt).
        val han = Regex("[\\u4e00-\\u9fff]")
        val exempt = setOf(Str.LANGUAGE_ROW, Str.LANG_ZH, Str.LANG_EN, Str.NAV_CONFIRM_PROMPT) // the prompt quotes the Chinese voice command "确认导航"
        Str.entries.filter { it !in exempt }.forEach { assertFalse("$it en has Chinese: ${it.en}", han.containsMatchIn(it.en)) }
    }

    @Test
    fun `parameters substitute in both languages`() {
        assertEquals("Aria 思考中…", Str.TURN_THINKING.text(AppLanguage.ZH, "name" to "Aria"))
        assertEquals("Aria is thinking…", Str.TURN_THINKING.text(AppLanguage.EN, "name" to "Aria"))
        assertEquals("Hi, I'm Aria", Str.GREETING.text(AppLanguage.EN, "name" to "Aria"))
        assertEquals("“hey aria”".let { "Standby, or say $it" }, Str.HINT_WAKE.text(AppLanguage.EN, "caption" to "Standby", "wake" to "hey aria"))
        assertEquals("Assistive glasses gallery".let { "Aria gallery" }, Str.GALLERY_TITLE.text(AppLanguage.EN, "name" to "Aria"))
        assertFalse(Str.QQ_HELP.text(AppLanguage.EN, "name" to "Aria").contains("{name}"))
    }

    @Test
    fun `override beats the system language`() {
        val zhSystem = Locale.SIMPLIFIED_CHINESE
        val enSystem = Locale.US
        assertEquals(AppLanguage.ZH, resolveLanguage(LanguagePreference.SYSTEM, zhSystem))
        assertEquals(AppLanguage.EN, resolveLanguage(LanguagePreference.SYSTEM, enSystem))
        assertEquals(AppLanguage.EN, resolveLanguage(LanguagePreference.SYSTEM, Locale.FRANCE))
        assertEquals(AppLanguage.EN, resolveLanguage(LanguagePreference.EN, zhSystem))
        assertEquals(AppLanguage.ZH, resolveLanguage(LanguagePreference.ZH, enSystem))
        assertEquals(LanguagePreference.SYSTEM, LanguagePreference.fromStored(null))
        assertEquals(LanguagePreference.EN, LanguagePreference.fromStored("en"))
        Localization.apply(LanguagePreference.EN, zhSystem)
        assertEquals(AppLanguage.EN, Localization.language)
        Localization.apply(LanguagePreference.SYSTEM, zhSystem)
        assertEquals(AppLanguage.ZH, Localization.language)
    }

    @Test
    fun `chinese output is identical to the previous hard-coded strings`() {
        Localization.forTest(AppLanguage.ZH)
        assertEquals("点按镜面开始对话", tr(Str.TAP_VISOR))
        assertEquals("免提待命 · 请讲话", tr(Str.TURN_LISTENING))
        assertEquals("你好，我是 Max", tr(Str.GREETING, "name" to "Max"))
        assertEquals("已就绪", tr(Str.CONN_READY))
        assertEquals("高风险 · 优先安全", tr(Str.HAZARD_CRITICAL))
        assertEquals("退出登录", tr(Str.SIGN_OUT))
        assertEquals("女声", VoiceGender.FEMALE.label)
        assertEquals("领航", VoicePersonality.RALLY.label)
        assertEquals("骑行", RideMode.RIDE.label)
        assertEquals("横风", DemoScenario.WIND.label)
        assertEquals("头盔", DeviceKind.HELMET.noun)
        assertEquals("波形", VoiceStyle.WAVE.label)
    }

    @Test
    fun `english output follows the table and labels switch live`() {
        Localization.forTest(AppLanguage.EN)
        assertEquals("Tap the visor to start", tr(Str.TAP_VISOR))
        assertEquals("Female", VoiceGender.FEMALE.label)
        assertEquals("Navigation", RideMode.NAVIGATION.label)
        assertEquals("Helmet", DeviceKind.HELMET.noun)
        assertEquals("Bars", VoiceStyle.BARS.label)
        assertEquals("Daylight", io.github.henrycooper86.max.ui.theme.VisorTemplates.DAYLIGHT.name)
        assertEquals("Aria is thinking…", orbCaption(
            io.github.henrycooper86.max.agent.AgentSession.State(
                handsFree = true,
                connection = io.github.henrycooper86.max.agent.ConnectionState.READY,
                turnState = io.github.henrycooper86.max.agent.TurnState.THINKING
            ), "Aria"
        ))
        assertEquals("Misheard", flagReasonLabel("听错了"))
        assertEquals("QQ Music", musicLabel("QQ音乐"))
    }

    @Test
    fun `stored status text is shown in the current language`() {
        Localization.forTest(AppLanguage.EN)
        assertEquals("Offline", relocalize("离线"))
        assertEquals("Waiting for ride context", relocalize("等待骑行上下文"))
        assertEquals("免提待命，请讲话", relocalize("免提待命，请讲话")) // relay text is left as received
        Localization.forTest(AppLanguage.ZH)
        assertEquals("离线", relocalize("离线"))
    }

    @Test
    fun `session start carries the effective language only when given`() {
        fun start(language: String?) = JSONObject(
            buildSessionStart(VoiceGender.FEMALE, VoicePersonality.CONCISE, RideMode.RIDE, DemoScenario.COMMUTE, null, null, language = language)
        )
        assertFalse(start(null).has("language"))
        assertEquals("en", start("en").getString("language"))
        assertEquals("zh", start("zh").getString("language"))
        assertFalse(start("fr").has("language"))
        Localization.apply(LanguagePreference.EN, Locale.SIMPLIFIED_CHINESE)
        assertEquals("en", Localization.language.wire)
        Localization.apply(LanguagePreference.SYSTEM, Locale.SIMPLIFIED_CHINESE)
        assertEquals("zh", Localization.language.wire)
    }
}
