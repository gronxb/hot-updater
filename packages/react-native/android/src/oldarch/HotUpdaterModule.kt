package com.hotupdater

import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.launch

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
    override fun setChannel(
        channel: String,
        promise: Promise,
    ) {
        HotUpdater.setChannel(mReactApplicationContext, channel)
        promise.resolve(null)
    }

    @ReactMethod
    override fun updateBundle(
        bundleData: ReadableMap,
        promise: Promise,
    ) {
        // Use lifecycleScope when currentActivity is FragmentActivity
        (currentActivity as? FragmentActivity)?.lifecycleScope?.launch {
            try {
                val bundleId = bundleData.getString("bundleId")!!
                val fileUrl = bundleData.getString("fileUrl")

                val isSuccess =
                    HotUpdater.updateBundle(
                        mReactApplicationContext,
                        bundleId,
                        fileUrl,
                    ) { progress ->
                        val params =
                            WritableNativeMap().apply {
                                putDouble("progress", progress)
                            }

                        this@HotUpdaterModule
                            .mReactApplicationContext
                            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("onProgress", params)
                    }
                promise.resolve(isSuccess)
            } catch (e: Exception) {
                promise.reject("updateBundle", e)
            }
        }
    }

    @ReactMethod
    fun addListener(
        @Suppress("UNUSED_PARAMETER") eventName: String?,
    ) {
        // No-op
    }

    @ReactMethod
    fun removeListeners(
        @Suppress("UNUSED_PARAMETER") count: Double,
    ) {
        // No-op
    }

    override fun getConstants(): Map<String, Any?> {
        val constants: MutableMap<String, Any?> = HashMap()
        constants["MIN_BUNDLE_ID"] = HotUpdater.getMinBundleId(mReactApplicationContext)
        constants["APP_VERSION"] = HotUpdater.getAppVersion(mReactApplicationContext)
        constants["CHANNEL"] = HotUpdater.getChannel(mReactApplicationContext)
        return constants
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
