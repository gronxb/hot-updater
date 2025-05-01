package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReadableMap

abstract class HotUpdaterSpec internal constructor(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    abstract fun updateBundle(
        bundleData: ReadableMap,
        promise: Promise,
    )

    abstract fun reload()

    abstract fun getAppVersion(promise: Promise)

    abstract fun setChannel(
        channel: String,
        promise: Promise,
    )
}
