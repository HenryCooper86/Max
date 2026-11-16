package com.horizon.maxhelmet.ui

import org.json.JSONObject

/** The kind of hardware the assistant lives in; purely presentational wording. */
enum class DeviceKind(val wire: String, private val text: Str) {
    HELMET("helmet", Str.DEVICE_HELMET),
    GLASSES("glasses", Str.DEVICE_GLASSES),
    OTHER("other", Str.DEVICE_OTHER);

    val noun: String get() = tr(text)

    companion object {
        fun fromWire(value: String?): DeviceKind? = entries.firstOrNull { it.wire == value?.trim()?.lowercase() }
    }
}

const val DEFAULT_ASSISTANT_NAME = "Max"

/**
 * Process-wide mirror of the assistant name so non-Compose surfaces (the
 * foreground-service notification) can use it. MainViewModel owns the state and
 * writes here whenever it changes.
 */
object AssistantBranding {
    @Volatile
    var name: String = DEFAULT_ASSISTANT_NAME
}

/** A selectable voice backend advertised by the relay's /health. */
data class VoiceProviderInfo(
    val id: String,
    val label: String,
    val kind: String,
    val configured: Boolean,
    val description: String? = null
)

data class VoiceBackends(
    val active: String,
    val switching: Boolean,
    val providers: List<VoiceProviderInfo>
) {
    /** Label of the active provider, falling back to its id. */
    val activeLabel: String get() = providers.firstOrNull { it.id == active }?.label ?: active
}

/** Optional assistant branding advertised by /health. Every field may be absent. */
data class HealthAssistant(
    val name: String? = null,
    val device: DeviceKind? = null,
    val wakePhrase: String? = null,
    val accentHex: String? = null,
    /** One of the relay's device presets (motorcycle-helmet ... wearable); wire value, unvalidated. */
    val deviceProfile: String? = null,
    val deviceLabel: String? = null,
    /** Design template id the owner chose (visor, daylight, beacon, ember, holo). */
    val template: String? = null,
    /** False when the owner pinned the template (and the voice display). */
    val templateSwitching: Boolean = true,
    /** Owner token overrides (string values only); the client applies accent and radius-* . */
    val theme: Map<String, String> = emptyMap(),
    /** Owner's voice display style id. */
    val visualizer: String? = null,
    /** A path on the relay (e.g. "/brand/logo?v=abc"); never an absolute URL. */
    val logoUrl: String? = null
)

data class HealthInfo(val assistant: HealthAssistant?, val voice: VoiceBackends?)

/** Lenient parse of the relay /health JSON; unknown or malformed parts are dropped. */
fun parseHealth(body: String): HealthInfo? {
    val root = runCatching { JSONObject(body) }.getOrNull() ?: return null
    val assistant = root.optJSONObject("assistant")?.let { a ->
        HealthAssistant(
            name = a.optString("name").trim().take(24).ifEmpty { null },
            device = DeviceKind.fromWire(a.optString("device")),
            wakePhrase = a.optString("wakePhrase").trim().take(40).ifEmpty { null },
            accentHex = a.optString("accentColor").trim().ifEmpty { null },
            deviceProfile = a.optString("deviceProfile").trim().lowercase().take(40).ifEmpty { null },
            deviceLabel = a.optString("deviceLabel").trim().take(40).ifEmpty { null },
            template = a.optString("template").trim().lowercase().take(40).ifEmpty { null },
            templateSwitching = a.optBoolean("templateSwitching", true),
            theme = parseThemeMap(a.optJSONObject("theme")),
            visualizer = a.optString("visualizer").trim().lowercase().take(40).ifEmpty { null },
            logoUrl = safeLogoPath(a.optString("logoUrl"))
        )
    }
    val voice = root.optJSONObject("voice")?.let { v ->
        val active = v.optString("active")
        val array = v.optJSONArray("providers")
        val providers = buildList {
            if (array != null) for (i in 0 until array.length()) {
                val p = array.optJSONObject(i) ?: continue
                val id = p.optString("id")
                if (id.isEmpty()) continue
                add(
                    VoiceProviderInfo(
                        id = id,
                        label = p.optString("label").ifEmpty { id },
                        kind = p.optString("kind"),
                        configured = p.optBoolean("configured", false),
                        description = p.optString("description").takeIf { it.isNotEmpty() }
                    )
                )
            }
        }
        VoiceBackends(active = active, switching = v.optBoolean("switching", false), providers = providers)
    }
    return HealthInfo(assistant, voice)
}

private fun parseThemeMap(obj: JSONObject?): Map<String, String> {
    if (obj == null) return emptyMap()
    return buildMap {
        obj.keys().forEach { key -> (obj.opt(key) as? String)?.let { if (key.length <= 40 && it.length <= 48) put(key, it) } }
    }
}

/** Only a path on the relay's own origin is ever fetched ("/brand/logo?v=1"); anything else is dropped. */
internal fun safeLogoPath(value: String?): String? {
    val path = value?.trim() ?: return null
    if (path.isEmpty() || path.length > 200 || !path.startsWith("/") || path.startsWith("//") || path.contains("\\") || path.any { it.isWhitespace() }) return null
    return path
}
