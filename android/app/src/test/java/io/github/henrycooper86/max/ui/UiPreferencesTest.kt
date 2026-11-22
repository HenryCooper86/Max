package io.github.henrycooper86.max.ui

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** In-memory SharedPreferences: the unit-test android.jar only has throwing stubs. */
internal class MemoryPreferences(initial: Map<String, Any?> = emptyMap()) : SharedPreferences {
    val values = initial.toMutableMap()
    override fun getAll(): Map<String, *> = values.toMap()
    override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String, defValues: Set<String>?): Set<String>? = values[key] as? Set<String> ?: defValues
    override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
    override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    override fun contains(key: String): Boolean = key in values
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val puts = mutableMapOf<String, Any?>()
        private val removes = mutableSetOf<String>()
        private var clear = false
        override fun putString(key: String, value: String?) = apply { puts[key] = value }
        override fun putStringSet(key: String, values: Set<String>?) = apply { puts[key] = values }
        override fun putInt(key: String, value: Int) = apply { puts[key] = value }
        override fun putLong(key: String, value: Long) = apply { puts[key] = value }
        override fun putFloat(key: String, value: Float) = apply { puts[key] = value }
        override fun putBoolean(key: String, value: Boolean) = apply { puts[key] = value }
        override fun remove(key: String) = apply { removes += key }
        override fun clear() = apply { clear = true }
        override fun commit(): Boolean { apply(); return true }
        override fun apply() {
            if (clear) values.clear()
            removes.forEach { values.remove(it) }
            puts.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
        }
    }
}

class UiPreferencesTest {
    @Test
    fun `interface choices move out of the rider-data file`() {
        val legacy = MemoryPreferences(mapOf(
            "ui_language" to "en", "wearer_template" to "ember", "wearer_visualizer" to "bars",
            "transcript_log_v2_abc" to "[]", "relay_url" to "wss://relay.example.com/agent"
        ))
        val ui = MemoryPreferences()

        migrateUiPreferences(legacy, ui)

        assertEquals(mapOf("ui_language" to "en", "wearer_template" to "ember", "wearer_visualizer" to "bars"), ui.values)
        assertEquals(setOf("transcript_log_v2_abc", "relay_url"), legacy.values.keys)
    }

    @Test
    fun `a choice already in the new file is never overwritten by a stale copy`() {
        val legacy = MemoryPreferences(mapOf("ui_language" to "zh"))
        val ui = MemoryPreferences(mapOf("ui_language" to "en"))

        migrateUiPreferences(legacy, ui)

        assertEquals("en", ui.getString("ui_language", null))
        assertFalse(legacy.contains("ui_language"))
    }

    @Test
    fun `nothing to move leaves both files alone`() {
        val legacy = MemoryPreferences(mapOf("relay_url" to "ws://10.0.2.2:8787/agent"))
        val ui = MemoryPreferences()

        migrateUiPreferences(legacy, ui)

        assertEquals(1, legacy.values.size)
        assertNull(ui.getString("ui_language", null))
    }
}
