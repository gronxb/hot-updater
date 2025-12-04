package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReadableMap

abstract class HotUpdaterSpec internal constructor(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    abstract fun updateBundle(
        params: ReadableMap,
        promise: Promise,
    )

    abstract fun reload(promise: Promise)

    abstract fun notifyAppReady(params: ReadableMap): ReadableMap

    abstract fun getCrashHistory(): String

    abstract fun clearCrashHistory(): Boolean
}
