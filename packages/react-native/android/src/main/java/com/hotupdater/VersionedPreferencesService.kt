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
    private val isolationKey: String,
    // The family of isolation keys this service replaces: main's, or one named instance's.
    private val familyPrefix: String = "HotUpdaterPrefs_",
) : PreferencesService {
    companion object {
        /**
         * Deletes the preferences of every other isolation key in [familyPrefix]'s
         * family, the app version or channel this instance left behind. Files of
         * other families belong to other instances and stay.
         */
        internal fun deleteStalePreferences(
            sharedPrefsDir: File,
            familyPrefix: String,
            isolationKey: String,
        ) {
            if (sharedPrefsDir.exists() && sharedPrefsDir.isDirectory) {
                sharedPrefsDir.listFiles()?.forEach { file ->
                    if (file.name.startsWith(familyPrefix) && file.name != "$isolationKey.xml") {
                        file.delete()
                    }
                }
            }
        }
    }

    private val prefs: SharedPreferences

    init {
        deleteStalePreferences(File(context.applicationInfo.dataDir, "shared_prefs"), familyPrefix, isolationKey)

        prefs = context.getSharedPreferences(isolationKey, Context.MODE_PRIVATE)
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
