package com.hotupdater.lynx.sparkling

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import org.json.JSONObject

/** String launch properties exposed to the managed Lynx application. */
object HotUpdaterSparklingLaunchConfiguration {
    const val EXTRA = "hotUpdaterLaunchConfiguration"

    fun from(context: Context): Map<String, String> {
        val encoded = context.activity()?.intent?.getStringExtra(EXTRA)
            ?: return emptyMap()
        return parse(encoded)
    }

    private tailrec fun Context.activity(): Activity? = when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.activity()
        else -> null
    }

    internal fun parse(encoded: String): Map<String, String> {
        val objectValue = JSONObject(encoded)
        return objectValue.keys().asSequence().associateWith { key ->
            require(key.isNotEmpty() && objectValue.get(key) is String) {
                "Lynx launch configuration must be a JSON string map"
            }
            objectValue.getString(key)
        }
    }
}
