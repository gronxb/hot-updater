package com.hotupdater

import android.util.Log
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class HotUpdaterModule internal constructor(
    reactContext: ReactApplicationContext,
) : HotUpdaterSpec(reactContext) {
    private val mReactApplicationContext: ReactApplicationContext = reactContext

    override fun getName(): String = NAME

    /**
     * Resolves HotUpdaterImpl instance based on identifier
     * @param identifier Optional identifier to look up in registry (null = use singleton)
     * @param promise Promise to reject if instance not found
     * @return HotUpdaterImpl instance or null if not found (promise will be rejected)
     */
    private fun resolveHotUpdaterInstance(
        identifier: String?,
        promise: Promise,
    ): HotUpdaterImpl? {
        val impl =
            if (identifier != null) {
                HotUpdaterRegistry.get(identifier)
            } else {
                HotUpdater.getInstance(mReactApplicationContext)
            }

        if (impl == null) {
            val message =
                if (identifier != null) {
                    "HotUpdater instance with identifier '$identifier' not found. Make sure to create the instance first."
                } else {
                    "HotUpdater instance not found. Make sure to call getJSBundleFile first."
                }
            promise.reject("INSTANCE_NOT_FOUND", message)
        }

        return impl
    }

    override fun reload(promise: Promise) {
        CoroutineScope(Dispatchers.Main.immediate).launch {
            try {
                // Get the identifier used by getJSBundleFile
                val identifier = HotUpdaterRegistry.getDefaultIdentifier()
                val impl = resolveHotUpdaterInstance(identifier, promise) ?: return@launch

                val currentActivity = mReactApplicationContext.currentActivity
                impl.reload(currentActivity)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to reload", e)
                promise.reject("reload", e)
            }
        }
    }

    override fun updateBundle(
        params: ReadableMap?,
        promise: Promise,
    ) {
        (mReactApplicationContext.currentActivity as FragmentActivity?)?.lifecycleScope?.launch {
            try {
                // Parameter validation
                if (params == null) {
                    promise.reject("UNKNOWN_ERROR", "Missing or invalid parameters for updateBundle")
                    return@launch
                }

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
                val identifier = params.getString("identifier")

                val impl = resolveHotUpdaterInstance(identifier, promise) ?: return@launch

                impl.updateBundle(
                    bundleId,
                    fileUrl,
                    fileHash,
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

    companion object {
        const val NAME = "HotUpdater"
    }
}
