package com.hotupdater

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
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
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val mReactApplicationContext: ReactApplicationContext = context
    private val cohortService = CohortService(context)

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

    private fun parseChangedAssets(params: ReadableMap): Map<String, ChangedAssetDescriptor>? {
        if (!params.hasKey("changedAssets") || params.isNull("changedAssets")) {
            return null
        }

        val changedAssetsMap = params.getMap("changedAssets") ?: return null
        val parsedAssets = linkedMapOf<String, ChangedAssetDescriptor>()
        val iterator = changedAssetsMap.keySetIterator()

        while (iterator.hasNextKey()) {
            val assetPath = iterator.nextKey()
            val assetMap = changedAssetsMap.getMap(assetPath) ?: continue
            val assetUrl = assetMap.getString("fileUrl") ?: continue
            val assetHash = assetMap.getString("fileHash") ?: continue
            parsedAssets[assetPath] = ChangedAssetDescriptor(assetUrl, assetHash)
        }

        return parsedAssets
    }

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
                val manifestUrl = params.getString("manifestUrl")
                val manifestFileHash = params.getString("manifestFileHash")
                val changedAssets = parseChangedAssets(params)
                val channel = params.getString("channel")

                val impl = getInstance()

                impl.updateBundle(
                    bundleId,
                    fileUrl,
                    fileHash,
                    manifestUrl,
                    manifestFileHash,
                    changedAssets,
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
        constants["CHANNEL"] = getInstance().getChannel()
        constants["DEFAULT_CHANNEL"] = getInstance().getDefaultChannel()
        constants["FINGERPRINT_HASH"] = HotUpdater.getFingerprintHash(mReactApplicationContext)
        return constants
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun notifyAppReady(): WritableNativeMap = getInstance().notifyAppReady().toWritableNativeMap()

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun getCrashHistory(): WritableNativeArray = getInstance().getCrashHistory().toWritableNativeArray()

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

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun getBundleId(): String? {
        val impl = getInstance()
        return impl.getBundleId()
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun getManifest(): WritableNativeMap = getInstance().getManifest().toWritableNativeMap()

    @ReactMethod
    override fun setCohort(cohort: String) {
        cohortService.setCohort(cohort)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun getCohort(): String = cohortService.getCohort()

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
