package com.hotupdaterexample

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class E2ERuntimeConfigModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "E2ERuntimeConfig"

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getAppBaseUrl(): String? {
        return getString(APP_BASE_URL_KEY)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getChannelNamespace(): String? {
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
        private const val PREFERENCES_NAME = "HotUpdaterE2E"
        private const val APP_BASE_URL_KEY = "HOT_UPDATER_E2E_APP_BASE_URL"
        private const val CHANNEL_NAMESPACE_KEY = "HOT_UPDATER_E2E_CHANNEL_NAMESPACE"
    }
}
