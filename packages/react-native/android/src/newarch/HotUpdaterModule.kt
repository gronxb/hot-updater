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
    private val cohortService = CohortService(reactContext)

    // Managed coroutine scope for the module lifecycle
    private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun getName(): String = NAME

    private fun readSafeInteger(
        map: ReadableMap,
        key: String,
    ): Long? {
        if (!map.hasKey(key) || map.isNull(key)) return null
        val value = runCatching { map.getDouble(key) }.getOrNull() ?: return null
        if (!value.isFinite() || value % 1.0 != 0.0) return null
        return value.toLong().takeIf { it in 0..9_007_199_254_740_991L }
    }

    override fun initialize() {
        super.initialize()
        // Each runtime has its own module, so this reaches a named instance's
        // runtime, whose host the app doesn't expose, and main's, whose root
        // views are looked for too; main's errors are left alone.
        registeredInstanceName = HotUpdaterRecoveryManager.registerRuntime(mReactApplicationContext)
    }

    // The named instance whose runtime this module registered; the runtime,
    // whichever instance's, is unregistered when it is torn down.
    private var registeredInstanceName: String? = null

    private fun unregisterRuntime() {
        HotUpdaterRecoveryManager.unregisterRuntime(mReactApplicationContext, registeredInstanceName)
        registeredInstanceName = null
    }

    override fun invalidate() {
        super.invalidate()
        unregisterRuntime()
        // Cancel all ongoing coroutines when module is destroyed
        moduleScope.cancel()
    }

    // The instance whose bundle this module's runtime runs, read from the
    // URL React Native loaded it from.
    private val runtimeInstance = HotUpdaterRuntimeInstance(mReactApplicationContext, { mReactApplicationContext.sourceURL })

    /**
     * The impl of this runtime's instance: main's, or a named instance's
     * when the runtime runs its bundle
     */
    private fun getInstance(): HotUpdaterImpl = runtimeInstance.impl

    /**
     * Every changed file with its hash and URL or Hermes patch; with
     * [requireFileHash] false, also entries that hold only the Hermes patch.
     */
    private fun parseAssets(
        params: ReadableMap,
        requireFileHash: Boolean,
    ): Map<String, ChangedAssetDescriptor>? {
        if (!params.hasKey("assets") || params.isNull("assets")) {
            return null
        }

        val changedAssetsMap = params.getMap("assets") ?: return null
        val parsedAssets = linkedMapOf<String, ChangedAssetDescriptor>()
        val iterator = changedAssetsMap.keySetIterator()

        while (iterator.hasNextKey()) {
            val assetPath = iterator.nextKey()
            val assetMap = changedAssetsMap.getMap(assetPath) ?: continue
            val assetHash = if (assetMap.hasKey("fileHash")) assetMap.getString("fileHash") else null
            if (assetHash == null && requireFileHash) continue
            val patchMap = assetMap.getMap("patch")
            val patch = parsePatch(patchMap)
            val fileMap =
                if (assetMap.hasKey("file") && !assetMap.isNull("file")) {
                    assetMap.getMap("file")
                } else {
                    null
                }
            val assetUrl = fileMap?.getString("url")
            val fileCompression =
                if (fileMap != null && fileMap.hasKey("compression") && !fileMap.isNull("compression")) {
                    fileMap.getString("compression")
                } else {
                    null
                }
            if (assetUrl == null && patch == null) {
                continue
            }
            if (assetHash == null && assetUrl != null) {
                continue
            }
            parsedAssets[assetPath] =
                ChangedAssetDescriptor(
                    fileUrl = assetUrl,
                    fileHash = assetHash ?: "",
                    fileCompression = fileCompression,
                    patch = patch,
                )
        }

        return parsedAssets
    }

    /** The update check's request headers, which the artifact files request repeats. */
    private fun parseRequestHeaders(params: ReadableMap): Map<String, String> {
        if (!params.hasKey("requestHeaders") || params.isNull("requestHeaders")) return emptyMap()
        val headers = params.getMap("requestHeaders") ?: return emptyMap()
        val parsed = linkedMapOf<String, String>()
        val iterator = headers.keySetIterator()
        while (iterator.hasNextKey()) {
            val name = iterator.nextKey()
            if (headers.getType(name) == com.facebook.react.bridge.ReadableType.String) {
                headers.getString(name)?.let { parsed[name] = it }
            }
        }
        return parsed
    }

    private fun parsePatch(patchMap: ReadableMap?): BsdiffPatchDescriptor? {
        if (patchMap == null) return null
        val algorithm = patchMap.getString("algorithm")
        val baseBundleId = patchMap.getString("baseBundleId")
        val baseFileHash = patchMap.getString("baseFileHash")
        val patchFileHash = patchMap.getString("patchFileHash")
        val patchUrl = patchMap.getString("patchUrl")
        val byteSize = readSafeInteger(patchMap, "byteSize")

        return if (
            algorithm != null &&
            baseBundleId != null &&
            baseFileHash != null &&
            patchFileHash != null &&
            patchUrl != null
        ) {
            BsdiffPatchDescriptor(
                algorithm = algorithm,
                baseBundleId = baseBundleId,
                baseFileHash = baseFileHash,
                patchFileHash = patchFileHash,
                patchUrl = patchUrl,
                byteSize = byteSize,
            )
        } else {
            null
        }
    }

    /**
     * The resolver that asks `filesUrl` for the files native downloads one by
     * one; null when `filesUrl` is missing.
     */
    private fun parseFileResolver(params: ReadableMap): ArtifactFileResolver? {
        val filesUrl =
            if (params.hasKey("filesUrl") && !params.isNull("filesUrl")) {
                params.getString("filesUrl")?.takeIf { it.isNotEmpty() }
            } else {
                null
            } ?: return null
        try {
            java.net.URL(filesUrl)
        } catch (e: java.net.MalformedURLException) {
            throw HotUpdaterException.invalidFileUrl("filesUrl", filesUrl, UpdateFailureResource.FILE)
        }
        val requestTimeoutMs =
            if (params.hasKey("requestTimeout") && !params.isNull("requestTimeout")) {
                params.getDouble("requestTimeout").toLong().takeIf { it > 0 }
            } else {
                null
            } ?: HttpArtifactFileResolver.DEFAULT_TIMEOUT_MS
        return HttpArtifactFileResolver(filesUrl, parseRequestHeaders(params), requestTimeoutMs)
    }

    /**
     * Artifact protocol v2: the Hermes patch as the only planned asset, and
     * the resolver that asks `filesUrl` for the files native downloads one by
     * one; null when `filesUrl` is missing.
     */
    private fun parseArtifactInstall(params: ReadableMap): Pair<Map<String, ChangedAssetDescriptor>, ArtifactFileResolver?>? {
        val fileResolver = parseFileResolver(params) ?: return null
        val patchMap = if (params.hasKey("patch") && !params.isNull("patch")) params.getMap("patch") else null
        val assetPath = patchMap?.getString("assetPath")
        val patch = parsePatch(patchMap)
        val assets =
            if (assetPath != null && patch != null) {
                mapOf(assetPath to ChangedAssetDescriptor(fileUrl = null, fileHash = "", patch = patch))
            } else {
                emptyMap()
            }
        return assets to fileResolver
    }

    private fun parseSelection(params: ReadableMap): PersistedSelection? {
        if (!params.hasKey("selection") || params.isNull("selection")) return null
        val selection = params.getMap("selection") ?: return null
        return PersistedSelection(
            kind = selection.getString("kind") ?: return null,
            releaseId = selection.getString("releaseId"),
            bundleId = selection.getString("bundleId") ?: return null,
            catalogId = selection.getString("catalogId"),
            scopeKey = selection.getString("scopeKey"),
            generation =
                if (selection.hasKey("generation") && !selection.isNull("generation")) {
                    selection.getDouble("generation").toLong()
                } else {
                    null
                },
            catalogHash = selection.getString("catalogHash"),
            channel = selection.getString("channel") ?: "",
            selectionContextHash = selection.getString("selectionContextHash"),
        )
    }

    // Legacy: released JavaScript calls reload() on Android when the app chose
    // setReloadBehavior("reload"). The in-place React Native reload is gone, so
    // reload() restarts the process, and reloadProcess() runs the same code.
    override fun reload(promise: Promise) {
        runtimeInstance.reloadUnsupportedReason()?.let { reason ->
            promise.reject(RELOAD_UNSUPPORTED_CODE, reason)
            return
        }
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

    // Deprecated: JavaScript calls reloadProcess() on Android, both released
    // JavaScript and this SDK's, so it stays until the next major release.
    override fun reloadProcess(promise: Promise) = reload(promise)

    override fun updateBundle(
        params: ReadableMap,
        promise: Promise,
    ) {
        // Legacy: artifact protocol v1, where every file comes with its URL.
        // JavaScript from the first protocol v2 SDK also sends `filesUrl`
        // here, with only the Hermes patch in `assets`; its OTA Bundles must
        // still install.
        stage(params, promise) {
            val fileResolver = parseFileResolver(params)
            parseAssets(params, requireFileHash = fileResolver == null)?.let { it to fileResolver }
        }
    }

    override fun installArtifact(
        params: ReadableMap,
        promise: Promise,
    ) {
        stage(params, promise) { parseArtifactInstall(params) }
    }

    private fun stage(
        params: ReadableMap,
        promise: Promise,
        plan: () -> Pair<Map<String, ChangedAssetDescriptor>, ArtifactFileResolver?>?,
    ) {
        moduleScope.launch {
            try {
                val bundleId = params.getString("bundleId")
                if (bundleId == null || bundleId.isEmpty()) {
                    promise.rejectUpdateBundle(HotUpdaterException.missingBundleId())
                    return@launch
                }

                val manifestUrl = params.getString("manifestUrl")
                val manifestFileHash = params.getString("manifestFileHash")
                val planned = plan()
                val assets = planned?.first
                if (manifestUrl.isNullOrEmpty() || manifestFileHash.isNullOrEmpty() || assets == null) {
                    promise.rejectUpdateBundle(HotUpdaterException.invalidManifestParams())
                    return@launch
                }
                try {
                    java.net.URL(manifestUrl)
                } catch (e: java.net.MalformedURLException) {
                    promise.rejectUpdateBundle(
                        HotUpdaterException.invalidFileUrl("manifestUrl", manifestUrl, UpdateFailureResource.MANIFEST),
                    )
                    return@launch
                }
                val channel = params.getString("channel")
                val archiveUrl =
                    if (params.hasKey("archiveUrl") && !params.isNull("archiveUrl")) {
                        params.getString("archiveUrl")
                    } else {
                        null
                    }
                if (archiveUrl != null) {
                    try {
                        java.net.URL(archiveUrl)
                    } catch (e: java.net.MalformedURLException) {
                        promise.rejectUpdateBundle(
                            HotUpdaterException.invalidFileUrl("archiveUrl", archiveUrl, UpdateFailureResource.ARCHIVE),
                        )
                        return@launch
                    }
                }
                val selection = parseSelection(params)
                val fileResolver = planned.second

                val impl = getInstance()

                val result =
                    impl.updateBundle(
                        bundleId,
                        manifestUrl,
                        manifestFileHash,
                        assets,
                        channel,
                        selection,
                        archiveUrl,
                        fileResolver,
                    ) { progress ->
                        // Post to Main thread for React Native event emission
                        Handler(Looper.getMainLooper()).post {
                            try {
                                val progressParams =
                                    WritableNativeMap().apply {
                                        putDouble("progress", progress.progress)
                                        putString("artifactType", progress.artifactType)
                                        progress.details?.let { details ->
                                            putMap(
                                                "details",
                                                WritableNativeMap().apply {
                                                    putInt("totalFilesCount", details.totalFilesCount)
                                                    putInt("completedFilesCount", details.completedFilesCount)
                                                    putArray(
                                                        "files",
                                                        WritableNativeArray().apply {
                                                            details.files.forEach { file ->
                                                                pushMap(
                                                                    WritableNativeMap().apply {
                                                                        putString("path", file.path)
                                                                        putString("downloadPath", file.downloadPath)
                                                                        putString("status", file.status)
                                                                        putDouble("progress", file.progress)
                                                                        putInt("order", file.order)
                                                                        file.downloadedBytes?.let {
                                                                            putDouble(
                                                                                "downloadedBytes",
                                                                                it.toDouble(),
                                                                            )
                                                                        }
                                                                        file.totalBytes?.let { putDouble("totalBytes", it.toDouble()) }
                                                                    },
                                                                )
                                                            }
                                                        },
                                                    )
                                                },
                                            )
                                        }
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
                promise.resolve(result.toWritableMap())
            } catch (e: HotUpdaterException) {
                promise.rejectUpdateBundle(e)
            } catch (e: Exception) {
                // Not an update failure (a stale Release selection, for example),
                // so the rejection carries no classification.
                promise.reject("UNKNOWN_ERROR", e.message ?: "An unknown error occurred")
            }
        }
    }

    override fun acceptReleaseCatalog(params: ReadableMap): Boolean {
        val catalogId = params.getString("catalogId") ?: return false
        val scopeKey = params.getString("scopeKey") ?: return false
        val catalogHash = params.getString("catalogHash") ?: return false
        val channel = params.getString("channel") ?: return false
        val selectionContextHash = params.getString("selectionContextHash") ?: return false
        return getInstance().acceptReleaseCatalog(
            catalogId = catalogId,
            scopeKey = scopeKey,
            generation = params.getDouble("generation").toLong(),
            catalogHash = catalogHash,
            channel = channel,
            selectionContextHash = selectionContextHash,
        )
    }

    override fun getActiveUpdateState(): WritableNativeMap = getInstance().getActiveUpdateState().toWritableNativeMap()

    override fun getReleaseCatalogCache(
        partition: String,
        promise: Promise,
    ) {
        moduleScope.launch(Dispatchers.IO) {
            promise.resolve(getInstance().getReleaseCatalogCache(partition))
        }
    }

    override fun setReleaseCatalogCache(
        partition: String,
        payload: String,
        promise: Promise,
    ) {
        moduleScope.launch(Dispatchers.IO) {
            promise.resolve(getInstance().setReleaseCatalogCache(partition, payload))
        }
    }

    override fun removeReleaseCatalogCache(
        partition: String,
        promise: Promise,
    ) {
        moduleScope.launch(Dispatchers.IO) {
            promise.resolve(getInstance().removeReleaseCatalogCache(partition))
        }
    }

    override fun isReleaseSelectionCurrent(params: ReadableMap): Boolean {
        val catalogId = params.getString("catalogId") ?: return false
        val scopeKey = params.getString("scopeKey") ?: return false
        val catalogHash = params.getString("catalogHash") ?: return false
        val channel = params.getString("channel") ?: return false
        val selectionContextHash = params.getString("selectionContextHash") ?: return false
        return getInstance().isReleaseSelectionCurrent(
            catalogId = catalogId,
            scopeKey = scopeKey,
            generation = params.getDouble("generation").toLong(),
            catalogHash = catalogHash,
            channel = channel,
            selectionContextHash = selectionContextHash,
        )
    }

    override fun commitReleaseSelection(
        params: ReadableMap,
        promise: Promise,
    ) {
        val selection = parseSelection(params)
        if (selection == null) {
            promise.reject("INVALID_SELECTION", "Invalid Release selection")
            return
        }
        moduleScope.launch {
            try {
                promise.resolve(getInstance().commitReleaseSelection(selection))
            } catch (error: Exception) {
                promise.reject("UNKNOWN_ERROR", error.message, error)
            }
        }
    }

    override fun getTypedExportedConstants(): Map<String, Any?> {
        val constants: MutableMap<String, Any?> = HashMap()
        constants["MIN_BUNDLE_ID"] = HotUpdater.getMinBundleId()
        constants["APP_VERSION"] = HotUpdater.getAppVersion(mReactApplicationContext)
        constants["CHANNEL"] = getInstance().getChannel()
        constants["DEFAULT_CHANNEL"] = getInstance().getDefaultChannel()
        constants["FINGERPRINT_HASH"] = getInstance().getFingerprintHash()
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

    override fun getBaseURL(): String? {
        val impl = getInstance()
        return impl.getBaseURL()
    }

    override fun setCohort(cohort: String) {
        cohortService.setCohort(cohort)
    }

    override fun getCohort(): String = cohortService.getCohort()

    override fun getBundleId(): String? {
        val impl = getInstance()
        return impl.getBundleId()
    }

    override fun getManifest(): WritableNativeMap = getInstance().getManifest().toWritableNativeMap()

    override fun getInstallId(): String = getInstance().getInstallId()

    override fun getStorageItem(key: String): String? = getInstance().getStorageItem(key)

    override fun setStorageItem(
        key: String,
        value: String?,
    ) {
        getInstance().setStorageItem(key, value)
    }

    override fun takeNativeUpdateEvents(): String? = getInstance().takeNativeUpdateEvents()

    override fun resetChannelIfSelectionCurrent(
        params: ReadableMap,
        promise: Promise,
    ) {
        val catalogId = params.getString("catalogId")
        val scopeKey = params.getString("scopeKey")
        val catalogHash = params.getString("catalogHash")
        val channel = params.getString("channel")
        val selectionContextHash = params.getString("selectionContextHash")
        if (catalogId == null || scopeKey == null || catalogHash == null || channel == null || selectionContextHash == null) {
            promise.resolve(false)
            return
        }
        val guard =
            ReleaseSelectionGuard(
                catalogId = catalogId,
                scopeKey = scopeKey,
                generation = params.getDouble("generation").toLong(),
                catalogHash = catalogHash,
                channel = channel,
                selectionContextHash = selectionContextHash,
            )
        moduleScope.launch {
            try {
                // Waits for a native check or download, as resetChannel does.
                val name = runtimeInstance.name
                promise.resolve(
                    NativeUpdateCheck.resetChannelIfSelectionCurrent(mReactApplicationContext, name, guard) {
                        runtimeInstance.impl(name)
                    },
                )
            } catch (e: HotUpdaterException) {
                promise.reject(e.code, e.message)
            } catch (e: Exception) {
                promise.reject("UNKNOWN_ERROR", e.message ?: "Failed to reset channel")
            }
        }
    }

    override fun resetChannel(promise: Promise) {
        moduleScope.launch {
            try {
                // Waits for a native check or download, which would save its
                // channel again after the reset.
                val name = runtimeInstance.name
                val success = NativeUpdateCheck.resetChannel(mReactApplicationContext, name) { runtimeInstance.impl(name) }
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
