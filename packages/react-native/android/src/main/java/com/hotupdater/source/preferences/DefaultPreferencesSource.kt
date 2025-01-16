package com.hotupdater.source.preferences

import android.content.Context
import androidx.core.content.edit

private const val PREFS_NAME = "HotUpdaterPrefs"
private const val KEY_BUNDLE_URL = "HotUpdaterBundleURL"

class DefaultPreferencesSource : PreferencesSource {
    override fun setBundleURL(
        context: Context,
        bundleURL: String?
    ) {
        val sharedPreferences = context.getSharedPreferences(
            PREFS_NAME,
            Context.MODE_PRIVATE
        )
        sharedPreferences.edit {
            putString(
                KEY_BUNDLE_URL,
                bundleURL
            )
        }
    }

    override fun getBundleURL(context: Context): String? {
        val sharedPreferences = context.getSharedPreferences(
            PREFS_NAME,
            Context.MODE_PRIVATE
        )
        return sharedPreferences.getString(
            KEY_BUNDLE_URL,
            null
        )
    }

    override fun getAppVersion(context: Context): String? {
        return try {
            val packageInfo = context.packageManager.getPackageInfo(
                context.packageName,
                0
            )
            packageInfo.versionName
        } catch (e: Exception) {
            null
        }
    }
}