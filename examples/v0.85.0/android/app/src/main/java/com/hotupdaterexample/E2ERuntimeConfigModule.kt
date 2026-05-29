package com.hotupdaterexample

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext

class E2ERuntimeConfigModule(
    reactContext: ReactApplicationContext,
) : NativeE2ERuntimeConfigSpec(reactContext) {
    override fun getName(): String = NAME

    override fun getAppBaseUrl(): String? {
        return getString(APP_BASE_URL_KEY)
    }

    override fun getChannelNamespace(): String? {
        return getString(CHANNEL_NAMESPACE_KEY)
    }

    private fun getString(key: String): String? {
        val value =
            reactApplicationContext
                .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .getString(key, null)
                ?.trim()

        return if (value.isNullOrEmpty()) null else value
    }

    companion object {
        const val NAME = "E2ERuntimeConfig"
        private const val PREFERENCES_NAME = "HotUpdaterE2E"
        private const val APP_BASE_URL_KEY = "HOT_UPDATER_E2E_APP_BASE_URL"
        private const val CHANNEL_NAMESPACE_KEY = "HOT_UPDATER_E2E_CHANNEL_NAMESPACE"
    }
}
