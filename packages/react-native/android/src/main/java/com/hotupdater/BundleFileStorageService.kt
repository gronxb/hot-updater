package com.hotupdater

import android.os.StatFs
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.URL

data class ChangedAssetDescriptor(
    val fileUrl: String,
    val fileHash: String,
    val patch: BsdiffPatchDescriptor? = null,
)

data class BsdiffPatchDescriptor(
    val algorithm: String,
    val baseBundleId: String,
    val baseFileHash: String,
    val patchFileHash: String,
    val patchUrl: String,
)

data class UpdateProgressPayload(
    val progress: Double,
    val artifactType: String,
    val details: DiffProgressDetails? = null,
)

data class DiffProgressFileSnapshot(
    val path: String,
    val status: String,
    val progress: Double,
    val order: Int,
)

data class DiffProgressDetails(
    val totalFilesCount: Int,
    val completedFilesCount: Int,
    val files: List<DiffProgressFileSnapshot> = emptyList(),
)

/**
 * Interface for bundle storage operations
 */
interface BundleStorageService {
    /**
     * Sets the current bundle URL
     * @param localPath Path to the bundle file (or null to reset)
     * @return true if the operation was successful
     */
    fun setBundleURL(localPath: String?): Boolean

    /**
     * Gets the URL to the cached bundle file
     * @return The path to the cached bundle or null if not found
     */
    fun getCachedBundleURL(): String?

    /**
     * Gets the URL to the fallback bundle included in the app
     * @return The fallback bundle path
     */
    fun getFallbackBundleURL(): String

    /**
     * Prepares the bundle launch for the current process.
     * Applies any pending rollback decision from the previous launch and returns
     * the bundle that should be loaded now.
     */
    fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection

    /**
     * Updates the bundle from the specified URL
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or null to reset)
     * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
     * @param progressCallback Callback for download progress updates
     * @throws HotUpdaterException if the update fails
     */
    suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        fileHash: String?,
        manifestUrl: String?,
        manifestFileHash: String?,
        changedAssets: Map<String, ChangedAssetDescriptor>?,
        progressCallback: (UpdateProgressPayload) -> Unit,
    )

    /**
     * Marks the current launch as successful after the first content appeared.
     */
    fun markLaunchCompleted(currentBundleId: String?)

    /**
     * Returns the launch report for the current process.
     */
    fun notifyAppReady(): Map<String, Any?>

    /**
     * Gets the crashed bundle history
     * @return CrashedHistory containing crashed bundles
     */
    fun getCrashHistory(): CrashedHistory

    /**
     * Clears the crashed bundle history
     * @return true if clearing was successful
     */
    fun clearCrashHistory(): Boolean

    /**
     * Gets the base URL for the current active bundle directory
     * @return Base URL string (e.g., "file:///data/.../bundle-store/abc123") or empty string
     */
    fun getBaseURL(): String

    /**
     * Gets the base URL for a specific launched bundle.
     * Returns an empty string for the built-in bundle or when the bundle is unavailable.
     */
    fun getBaseURLForBundle(bundleId: String?): String

    /**
     * Gets the current active bundle ID from bundle storage.
     * Reads manifest.json first and falls back to older metadata when needed.
     */
    fun getBundleId(): String?

    /**
     * Gets the current manifest from bundle storage.
     * Returns an empty map when manifest.json is missing or invalid.
     */
    fun getManifest(): Map<String, Any?>

    /**
     * Gets the manifest for a specific launched bundle.
     * Returns an empty map for the built-in bundle or when the bundle is unavailable.
     */
    fun getManifestForBundle(bundleId: String?): Map<String, Any?>

    /**
     * Restores the original bundle and clears downloaded bundle state.
     * @return true if the reset was successful
     */
    suspend fun resetChannel(): Boolean
}

/**
 * Implementation of BundleStorageService
 */
