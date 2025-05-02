package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class HotUpdaterModule internal constructor(
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val mReactApplicationContext: ReactApplicationContext = context

    override fun getName(): String = NAME

    @ReactMethod
    override fun reload() {
        val reloader = ReactNativeReloader(mReactApplicationContext)
        reloader.reload()
    }

    @ReactMethod
    override fun getAppVersion(promise: Promise) {
        promise.resolve(HotUpdaterUtils.getAppVersion(mReactApplicationContext))
    }

    @ReactMethod
    override fun setChannel(
        channel: String,
        promise: Promise,
    ) {
        HotUpdaterPreferenceManager.getInstance(mReactApplicationContext).setItem(HotUpdaterPreferenceManager.KEY_CHANNEL, channel)
        promise.resolve(null)
    }

    @ReactMethod
    override fun updateBundle(
        bundleData: ReadableMap,
        promise: Promise,
    ) {
        HotUpdater.updateBundle(
            mReactApplicationContext,
            bundleId,
            zipUrl,
            progressCallback = { progress ->
                val params =
                    WritableNativeMap().apply {
                        putDouble("progress", progress)
                    }

                mReactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    ?.emit("onProgress", params)
                    ?: System.err.println("RCTDeviceEventEmitter is null, cannot emit progress")
            },
            completionCallback = { isSuccess ->
                if (isSuccess) {
                    promise.resolve(true)
                } else {
                    promise.reject("UpdateError", "Failed to update bundle.")
                }
            },
        )
    }

    override fun getTypedExportedConstants(): Map<String, Any?> {
        val constants: MutableMap<String, Any?> = HashMap()
        constants["MIN_BUNDLE_ID"] = HotUpdaterUtils.getMinBundleId()
        constants["APP_VERSION"] = HotUpdaterUtils.getAppVersion(mReactApplicationContext)
        constants["CHANNEL"] =
            HotUpdaterPreferenceManager.getInstance(mReactApplicationContext).getItem(HotUpdaterPreferenceManager.KEY_CHANNEL)
        return constants
    }

    override fun addListener(
        @Suppress("UNUSED_PARAMETER") eventName: String?,
    ) {
        // No-op
    }

    override fun removeListeners(
        @Suppress("UNUSED_PARAMETER") count: Double,
    ) {
        // No-op
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
