package com.hotupdater.source.preferences

import android.content.Context

private const val PREFS_NAME = "HotUpdaterPrefs"
private const val KEY_BUNDLE_URL = "HotUpdaterBundleURL"

class DefaultPreferencesSource : PreferencesSource {
    override fun setBundleURL(
        context: Context,
        bundleURL: String?,
    ) {
        val sharedPreferences =
            context.getSharedPreferences(
                PREFS_NAME,
                Context.MODE_PRIVATE,
            )
        with(sharedPreferences.edit()) {
            putString(
                KEY_BUNDLE_URL,
                bundleURL,
            )
            apply()
        }
    }

    override fun getBundleURL(context: Context): String? {
        val sharedPreferences =
            context.getSharedPreferences(
                PREFS_NAME,
                Context.MODE_PRIVATE,
            )
        return sharedPreferences.getString(
            KEY_BUNDLE_URL,
            null,
        )
    }

    override fun getAppVersion(context: Context): String? =
        try {
            val packageInfo =
                context.packageManager.getPackageInfo(
                    context.packageName,
                    0,
                )
            packageInfo.versionName
        } catch (e: Exception) {
            null
        }
}