class BundleFileStorageService(
    private val context: android.content.Context,
    private val fileSystem: FileSystemService,
    private val downloadService: DownloadService,
    private val decompressService: DecompressService,
    private val preferences: PreferencesService,
    private val isolationKey: String,
) : BundleStorageService {
    companion object {
        private const val TAG = "BundleStorage"
    }

    private fun emitArchiveProgress(
        progressCallback: (UpdateProgressPayload) -> Unit,
        progress: Double,
    ) {
        progressCallback(
            UpdateProgressPayload(
                progress = progress.coerceIn(0.0, 1.0),
                artifactType = "archive",
            ),
        )
    }

    private fun createDiffProgressFiles(changedAssets: Map<String, ChangedAssetDescriptor>): MutableList<DiffProgressFileSnapshot> =
        changedAssets.keys
            .sorted()
            .mapIndexed { order, path ->
                DiffProgressFileSnapshot(
                    path = path,
                    status = "pending",
                    progress = 0.0,
                    order = order,
                )
            }.toMutableList()

    private fun updateDiffProgressFile(
        files: MutableList<DiffProgressFileSnapshot>,
        assetPath: String,
        status: String,
        progress: Double,
    ) {
        val fileIndex = files.indexOfFirst { it.path == assetPath }
        if (fileIndex == -1) {
            return
        }

        files[fileIndex] =
            files[fileIndex].copy(
                status = status,
                progress = progress.coerceIn(0.0, 1.0),
            )
    }

    private fun calculateDiffOverallProgress(
        phase: String,
        files: List<DiffProgressFileSnapshot>,
        manifestProgress: Double = 0.0,
    ): Double {
        val normalizedManifestProgress = manifestProgress.coerceIn(0.0, 1.0)
        return when (phase) {
            "manifest" -> normalizedManifestProgress * 0.15
            "downloading" -> {
                if (files.isEmpty()) {
                    0.92
                } else {
                    val completedFilesCount = files.count { it.status == "downloaded" }
                    val activeProgressUnits =
                        files
                            .filter { it.status == "downloading" }
                            .sumOf { it.progress.coerceIn(0.0, 1.0) }
                    (0.2 + ((completedFilesCount + activeProgressUnits) / files.size) * 0.72)
                        .coerceIn(0.2, 0.92)
                }
            }
            "finalizing" -> 0.97
            "completed" -> 1.0
            else -> 0.0
        }
    }

    private fun emitDiffProgress(
        progressCallback: (UpdateProgressPayload) -> Unit,
        phase: String,
        files: List<DiffProgressFileSnapshot>,
        manifestProgress: Double = 0.0,
    ) {
        progressCallback(
            UpdateProgressPayload(
                progress =
                    calculateDiffOverallProgress(
                        phase = phase,
                        files = files,
                        manifestProgress = manifestProgress,
                    ),
                artifactType = "diff",
                details =
                    DiffProgressDetails(
                        totalFilesCount = files.size,
                        completedFilesCount = files.count { it.status == "downloaded" },
                        files = files.toList(),
                    ),
            ),
        )
    }

    private fun resetDiffProgressFile(
        files: MutableList<DiffProgressFileSnapshot>,
        assetPath: String,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ) {
        updateDiffProgressFile(
            files = files,
            assetPath = assetPath,
            status = "pending",
            progress = 0.0,
        )
        emitDiffProgress(
            progressCallback = progressCallback,
            phase = "downloading",
            files = files,
        )
    }

    private fun patchTempFile(
        tempDir: File,
        assetPath: String,
    ): File {
        val safeName = assetPath.replace("/", "__").replace("\\", "__")
        val patchDir = File(tempDir, "patches")
        patchDir.mkdirs()
        return File(patchDir, "$safeName.bsdiff")
    }

    private suspend fun applyPatchAssetIfPossible(
        assetPath: String,
        changedAsset: ChangedAssetDescriptor,
        currentBundleId: String?,
        activeBundleDir: File?,
        targetFile: File,
        expectedHash: String,
        tempDir: File,
        diffFiles: MutableList<DiffProgressFileSnapshot>,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): Boolean {
        val patch = changedAsset.patch ?: return false
        if (patch.algorithm != "bsdiff" || currentBundleId != patch.baseBundleId) {
            return false
        }

        val sourceDir = activeBundleDir ?: return false
        val sourceFile = File(sourceDir, assetPath)
        if (!sourceFile.exists() || !HashUtils.verifyHash(sourceFile, patch.baseFileHash)) {
            return false
        }

        val patchFile = patchTempFile(tempDir, assetPath)

        return try {
            when (
                val patchDownloadResult =
                    downloadService.downloadFile(
                        URL(patch.patchUrl),
                        patchFile,
                    ) { downloadProgress ->
                        updateDiffProgressFile(
                            files = diffFiles,
                            assetPath = assetPath,
                            status = "downloading",
                            progress = downloadProgress,
                        )
                        emitDiffProgress(
                            progressCallback = progressCallback,
                            phase = "downloading",
                            files = diffFiles,
                        )
                    }
            ) {
                is DownloadResult.Error -> {
                    false
                }
                is DownloadResult.Success -> {
                    if (!HashUtils.verifyHash(patchDownloadResult.file, patch.patchFileHash)) {
                        false
                    } else {
                        BsdiffPatch.apply(sourceFile, patchDownloadResult.file, targetFile)
                        HashUtils.verifyHash(targetFile, expectedHash).also { patched ->
                            if (patched) {
                                Log.d(
                                    TAG,
                                    "HotUpdaterBsdiffPatchApplied asset=$assetPath baseBundleId=${patch.baseBundleId}",
                                )
                            }
                        }
                    }
                }
            }
        } catch (_: Exception) {
            false
        } finally {
            patchFile.delete()
            if (!targetFile.exists() || !HashUtils.verifyHash(targetFile, expectedHash)) {
                targetFile.delete()
            }
        }.also { patched ->
            if (!patched) {
                resetDiffProgressFile(
                    files = diffFiles,
                    assetPath = assetPath,
                    progressCallback = progressCallback,
                )
            }
        }
    }

    private data class ParsedBundleManifest(
        val bundleId: String,
        val assets: Map<String, ParsedManifestAsset>,
    )

    private data class ParsedManifestAsset(
        val fileHash: String,
        val signature: String?,
    )

    private data class ActiveBundleMetadataSnapshot(
        val activeBundleId: String,
        val bundleId: String?,
        val manifest: Map<String, Any?>,
    )

    init {
        // Ensure bundle store directory exists
        getBundleStoreDir().mkdirs()

        // Clean up old bundles if isolationKey format changed
        checkAndCleanupIfIsolationKeyChanged()
    }

    private var currentLaunchReport: LaunchReport? = null

    @Volatile
    private var activeBundleMetadataSnapshot: ActiveBundleMetadataSnapshot? = null
    private val activeBundleMetadataLock = Any()

    // MARK: - Bundle Store Directory

    private fun getBundleStoreDir(): File {
        val baseDir = fileSystem.getExternalFilesDir()
        return File(baseDir, "bundle-store")
    }

    private fun getMetadataFile(): File = File(getBundleStoreDir(), BundleMetadata.METADATA_FILENAME)

    private fun getCrashedHistoryFile(): File = File(getBundleStoreDir(), CrashedHistory.CRASHED_HISTORY_FILENAME)

    private fun getLaunchReportFile(): File = File(getBundleStoreDir(), LaunchReport.LAUNCH_REPORT_FILENAME)

    // MARK: - Metadata Operations

    private fun loadMetadataOrNull(): BundleMetadata? = BundleMetadata.loadFromFile(getMetadataFile(), isolationKey)

    private fun saveMetadata(metadata: BundleMetadata): Boolean {
        val updatedMetadata = metadata.copy(isolationKey = isolationKey)
        return updatedMetadata.saveToFile(getMetadataFile())
    }

    private fun loadLaunchReport(): LaunchReport? =
        currentLaunchReport ?: LaunchReport.loadFromFile(getLaunchReportFile())?.also {
            currentLaunchReport = it
        }

    private fun saveLaunchReport(report: LaunchReport?) {
        currentLaunchReport = report
        val file = getLaunchReportFile()
        if (report == null) {
            if (file.exists()) {
                file.delete()
            }
            return
        }
        report.saveToFile(file)
    }

    private fun createInitialMetadata(): BundleMetadata {
        val currentBundleId = extractBundleIdFromCurrentURL()
        Log.d(TAG, "Creating initial metadata with stagingBundleId: $currentBundleId")
        return BundleMetadata(
            stableBundleId = null,
            stagingBundleId = currentBundleId,
            verificationPending = false,
        )
    }

    private fun extractBundleIdFromCurrentURL(): String? {
        val currentUrl = preferences.getItem("HotUpdaterBundleURL") ?: return null
        // "bundle-store/abc123/index.android.bundle" -> "abc123"
        val regex = Regex("bundle-store/([^/]+)/")
        return regex.find(currentUrl)?.groupValues?.get(1)
    }

    private fun resolveBundleFile(bundleDir: File): File? {
        val manifest = readManifestFromBundleDir(bundleDir)
        val manifestBundlePath =
            (manifest?.get("assets") as? Map<*, *>)
                ?.keys
                ?.mapNotNull { key ->
                    (key as? String)
                        ?.trim()
                        ?.takeIf { it.isNotEmpty() }
                        ?.takeIf { File(it).name.endsWith(".android.bundle") }
                }?.singleOrNull()

        if (manifestBundlePath != null) {
            try {
                val canonicalBundleDir = bundleDir.canonicalFile
                val canonicalBundleFile = File(bundleDir, manifestBundlePath).canonicalFile
                val canonicalBundleDirPath = canonicalBundleDir.path
                val canonicalBundleFilePath = canonicalBundleFile.path
                val isWithinBundleDir =
                    canonicalBundleFilePath == canonicalBundleDirPath ||
                        canonicalBundleFilePath.startsWith("$canonicalBundleDirPath${File.separator}")

                if (isWithinBundleDir && canonicalBundleFile.isFile) {
                    return canonicalBundleFile
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to resolve manifest bundle file from ${bundleDir.absolutePath}: ${e.message}")
            }
        }

        return File(bundleDir, "index.android.bundle").absoluteFile.takeIf { it.isFile }
    }

    private fun findBundleFile(bundleId: String): File? {
        val bundleDir = File(getBundleStoreDir(), bundleId)
        return resolveBundleFile(bundleDir)
    }

    private fun getBundleUrlForId(bundleId: String): String? = findBundleFile(bundleId)?.absolutePath

    private fun getCurrentVerifiedBundleId(metadata: BundleMetadata): String? =
        when {
            metadata.stagingBundleId != null && !metadata.verificationPending -> metadata.stagingBundleId
            metadata.stableBundleId != null -> metadata.stableBundleId
            else -> null
        }

    private fun getActiveBundleId(): String? {
        extractBundleIdFromCurrentURL()?.let { return it }

        val metadata = loadMetadataOrNull()
        return when {
            metadata?.stagingBundleId != null && !metadata.verificationPending -> metadata.stagingBundleId
            metadata?.stableBundleId != null -> metadata.stableBundleId
            else -> null
        }
    }

    private fun getActiveBundleMetadataSnapshot(): ActiveBundleMetadataSnapshot? {
        val activeBundleId =
            getActiveBundleId() ?: run {
                clearActiveBundleMetadataSnapshot()
                return null
            }

        activeBundleMetadataSnapshot
            ?.takeIf { it.activeBundleId == activeBundleId }
            ?.let { return it }

        synchronized(activeBundleMetadataLock) {
            activeBundleMetadataSnapshot
                ?.takeIf { it.activeBundleId == activeBundleId }
                ?.let { return it }

            val bundleDir = File(getBundleStoreDir(), activeBundleId)
            if (!bundleDir.exists()) {
                activeBundleMetadataSnapshot = null
                return null
            }

            return resolveActiveBundleMetadataSnapshot(bundleDir).also {
                activeBundleMetadataSnapshot = it
            }
        }
    }

    private fun clearActiveBundleMetadataSnapshot() {
        synchronized(activeBundleMetadataLock) {
            activeBundleMetadataSnapshot = null
        }
    }

    private fun resolveActiveBundleMetadataSnapshot(bundleDir: File): ActiveBundleMetadataSnapshot {
        val manifest = readManifestFromBundleDir(bundleDir) ?: emptyMap()
        val manifestBundleId =
            (manifest["bundleId"] as? String)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }

        return ActiveBundleMetadataSnapshot(
            activeBundleId = bundleDir.name,
            bundleId = manifestBundleId ?: readCompatibilityBundleIdFromBundleDir(bundleDir),
            manifest = manifest,
        )
    }

    private fun getBundleMetadataSnapshot(bundleId: String?): ActiveBundleMetadataSnapshot? {
        if (bundleId.isNullOrBlank()) {
            return null
        }

        val bundleDir = File(getBundleStoreDir(), bundleId)
        if (!bundleDir.exists()) {
            return null
        }

        return resolveActiveBundleMetadataSnapshot(bundleDir)
    }

    private fun readCompatibilityBundleIdFromBundleDir(bundleDir: File): String? {
        val compatibilityBundleIdFile = File(bundleDir, compatibilityBundleIdFilename())
        if (!compatibilityBundleIdFile.exists()) {
            return null
        }

        return try {
            compatibilityBundleIdFile.readText().trim().takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            Log.w(
                TAG,
                "Failed to read compatibility bundle metadata from ${compatibilityBundleIdFile.absolutePath}: ${e.message}",
            )
            null
        }
    }

    private fun compatibilityBundleIdFilename(): String = "BUNDLE_ID"

    private fun readManifestFromBundleDir(bundleDir: File): Map<String, Any?>? {
        val manifestFile = File(bundleDir, "manifest.json")
        if (!manifestFile.exists()) {
            return null
        }

        return try {
            JSONObject(manifestFile.readText()).let(::jsonObjectToMap)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read manifest from ${manifestFile.absolutePath}: ${e.message}")
            null
        }
    }

    private fun jsonObjectToMap(jsonObject: JSONObject): Map<String, Any?> {
        val result = linkedMapOf<String, Any?>()
        val keys = jsonObject.keys()

        while (keys.hasNext()) {
            val key = keys.next()
            result[key] = jsonValueToKotlin(jsonObject.opt(key))
        }

        return result
    }

    private fun jsonArrayToList(jsonArray: org.json.JSONArray): List<Any?> =
        List(jsonArray.length()) { index ->
            jsonValueToKotlin(jsonArray.opt(index))
        }

    private fun jsonValueToKotlin(value: Any?): Any? =
        when (value) {
            JSONObject.NULL -> null
            is JSONObject -> jsonObjectToMap(value)
            is org.json.JSONArray -> jsonArrayToList(value)
            else -> value
        }

    private fun parseBundleManifestFromMap(manifest: Map<String, Any?>): ParsedBundleManifest? {
        val manifestBundleId =
            (manifest["bundleId"] as? String)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?: return null
        val assetsValue = manifest["assets"] as? Map<*, *> ?: return null
        val assets = linkedMapOf<String, ParsedManifestAsset>()

        for ((assetPath, assetValue) in assetsValue) {
            if (assetPath !is String) {
                return null
            }

            val assetMap = assetValue as? Map<*, *> ?: return null
            val fileHash = assetMap["fileHash"] as? String ?: return null
            val signature = assetMap["signature"] as? String
            assets[assetPath] =
                ParsedManifestAsset(
                    fileHash = fileHash,
                    signature = signature?.takeIf { it.isNotBlank() },
                )
        }

        return ParsedBundleManifest(
            bundleId = manifestBundleId,
            assets = assets,
        )
    }

    private fun parseBundleManifestFromFile(manifestFile: File): ParsedBundleManifest? {
        if (!manifestFile.exists()) {
            return null
        }

        return try {
            val parsed = JSONObject(manifestFile.readText()).let(::jsonObjectToMap)
            parseBundleManifestFromMap(parsed)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse manifest ${manifestFile.absolutePath}: ${e.message}")
            null
        }
    }

    private fun writeBundleManifestFile(
        destination: File,
        manifest: ParsedBundleManifest,
    ) {
        destination.parentFile?.mkdirs()
        val assetsObject = JSONObject()

        manifest.assets.toSortedMap().forEach { (assetPath, asset) ->
            val assetObject = JSONObject().put("fileHash", asset.fileHash)
            if (!asset.signature.isNullOrBlank()) {
                assetObject.put("signature", asset.signature)
            }
            assetsObject.put(
                assetPath,
                assetObject,
            )
        }

        val manifestObject =
            JSONObject()
                .put("bundleId", manifest.bundleId)
                .put("assets", assetsObject)

        destination.writeText("${manifestObject}\n")
    }

    private fun getActiveBundleDir(): File? {
        val activeBundleId = getActiveBundleId() ?: return null
        val bundleDir = File(getBundleStoreDir(), activeBundleId)
        return bundleDir.takeIf { it.exists() }
    }

    private fun canUseManifestDrivenInstall(): Boolean {
        val activeBundleDir = getActiveBundleDir() ?: return false
        if (!activeBundleDir.exists()) {
            return false
        }

        val currentManifest =
            getActiveBundleMetadataSnapshot()
                ?.manifest
                ?.let(::parseBundleManifestFromMap) ?: return false

        return currentManifest.assets.isNotEmpty()
    }

    private fun copyBundleFile(
        source: File,
        destination: File,
    ) {
        destination.parentFile?.mkdirs()
        source.copyTo(destination, overwrite = true)
    }

    private fun verifyManifestAssetFile(
        file: File,
        asset: ParsedManifestAsset,
    ) {
        val actualHash =
            HashUtils.calculateSHA256(file)
                ?: throw SignatureVerificationException.FileReadFailed()

        if (!actualHash.equals(asset.fileHash, ignoreCase = true)) {
            throw SignatureVerificationException.FileHashMismatch()
        }

        if (!SignatureVerifier.isSigningEnabled(context)) {
            return
        }

        val signature =
            asset.signature
                ?: throw SignatureVerificationException.InvalidSignatureFormat()

        SignatureVerifier.verifyHashSignature(context, asset.fileHash, signature)
    }

    private fun verifyManifestAssetFileOrThrow(
        file: File,
        asset: ParsedManifestAsset,
    ) {
        try {
            verifyManifestAssetFile(file, asset)
        } catch (e: SignatureVerificationException) {
            throw HotUpdaterException.signatureVerificationFailed(e)
        }
    }

    /**
     * Checks if isolationKey has changed and cleans up old bundles if needed.
     * This handles migration when isolationKey format changes.
     */
    private fun checkAndCleanupIfIsolationKeyChanged() {
        val metadataFile = getMetadataFile()

        if (!metadataFile.exists()) {
            // First launch - no cleanup needed
            return
        }

        try {
            // Read metadata without validation to get stored isolationKey
            val jsonString = metadataFile.readText()
            val json = org.json.JSONObject(jsonString)
            val storedIsolationKey = if (json.has("isolationKey")) json.getString("isolationKey") else null

            if (storedIsolationKey != null && storedIsolationKey != isolationKey) {
                // isolationKey changed - migration needed
                Log.d(TAG, "isolationKey changed: $storedIsolationKey -> $isolationKey")
                Log.d(TAG, "Cleaning up old bundles for migration")
                cleanupAllBundlesForMigration()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking isolationKey: ${e.message}")
        }
    }

    /**
     * Removes all bundle directories during migration.
     * Called when isolationKey format changes.
     */
    private fun cleanupAllBundlesForMigration() {
        val bundleStoreDir = getBundleStoreDir()

        if (!bundleStoreDir.exists()) {
            return
        }

        try {
            var cleanedCount = 0
            bundleStoreDir.listFiles()?.forEach { file ->
                if (file.isDirectory) {
                    try {
                        if (file.deleteRecursively()) {
                            cleanedCount++
                            Log.d(TAG, "Migration: removed old bundle ${file.name}")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error removing bundle ${file.name}: ${e.message}")
                    }
                }
            }

            Log.d(TAG, "Migration cleanup complete: removed $cleanedCount bundles")
        } catch (e: Exception) {
            Log.e(TAG, "Error during migration cleanup: ${e.message}")
        }
    }

    // MARK: - State Machine

    private fun isVerificationPending(metadata: BundleMetadata): Boolean = metadata.verificationPending && metadata.stagingBundleId != null

    private fun prepareMetadataForNewStagingBundle(
        metadata: BundleMetadata,
        bundleId: String,
    ): BundleMetadata {
        val currentVerifiedBundleId =
            getCurrentVerifiedBundleId(metadata)?.takeIf { it != bundleId }

        return metadata.copy(
            stableBundleId = currentVerifiedBundleId,
            stagingBundleId = bundleId,
            verificationPending = true,
            updatedAt = System.currentTimeMillis(),
        )
    }

    private fun rollbackPendingBundle(stagingBundleId: String): Boolean {
        val metadata = loadMetadataOrNull() ?: return false
        if (metadata.stagingBundleId != stagingBundleId) {
            return false
        }

        Log.w(TAG, "Rolling back crashed staging bundle: $stagingBundleId")

        val crashedHistory = loadCrashedHistory()
        crashedHistory.addEntry(stagingBundleId)
        saveCrashedHistory(crashedHistory)

        val fallbackBundleId =
            metadata.stableBundleId?.takeIf { candidate ->
                getBundleUrlForId(candidate) != null
            }

        val updatedMetadata =
            metadata.copy(
                stableBundleId = null,
                stagingBundleId = fallbackBundleId,
                verificationPending = false,
                updatedAt = System.currentTimeMillis(),
            )
        saveMetadata(updatedMetadata)

        val fallbackBundleUrl = fallbackBundleId?.let { getBundleUrlForId(it) }
        setBundleURL(fallbackBundleUrl)

        File(getBundleStoreDir(), stagingBundleId).deleteRecursively()
        saveLaunchReport(LaunchReport(status = "RECOVERED", crashedBundleId = stagingBundleId))
        return true
    }

    private fun applyPendingRecoveryIfNeeded(pendingRecovery: PendingCrashRecovery?) {
        val metadata = loadMetadataOrNull() ?: return
        val stagingBundleId = metadata.stagingBundleId ?: return

        if (pendingRecovery?.shouldRollback == true &&
            pendingRecovery.launchedBundleId == stagingBundleId &&
            isVerificationPending(metadata)
        ) {
            rollbackPendingBundle(stagingBundleId)
        }
    }

    private fun selectLaunch(): LaunchSelection {
        val metadata = loadMetadataOrNull()
        if (metadata == null) {
            val cached = getCachedBundleURL()
            return LaunchSelection(
                bundleUrl = cached ?: getFallbackBundleURL(),
                launchedBundleId = extractBundleIdFromCurrentURL(),
                shouldRollbackOnCrash = false,
            )
        }

        metadata.stagingBundleId?.let { stagingBundleId ->
            val stagingBundleUrl = getBundleUrlForId(stagingBundleId)
            if (stagingBundleUrl != null) {
                return LaunchSelection(
                    bundleUrl = stagingBundleUrl,
                    launchedBundleId = stagingBundleId,
                    shouldRollbackOnCrash = metadata.verificationPending,
                )
            }

            if (metadata.verificationPending && rollbackPendingBundle(stagingBundleId)) {
                return selectLaunch()
            }
        }

        metadata.stableBundleId?.let { stableBundleId ->
            val stableBundleUrl = getBundleUrlForId(stableBundleId)
            if (stableBundleUrl != null) {
                return LaunchSelection(
                    bundleUrl = stableBundleUrl,
                    launchedBundleId = stableBundleId,
                    shouldRollbackOnCrash = false,
                )
            }
        }

        val cached = getCachedBundleURL()
        return LaunchSelection(
            bundleUrl = cached ?: getFallbackBundleURL(),
            launchedBundleId = extractBundleIdFromCurrentURL(),
            shouldRollbackOnCrash = false,
        )
    }

    // MARK: - Crashed History

    private fun loadCrashedHistory(): CrashedHistory = CrashedHistory.loadFromFile(getCrashedHistoryFile())

    private fun saveCrashedHistory(history: CrashedHistory): Boolean = history.saveToFile(getCrashedHistoryFile())

    private fun isBundleInCrashedHistory(bundleId: String): Boolean = loadCrashedHistory().contains(bundleId)

    override fun getCrashHistory(): CrashedHistory = loadCrashedHistory()

    override fun clearCrashHistory(): Boolean {
        val history = CrashedHistory()
        saveCrashedHistory(history)
        Log.d(TAG, "Cleared crash history")
        return true
    }

    override fun markLaunchCompleted(currentBundleId: String?) {
        val metadata = loadMetadataOrNull() ?: return
        val stagingBundleId = metadata.stagingBundleId ?: return
        if (!metadata.verificationPending || stagingBundleId != currentBundleId) {
            return
        }

        saveMetadata(
            metadata.copy(
                verificationPending = false,
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    // MARK: - notifyAppReady

    override fun notifyAppReady(): Map<String, Any?> {
        val report = loadLaunchReport() ?: return mapOf("status" to "STABLE")
        return buildMap {
            put("status", report.status)
            report.crashedBundleId?.let { put("crashedBundleId", it) }
        }
    }

    // MARK: - Bundle URL Operations

    override fun setBundleURL(localPath: String?): Boolean {
        Log.d(TAG, "setBundleURL: $localPath")
        preferences.setItem("HotUpdaterBundleURL", localPath)
        clearActiveBundleMetadataSnapshot()
        return true
    }

    override fun getCachedBundleURL(): String? {
        val urlString = preferences.getItem("HotUpdaterBundleURL")
        Log.d(TAG, "getCachedBundleURL: read from prefs = $urlString")
        if (urlString.isNullOrEmpty()) {
            Log.d(TAG, "getCachedBundleURL: urlString is null or empty")
            return null
        }

        val file = File(urlString)
        val exists = file.exists()
        Log.d(TAG, "getCachedBundleURL: file exists = $exists at path: $urlString")
        if (!exists) {
            preferences.setItem("HotUpdaterBundleURL", null)
            Log.d(TAG, "getCachedBundleURL: file doesn't exist, cleared preference")
            return null
        }
        return urlString
    }

    override fun getFallbackBundleURL(): String = "assets://index.android.bundle"

    override fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection {
        saveLaunchReport(null)
        applyPendingRecoveryIfNeeded(pendingRecovery)

        val selection = selectLaunch()
        Log.d(
            TAG,
            "prepareLaunch: bundleId=${selection.launchedBundleId} shouldRollback=${selection.shouldRollbackOnCrash} url=${selection.bundleUrl}",
        )
        return selection
    }

    override suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        fileHash: String?,
        manifestUrl: String?,
        manifestFileHash: String?,
        changedAssets: Map<String, ChangedAssetDescriptor>?,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ) {
        Log.d(
            TAG,
            "updateBundle bundleId $bundleId fileUrl $fileUrl fileHash $fileHash manifestUrl $manifestUrl",
        )

        // If no URL is provided, reset to fallback and clean up all bundles
        if (fileUrl.isNullOrEmpty()) {
            Log.d(TAG, "fileUrl is null or empty, resetting to fallback bundle")

            withContext(Dispatchers.IO) {
                // 1. Set bundle URL to null (reset preference)
                val setResult = setBundleURL(null)
                if (!setResult) {
                    Log.w(TAG, "Failed to reset bundle URL")
                }

                // 2. Reset metadata to initial state (clear all bundle references)
                val metadata = createInitialMetadata()
                val saveResult = saveMetadata(metadata)
                if (!saveResult) {
                    Log.w(TAG, "Failed to reset metadata")
                }

                // 3. Clean up all downloaded bundles
                // Pass null for currentBundleId to remove all bundles except the new bundleId
                val bundleStoreDir = getBundleStoreDir()
                cleanupOldBundles(bundleStoreDir, null, bundleId)

                Log.d(TAG, "Successfully reset to fallback bundle and cleaned up downloads")
            }
            return
        }

        // Check if bundle is in crashed history
        if (isBundleInCrashedHistory(bundleId)) {
            Log.w(TAG, "Bundle $bundleId is in crashed history, rejecting update")
            throw HotUpdaterException.bundleInCrashedHistory(bundleId)
        }

        // Initialize metadata if it doesn't exist (lazy initialization)
        val existingMetadata = loadMetadataOrNull()
        val metadata =
            existingMetadata ?: createInitialMetadata().also {
                saveMetadata(it)
                Log.d(TAG, "Created initial metadata during updateBundle")
            }

        val baseDir = fileSystem.getExternalFilesDir()
        val bundleStoreDir = getBundleStoreDir()
        if (!bundleStoreDir.exists()) {
            bundleStoreDir.mkdirs()
        }

        val finalBundleDir = File(bundleStoreDir, bundleId)
        if (finalBundleDir.exists()) {
            Log.d(TAG, "Bundle for bundleId $bundleId already exists. Using cached bundle.")
            val existingBundleFile = resolveBundleFile(finalBundleDir)
            if (existingBundleFile != null) {
                // Update last modified time
                finalBundleDir.setLastModified(System.currentTimeMillis())

                // Update metadata: set as staging
                val currentMetadata = loadMetadataOrNull() ?: createInitialMetadata()
                val updatedMetadata = prepareMetadataForNewStagingBundle(currentMetadata, bundleId)
                saveMetadata(updatedMetadata)

                // Set bundle URL for backwards compatibility
                setBundleURL(existingBundleFile.absolutePath)

                // Keep the current verified bundle as a fallback if one exists.
                cleanupOldBundles(bundleStoreDir, updatedMetadata.stableBundleId, bundleId)

                Log.d(TAG, "Existing bundle set as staging bundle for next launch")
                return
            } else {
                // If index.android.bundle is missing, delete and re-download
                finalBundleDir.deleteRecursively()
            }
        }

        val hasManifestDrivenArtifacts =
            !manifestUrl.isNullOrEmpty() &&
                !manifestFileHash.isNullOrEmpty() &&
                changedAssets != null

        if (hasManifestDrivenArtifacts && canUseManifestDrivenInstall()) {
            try {
                updateBundleFromManifest(
                    bundleId = bundleId,
                    manifestUrl = manifestUrl!!,
                    manifestFileHash = manifestFileHash!!,
                    changedAssets = changedAssets!!,
                    bundleStoreDir = bundleStoreDir,
                    finalBundleDir = finalBundleDir,
                    progressCallback = progressCallback,
                )
                return
            } catch (e: Exception) {
                if (fileUrl.isNullOrEmpty()) {
                    throw e
                }
                Log.w(
                    TAG,
                    "Manifest-driven install failed for $bundleId. Falling back to archive: ${e.message}",
                    e,
                )
            }
        } else if (hasManifestDrivenArtifacts) {
            Log.d(
                TAG,
                "Skipping manifest-driven install for $bundleId because no active OTA manifest is available. Using archive.",
            )
        }

        val tempDirName = "bundle-temp"
        val tempDir = File(baseDir, tempDirName)
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        withContext(Dispatchers.IO) {
            val downloadUrl = URL(fileUrl)

            // Determine bundle filename from URL
            val bundleFileName =
                if (downloadUrl.path.isNotEmpty()) {
                    File(downloadUrl.path).name.ifEmpty { "bundle.zip" }
                } else {
                    "bundle.zip"
                }
            val tempBundleFile = File(tempDir, bundleFileName)

            // Download the file (0% - 80%)
            // Disk space check will be performed in fileSizeCallback
            var diskSpaceError: HotUpdaterException? = null

            val downloadResult =
                downloadService.downloadFile(
                    downloadUrl,
                    tempBundleFile,
                    fileSizeCallback = { fileSize ->
                        // Perform disk space check when file size is known
                        if (baseDir != null) {
                            val stat = StatFs(baseDir.absolutePath)
                            val availableBytes = stat.availableBlocksLong * stat.blockSizeLong
                            val requiredSpace = fileSize * 2 // ZIP + extracted files

                            Log.d(
                                "BundleStorage",
                                "File size: $fileSize bytes, Available: $availableBytes bytes, Required: $requiredSpace bytes",
                            )

                            if (availableBytes < requiredSpace) {
                                Log.d(
                                    TAG,
                                    "Insufficient disk space detected: need $requiredSpace bytes, available $availableBytes bytes",
                                )
                                // Store error to be thrown after download completes/cancels
                                diskSpaceError = HotUpdaterException.insufficientDiskSpace(requiredSpace, availableBytes)
                            }
                        }
                    },
                ) { downloadProgress ->
                    // Map download progress to 0.0 - 0.8
                    emitArchiveProgress(progressCallback, downloadProgress * 0.8)
                }

            // Check for disk space error first before processing download result
            diskSpaceError?.let {
                Log.d(TAG, "Throwing disk space error")
                tempDir.deleteRecursively()
                throw it
            }

            when (downloadResult) {
                is DownloadResult.Error -> {
                    Log.d("BundleStorage", "Download failed: ${downloadResult.exception.message}")
                    tempDir.deleteRecursively()

                    // Check if this is an incomplete download error
                    if (downloadResult.exception is IncompleteDownloadException) {
                        val incompleteEx = downloadResult.exception as IncompleteDownloadException
                        throw HotUpdaterException.incompleteDownload(
                            incompleteEx.expectedSize,
                            incompleteEx.actualSize,
                        )
                    } else {
                        throw HotUpdaterException.downloadFailed(downloadResult.exception)
                    }
                }

                is DownloadResult.Success -> {
                    Log.d("BundleStorage", "Download successful")
                    // 1) Verify bundle integrity (hash or signature based on fileHash format)
                    Log.d("BundleStorage", "Verifying bundle integrity...")
                    try {
                        SignatureVerifier.verifyBundle(context, tempBundleFile, fileHash)
                        Log.d("BundleStorage", "Bundle verification completed successfully")
                    } catch (e: SignatureVerificationException) {
                        Log.e("BundleStorage", "Bundle verification failed", e)
                        tempDir.deleteRecursively()
                        tempBundleFile.delete()
                        throw HotUpdaterException.signatureVerificationFailed(e)
                    }

                    // 2) Create a .tmp directory under bundle-store (to avoid colliding with an existing bundleId folder)
                    val tmpDir = File(bundleStoreDir, "$bundleId.tmp")
                    if (tmpDir.exists()) {
                        tmpDir.deleteRecursively()
                    }
                    tmpDir.mkdirs()

                    // 3) Extract archive into tmpDir (80% - 100%)
                    Log.d("BundleStorage", "Extracting $tempBundleFile → $tmpDir")
                    if (!decompressService.extractZipFile(
                            tempBundleFile.absolutePath,
                            tmpDir.absolutePath,
                        ) { unzipProgress ->
                            // Map unzip progress (0.0 - 1.0) to overall progress (0.8 - 1.0)
                            emitArchiveProgress(
                                progressCallback,
                                0.8 + (unzipProgress * 0.2),
                            )
                        }
                    ) {
                        Log.d("BundleStorage", "Failed to extract archive into tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        throw HotUpdaterException.extractionFormatError()
                    }

                    // 4) Resolve the extracted Android bundle file.
                    val extractedBundleFile = resolveBundleFile(tmpDir)
                    if (extractedBundleFile == null) {
                        Log.d("BundleStorage", "Android bundle file could not be resolved in tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        throw HotUpdaterException.invalidBundle()
                    }

                    // 5) Log extracted bundle file size
                    val bundleSize = extractedBundleFile.length()
                    Log.d("BundleStorage", "Extracted bundle size: $bundleSize bytes")

                    // 6) If the realDir (bundle-store/<bundleId>) exists, delete it
                    if (finalBundleDir.exists()) {
                        finalBundleDir.deleteRecursively()
                    }

                    // 7) Attempt to rename tmpDir → finalBundleDir (atomic within the same parent folder)
                    val renamed = tmpDir.renameTo(finalBundleDir)
                    if (!renamed) {
                        // If rename fails, use moveItem as fallback
                        if (!fileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                            // If move also fails, try copy + delete as last resort
                            if (!fileSystem.copyItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                                // All strategies failed
                                Log.e(
                                    "BundleStorage",
                                    "Failed to move bundle from tmpDir to finalBundleDir (rename, move, and copy all failed)",
                                )
                                tempDir.deleteRecursively()
                                tmpDir.deleteRecursively()
                                throw HotUpdaterException.moveOperationFailed()
                            }
                            // Copy succeeded, clean up tmpDir
                            tmpDir.deleteRecursively()
                        }
                    }

                    // 8) Verify the Android bundle file exists inside finalBundleDir.
                    val finalBundleFile = resolveBundleFile(finalBundleDir)
                    if (finalBundleFile == null) {
                        Log.d("BundleStorage", "Android bundle file could not be resolved in realDir.")
                        tempDir.deleteRecursively()
                        finalBundleDir.deleteRecursively()
                        throw HotUpdaterException.invalidBundle()
                    }

                    // 9) Update finalBundleDir's last modified time
                    finalBundleDir.setLastModified(System.currentTimeMillis())

                    // 10) Save the new bundle as STAGING with verification pending
                    val bundlePath = finalBundleFile.absolutePath
                    Log.d(TAG, "Setting bundle as staging: $bundlePath")

                    // Update metadata: set new bundle as staging
                    val currentMetadata = loadMetadataOrNull() ?: createInitialMetadata()
                    val updatedMetadata = prepareMetadataForNewStagingBundle(currentMetadata, bundleId)
                    saveMetadata(updatedMetadata)

                    // Also update HotUpdaterBundleURL for backwards compatibility
                    // This will point to the staging bundle that will be loaded
                    setBundleURL(bundlePath)

                    // 11) Clean up temporary and download folders
                    tempDir.deleteRecursively()

                    // 12) Keep the fallback bundle and the new staging bundle.
                    cleanupOldBundles(bundleStoreDir, updatedMetadata.stableBundleId, bundleId)

                    Log.d(TAG, "Downloaded and set bundle as staging successfully for the next launch.")
                    // Progress already at 1.0 from unzip completion
                }
            }
        }
    }

    /**
     * Removes old bundles except for the specified bundle IDs, and any leftover .tmp directories
     */
    private suspend fun updateBundleFromManifest(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        changedAssets: Map<String, ChangedAssetDescriptor>,
        bundleStoreDir: File,
        finalBundleDir: File,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ) {
        val activeBundleDir = getActiveBundleDir()
        val currentBundleId = getBundleId()
        val currentManifest =
            getActiveBundleMetadataSnapshot()?.manifest?.let(::parseBundleManifestFromMap)
        val baseDir = fileSystem.getExternalFilesDir() ?: bundleStoreDir.parentFile ?: bundleStoreDir
        val tempDir = File(baseDir, "bundle-manifest-temp")
        val tmpDir = File(bundleStoreDir, "$bundleId.tmp")

        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        val diffFiles = createDiffProgressFiles(changedAssets)

        try {
            val manifestFile = File(tempDir, "manifest.json")
            emitDiffProgress(
                progressCallback = progressCallback,
                phase = "manifest",
                files = diffFiles,
                manifestProgress = 0.0,
            )
            when (
                val manifestDownloadResult =
                    downloadService.downloadFile(
                        URL(manifestUrl),
                        manifestFile,
                    ) { downloadProgress ->
                        emitDiffProgress(
                            progressCallback = progressCallback,
                            phase = "manifest",
                            files = diffFiles,
                            manifestProgress = downloadProgress,
                        )
                    }
            ) {
                is DownloadResult.Error -> {
                    if (manifestDownloadResult.exception is IncompleteDownloadException) {
                        val incompleteEx =
                            manifestDownloadResult.exception as IncompleteDownloadException
                        throw HotUpdaterException.incompleteDownload(
                            incompleteEx.expectedSize,
                            incompleteEx.actualSize,
                        )
                    }
                    throw HotUpdaterException.downloadFailed(manifestDownloadResult.exception)
                }

                is DownloadResult.Success -> Unit
            }

            try {
                SignatureVerifier.verifyBundle(context, manifestFile, manifestFileHash)
            } catch (e: SignatureVerificationException) {
                throw HotUpdaterException.signatureVerificationFailed(e)
            }

            val targetManifest = parseBundleManifestFromFile(manifestFile) ?: throw HotUpdaterException.invalidBundle()
            if (targetManifest.bundleId != bundleId) {
                throw HotUpdaterException.invalidBundle()
            }
            emitDiffProgress(
                progressCallback = progressCallback,
                phase = if (diffFiles.isEmpty()) "finalizing" else "downloading",
                files = diffFiles,
            )

            if (tmpDir.exists()) {
                tmpDir.deleteRecursively()
            }
            tmpDir.mkdirs()

            val targetEntries = targetManifest.assets.entries.toList()
            targetEntries.forEachIndexed { index, (assetPath, expectedAsset) ->
                val expectedHash = expectedAsset.fileHash
                val targetFile = File(tmpDir, assetPath)
                val currentAsset = currentManifest?.assets?.get(assetPath)

                if (currentAsset?.fileHash == expectedHash) {
                    val sourceDir =
                        activeBundleDir
                            ?: throw HotUpdaterException.downloadFailed(
                                IllegalStateException("Current bundle directory unavailable for reused asset: $assetPath"),
                            )
                    val sourceFile = File(sourceDir, assetPath)
                    if (!sourceFile.exists() || !HashUtils.verifyHash(sourceFile, expectedHash)) {
                        throw HotUpdaterException.downloadFailed(
                            IllegalStateException("Reusable asset missing or corrupted: $assetPath"),
                        )
                    }
                    copyBundleFile(sourceFile, targetFile)
                    verifyManifestAssetFileOrThrow(targetFile, expectedAsset)
                    return@forEachIndexed
                }

                val changedAsset =
                    changedAssets[assetPath]
                        ?: run {
                            updateDiffProgressFile(
                                files = diffFiles,
                                assetPath = assetPath,
                                status = "failed",
                                progress = 0.0,
                            )
                            emitDiffProgress(
                                progressCallback = progressCallback,
                                phase = "downloading",
                                files = diffFiles,
                            )
                            throw HotUpdaterException.downloadFailed(
                                IllegalStateException("Changed asset missing from update response: $assetPath"),
                            )
                        }

                if (!changedAsset.fileHash.equals(expectedHash, ignoreCase = true)) {
                    updateDiffProgressFile(
                        files = diffFiles,
                        assetPath = assetPath,
                        status = "failed",
                        progress = 0.0,
                    )
                    emitDiffProgress(
                        progressCallback = progressCallback,
                        phase = "downloading",
                        files = diffFiles,
                    )
                    throw HotUpdaterException.signatureVerificationFailed(
                        SignatureVerificationException.FileHashMismatch(),
                    )
                }

                val patched =
                    applyPatchAssetIfPossible(
                        assetPath = assetPath,
                        changedAsset = changedAsset,
                        currentBundleId = currentBundleId,
                        activeBundleDir = activeBundleDir,
                        targetFile = targetFile,
                        expectedHash = expectedHash,
                        tempDir = tempDir,
                        diffFiles = diffFiles,
                        progressCallback = progressCallback,
                    )
                if (patched) {
                    verifyManifestAssetFileOrThrow(targetFile, expectedAsset)
                    updateDiffProgressFile(
                        files = diffFiles,
                        assetPath = assetPath,
                        status = "downloaded",
                        progress = 1.0,
                    )
                    emitDiffProgress(
                        progressCallback = progressCallback,
                        phase =
                            if (diffFiles.all { it.status == "downloaded" }) {
                                "finalizing"
                            } else {
                                "downloading"
                            },
                        files = diffFiles,
                    )
                    return@forEachIndexed
                }

                when (
                    val assetDownloadResult =
                        downloadService.downloadFile(
                            URL(changedAsset.fileUrl),
                            targetFile,
                        ) { downloadProgress ->
                            updateDiffProgressFile(
                                files = diffFiles,
                                assetPath = assetPath,
                                status = "downloading",
                                progress = downloadProgress,
                            )
                            emitDiffProgress(
                                progressCallback = progressCallback,
                                phase = "downloading",
                                files = diffFiles,
                            )
                        }
                ) {
                    is DownloadResult.Error -> {
                        updateDiffProgressFile(
                            files = diffFiles,
                            assetPath = assetPath,
                            status = "failed",
                            progress =
                                diffFiles
                                    .firstOrNull { it.path == assetPath }
                                    ?.progress ?: 0.0,
                        )
                        emitDiffProgress(
                            progressCallback = progressCallback,
                            phase = "downloading",
                            files = diffFiles,
                        )
                        if (assetDownloadResult.exception is IncompleteDownloadException) {
                            val incompleteEx =
                                assetDownloadResult.exception as IncompleteDownloadException
                            throw HotUpdaterException.incompleteDownload(
                                incompleteEx.expectedSize,
                                incompleteEx.actualSize,
                            )
                        }
                        throw HotUpdaterException.downloadFailed(assetDownloadResult.exception)
                    }

                    is DownloadResult.Success -> {
                        try {
                            verifyManifestAssetFileOrThrow(
                                assetDownloadResult.file,
                                expectedAsset,
                            )
                        } catch (e: HotUpdaterException) {
                            updateDiffProgressFile(
                                files = diffFiles,
                                assetPath = assetPath,
                                status = "failed",
                                progress = 1.0,
                            )
                            emitDiffProgress(
                                progressCallback = progressCallback,
                                phase = "downloading",
                                files = diffFiles,
                            )
                            throw e
                        }
                        updateDiffProgressFile(
                            files = diffFiles,
                            assetPath = assetPath,
                            status = "downloaded",
                            progress = 1.0,
                        )
                        emitDiffProgress(
                            progressCallback = progressCallback,
                            phase = if (diffFiles.all { it.status == "downloaded" }) "finalizing" else "downloading",
                            files = diffFiles,
                        )
                    }
                }
            }

            emitDiffProgress(
                progressCallback = progressCallback,
                phase = "finalizing",
                files = diffFiles,
            )

            writeBundleManifestFile(File(tmpDir, "manifest.json"), targetManifest)

            val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
            if (extractedIndex == null) {
                throw HotUpdaterException.invalidBundle()
            }

            if (finalBundleDir.exists()) {
                finalBundleDir.deleteRecursively()
            }

            val renamed = tmpDir.renameTo(finalBundleDir)
            if (!renamed) {
                if (!fileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                    if (!fileSystem.copyItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                        throw HotUpdaterException.moveOperationFailed()
                    }
                    tmpDir.deleteRecursively()
                }
            }

            val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (finalIndexFile == null) {
                finalBundleDir.deleteRecursively()
                throw HotUpdaterException.invalidBundle()
            }

            finalBundleDir.setLastModified(System.currentTimeMillis())

            val currentMetadata = loadMetadataOrNull() ?: createInitialMetadata()
            val updatedMetadata = prepareMetadataForNewStagingBundle(currentMetadata, bundleId)
            saveMetadata(updatedMetadata)
            setBundleURL(finalIndexFile.absolutePath)

            tempDir.deleteRecursively()
            cleanupOldBundles(bundleStoreDir, updatedMetadata.stableBundleId, bundleId)
            progressCallback(
                UpdateProgressPayload(
                    progress = 1.0,
                    artifactType = "diff",
                    details =
                        DiffProgressDetails(
                            totalFilesCount = diffFiles.size,
                            completedFilesCount = diffFiles.count { it.status == "downloaded" },
                            files = diffFiles.toList(),
                        ),
                ),
            )
        } catch (e: Exception) {
            tempDir.deleteRecursively()
            tmpDir.deleteRecursively()
            throw e
        }
    }

    private fun cleanupOldBundles(
        bundleStoreDir: File,
        currentBundleId: String?,
        bundleId: String,
    ) {
        try {
            // List only directories that are not .tmp
            val bundles =
                bundleStoreDir
                    .listFiles { file ->
                        file.isDirectory && !file.name.endsWith(".tmp")
                    }?.toList() ?: return

            // Keep only the specified bundle IDs (filter out null values)
            val bundleIdsToKeep = setOfNotNull(currentBundleId, bundleId).filter { it.isNotBlank() }

            bundles.forEach { bundle ->
                try {
                    if (bundle.name !in bundleIdsToKeep) {
                        Log.d(TAG, "Removing old bundle: ${bundle.name}")
                        if (bundle.deleteRecursively()) {
                            Log.d(TAG, "Successfully removed old bundle: ${bundle.name}")
                        } else {
                            Log.w(TAG, "Failed to remove old bundle: ${bundle.name}")
                        }
                    } else {
                        Log.d(TAG, "Keeping bundle: ${bundle.name}")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error removing bundle ${bundle.name}: ${e.message}")
                }
            }

            // Remove any leftover .tmp directories
            bundleStoreDir
                .listFiles { file ->
                    file.isDirectory && file.name.endsWith(".tmp")
                }?.forEach { staleTmp ->
                    try {
                        Log.d(TAG, "Removing stale tmp directory: ${staleTmp.name}")
                        if (staleTmp.deleteRecursively()) {
                            Log.d(TAG, "Successfully removed tmp directory: ${staleTmp.name}")
                        } else {
                            Log.w(TAG, "Failed to remove tmp directory: ${staleTmp.name}")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error removing tmp directory ${staleTmp.name}: ${e.message}")
                    }
                }
        } catch (e: Exception) {
            Log.e(TAG, "Error during cleanup: ${e.message}")
        }
    }

    /**
     * Gets the base URL for the current active bundle directory.
     * Returns the file:// URL to the bundle directory without trailing slash.
     * This is used for Expo DOM components to construct full asset paths.
     * @return Base URL string (e.g., "file:///data/.../bundle-store/abc123") or empty string
     */
    override fun getBaseURL(): String {
        return try {
            val activeBundleId = getActiveBundleId()

            if (activeBundleId != null) {
                val bundleDir = File(getBundleStoreDir(), activeBundleId)
                if (bundleDir.exists()) {
                    return "file://${bundleDir.absolutePath}"
                }
            }

            ""
        } catch (e: Exception) {
            Log.e(TAG, "Error getting base URL: ${e.message}")
            ""
        }
    }

    override fun getBaseURLForBundle(bundleId: String?): String {
        return try {
            val activeBundleId = bundleId?.takeIf { it.isNotBlank() } ?: return ""
            val bundleDir = File(getBundleStoreDir(), activeBundleId)
            if (!bundleDir.exists()) {
                return ""
            }

            "file://${bundleDir.absolutePath}"
        } catch (e: Exception) {
            Log.e(TAG, "Error getting base URL for bundle $bundleId: ${e.message}")
            ""
        }
    }

    override fun getBundleId(): String? =
        try {
            getActiveBundleMetadataSnapshot()?.bundleId
        } catch (e: Exception) {
            Log.e(TAG, "Error getting bundle ID: ${e.message}")
            null
        }

    override fun getManifest(): Map<String, Any?> =
        try {
            getActiveBundleMetadataSnapshot()?.manifest ?: emptyMap()
        } catch (e: Exception) {
            Log.e(TAG, "Error getting manifest: ${e.message}")
            emptyMap()
        }

    override fun getManifestForBundle(bundleId: String?): Map<String, Any?> =
        try {
            getBundleMetadataSnapshot(bundleId)?.manifest ?: emptyMap()
        } catch (e: Exception) {
            Log.e(TAG, "Error getting manifest for bundle $bundleId: ${e.message}")
            emptyMap()
        }

    override suspend fun resetChannel(): Boolean =
        withContext(Dispatchers.IO) {
            if (!setBundleURL(null)) {
                return@withContext false
            }

            val clearedMetadata =
                BundleMetadata(
                    isolationKey = isolationKey,
                    stableBundleId = null,
                    stagingBundleId = null,
                    verificationPending = false,
                )

            if (!saveMetadata(clearedMetadata)) {
                return@withContext false
            }

            saveLaunchReport(null)

            getBundleStoreDir().listFiles()?.forEach { file ->
                if (
                    file.name == BundleMetadata.METADATA_FILENAME ||
                    file.name == CrashedHistory.CRASHED_HISTORY_FILENAME ||
                    file.name == LaunchReport.LAUNCH_REPORT_FILENAME
                ) {
                    return@forEach
                }

                if (file.isDirectory) {
                    file.deleteRecursively()
                }
            }

            true
        }
}
