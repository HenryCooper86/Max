package io.github.henrycooper86.max.ui

import android.content.SharedPreferences

/**
 * Interface-only choices live in their own file because backups may copy it
 * (res/xml/backup_rules.xml); the main "max_helmet" file also holds ride
 * transcripts and account data, which must never leave the phone.
 */
const val UI_PREFS = "max_ui"
internal const val KEY_LANGUAGE = "ui_language"
internal const val KEY_WEARER_TEMPLATE = "wearer_template"
internal const val KEY_WEARER_VISUALIZER = "wearer_visualizer"
private val UI_KEYS = listOf(KEY_LANGUAGE, KEY_WEARER_TEMPLATE, KEY_WEARER_VISUALIZER)

/** Moves choices saved by older versions out of the rider-data file, once. */
fun migrateUiPreferences(legacy: SharedPreferences, ui: SharedPreferences) {
    val moving = UI_KEYS.filter { legacy.contains(it) }
    if (moving.isEmpty()) return
    val target = ui.edit()
    moving.forEach { key ->
        // A value already in the new file is newer than any copy left behind.
        if (!ui.contains(key)) legacy.getString(key, null)?.let { target.putString(key, it) }
    }
    target.apply()
    legacy.edit().apply { moving.forEach { remove(it) } }.apply()
}
