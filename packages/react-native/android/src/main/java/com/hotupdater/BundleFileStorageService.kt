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

        val finalBundleDir = File(bundleStoreDir, bundleId)
        if (finalBundleDir.exists()) {
            Log.d("BundleStorage", "Bundle for bundleId $bundleId already exists. Using cached bundle.")
            val existingIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (existingIndexFile != null) {
                // Update last modified time and set the cached bundle URL
                finalBundleDir.setLastModified(System.currentTimeMillis())
                setBundleURL(existingIndexFile.absolutePath)
                cleanupOldBundles(bundleStoreDir)
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
                    // 1) Create a .tmp directory under bundle-store (to avoid colliding with an existing bundleId folder)
                    val tmpDir = File(bundleStoreDir, "$bundleId.tmp")
                    if (tmpDir.exists()) {
                        tmpDir.deleteRecursively()
                    }
                    tmpDir.mkdirs()

                    // 2) Unzip into tmpDir
                    Log.d("BundleStorage", "Unzipping $tempZipFile → $tmpDir")
                    if (!unzipService.extractZipFile(tempZipFile.absolutePath, tmpDir.absolutePath)) {
                        Log.d("BundleStorage", "Failed to extract zip into tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        return@withContext false
                    }

                    // 3) Find index.android.bundle inside tmpDir
                    val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
                    if (extractedIndex == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        return@withContext false
                    }

                    // 4) If the realDir (bundle-store/<bundleId>) exists, delete it
                    if (finalBundleDir.exists()) {
                        finalBundleDir.deleteRecursively()
                    }

                    // 5) Attempt to rename tmpDir → finalBundleDir (atomic within the same parent folder)
                    val renamed = tmpDir.renameTo(finalBundleDir)
                    if (!renamed) {
                        // If rename fails, use moveItem or copyItem
                        if (!fileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                            fileSystem.copyItem(tmpDir.absolutePath, finalBundleDir.absolutePath)
                            tmpDir.deleteRecursively()
                        }
                    }

                    // 6) Verify index.android.bundle exists inside finalBundleDir
                    val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                    if (finalIndexFile == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in realDir.")
                        tempDir.deleteRecursively()
                        finalBundleDir.deleteRecursively()
                        return@withContext false
                    }

                    // 7) Update finalBundleDir's last modified time
                    finalBundleDir.setLastModified(System.currentTimeMillis())

                    // 8) Save the new bundle path in Preferences
                    val bundlePath = finalIndexFile.absolutePath
                    Log.d("BundleStorage", "Setting bundle URL: $bundlePath")
                    setBundleURL(bundlePath)

                    // 9) Clean up temporary and download folders
                    tempDir.deleteRecursively()

                    // 10) Remove old bundles
                    cleanupOldBundles(bundleStoreDir)

                    Log.d("BundleStorage", "Downloaded and activated bundle successfully.")
                    return@withContext true
                }
            }
        }
    }

    /**
     * Removes older bundles and any leftover .tmp directories
     */
    private fun cleanupOldBundles(bundleStoreDir: File) {
        // List only directories that are not .tmp
        val bundles = bundleStoreDir.listFiles { file -> file.isDirectory && !file.name.endsWith(".tmp") }?.toList() ?: return
        // Sort bundles by last modified (newest first)
        val sortedBundles = bundles.sortedByDescending { it.lastModified() }
        if (sortedBundles.size > 1) {
            // Keep the most recent bundle, delete the rest
            sortedBundles.drop(1).forEach { oldBundle ->
                Log.d("BundleStorage", "Removing old bundle: ${oldBundle.name}")
                oldBundle.deleteRecursively()
            }
        }

        // Remove any leftover .tmp directories
        bundleStoreDir.listFiles { file -> file.isDirectory && file.name.endsWith(".tmp") }?.forEach { staleTmp ->
            Log.d("BundleStorage", "Removing stale tmp directory: ${staleTmp.name}")
            staleTmp.deleteRecursively()
        }
    }
}
