package com.hotupdater

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.launch

class HotUpdaterModule internal constructor(
    reactContext: ReactApplicationContext,
) : HotUpdaterSpec(reactContext) {
    private val mReactApplicationContext: ReactApplicationContext = reactContext

    override fun getName(): String = NAME

    override fun reload(promise: Promise) {
        CoroutineScope(Dispatchers.Main.immediate).launch {
            try {
                HotUpdater.reload(mReactApplicationContext)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to reload", e)
                promise.reject("reload", e)
            }
        }
    }

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

    override fun getTypedExportedConstants(): Map<String, Any?> {
        val constants: MutableMap<String, Any?> = HashMap()
        constants["MIN_BUNDLE_ID"] = HotUpdater.getMinBundleId(mReactApplicationContext)
        constants["APP_VERSION"] = HotUpdater.getAppVersion(mReactApplicationContext)
        constants["CHANNEL"] = HotUpdater.getChannel(mReactApplicationContext)
        constants["FINGERPRINT_HASH"] = HotUpdater.getFingerprintHash(mReactApplicationContext)
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
