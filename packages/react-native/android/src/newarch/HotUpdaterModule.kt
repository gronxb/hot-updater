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

    private fun parseIncrementalRequest(params: ReadableMap): IncrementalUpdateRequest {
        val bundleId = params.getString("bundleId")
        val baseBundleId = params.getString("baseBundleId")
        val contentBaseUrl = params.getString("contentBaseUrl")
        val jsBundlePath = params.getString("jsBundlePath")
        val patchHash = params.getString("patchHash")
        val patchSignedHash = params.getString("patchSignedHash")
        val sourceHash = params.getString("sourceHash")
        val targetHash = params.getString("targetHash")
        val targetSignedHash = params.getString("targetSignedHash")

        if (bundleId.isNullOrBlank()) {
            throw HotUpdaterException.invalidIncrementalRequest("Missing 'bundleId'")
        }
        if (baseBundleId.isNullOrBlank()) {
            throw HotUpdaterException.invalidIncrementalRequest(
                "Missing 'baseBundleId'",
            )
        }
        if (contentBaseUrl.isNullOrBlank()) {
            throw HotUpdaterException.invalidIncrementalRequest(
                "Missing 'contentBaseUrl'",
            )
        }
        if (jsBundlePath.isNullOrBlank()) {
            throw HotUpdaterException.invalidIncrementalRequest(
                "Missing 'jsBundlePath'",
            )
        }
        if (patchHash.isNullOrBlank() || patchSignedHash.isNullOrBlank()) {
            throw HotUpdaterException.invalidIncrementalRequest(
                "Missing patch hash/signature",
            )
        }
        if (
            sourceHash.isNullOrBlank() ||
            targetHash.isNullOrBlank() ||
            targetSignedHash.isNullOrBlank()
        ) {
            throw HotUpdaterException.invalidIncrementalRequest(
                "Missing source/target hash metadata",
            )
        }

        val filesArray = params.getArray("files")
            ?: throw HotUpdaterException.invalidIncrementalRequest("Missing 'files'")

        val files = mutableListOf<IncrementalFileEntry>()
        for (i in 0 until filesArray.size()) {
            val file = filesArray.getMap(i)
                ?: throw HotUpdaterException.invalidIncrementalRequest(
                    "Invalid file entry at index $i",
                )
            val filePath = file.getString("path")
            val fileSize = file.getDouble("size").toLong()
            val fileHash = file.getString("hash")
            val fileSignedHash = file.getString("signedHash")

            if (
                filePath.isNullOrBlank() ||
                fileHash.isNullOrBlank() ||
                fileSignedHash.isNullOrBlank()
            ) {
                throw HotUpdaterException.invalidIncrementalRequest(
                    "Invalid file metadata at index $i",
                )
            }

            files += IncrementalFileEntry(
                path = filePath,
                size = fileSize,
                hash = fileHash,
                signedHash = fileSignedHash,
            )
        }

        return IncrementalUpdateRequest(
            bundleId = bundleId,
            baseBundleId = baseBundleId,
            contentBaseUrl = contentBaseUrl,
            jsBundlePath = jsBundlePath,
            patchHash = patchHash,
            patchSignedHash = patchSignedHash,
            sourceHash = sourceHash,
            targetHash = targetHash,
            targetSignedHash = targetSignedHash,
            files = files,
        )
    }

    override fun updateBundleIncremental(
        params: ReadableMap,
        promise: Promise,
    ) {
        moduleScope.launch {
            try {
                val request = parseIncrementalRequest(params)
                val impl = getInstance()

                impl.updateBundleIncremental(request) { progress ->
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

    override fun notifyAppReady(params: ReadableMap): WritableNativeMap {
        val result = WritableNativeMap()
        val bundleId = params.getString("bundleId")
        if (bundleId == null) {
            result.putString("status", "STABLE")
            return result
        }

        val impl = getInstance()
        val statusMap = impl.notifyAppReady(bundleId)

        result.putString("status", statusMap["status"] as? String ?: "STABLE")
        statusMap["crashedBundleId"]?.let {
            result.putString("crashedBundleId", it as String)
        }

        return result
    }

    override fun getCrashHistory(): WritableNativeArray {
        val impl = getInstance()
        val crashHistory = impl.getCrashHistory()
        val result = WritableNativeArray()
        crashHistory.forEach { result.pushString(it) }
        return result
    }

    override fun clearCrashHistory(): Boolean {
        val impl = getInstance()
        return impl.clearCrashHistory()
    }

    override fun getBaseURL(): String {
        val impl = getInstance()
        return impl.getBaseURL()
    }

    companion object {
        const val NAME = "HotUpdater"
    }
}
