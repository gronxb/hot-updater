import Foundation

/**
 * Protocol for custom download service implementations.
 *
 * Implement this protocol to provide a custom networking stack for OTA bundle downloads.
 * This is useful for enterprise environments that require TLS pinning, corporate proxies,
 * or custom network interceptors.
 *
 * Example:
 * ```swift
 * class PinnedDownloadService: NSObject, DownloadService {
 *     func downloadFile(from url: URL, to destination: String, ...) -> URLSessionDownloadTask? {
 *         // Use your custom URLSession with certificate pinning
 *     }
 * }
 *
 * // Before HotUpdater initializes:
 * HotUpdaterImpl.downloadServiceFactory = { PinnedDownloadService() }
 * ```
 */
public protocol DownloadService {
    /**
     * Downloads a file from a URL.
     * @param url The URL to download from
     * @param destination The local path to save to
     * @param fileSizeHandler Optional callback called when file size is known
     * @param progressHandler Callback for download progress updates (0.0 to 1.0)
     * @param completion Callback with downloaded file URL or error
     * @return The download task, if applicable (may return nil for non-URLSession implementations)
     */
    func downloadFile(from url: URL, to destination: String, fileSizeHandler: ((Int64) -> Void)?, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask?
}
