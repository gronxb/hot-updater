package com.hotupdater

import android.app.Activity
import android.content.Context
import android.content.Intent

enum class ReloadMethod(
    val value: String,
) {
    REACT_RELOAD("reactReload"),
    PROCESS_RESTART("processRestart"),
    ;

    companion object {
        fun fromValue(value: String): ReloadMethod? = entries.firstOrNull { it.value.equals(value, ignoreCase = true) }
    }
}

fun interface RestartIntentProvider {
    fun createIntent(
        context: Context,
        currentActivity: Activity,
    ): Intent?
}

object ReloadMethodHolder {
    @Volatile
    private var reloadMethod: ReloadMethod = ReloadMethod.REACT_RELOAD

    @Volatile
    private var restartIntentProvider: RestartIntentProvider? = null

    fun setReloadMethod(methodValue: String) {
        setReloadMethod(methodValue, null)
    }

    fun setReloadMethod(
        methodValue: String,
        provider: RestartIntentProvider?,
    ) {
        val method =
            ReloadMethod.fromValue(methodValue)
                ?: throw IllegalArgumentException(
                    "Unsupported reload method: $methodValue. Supported values: reactReload, processRestart",
                )

        if (method != ReloadMethod.PROCESS_RESTART && provider != null) {
            throw IllegalArgumentException(
                "RestartIntentProvider can only be used with processRestart",
            )
        }

        synchronized(this) {
            reloadMethod = method
            restartIntentProvider = if (method == ReloadMethod.PROCESS_RESTART) provider else null
        }
    }

    fun getReloadMethod(): ReloadMethod = reloadMethod

    fun getRestartIntentProvider(): RestartIntentProvider? = restartIntentProvider
}
