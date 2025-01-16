package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class HotUpdaterModule internal constructor(
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val mReactApplicationContext: ReactApplicationContext = context

    override fun getName(): String = NAME

    @ReactMethod
    override fun reload() {
        HotUpdater.reload(mReactApplicationContext)
    }

    @ReactMethod
    override fun getAppVersion(promise: Promise) {
        promise.resolve(HotUpdater.getAppVersion(mReactApplicationContext))
    }

    @ReactMethod
    override fun updateBundle(
        bundleId: String,
        zipUrl: String,
        promise: Promise,
    ) {
        val isSuccess =
            HotUpdater.updateBundle(mReactApplicationContext, bundleId, zipUrl) { progress ->
                val params =
                    WritableNativeMap().apply {
                        putDouble("progress", progress)
                    }

                this.mReactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onProgress", params)
            }
        promise.resolve(isSuccess)
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
