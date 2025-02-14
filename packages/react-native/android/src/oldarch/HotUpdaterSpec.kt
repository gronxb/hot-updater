package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

abstract class HotUpdaterSpec internal constructor(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    abstract fun updateBundle(
        bundleId: String,
        zipUrl: String?,
        promise: Promise,
    )

    abstract fun reload()

    abstract fun getAppVersion(promise: Promise)
}
