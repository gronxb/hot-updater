package com.hotupdater

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipFile

class BundleFileManager(
    private val context: Context,
) {
    private val baseDir by lazy { context.getExternalFilesDir(null) }
    private val bundleStoreDir by lazy {
        File(baseDir, "bundle-store").also { if (!it.exists()) it.mkdirs() }
    }
    private val tempDir by lazy {
        File(baseDir, "bundle-temp")
    }

    fun getBundleStoreDirectory(): File = bundleStoreDir

    fun getTemporaryDirectory(): File = tempDir

    suspend fun downloadBundle(
        zipUrl: String,
        progressCallback: (Double) -> Unit,
    ): File? {
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()
        val tempZipFile = File(tempDir, "bundle.zip")

        return withContext(Dispatchers.IO) {
            try {
                val downloadUrl = URL(zipUrl)
                val conn = downloadUrl.openConnection() as HttpURLConnection
                conn.connect()

                val totalSize = conn.contentLength
                if (totalSize <= 0) {
                    Log.d(TAG, "Invalid content length: $totalSize")
                    tempDir.deleteRecursively()
                    return@withContext null
                }

                conn.inputStream.use { input ->
                    tempZipFile.outputStream().use { output ->
                        copyStreamWithProgress(input, output, totalSize, progressCallback)
                    }
                }
                conn.disconnect()
                tempZipFile
            } catch (e: Exception) {
                Log.e(TAG, "Failed to download bundle from $zipUrl: ${e.message}", e)
                tempDir.deleteRecursively()
                null
            }
        }
    }

    private fun copyStreamWithProgress(
        inputStream: InputStream,
        outputStream: FileOutputStream,
        totalSize: Int,
        progressCallback: (Double) -> Unit,
    ) {
        val buffer = ByteArray(8 * 1024)
        var bytesRead: Int
        var totalRead = 0L
        var lastProgressTime = System.currentTimeMillis()

        while (inputStream.read(buffer).also { bytesRead = it } != -1) {
            outputStream.write(buffer, 0, bytesRead)
            totalRead += bytesRead
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastProgressTime >= 100 || totalRead == totalSize.toLong()) {
                val progress = totalRead.toDouble() / totalSize
                progressCallback(progress)
                lastProgressTime = currentTime
            }
        }
        // Ensure final progress is reported
        if (totalRead != totalSize.toLong()) {
            progressCallback(1.0)
        }
    }

    suspend fun extractBundle(zipFile: File): File? {
        val extractedDir = File(tempDir, "extracted")
        if (extractedDir.exists()) {
            extractedDir.deleteRecursively()
        }
        extractedDir.mkdirs()

        return withContext(Dispatchers.IO) {
            try {
                ZipFile(zipFile).use { zip ->
                    zip.entries().asSequence().forEach { entry ->
                        val file = File(extractedDir, entry.name)
                        if (entry.isDirectory) {
                            file.mkdirs()
                        } else {
                            file.parentFile?.mkdirs()
                            zip.getInputStream(entry).use { input ->
                                file.outputStream().use { output -> input.copyTo(output) }
                            }
                        }
                    }
                }
                // Verify extraction
                val indexFile = findIndexBundle(extractedDir)
                if (indexFile != null) extractedDir else null
            } catch (e: Exception) {
                Log.e(TAG, "Failed to extract zip file: ${e.message}", e)
                extractedDir.deleteRecursively()
                null
            }
        }
    }

    suspend fun installBundle(
        extractedDir: File,
        bundleId: String,
    ): File? =
        withContext(Dispatchers.IO) {
            val finalBundleDir = File(bundleStoreDir, bundleId)
            if (finalBundleDir.exists()) {
                finalBundleDir.deleteRecursively()
            }

            try {
                // Attempt to rename first for efficiency
                if (!extractedDir.renameTo(finalBundleDir)) {
                    // Fallback to copy if rename fails (e.g., across different filesystems)
                    extractedDir.copyRecursively(finalBundleDir, overwrite = true)
                    extractedDir.deleteRecursively() // Clean up original extracted dir
                }
                finalBundleDir.setLastModified(System.currentTimeMillis())
                findIndexBundle(finalBundleDir)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to install bundle $bundleId: ${e.message}", e)
                finalBundleDir.deleteRecursively() // Clean up failed installation
                null
            }
        }

    fun findIndexBundle(directory: File): File? = directory.walk().find { it.name == "index.android.bundle" && it.isFile }

    fun cleanupTemporaryFiles() {
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
            Log.d(TAG, "Cleaned up temporary directory.")
        }
    }

    fun cleanupOldBundles(keepCount: Int = 1) {
        val bundles = bundleStoreDir.listFiles { file -> file.isDirectory }?.toList() ?: return
        if (bundles.size > keepCount) {
            val sortedBundles = bundles.sortedByDescending { it.lastModified() }
            sortedBundles.drop(keepCount).forEach { oldBundle ->
                Log.d(TAG, "Removing old bundle: ${oldBundle.name}")
                oldBundle.deleteRecursively()
            }
        }
    }

    companion object {
        private const val TAG = "BundleFileManager"
    }
}
