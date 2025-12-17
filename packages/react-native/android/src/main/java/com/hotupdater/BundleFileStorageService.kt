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
     * Gets the URL to the bundle file (cached or fallback)
     * With rollback support: checks for crashed staging bundles
     * @return The path to the bundle file
     */
    fun getBundleURL(): String

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
     * Notifies that the app has started successfully with the current bundle
     * @param currentBundleId The bundle ID that JS reports as currently loaded
     * @return Map containing status and optional crashedBundleId
     */
    fun notifyAppReady(currentBundleId: String?): Map<String, Any?>

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

    // Session-only rollback tracking (in-memory)
    private var sessionRollbackBundleId: String? = null

    // MARK: - Bundle Store Directory

    private fun getBundleStoreDir(): File {
        val baseDir = fileSystem.getExternalFilesDir()
        return File(baseDir, "bundle-store")
    }

    private fun getMetadataFile(): File = File(getBundleStoreDir(), BundleMetadata.METADATA_FILENAME)

    private fun getCrashedHistoryFile(): File = File(getBundleStoreDir(), CrashedHistory.CRASHED_HISTORY_FILENAME)

    // MARK: - Metadata Operations

    private fun loadMetadataOrNull(): BundleMetadata? = BundleMetadata.loadFromFile(getMetadataFile(), isolationKey)

    private fun saveMetadata(metadata: BundleMetadata): Boolean {
        val updatedMetadata = metadata.copy(isolationKey = isolationKey)
        return updatedMetadata.saveToFile(getMetadataFile())
    }

    private fun createInitialMetadata(): BundleMetadata {
        val currentBundleId = extractBundleIdFromCurrentURL()
        Log.d(TAG, "Creating initial metadata with stableBundleId: $currentBundleId")
        return BundleMetadata(
            stableBundleId = currentBundleId,
            stagingBundleId = null,
            verificationPending = false,
            verificationAttemptedAt = null,
        )
    }

    private fun extractBundleIdFromCurrentURL(): String? {
        val currentUrl = preferences.getItem("HotUpdaterBundleURL") ?: return null
        // "bundle-store/abc123/index.android.bundle" -> "abc123"
        val regex = Regex("bundle-store/([^/]+)/")
        return regex.find(currentUrl)?.groupValues?.get(1)
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
            val storedIsolationKey = json.optString("isolationKey", null)

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

    private fun wasVerificationAttempted(metadata: BundleMetadata): Boolean = metadata.verificationAttemptedAt != null

    private fun markVerificationAttempted() {
        val metadata = loadMetadataOrNull() ?: return
        val updatedMetadata =
            metadata.copy(
                verificationAttemptedAt = System.currentTimeMillis(),
                updatedAt = System.currentTimeMillis(),
            )
        saveMetadata(updatedMetadata)
        Log.d(TAG, "Marked verification attempted at ${updatedMetadata.verificationAttemptedAt}")
    }

    private fun promoteStagingToStable() {
        val metadata = loadMetadataOrNull() ?: return
        val stagingBundleId = metadata.stagingBundleId ?: return

        Log.d(TAG, "Promoting staging bundle $stagingBundleId to stable")

        val updatedMetadata =
            metadata.copy(
                stableBundleId = stagingBundleId,
                stagingBundleId = null,
                verificationPending = false,
                verificationAttemptedAt = null,
                updatedAt = System.currentTimeMillis(),
            )
        saveMetadata(updatedMetadata)

        // Update HotUpdaterBundleURL preference to point to stable bundle
        val bundleStoreDir = getBundleStoreDir()
        val stableBundleDir = File(bundleStoreDir, stagingBundleId)
        val bundleFile = stableBundleDir.walk().find { it.name == "index.android.bundle" }
        if (bundleFile != null) {
            preferences.setItem("HotUpdaterBundleURL", bundleFile.absolutePath)
        }

        // Cleanup old bundles (keep only the new stable)
        cleanupOldBundles(bundleStoreDir, null, stagingBundleId)
    }

    private fun rollbackToStable() {
        val metadata = loadMetadataOrNull() ?: return
        val stagingBundleId = metadata.stagingBundleId ?: return

        Log.w(TAG, "Rolling back: adding $stagingBundleId to crashed history")

        // Add to crashed history
        val crashedHistory = loadCrashedHistory()
        crashedHistory.addEntry(stagingBundleId)
        saveCrashedHistory(crashedHistory)

        // Save rollback info to session variable (memory only)
        sessionRollbackBundleId = stagingBundleId

        // Clear staging pointer
        val updatedMetadata =
            metadata.copy(
                stagingBundleId = null,
                verificationPending = false,
                verificationAttemptedAt = null,
                stagingExecutionCount = null,
                updatedAt = System.currentTimeMillis(),
            )
        saveMetadata(updatedMetadata)

        // Update bundle URL to point to stable bundle
        val stableBundleId = updatedMetadata.stableBundleId
        if (stableBundleId != null) {
            val bundleStoreDir = getBundleStoreDir()
            val stableBundleDir = File(bundleStoreDir, stableBundleId)
            val bundleFile = stableBundleDir.walk().find { it.name == "index.android.bundle" }
            if (bundleFile != null && bundleFile.exists()) {
                setBundleURL(bundleFile.absolutePath)
                Log.d(TAG, "Updated bundle URL to stable: $stableBundleId")
            }
        } else {
            // No stable bundle available, clear bundle URL (fallback to assets)
            setBundleURL(null)
            Log.d(TAG, "Cleared bundle URL (no stable bundle)")
        }

        // Remove staging bundle directory
        val bundleStoreDir = getBundleStoreDir()
        val stagingBundleDir = File(bundleStoreDir, stagingBundleId)
        if (stagingBundleDir.exists()) {
            stagingBundleDir.deleteRecursively()
            Log.d(TAG, "Deleted crashed staging bundle directory: $stagingBundleId")
        }
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

    // MARK: - notifyAppReady

    override fun notifyAppReady(currentBundleId: String?): Map<String, Any?> {
        val metadata =
            loadMetadataOrNull()
                ?: return mapOf("status" to "STABLE")

        // Check if there was a recent rollback (session variable)
        sessionRollbackBundleId?.let { crashedBundleId ->
            // Clear rollback info (one-time read)
            sessionRollbackBundleId = null

            Log.d(TAG, "notifyAppReady: recovered from rollback (crashed bundle: $crashedBundleId)")
            return mapOf(
                "status" to "RECOVERED",
                "crashedBundleId" to crashedBundleId,
            )
        }

        // Check for promotion
        if (isVerificationPending(metadata)) {
            val stagingBundleId = metadata.stagingBundleId
            if (stagingBundleId != null && stagingBundleId == currentBundleId) {
                Log.d(TAG, "App started successfully with staging bundle $currentBundleId, promoting to stable")
                promoteStagingToStable()
                return mapOf("status" to "PROMOTED")
            } else {
                Log.d(TAG, "notifyAppReady: bundleId mismatch (staging=$stagingBundleId, current=$currentBundleId)")
            }
        } else {
            Log.d(TAG, "notifyAppReady: no verification pending")
        }

        // No changes
        return mapOf("status" to "STABLE")
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

    // Track if crash detection has already run in this process
    private var crashDetectionCompleted = false

    override fun getBundleURL(): String {
        val metadata = loadMetadataOrNull()

        if (metadata == null) {
            // Legacy mode: no metadata.json exists, use existing behavior
            val cached = getCachedBundleURL()
            val result = cached ?: getFallbackBundleURL()
            Log.d(TAG, "getBundleURL (legacy): returning $result")
            return result
        }

        // New rollback-aware mode - only run crash detection ONCE per process
        if (isVerificationPending(metadata) && !crashDetectionCompleted) {
            crashDetectionCompleted = true

            if (wasVerificationAttempted(metadata)) {
                // Already executed once but didn't call notifyAppReady → crash!
                Log.w(TAG, "Crash detected: staging bundle executed but didn't call notifyAppReady")
                rollbackToStable()
            } else {
                // First execution - mark verification attempted and give it a chance
                Log.d(TAG, "First execution of staging bundle, marking verification attempted")
                markVerificationAttempted()
            }
        }

        // Reload metadata after potential rollback
        val currentMetadata = loadMetadataOrNull()

        // Return staging bundle if verification pending
        if (currentMetadata != null && isVerificationPending(currentMetadata)) {
            val stagingId = currentMetadata.stagingBundleId
            if (stagingId != null) {
                val bundleStoreDir = getBundleStoreDir()
                val stagingBundleDir = File(bundleStoreDir, stagingId)
                val bundleFile = stagingBundleDir.walk().find { it.name == "index.android.bundle" }
                if (bundleFile != null && bundleFile.exists()) {
                    Log.d(TAG, "getBundleURL: returning STAGING bundle $stagingId")
                    return bundleFile.absolutePath
                } else {
                    Log.w(TAG, "getBundleURL: staging bundle file not found for $stagingId")
                    // Staging bundle file missing, rollback to stable
                    rollbackToStable()
                }
            }
        }

        // Return stable bundle URL
        val stableBundleId = currentMetadata?.stableBundleId
        if (stableBundleId != null) {
            val bundleStoreDir = getBundleStoreDir()
            val stableBundleDir = File(bundleStoreDir, stableBundleId)
            val bundleFile = stableBundleDir.walk().find { it.name == "index.android.bundle" }
            if (bundleFile != null && bundleFile.exists()) {
                Log.d(TAG, "getBundleURL: returning stable bundle $stableBundleId")
                return bundleFile.absolutePath
            }
        }

        // Fallback
        val cached = getCachedBundleURL()
        val result = cached ?: getFallbackBundleURL()
        Log.d(TAG, "getBundleURL: returning $result (cached=$cached)")
        return result
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
                val updatedMetadata =
                    currentMetadata.copy(
                        stagingBundleId = bundleId,
                        verificationPending = true,
                        verificationAttemptedAt = null,
                        updatedAt = System.currentTimeMillis(),
                    )
                saveMetadata(updatedMetadata)

                // Set bundle URL for backwards compatibility
                setBundleURL(existingIndexFile.absolutePath)

                // Keep both stable and staging bundles
                val stableBundleId = currentMetadata.stableBundleId
                cleanupOldBundles(bundleStoreDir, stableBundleId, bundleId)

                Log.d(TAG, "Existing bundle set as staging, will be promoted after notifyAppReady")
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
                                Log.w(
                                    "BundleStorage",
                                    "Insufficient disk space: need $requiredSpace bytes, available $availableBytes bytes",
                                )
                                // Note: Cannot throw from callback
                                // Will fail during file write if space runs out
                            }
                        }
                    },
                ) { downloadProgress ->
                    // Map download progress to 0.0 - 0.8
                    progressCallback(downloadProgress * 0.8)
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
                    val updatedMetadata =
                        currentMetadata.copy(
                            stagingBundleId = bundleId,
                            verificationPending = true,
                            verificationAttemptedAt = null,
                            updatedAt = System.currentTimeMillis(),
                        )
                    saveMetadata(updatedMetadata)

                    // Also update HotUpdaterBundleURL for backwards compatibility
                    // This will point to the staging bundle that will be loaded
                    setBundleURL(bundlePath)

                    // 11) Clean up temporary and download folders
                    tempDir.deleteRecursively()

                    // 12) Keep both stable and staging bundles
                    val stableBundleId = currentMetadata.stableBundleId
                    cleanupOldBundles(bundleStoreDir, stableBundleId, bundleId)

                    Log.d(TAG, "Downloaded and set bundle as staging successfully. Will be promoted after notifyAppReady.")
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
                    metadata?.verificationPending == true && metadata.stagingBundleId != null ->
                        metadata.stagingBundleId
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
}
