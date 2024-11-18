package com.hotupdater

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class HotUpdaterModule internal constructor(
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val mReactApplicationContext: ReactApplicationContext = context

    override fun getName(): String = NAME

    @ReactMethod
    override fun reload() {
        HotUpdater.reload()
    }

    @ReactMethod
    override fun getAppVersion(promise: Promise) {
        promise.resolve(HotUpdater.getAppVersion())
    }

    @ReactMethod
    override fun updateBundle(
        bundleId: String,
        zipUrl: String,
        promise: Promise,
    ) {
        val result = HotUpdater.updateBundle(bundleId, zipUrl)
        promise.resolve(result)
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
