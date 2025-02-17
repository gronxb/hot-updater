package com.hotupdater

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class HotUpdaterModule internal constructor(
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val mReactApplicationContext: ReactApplicationContext = context

    override fun getName(): String = NAME

    private val coroutineScope = CoroutineScope(Dispatchers.IO)  // Define a scope for coroutines

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
        zipUrl: String?,
        promise: Promise
    ) {
        coroutineScope.launch {
            try {
                var lastUpdateTime = 0L  // Track last update time to throttle emissions

                val isSuccess = HotUpdater.updateBundle(mReactApplicationContext, bundleId, zipUrl) { progress ->
                    val currentTime = System.currentTimeMillis()
                    if (currentTime - lastUpdateTime >= 100) {  // Throttle updates to every 100ms
                        lastUpdateTime = currentTime

                        val params = WritableNativeMap().apply {
                            putDouble("progress", progress)
                        }

                        // Ensure UI updates on the main thread
                        launch(Dispatchers.Main) {
                            mReactApplicationContext
                                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("onProgress", params)
                        }
                    }
                }

                // Resolve the promise on the main thread
                launch(Dispatchers.Main) {
                    promise.resolve(isSuccess)
                }
            } catch (e: Exception) {
                // Reject the promise with an error
                launch(Dispatchers.Main) {
                    promise.reject("UPDATE_BUNDLE_ERROR", e.message ?: "Unknown error")
                }
            }
        }
    }


    companion object {
        const val NAME = "HotUpdater"
    }
}
