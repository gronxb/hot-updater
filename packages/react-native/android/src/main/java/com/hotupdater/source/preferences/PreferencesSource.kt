package com.hotupdater.source.preferences

import android.content.Context

interface PreferencesSource {
    fun setBundleURL(
        context: Context,
        bundleURL: String?,
    )

    fun getBundleURL(context: Context): String?

    fun getAppVersion(context: Context): String?
}
