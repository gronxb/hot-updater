package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import java.util.UUID

class CohortService(
    private val context: Context,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("HotUpdaterCohort", Context.MODE_PRIVATE)

    companion object {
        private const val CUSTOM_COHORT_KEY = "custom_cohort"
        private const val FALLBACK_IDENTIFIER_KEY = "fallback_identifier"
        private const val CLEAR_OVERRIDE_SENTINEL = "__hot_updater_clear__"
    }

    private fun hashString(value: String): Int {
        var hash = 0
        for (char in value) {
            hash = (hash shl 5) - hash + char.code
        }
        return hash
    }

    private fun defaultNumericCohort(identifier: String): String {
        val hash = hashString(identifier)
        val normalized = ((hash % 1000) + 1000) % 1000
        return (normalized + 1).toString()
    }

    private fun fallbackIdentifier(): String {
        val fallback = prefs.getString(FALLBACK_IDENTIFIER_KEY, null)
        if (!fallback.isNullOrEmpty()) {
            return fallback
        }

        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(FALLBACK_IDENTIFIER_KEY, generated).apply()
        return generated
    }

    fun setCohort(cohort: String) {
        if (cohort.isEmpty() || cohort == CLEAR_OVERRIDE_SENTINEL) {
            prefs.edit().remove(CUSTOM_COHORT_KEY).apply()
            return
        }
        prefs.edit().putString(CUSTOM_COHORT_KEY, cohort).apply()
    }

    fun getCohort(): String {
        val cohort = prefs.getString(CUSTOM_COHORT_KEY, null)
        if (!cohort.isNullOrEmpty()) {
            return cohort
        }

        val androidId =
            Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ANDROID_ID,
            )
        if (!androidId.isNullOrEmpty()) {
            return defaultNumericCohort(androidId)
        }

        return defaultNumericCohort(fallbackIdentifier())
    }
}
