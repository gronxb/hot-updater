package com.hotupdater

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
     * @param progressCallback Callback for download progress updates
     * @return true if the update was successful
     */
    suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        progressCallback: (Double) -> Unit,
    ): Boolean
}

/**
 * Implementation of BundleStorageService
 */
class BundleFileStorageService(
    private val fileSystem: FileSystemService,
    private val downloadService: DownloadService,
    private val unzipService: UnzipService,
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
        progressCallback: (Double) -> Unit,
    ): Boolean {
        Log.d("BundleStorage", "updateBundle bundleId $bundleId fileUrl $fileUrl")

        if (fileUrl.isNullOrEmpty()) {
            setBundleURL(null)
            return true
        }

        val baseDir = fileSystem.getExternalFilesDir()
        val bundleStoreDir = File(baseDir, "bundle-store")
        if (!bundleStoreDir.exists()) {
            bundleStoreDir.mkdirs()
        }

        val finalBundleDir = File(bundleStoreDir, bundleId)
        if (finalBundleDir.exists()) {
            Log.d("BundleStorage", "Bundle for bundleId $bundleId already exists. Using cached bundle.")
            val existingIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (existingIndexFile != null) {
                finalBundleDir.setLastModified(System.currentTimeMillis())
                setBundleURL(existingIndexFile.absolutePath)
                cleanupOldBundles(bundleStoreDir)
                return true
            } else {
                finalBundleDir.deleteRecursively()
            }
        }

        val tempDir = File(baseDir, "bundle-temp")
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        val tempZipFile = File(tempDir, "bundle.zip")
        val extractedDir = File(tempDir, "extracted")
        extractedDir.mkdirs()

        return withContext(Dispatchers.IO) {
            val downloadUrl = URL(fileUrl)

            // Download the file
            val downloadResult =
                downloadService.downloadFile(
                    downloadUrl,
                    tempZipFile,
                    progressCallback,
                )

            when (downloadResult) {
                is DownloadResult.Error -> {
                    Log.d("BundleStorage", "Download failed: ${downloadResult.exception.message}")
                    tempDir.deleteRecursively()
                    return@withContext false
                }
                is DownloadResult.Success -> {
                    // Extract the zip file
                    if (!unzipService.extractZipFile(tempZipFile.absolutePath, extractedDir.absolutePath)) {
                        Log.d("BundleStorage", "Failed to extract zip file.")
                        tempDir.deleteRecursively()
                        return@withContext false
                    }

                    // Find the bundle file
                    val indexFileExtracted = extractedDir.walk().find { it.name == "index.android.bundle" }
                    if (indexFileExtracted == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in extracted files.")
                        tempDir.deleteRecursively()
                        return@withContext false
                    }

                    // Move to final location
                    if (finalBundleDir.exists()) {
                        finalBundleDir.deleteRecursively()
                    }

                    if (!fileSystem.moveItem(extractedDir.absolutePath, finalBundleDir.absolutePath)) {
                        fileSystem.copyItem(extractedDir.absolutePath, finalBundleDir.absolutePath)
                        extractedDir.deleteRecursively()
                    }

                    val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                    if (finalIndexFile == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in final directory.")
                        tempDir.deleteRecursively()
                        return@withContext false
                    }

                    finalBundleDir.setLastModified(System.currentTimeMillis())
                    val bundlePath = finalIndexFile.absolutePath
                    Log.d("BundleStorage", "Setting bundle URL: $bundlePath")
                    setBundleURL(bundlePath)
                    cleanupOldBundles(bundleStoreDir)
                    tempDir.deleteRecursively()

                    Log.d("BundleStorage", "Downloaded and extracted file successfully.")
                    return@withContext true
                }
            }
        }
    }

    private fun cleanupOldBundles(bundleStoreDir: File) {
        val bundles = bundleStoreDir.listFiles { file -> file.isDirectory }?.toList() ?: return
        val sortedBundles = bundles.sortedByDescending { it.lastModified() }
        if (sortedBundles.size > 1) {
            sortedBundles.drop(1).forEach { oldBundle ->
                Log.d("BundleStorage", "Removing old bundle: ${oldBundle.name}")
                oldBundle.deleteRecursively()
            }
        }
    }
}
