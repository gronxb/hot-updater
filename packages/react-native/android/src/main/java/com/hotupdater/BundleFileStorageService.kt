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
     * @return The path to the bundle file
     */
    fun getBundleURL(): String

    /**
     * Updates the bundle from the specified URL
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or null to reset)
     * @param fileHash SHA256 hash of the bundle file for verification (nullable)
     * @param progressCallback Callback for download progress updates
     * @return true if the update was successful
     */
    suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        fileHash: String?,
        progressCallback: (Double) -> Unit,
    ): Boolean
}

/**
 * Implementation of BundleStorageService
 */
class BundleFileStorageService(
    private val fileSystem: FileSystemService,
    private val downloadService: DownloadService,
    private val decompressService: DecompressService,
    private val preferences: PreferencesService,
) : BundleStorageService {
    companion object {
        // Lock object for synchronizing cleanup operations across all instances
        private val cleanupLock = Any()
    }

    override fun setBundleURL(localPath: String?): Boolean {
        preferences.setItem("HotUpdaterBundleURL", localPath)
        return true
    }

    override fun getCachedBundleURL(): String? {
        val urlString = preferences.getItem("HotUpdaterBundleURL")
        if (urlString.isNullOrEmpty()) {
            return null
        }

        val file = File(urlString)
        if (!file.exists()) {
            preferences.setItem("HotUpdaterBundleURL", null)
            return null
        }
        return urlString
    }

    override fun getFallbackBundleURL(): String = "assets://index.android.bundle"

    override fun getBundleURL(): String = getCachedBundleURL() ?: getFallbackBundleURL()

    override suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        fileHash: String?,
        progressCallback: (Double) -> Unit,
    ): Boolean {
        Log.d("BundleStorage", "updateBundle bundleId $bundleId fileUrl $fileUrl fileHash $fileHash")

        // If no URL is provided, reset to fallback
        if (fileUrl.isNullOrEmpty()) {
            setBundleURL(null)
            return true
        }

        val baseDir = fileSystem.getExternalFilesDir()
        if (baseDir == null) {
            Log.d("BundleStorage", "External files directory is null")
            return false
        }
        val isolationKey = preferences.getIsolationKey()
        val safeDirName = isolationKey.replace("|", "_")
        val baseBundleStoreDir = File(baseDir, "bundle-store")
        val bundleStoreDir = File(baseBundleStoreDir, safeDirName)
        if (!bundleStoreDir.exists()) {
            bundleStoreDir.mkdirs()
        }

        val currentBundleId =
            getCachedBundleURL()?.let { cachedUrl ->
                // Only consider cached bundles, not fallback bundles
                if (!cachedUrl.startsWith("assets://")) {
                    File(cachedUrl).parentFile?.name
                } else {
                    null
                }
            }
        val finalBundleDir = File(bundleStoreDir, bundleId)
        if (finalBundleDir.exists()) {
            Log.d("BundleStorage", "Bundle for bundleId $bundleId already exists. Using cached bundle.")
            val existingIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (existingIndexFile != null) {
                // Update last modified time and set the cached bundle URL
                finalBundleDir.setLastModified(System.currentTimeMillis())
                setBundleURL(existingIndexFile.absolutePath)
                // Cleanup old bundles (keep only the current bundleId), synchronized to avoid race conditions
                synchronized(cleanupLock) {
                    try {
                        bundleStoreDir
                            .listFiles { file ->
                                file.isDirectory && !file.name.endsWith(".tmp") && file.name != bundleId
                            }?.forEach { it.deleteRecursively() }
                    } catch (e: Exception) {
                        Log.e("BundleStorage", "Error during cleanup: ${e.message}")
                    }
                }
                return true
            } else {
                // If index.android.bundle is missing, delete and re-download
                finalBundleDir.deleteRecursively()
            }
        }

        // Use a unique temp directory for each update to avoid conflicts with concurrent updates
        val tempDir = File(baseDir, "bundle-temp-${System.currentTimeMillis()}-${(0..999).random()}")
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        return withContext(Dispatchers.IO) {
            val downloadUrl = URL(fileUrl)

            // Determine bundle filename from URL
            val bundleFileName =
                if (downloadUrl.path.isNotEmpty()) {
                    File(downloadUrl.path).name.ifEmpty { "bundle.zip" }
                } else {
                    "bundle.zip"
                }
            val tempBundleFile = File(tempDir, bundleFileName)

            // Check file size before downloading
            val fileSize = downloadService.getFileSize(downloadUrl)
            if (fileSize > 0 && baseDir != null) {
                try {
                    // Check available disk space
                    val stat = StatFs(baseDir.absolutePath)
                    val availableBytes = stat.availableBlocksLong * stat.blockSizeLong
                    val requiredSpace = fileSize * 2 // ZIP + extracted files

                    Log.d("BundleStorage", "File size: $fileSize bytes, Available: $availableBytes bytes, Required: $requiredSpace bytes")

                    // Only check disk space if availableBytes > 0 (avoid false positives in test environments where StatFs returns 0)
                    if (availableBytes > 0 && availableBytes < requiredSpace) {
                        val errorMsg = "Insufficient disk space: need $requiredSpace bytes, available $availableBytes bytes"
                        Log.d("BundleStorage", errorMsg)
                        return@withContext false
                    }
                } catch (e: Exception) {
                    // StatFs may fail in test environments (like Robolectric)
                    // Log the error but proceed with download
                    Log.d("BundleStorage", "Unable to check disk space (${e.message}), proceeding with download")
                }
            } else {
                Log.d("BundleStorage", "Unable to determine file size, proceeding with download")
            }

            // Download the file (0% - 80%)
            val downloadResult =
                downloadService.downloadFile(
                    downloadUrl,
                    tempBundleFile,
                ) { downloadProgress ->
                    // Map download progress to 0.0 - 0.8
                    progressCallback(downloadProgress * 0.8)
                }

            when (downloadResult) {
                is DownloadResult.Error -> {
                    Log.d("BundleStorage", "Download failed: ${downloadResult.exception.message}")
                    tempDir.deleteRecursively()
                    return@withContext false
                }
                is DownloadResult.Success -> {
                    Log.d("BundleStorage", "Download successful")
                    // 1) Verify file hash if provided
                    if (!fileHash.isNullOrEmpty()) {
                        Log.d("BundleStorage", "Verifying file hash...")
                        if (!HashUtils.verifyHash(tempBundleFile, fileHash)) {
                            Log.d("BundleStorage", "Hash mismatch! Deleting and aborting.")
                            tempDir.deleteRecursively()
                            tempBundleFile.delete()
                            return@withContext false
                        }
                        Log.d("BundleStorage", "Hash verification passed")
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
                        return@withContext false
                    }

                    // 4) Find index.android.bundle inside tmpDir
                    val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
                    if (extractedIndex == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        return@withContext false
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
                        // If rename fails, use moveItem or copyItem
                        if (!fileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                            fileSystem.copyItem(tmpDir.absolutePath, finalBundleDir.absolutePath)
                            tmpDir.deleteRecursively()
                        }
                    }

                    // 8) Verify index.android.bundle exists inside finalBundleDir
                    val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                    if (finalIndexFile == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in realDir.")
                        tempDir.deleteRecursively()
                        finalBundleDir.deleteRecursively()
                        return@withContext false
                    }

                    // 9) Update finalBundleDir's last modified time
                    finalBundleDir.setLastModified(System.currentTimeMillis())

                    // 10) Save the new bundle path in Preferences
                    val bundlePath = finalIndexFile.absolutePath
                    Log.d("BundleStorage", "Setting bundle URL: $bundlePath")
                    setBundleURL(bundlePath)

                    // 11) Clean up temporary and download folders
                    tempDir.deleteRecursively()

                    // 12) Remove old bundles (keep only the current bundleId), synchronized to avoid race conditions
                    synchronized(cleanupLock) {
                        try {
                            bundleStoreDir
                                .listFiles { file ->
                                    file.isDirectory && !file.name.endsWith(".tmp") && file.name != bundleId
                                }?.forEach { oldBundle ->
                                    try {
                                        Log.d("BundleStorage", "Removing old bundle: ${oldBundle.name}")
                                        oldBundle.deleteRecursively()
                                    } catch (e: Exception) {
                                        Log.e("BundleStorage", "Error removing bundle ${oldBundle.name}: ${e.message}")
                                    }
                                }

                            // Remove any leftover .tmp directories
                            bundleStoreDir
                                .listFiles { file ->
                                    file.isDirectory && file.name.endsWith(".tmp")
                                }?.forEach { staleTmp ->
                                    try {
                                        staleTmp.deleteRecursively()
                                    } catch (e: Exception) {
                                        Log.e("BundleStorage", "Error removing tmp directory: ${e.message}")
                                    }
                                }
                        } catch (e: Exception) {
                            Log.e("BundleStorage", "Error during cleanup: ${e.message}")
                        }
                    }

                    Log.d("BundleStorage", "Downloaded and activated bundle successfully.")
                    // Progress already at 1.0 from unzip completion
                    return@withContext true
                }
            }
        }
    }
}
