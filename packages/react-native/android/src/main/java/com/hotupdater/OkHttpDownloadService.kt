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
 * The server answered with a non-2xx status. [originCode] is the storage
 * origin's XML error `<Code>` (S3, R2, or GCS style) when the body names one.
 */
class HttpStatusException(
    val statusCode: Int,
    statusMessage: String,
    val originCode: String? = null,
) : Exception("HTTP error $statusCode: $statusMessage")

/** How much of an error body is read to find a storage origin's error code. */
internal const val MAX_ORIGIN_ERROR_BODY_BYTES = 4 * 1024L

private val ORIGIN_ERROR_CODE = Regex("<Error(?:\\s[^>]*)?>(?:(?!</Error>).)*?<Code>([^<]*)</Code>", RegexOption.DOT_MATCHES_ALL)
private val ORIGIN_CODE_VALUE = Regex("[A-Za-z0-9._-]{1,64}")

/**
 * Reads the `<Code>` of a storage origin's XML error, as in
 * `<Error><Code>AccessDenied</Code>...`, from at most the first 4 KB of
 * [body]. Only a 1 to 64 character code of letters, digits, `.`, `_`, and `-`
 * is kept, so no key, resource, or message text is ever returned.
 */
internal fun readOriginErrorCode(body: ResponseBody?): String? =
    try {
        body?.source()?.let { source ->
            source.request(MAX_ORIGIN_ERROR_BODY_BYTES)
            val prefix = source.buffer.readByteArray(minOf(source.buffer.size, MAX_ORIGIN_ERROR_BODY_BYTES))
            parseOriginErrorCode(String(prefix, Charsets.UTF_8))
        }
    } catch (_: Exception) {
        null
    }

internal fun parseOriginErrorCode(body: String): String? =
    ORIGIN_ERROR_CODE
        .find(body)
        ?.groupValues
        ?.get(1)
        ?.trim()
        ?.takeIf { ORIGIN_CODE_VALUE.matches(it) }

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
data class DownloadProgress(
    val progress: Double,
    val downloadedBytes: Long,
    val totalBytes: Long? = null,
)

interface DownloadService {
    /**
     * Downloads a file from a URL
     * @param fileUrl The URL to download from
     * @param destination The local file to save to
     * @param fileSizeCallback Optional callback called when file size is known
     * @param progressCallback Callback for download progress updates
     * @return Result indicating success or failure
     */
    suspend fun downloadFile(
        fileUrl: URL,
        destination: File,
        fileSizeCallback: ((Long) -> Unit)? = null,
        progressCallback: (DownloadProgress) -> Unit,
    ): DownloadResult

    suspend fun downloadFileOnce(
        fileUrl: URL,
        destination: File,
        fileSizeCallback: ((Long) -> Unit)? = null,
        progressCallback: (DownloadProgress) -> Unit,
    ): DownloadResult = downloadFile(fileUrl, destination, fileSizeCallback, progressCallback)
}

/**
 * Progress tracking wrapper for OkHttp ResponseBody
 */
private class ProgressResponseBody(
    private val responseBody: ResponseBody,
    private val progressCallback: (DownloadProgress) -> Unit,
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
                    val totalBytes = contentLength()
                    if (totalBytes > 0) {
                        val progress = totalBytesRead.toDouble() / totalBytes
                        progressCallback.invoke(
                            DownloadProgress(
                                progress = progress,
                                downloadedBytes = totalBytesRead,
                                totalBytes = totalBytes,
                            ),
                        )
                    } else {
                        progressCallback.invoke(
                            DownloadProgress(
                                progress = 0.0,
                                downloadedBytes = totalBytesRead,
                                totalBytes = null,
                            ),
                        )
                    }
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

    override suspend fun downloadFile(
        fileUrl: URL,
        destination: File,
        fileSizeCallback: ((Long) -> Unit)?,
        progressCallback: (DownloadProgress) -> Unit,
    ): DownloadResult =
        withContext(Dispatchers.IO) {
            var attempt = 0
            var lastException: Exception? = null

            while (attempt < MAX_RETRIES) {
                try {
                    return@withContext attemptDownload(
                        fileUrl,
                        destination,
                        fileSizeCallback,
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

    override suspend fun downloadFileOnce(
        fileUrl: URL,
        destination: File,
        fileSizeCallback: ((Long) -> Unit)?,
        progressCallback: (DownloadProgress) -> Unit,
    ): DownloadResult =
        try {
            attemptDownload(fileUrl, destination, fileSizeCallback, progressCallback)
        } catch (error: Exception) {
            DownloadResult.Error(error)
        }

    private suspend fun attemptDownload(
        fileUrl: URL,
        destination: File,
        fileSizeCallback: ((Long) -> Unit)?,
        progressCallback: (DownloadProgress) -> Unit,
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
                val error = HttpStatusException(response.code, response.message, readOriginErrorCode(response.body))
                Log.d(TAG, "HTTP error ${response.code}: ${response.message}")
                response.close()
                return@withContext DownloadResult.Error(error)
            }

            val body = response.body
            if (body == null) {
                response.close()
                return@withContext DownloadResult.Error(Exception("Response body is null"))
            }

            // Get total file size
            val totalSize = body.contentLength()

            if (totalSize > 0) {
                // Notify file size to caller for disk space check
                fileSizeCallback?.invoke(totalSize)
                Log.d(TAG, "Starting download: $totalSize bytes")
            } else {
                Log.d(TAG, "Content-Length not available ($totalSize), proceeding without disk space check")
            }

            try {
                // Wrap response body with progress tracking
                val progressBody =
                    ProgressResponseBody(body) { progress ->
                        progressCallback.invoke(progress)
                    }

                // Write to file. A local write failure surfaces as LocalStorageException,
                // so it is not mistaken for a network failure.
                progressBody.source().use { source ->
                    LocalStorageOutputStream.open(destination).use { output ->
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
                if (totalSize >= 0 && finalSize != totalSize) {
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
                progressCallback.invoke(
                    DownloadProgress(
                        progress = 1.0,
                        downloadedBytes = finalSize,
                        totalBytes = if (totalSize > 0) totalSize else null,
                    ),
                )
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
