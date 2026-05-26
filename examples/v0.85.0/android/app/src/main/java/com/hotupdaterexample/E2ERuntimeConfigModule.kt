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
        val value =
            reactApplicationContext
                .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .getString(APP_BASE_URL_KEY, null)
                ?.trim()

        return if (value.isNullOrEmpty()) null else value
    }

    companion object {
        private const val PREFERENCES_NAME = "HotUpdaterE2E"
        private const val APP_BASE_URL_KEY = "HOT_UPDATER_E2E_APP_BASE_URL"
    }
}
