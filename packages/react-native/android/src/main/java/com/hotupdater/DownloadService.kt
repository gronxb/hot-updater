package com.hotupdater

import java.io.File
import java.net.URL

/**
 * Interface for custom download service implementations.
 *
 * Implement this interface to provide a custom networking stack for OTA bundle downloads.
 * This is useful for enterprise environments that require TLS pinning, corporate proxies,
 * or custom network interceptors.
 *
 * Example:
 * ```kotlin
 * class PinnedDownloadService : DownloadService {
 *     override suspend fun downloadFile(
 *         fileUrl: URL, destination: File,
 *         fileSizeCallback: ((Long) -> Unit)?,
 *         progressCallback: (Double) -> Unit
 *     ): DownloadResult {
 *         // Use your custom OkHttpClient with certificate pinning
 *     }
 * }
 *
 * // Before HotUpdater initializes:
 * HotUpdaterImpl.downloadServiceFactory = { PinnedDownloadService() }
 * ```
 */
interface DownloadService {
    /**
     * Downloads a file from a URL
     * @param fileUrl The URL to download from
     * @param destination The local file to save to
     * @param fileSizeCallback Optional callback called when file size is known
     * @param progressCallback Callback for download progress updates (0.0 to 1.0)
     * @return Result indicating success or failure
     */
    suspend fun downloadFile(
        fileUrl: URL,
        destination: File,
        fileSizeCallback: ((Long) -> Unit)? = null,
        progressCallback: (Double) -> Unit,
    ): DownloadResult
}

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
