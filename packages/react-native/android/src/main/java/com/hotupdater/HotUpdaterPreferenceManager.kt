package com.hotupdater

import android.content.Context
import android.content.SharedPreferences

class HotUpdaterPreferenceManager(
    context: Context,
    appVersion: String,
) {
    private val prefsName = "HotUpdaterPrefs_$appVersion"
    private val prefs: SharedPreferences = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    fun setItem(
        key: String,
        value: String?,
    ) {
        prefs.edit().putString(key, value).apply()
    }

    fun getItem(key: String): String? = prefs.getString(key, null)

    companion object {
        const val KEY_BUNDLE_URL = "HotUpdaterBundleURL"
        const val KEY_CHANNEL = "HotUpdaterChannel"

        @Volatile
        private var instance: HotUpdaterPreferenceManager? = null

        @Volatile
        private var cachedAppVersion: String? = null

        fun getInstance(context: Context): HotUpdaterPreferenceManager {
            val appContext = context.applicationContext
            val currentAppVersion = HotUpdaterUtils.getAppVersion(appContext) ?: "unknown"
            synchronized(this) {
                if (instance == null || cachedAppVersion != currentAppVersion) {
                    instance = HotUpdaterPreferenceManager(appContext, currentAppVersion)
                    cachedAppVersion = currentAppVersion
                }
                return instance!!
            }
        }
    }
}
