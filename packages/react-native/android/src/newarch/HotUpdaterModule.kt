package com.hotupdater

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class HotUpdaterModule internal constructor(
    reactContext: ReactApplicationContext,
) : HotUpdaterSpec(reactContext) {
    private val mReactApplicationContext: ReactApplicationContext = reactContext

    // Managed coroutine scope for the module lifecycle
    private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun getName(): String = NAME

    override fun invalidate() {
        super.invalidate()
        // Cancel all ongoing coroutines when module is destroyed
        moduleScope.cancel()
    }

    /**
     * Gets the singleton HotUpdaterImpl instance
     */
    private fun getInstance(): HotUpdaterImpl = HotUpdater.getInstance(mReactApplicationContext)

    override fun reload(promise: Promise) {
        moduleScope.launch {
            try {
                val impl = getInstance()
                impl.reload(mReactApplicationContext)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to reload", e)
                promise.reject("reload", e)
            }
        }
    }

    override fun reloadProcess(promise: Promise) {
        moduleScope.launch {
            try {
                val impl = getInstance()
                impl.reloadProcess(mReactApplicationContext)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to restart process", e)
                promise.reject("reloadProcess", e)
            }
        }
    }

    override fun updateBundle(
        params: ReadableMap,
        promise: Promise,
    ) {
        moduleScope.launch {
            try {
                val bundleId = params.getString("bundleId")
                if (bundleId == null || bundleId.isEmpty()) {
                    promise.reject("MISSING_BUNDLE_ID", "Missing or empty 'bundleId'")
                    return@launch
                }

                val fileUrl = params.getString("fileUrl")

                // Validate fileUrl format if provided
                if (fileUrl != null && fileUrl.isNotEmpty()) {
                    try {
                        java.net.URL(fileUrl)
                    } catch (e: java.net.MalformedURLException) {
                        promise.reject("INVALID_FILE_URL", "Invalid 'fileUrl' provided: $fileUrl")
                        return@launch
                    }
                }

                val fileHash = params.getString("fileHash")
                val channel = params.getString("channel")

                val impl = getInstance()

                impl.updateBundle(
                    bundleId,
                    fileUrl,
                    fileHash,
                    channel,
                ) { progress ->
                    // Post to Main thread for React Native event emission
                    Handler(Looper.getMainLooper()).post {
                        try {
                            val progressParams =
                                WritableNativeMap().apply {
                                    putDouble("progress", progress)
                                }

                            this@HotUpdaterModule
                                .mReactApplicationContext
                                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                ?.emit("onProgress", progressParams)
                        } catch (e: Exception) {
                            Log.w("HotUpdater", "Failed to emit progress (bridge may be unavailable): ${e.message}")
                        }
                    }
                }
                promise.resolve(true)
            } catch (e: HotUpdaterException) {
                promise.reject(e.code, e.message)
            } catch (e: Exception) {
                promise.reject("UNKNOWN_ERROR", e.message ?: "An unknown error occurred")
            }
        }
    }

    override fun getTypedExportedConstants(): Map<String, Any?> {
        val constants: MutableMap<String, Any?> = HashMap()
        constants["MIN_BUNDLE_ID"] = HotUpdater.getMinBundleId()
        constants["APP_VERSION"] = HotUpdater.getAppVersion(mReactApplicationContext)
        constants["CHANNEL"] = getInstance().getChannel()
        constants["DEFAULT_CHANNEL"] = getInstance().getDefaultChannel()
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

    override fun notifyAppReady(): WritableNativeMap = getInstance().notifyAppReady().toWritableNativeMap()

    override fun getCrashHistory(): WritableNativeArray = getInstance().getCrashHistory().toWritableNativeArray()

    override fun clearCrashHistory(): Boolean {
        val impl = getInstance()
        return impl.clearCrashHistory()
    }

    override fun getBaseURL(): String {
        val impl = getInstance()
        return impl.getBaseURL()
    }

    override fun getBundleId(): String? {
        val impl = getInstance()
        return impl.getBundleId()
    }

    override fun getManifest(): WritableNativeMap = getInstance().getManifest().toWritableNativeMap()

    override fun resetChannel(promise: Promise) {
        moduleScope.launch {
            try {
                val impl = getInstance()
                val success = impl.resetChannel()
                promise.resolve(success)
            } catch (e: HotUpdaterException) {
                promise.reject(e.code, e.message)
            } catch (e: Exception) {
                promise.reject("UNKNOWN_ERROR", e.message ?: "Failed to reset channel")
            }
        }
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
