package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import java.io.File

/**
 * A class that manages SharedPreferences based on the app version.
 * Externally, only getItem(key) and setItem(key, value) can be used.
 * It constructs the prefs filename based on the app version passed in the constructor,
 * and deletes previous files that don't match the current version during initialization.
 */
class HotUpdaterPrefs(
    private val context: Context,
    private val appVersion: String,
) {
    private val prefs: SharedPreferences

    init {
        val prefsName = "HotUpdaterPrefs_$appVersion"

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

    fun getItem(key: String): String? = prefs.getString(key, null)

    fun setItem(
        key: String,
        value: String?,
    ) {
        prefs.edit().putString(key, value).apply()
    }

    fun removeItem(key: String) {
        prefs.edit().remove(key).apply()
    }
}
