package com.hotupdater

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class HotUpdaterModule internal constructor(
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val mReactApplicationContext: ReactApplicationContext = context

    // Managed coroutine scope for the module lifecycle
    private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun getName(): String = NAME

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        // Cancel all ongoing coroutines when module is destroyed
        moduleScope.cancel()
    }

    /**
     * Gets the singleton HotUpdaterImpl instance
     */
    private fun getInstance(): HotUpdaterImpl = HotUpdater.getInstance(mReactApplicationContext)

    @ReactMethod
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

    @ReactMethod
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

                val impl = getInstance()

                impl.updateBundle(
                    bundleId,
                    fileUrl,
                    fileHash,
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
        constants["MIN_BUNDLE_ID"] = HotUpdater.getMinBundleId()
        constants["APP_VERSION"] = HotUpdater.getAppVersion(mReactApplicationContext)
        constants["CHANNEL"] = HotUpdater.getChannel(mReactApplicationContext)
        constants["FINGERPRINT_HASH"] = HotUpdater.getFingerprintHash(mReactApplicationContext)
        return constants
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun notifyAppReady(params: ReadableMap): String {
        val bundleId = params.getString("bundleId")
        val result = JSONObject()

        if (bundleId == null) {
            result.put("status", "STABLE")
            return result.toString()
        }

        val impl = getInstance()
        val statusMap = impl.notifyAppReady(bundleId)

        result.put("status", statusMap["status"] as? String ?: "STABLE")
        statusMap["crashedBundleId"]?.let {
            result.put("crashedBundleId", it as String)
        }

        return result.toString()
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun getCrashHistory(): String {
        val impl = getInstance()
        val crashHistory = impl.getCrashHistory()
        return JSONArray(crashHistory).toString()
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun clearCrashHistory(): Boolean {
        val impl = getInstance()
        return impl.clearCrashHistory()
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun getBaseURL(): String {
        val impl = getInstance()
        return impl.getBaseURL()
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
