package com.hotupdater

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.Source
import okio.buffer
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * Exception for incomplete downloads with size information
 */
class IncompleteDownloadException(
    val expectedSize: Long,
    val actualSize: Long,
) : IOException("Download incomplete: received $actualSize bytes, expected $expectedSize bytes")

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
 * Progress tracking wrapper for OkHttp ResponseBody
 */
private class ProgressResponseBody(
    private val responseBody: ResponseBody,
    private val progressCallback: (Double) -> Unit,
) : ResponseBody() {
    private var bufferedSource: BufferedSource? = null

    override fun contentType() = responseBody.contentType()

    override fun contentLength() = responseBody.contentLength()

    override fun source(): BufferedSource {
        if (bufferedSource == null) {
            bufferedSource = source(responseBody.source()).buffer()
        }
        return bufferedSource!!
    }

    private fun source(source: Source): Source =
        object : ForwardingSource(source) {
            var totalBytesRead = 0L
            var lastProgressTime = System.currentTimeMillis()

            override fun read(
                sink: Buffer,
                byteCount: Long,
            ): Long {
                val bytesRead = super.read(sink, byteCount)
                totalBytesRead += if (bytesRead != -1L) bytesRead else 0
                val currentTime = System.currentTimeMillis()

                if (currentTime - lastProgressTime >= 100) {
                    val progress = totalBytesRead.toDouble() / contentLength()
                    progressCallback.invoke(progress)
                    lastProgressTime = currentTime
                }
                return bytesRead
            }
        }
}

/**
 * OkHttp-based implementation of DownloadService with resume support
 */
class OkHttpDownloadService : DownloadService {
    companion object {
        private const val TAG = "OkHttpDownloadService"
        private const val MAX_RETRIES = 3
        private const val INITIAL_RETRY_DELAY_MS = 1000L
        private const val TIMEOUT_SECONDS = 30L
    }

    private val client =
        OkHttpClient
            .Builder()
            .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()

    override suspend fun getFileSize(fileUrl: URL): Long =
        withContext(Dispatchers.IO) {
            try {
                val request =
                    Request
                        .Builder()
                        .url(fileUrl)
                        .head()
                        .build()
                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val contentLength = response.header("Content-Length")?.toLongOrNull() ?: -1L
                        Log.d(TAG, "File size from HEAD request: $contentLength bytes")
                        contentLength
                    } else {
                        Log.d(TAG, "HEAD request failed: ${response.code}")
                        -1L
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "Failed to get file size: ${e.message}")
                -1L
            }
        }

    override suspend fun downloadFile(
        fileUrl: URL,
        destination: File,
        progressCallback: (Double) -> Unit,
    ): DownloadResult =
        withContext(Dispatchers.IO) {
            var attempt = 0
            var lastException: Exception? = null

            while (attempt < MAX_RETRIES) {
                try {
                    return@withContext attemptDownload(
                        fileUrl,
                        destination,
                        progressCallback,
                    )
                } catch (e: Exception) {
                    lastException = e
                    attempt++

                    if (attempt < MAX_RETRIES && isRetryableException(e)) {
                        val delayMs = INITIAL_RETRY_DELAY_MS * (1 shl (attempt - 1))
                        Log.d(
                            TAG,
                            "Download failed (attempt $attempt/$MAX_RETRIES): ${e.message}. Retrying in ${delayMs}ms...",
                        )
                        delay(delayMs)
                    } else {
                        Log.d(TAG, "Download failed: ${e.message}")
                        break
                    }
                }
            }

            DownloadResult.Error(lastException ?: Exception("Download failed after $MAX_RETRIES attempts"))
        }

    private suspend fun attemptDownload(
        fileUrl: URL,
        destination: File,
        progressCallback: (Double) -> Unit,
    ): DownloadResult =
        withContext(Dispatchers.IO) {
            // Make sure parent directories exist
            destination.parentFile?.mkdirs()

            // Delete any existing partial file to start fresh
            if (destination.exists()) {
                Log.d(TAG, "Deleting existing file, starting fresh download")
                destination.delete()
            }

            val request = Request.Builder().url(fileUrl).build()
            val response: Response

            try {
                response = client.newCall(request).execute()
            } catch (e: Exception) {
                Log.d(TAG, "Failed to execute request: ${e.message}")
                return@withContext DownloadResult.Error(e)
            }

            if (!response.isSuccessful) {
                val errorMsg = "HTTP error ${response.code}: ${response.message}"
                Log.d(TAG, errorMsg)
                response.close()
                return@withContext DownloadResult.Error(Exception(errorMsg))
            }

            val body = response.body
            if (body == null) {
                response.close()
                return@withContext DownloadResult.Error(Exception("Response body is null"))
            }

            // Get total file size
            val totalSize = body.contentLength()

            if (totalSize <= 0) {
                Log.d(TAG, "Invalid content length: $totalSize")
                response.close()
                return@withContext DownloadResult.Error(Exception("Invalid content length: $totalSize"))
            }

            Log.d(TAG, "Starting download: $totalSize bytes")

            try {
                // Wrap response body with progress tracking
                val progressBody =
                    ProgressResponseBody(body) { progress ->
                        progressCallback.invoke(progress)
                    }

                // Write to file
                progressBody.source().use { source ->
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(8 * 1024)
                        var bytesRead: Int

                        while (source.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                        }
                    }
                }

                response.close()

                // Verify file size
                val finalSize = destination.length()
                if (finalSize != totalSize) {
                    Log.d(TAG, "Download incomplete: $finalSize / $totalSize bytes")

                    // Delete incomplete file
                    destination.delete()
                    return@withContext DownloadResult.Error(
                        IncompleteDownloadException(
                            expectedSize = totalSize,
                            actualSize = finalSize,
                        ),
                    )
                }

                Log.d(TAG, "Download completed successfully: $finalSize bytes")
                progressCallback.invoke(1.0)
                DownloadResult.Success(destination)
            } catch (e: Exception) {
                response.close()
                Log.d(TAG, "Failed to download data: ${e.message}")

                // Delete incomplete file
                if (destination.exists()) {
                    destination.delete()
                }
                DownloadResult.Error(e)
            }
        }

    /**
     * Check if exception is retryable
     */
    private fun isRetryableException(e: Exception): Boolean =
        when (e) {
            is SocketTimeoutException,
            is UnknownHostException,
            is IOException,
            -> true

            else -> false
        }
}
