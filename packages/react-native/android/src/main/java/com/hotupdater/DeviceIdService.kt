package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import java.util.UUID

class DeviceIdService(private val context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("HotUpdaterDeviceId", Context.MODE_PRIVATE)

    companion object {
        private const val CUSTOM_USER_ID_KEY = "custom_user_id"
        private const val FALLBACK_USER_ID_KEY = "fallback_user_id"
    }

    fun setUserId(customId: String) {
        if (customId.isEmpty()) {
            prefs.edit().remove(CUSTOM_USER_ID_KEY).apply()
            return
        }
        prefs.edit().putString(CUSTOM_USER_ID_KEY, customId).apply()
    }

    fun getUserId(): String {
        val customId = prefs.getString(CUSTOM_USER_ID_KEY, null)
        if (!customId.isNullOrEmpty()) {
            return customId
        }

        val androidId =
            Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ANDROID_ID,
            )
        if (!androidId.isNullOrEmpty()) {
            return androidId
        }

        val fallback = prefs.getString(FALLBACK_USER_ID_KEY, null)
        if (!fallback.isNullOrEmpty()) {
            return fallback
        }

        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(FALLBACK_USER_ID_KEY, generated).apply()
        return generated
    }
}

