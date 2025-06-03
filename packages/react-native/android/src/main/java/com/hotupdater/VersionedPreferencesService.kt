package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import java.io.File

/**
 * Interface for preference storage operations
 */
interface PreferencesService {
    /**
     * Gets a stored preference value
     * @param key The key to retrieve
     * @return The stored value or null if not found
     */
    fun getItem(key: String): String?

    /**
     * Sets a preference value
     * @param key The key to store under
     * @param value The value to store (or null to remove)
     */
    fun setItem(
        key: String,
        value: String?,
    )
}

/**
 * Implementation of PreferencesService using SharedPreferences
 * Modified from original HotUpdaterPrefs to follow the service pattern
 */
class VersionedPreferencesService(
    private val context: Context,
    private val appVersion: String,
    private val appChannel: String,
) : PreferencesService {
    private val prefs: SharedPreferences

    init {
        val prefsName = "HotUpdaterPrefs_${appVersion}_${appChannel}"

        val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
        if (sharedPrefsDir.exists() && sharedPrefsDir.isDirectory) {
            sharedPrefsDir.listFiles()?.forEach { file ->
                if (file.name.startsWith("HotUpdaterPrefs_") && file.name != "$prefsName.xml") {
                    file.delete()
                }
            }
        }

        prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
    }

    override fun getItem(key: String): String? = prefs.getString(key, null)

    override fun setItem(
        key: String,
        value: String?,
    ) {
        prefs.edit().apply {
            if (value == null) {
                remove(key)
            } else {
                putString(key, value)
            }
            apply()
        }
    }
}
