package com.hotupdater

import android.util.Log
import com.facebook.react.ReactHost

/**
 * Extension function for HotUpdater to support brownfield apps.
 * Sets the ReactHost for brownfield apps that don't have ReactApplication.
 * When set, reload() will use this ReactHost instead of accessing Application.
 *
 * Usage:
 * ```kotlin
 * HotUpdater.setReactHost(reactHost)
 * ```
 *
 * @param reactHost The ReactHost instance (must not be null)
 */
@JvmName("setReactHostExt")
fun HotUpdater.Companion.setReactHost(reactHost: ReactHost?) {
    if (reactHost == null) {
        Log.w("HotUpdater", "Attempting to set null ReactHost, ignoring")
        return
    }
    ReactHostHolder.setReactHost(reactHost)
}

/**
 * Clears the ReactHost instance.
 */
fun HotUpdater.Companion.clearReactHost() {
    ReactHostHolder.clear()
}
