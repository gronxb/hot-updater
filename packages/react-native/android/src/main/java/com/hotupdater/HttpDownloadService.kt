package com.hotupdater

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Result wrapper for download operations
 */
sealed class DownloadResult {
    data class Success(
        val file: File,
    ) : DownloadResult()

    data class Error(
        val exception: Exception,
    ) : DownloadResult()
}

/**
 * Interface for download operations
 */
interface DownloadService {
    /**
     * Gets the file size from the URL without downloading
     * @param fileUrl The URL to check
     * @return File size in bytes, or -1 if unavailable
     */
    suspend fun getFileSize(fileUrl: URL): Long

    /**
     * Downloads a file from a URL
     * @param fileUrl The URL to download from
     * @param destination The local file to save to
     * @param progressCallback Callback for download progress updates
     * @return Result indicating success or failure
     */
    suspend fun downloadFile(
        fileUrl: URL,
        destination: File,
        progressCallback: (Double) -> Unit,
    ): DownloadResult
}

/**
 * Implementation of DownloadService using HttpURLConnection
 */
class HttpDownloadService : DownloadService {
    override suspend fun getFileSize(fileUrl: URL): Long =
        withContext(Dispatchers.IO) {
            try {
                val conn = fileUrl.openConnection() as HttpURLConnection
                conn.requestMethod = "HEAD"
                conn.connect()
                val contentLength = conn.contentLength.toLong()
                conn.disconnect()
                contentLength
            } catch (e: Exception) {
                Log.d("DownloadService", "Failed to get file size: ${e.message}")
                -1L
            }
        }

    override suspend fun downloadFile(
        fileUrl: URL,
        destination: File,
        progressCallback: (Double) -> Unit,
    ): DownloadResult =
        withContext(Dispatchers.IO) {
            val conn =
                try {
                    fileUrl.openConnection() as HttpURLConnection
                } catch (e: Exception) {
                    Log.d("DownloadService", "Failed to open connection: ${e.message}")
                    return@withContext DownloadResult.Error(e)
                }

            try {
                conn.connect()
                val totalSize = conn.contentLength
                if (totalSize <= 0) {
                    Log.d("DownloadService", "Invalid content length: $totalSize")
                    return@withContext DownloadResult.Error(Exception("Invalid content length: $totalSize"))
                }

                // Make sure parent directories exist
                destination.parentFile?.mkdirs()

                conn.inputStream.use { input ->
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(8 * 1024)
                        var bytesRead: Int
                        var totalRead = 0L
                        var lastProgressTime = System.currentTimeMillis()

                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            totalRead += bytesRead
                            val currentTime = System.currentTimeMillis()
                            if (currentTime - lastProgressTime >= 100) {
                                val progress = totalRead.toDouble() / totalSize
                                progressCallback.invoke(progress)
                                lastProgressTime = currentTime
                            }
                        }
                        progressCallback.invoke(1.0)
                    }
                }
                DownloadResult.Success(destination)
            } catch (e: Exception) {
                Log.d("DownloadService", "Failed to download data from URL: $fileUrl, Error: ${e.message}")
                DownloadResult.Error(e)
            } finally {
                conn.disconnect()
            }
        }
}
