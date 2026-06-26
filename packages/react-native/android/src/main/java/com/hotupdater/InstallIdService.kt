package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

class InstallIdService(
    context: Context,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("HotUpdaterInstall", Context.MODE_PRIVATE)

    fun getInstallId(): String {
        val installId = prefs.getString(INSTALL_ID_KEY, null)
        if (!installId.isNullOrEmpty()) {
            return installId
        }

        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(INSTALL_ID_KEY, generated).commit()
        return generated
    }

    private companion object {
        const val INSTALL_ID_KEY = "install_id"
    }
}
