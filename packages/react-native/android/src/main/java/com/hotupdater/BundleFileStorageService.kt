package com.hotupdater

import android.os.StatFs
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL

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
        progressCallback: (Double) -> Unit,
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

    init {
        // Ensure bundle store directory exists
        getBundleStoreDir().mkdirs()

        // Clean up old bundles if isolationKey format changed
        checkAndCleanupIfIsolationKeyChanged()
    }

    private var currentLaunchReport: LaunchReport? = null

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

    private fun findBundleFile(bundleId: String): File? {
        val bundleDir = File(getBundleStoreDir(), bundleId)
        return bundleDir.walk().find { it.name == "index.android.bundle" && it.exists() }
    }

    private fun getBundleUrlForId(bundleId: String): String? = findBundleFile(bundleId)?.absolutePath

    private fun getCurrentVerifiedBundleId(metadata: BundleMetadata): String? =
        when {
            metadata.stagingBundleId != null && !metadata.verificationPending -> metadata.stagingBundleId
            metadata.stableBundleId != null -> metadata.stableBundleId
            else -> null
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
        progressCallback: (Double) -> Unit,
    ) {
        Log.d(
            TAG,
            "updateBundle bundleId $bundleId fileUrl $fileUrl fileHash $fileHash",
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
            val existingIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (existingIndexFile != null) {
                // Update last modified time
                finalBundleDir.setLastModified(System.currentTimeMillis())

                // Update metadata: set as staging
                val currentMetadata = loadMetadataOrNull() ?: createInitialMetadata()
                val updatedMetadata = prepareMetadataForNewStagingBundle(currentMetadata, bundleId)
                saveMetadata(updatedMetadata)

                // Set bundle URL for backwards compatibility
                setBundleURL(existingIndexFile.absolutePath)

                // Keep the current verified bundle as a fallback if one exists.
                cleanupOldBundles(bundleStoreDir, updatedMetadata.stableBundleId, bundleId)

                Log.d(TAG, "Existing bundle set as staging bundle for next launch")
                return
            } else {
                // If index.android.bundle is missing, delete and re-download
                finalBundleDir.deleteRecursively()
            }
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
                    progressCallback(downloadProgress * 0.8)
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
                            progressCallback(0.8 + (unzipProgress * 0.2))
                        }
                    ) {
                        Log.d("BundleStorage", "Failed to extract archive into tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        throw HotUpdaterException.extractionFormatError()
                    }

                    // 4) Find index.android.bundle inside tmpDir
                    val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
                    if (extractedIndex == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        throw HotUpdaterException.invalidBundle()
                    }

                    // 5) Log extracted bundle file size
                    val bundleSize = extractedIndex.length()
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

                    // 8) Verify index.android.bundle exists inside finalBundleDir
                    val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                    if (finalIndexFile == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in realDir.")
                        tempDir.deleteRecursively()
                        finalBundleDir.deleteRecursively()
                        throw HotUpdaterException.invalidBundle()
                    }

                    // 9) Update finalBundleDir's last modified time
                    finalBundleDir.setLastModified(System.currentTimeMillis())

                    // 10) Save the new bundle as STAGING with verification pending
                    val bundlePath = finalIndexFile.absolutePath
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
            val metadata = loadMetadataOrNull()
            val activeBundleId =
                when {
                    metadata?.stagingBundleId != null -> metadata.stagingBundleId
                    metadata?.stableBundleId != null -> metadata.stableBundleId
                    else -> extractBundleIdFromCurrentURL()
                }

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
