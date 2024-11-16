package com.hotupdater

import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod

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
    override fun getAppVersion(callback: Callback) {
        callback.invoke(HotUpdater.getAppVersion())
    }

    @ReactMethod
    override fun updateBundle(
        prefix: String,
        url: String?,
        callback: Callback,
    ) {
        val result = HotUpdater.updateBundle(prefix, url)
        callback.invoke(result)
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
