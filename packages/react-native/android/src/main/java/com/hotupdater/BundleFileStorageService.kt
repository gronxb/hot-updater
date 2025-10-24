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
    private val preferences: PreferencesService,
) : BundleStorageService {
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
        val bundleStoreDir = File(baseDir, "bundle-store")
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
                cleanupOldBundles(bundleStoreDir, currentBundleId, bundleId)
                return true
            } else {
                // If index.android.bundle is missing, delete and re-download
                finalBundleDir.deleteRecursively()
            }
        }

        val tempDir = File(baseDir, "bundle-temp")
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        val tempZipFile = File(tempDir, "bundle.zip")

        return withContext(Dispatchers.IO) {
            val downloadUrl = URL(fileUrl)

            // Check file size before downloading
            val fileSize = downloadService.getFileSize(downloadUrl)
            if (fileSize > 0 && baseDir != null) {
                // Check available disk space
                val stat = StatFs(baseDir.absolutePath)
                val availableBytes = stat.availableBlocksLong * stat.blockSizeLong
                val requiredSpace = fileSize * 2 // ZIP + extracted files

                Log.d("BundleStorage", "File size: $fileSize bytes, Available: $availableBytes bytes, Required: $requiredSpace bytes")

                if (availableBytes < requiredSpace) {
                    val errorMsg = "Insufficient disk space: need $requiredSpace bytes, available $availableBytes bytes"
                    Log.d("BundleStorage", errorMsg)
                    return@withContext false
                }
            } else {
                Log.d("BundleStorage", "Unable to determine file size, proceeding with download")
            }

            // Download the file (0% - 80%)
            val downloadResult =
                downloadService.downloadFile(
                    downloadUrl,
                    tempZipFile,
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
                    // Get content encoding from download result
                    val contentEncoding = downloadResult.contentEncoding
                    Log.d("BundleStorage", "Downloaded file with Content-Encoding: $contentEncoding")

                    // 1) Verify file hash if provided
                    if (!fileHash.isNullOrEmpty()) {
                        Log.d("BundleStorage", "Verifying file hash...")
                        if (!HashUtils.verifyHash(tempZipFile, fileHash)) {
                            Log.d("BundleStorage", "Hash mismatch! Deleting and aborting.")
                            tempDir.deleteRecursively()
                            tempZipFile.delete()
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

                    // 3) Create appropriate unzip service based on content encoding
                    val unzipService = UnzipServiceFactory.createUnzipService(contentEncoding)

                    // 4) Unzip into tmpDir (80% - 100%)
                    Log.d("BundleStorage", "Extracting $tempZipFile → $tmpDir")
                    if (!unzipService.extractZipFile(
                            tempZipFile.absolutePath,
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

                    // 5) Find index.android.bundle inside tmpDir
                    val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
                    if (extractedIndex == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        return@withContext false
                    }

                    // 6) Log extracted bundle file size
                    val bundleSize = extractedIndex.length()
                    Log.d("BundleStorage", "Extracted bundle size: $bundleSize bytes")

                    // 7) If the realDir (bundle-store/<bundleId>) exists, delete it
                    if (finalBundleDir.exists()) {
                        finalBundleDir.deleteRecursively()
                    }

                    // 8) Attempt to rename tmpDir → finalBundleDir (atomic within the same parent folder)
                    val renamed = tmpDir.renameTo(finalBundleDir)
                    if (!renamed) {
                        // If rename fails, use moveItem or copyItem
                        if (!fileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                            fileSystem.copyItem(tmpDir.absolutePath, finalBundleDir.absolutePath)
                            tmpDir.deleteRecursively()
                        }
                    }

                    // 9) Verify index.android.bundle exists inside finalBundleDir
                    val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                    if (finalIndexFile == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in realDir.")
                        tempDir.deleteRecursively()
                        finalBundleDir.deleteRecursively()
                        return@withContext false
                    }

                    // 10) Update finalBundleDir's last modified time
                    finalBundleDir.setLastModified(System.currentTimeMillis())

                    // 11) Save the new bundle path in Preferences
                    val bundlePath = finalIndexFile.absolutePath
                    Log.d("BundleStorage", "Setting bundle URL: $bundlePath")
                    setBundleURL(bundlePath)

                    // 12) Clean up temporary and download folders
                    tempDir.deleteRecursively()

                    // 13) Remove old bundles
                    cleanupOldBundles(bundleStoreDir, currentBundleId, bundleId)

                    Log.d("BundleStorage", "Downloaded and activated bundle successfully.")
                    // Progress already at 1.0 from unzip completion
                    return@withContext true
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
                        Log.d("BundleStorage", "Removing old bundle: ${bundle.name}")
                        if (bundle.deleteRecursively()) {
                            Log.d("BundleStorage", "Successfully removed old bundle: ${bundle.name}")
                        } else {
                            Log.w("BundleStorage", "Failed to remove old bundle: ${bundle.name}")
                        }
                    } else {
                        Log.d("BundleStorage", "Keeping bundle: ${bundle.name}")
                    }
                } catch (e: Exception) {
                    Log.e("BundleStorage", "Error removing bundle ${bundle.name}: ${e.message}")
                }
            }

            // Remove any leftover .tmp directories
            bundleStoreDir
                .listFiles { file ->
                    file.isDirectory && file.name.endsWith(".tmp")
                }?.forEach { staleTmp ->
                    try {
                        Log.d("BundleStorage", "Removing stale tmp directory: ${staleTmp.name}")
                        if (staleTmp.deleteRecursively()) {
                            Log.d("BundleStorage", "Successfully removed tmp directory: ${staleTmp.name}")
                        } else {
                            Log.w("BundleStorage", "Failed to remove tmp directory: ${staleTmp.name}")
                        }
                    } catch (e: Exception) {
                        Log.e("BundleStorage", "Error removing tmp directory ${staleTmp.name}: ${e.message}")
                    }
                }
        } catch (e: Exception) {
            Log.e("BundleStorage", "Error during cleanup: ${e.message}")
        }
    }
}
