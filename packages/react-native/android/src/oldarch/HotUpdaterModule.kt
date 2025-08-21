package com.hotupdater

import android.util.Log
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
        try {
            HotUpdater.reload(mReactApplicationContext)
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload", e)
        }
    }

    @ReactMethod
    override fun updateBundle(
        params: ReadableMap,
        promise: Promise,
    ) {
        (mReactApplicationContext.currentActivity as FragmentActivity?)?.lifecycleScope?.launch {
            try {
                val bundleId = params.getString("bundleId")!!
                val fileUrl = params.getString("fileUrl")

                val isSuccess =
                    HotUpdater.updateBundle(
                        mReactApplicationContext,
                        bundleId,
                        fileUrl,
                    ) { progress ->
                        val progressParams =
                            WritableNativeMap().apply {
                                putDouble("progress", progress)
                            }

                        this@HotUpdaterModule
                            .mReactApplicationContext
                            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("onProgress", progressParams)
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
        constants["FINGERPRINT_HASH"] = HotUpdater.getFingerprintHash(mReactApplicationContext)
        return constants
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
