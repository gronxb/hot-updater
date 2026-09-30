import Foundation
#if !os(macOS)
import UIKit
#endif

struct DownloadProgress {
    let progress: Double
    let downloadedBytes: Int64
    let totalBytes: Int64?
}

protocol DownloadService {
    /**
     * Downloads a file from a URL.
     * @param url The URL to download from
     * @param destination The local path to save to
     * @param fileSizeHandler Optional callback called when file size is known
     * @param progressHandler Callback for download progress updates
     * @param completion Callback with downloaded file URL or error
     * @return The download task (optional)
     */
    func downloadFile(from url: URL, to destination: String, fileSizeHandler: ((Int64) -> Void)?, progressHandler: @escaping (DownloadProgress) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask?
}


enum DownloadError: Error, Equatable {
    case incompleteDownload(expected: Int64, actual: Int64)
    case invalidContentLength
    /// The server answered with a status outside 200-299. `originCode` is the
    /// `<Code>` of a storage origin's XML error body, when it has one.
    case httpStatus(Int, originCode: String? = nil)

    /// How much of an error body is searched for a storage origin's code.
    static let maximumErrorBodyPrefixByteCount = 4 * 1024
    private static let maximumOriginCodeLength = 64

    /// The failure for an HTTP response outside 200-299, or nil for a
    /// successful or non-HTTP response. `body` is the saved response body.
    static func httpStatusError(for response: URLResponse?, body: URL?) -> DownloadError? {
        guard let httpResponse = response as? HTTPURLResponse,
              !(200..<300).contains(httpResponse.statusCode) else {
            return nil
        }
        let originCode = body.flatMap { body -> String? in
            guard let handle = try? FileHandle(forReadingFrom: body) else {
                return nil
            }
            defer { try? handle.close() }
            let prefix = try? FileUtilities.readUpToCount(
                from: handle,
                count: maximumErrorBodyPrefixByteCount
            )
            return prefix.flatMap { storageOriginErrorCode(in: $0) }
        }
        return .httpStatus(httpResponse.statusCode, originCode: originCode)
    }

    /// The `<Code>` of an S3, R2, or GCS style `<Error>` document in the
    /// first 4 KB of `body`, such as "AccessDenied". Nothing else from the
    /// body is kept, and a code must be 1-64 characters of [A-Za-z0-9._-].
    static func storageOriginErrorCode(in body: Data) -> String? {
        let text = String(decoding: body.prefix(maximumErrorBodyPrefixByteCount), as: UTF8.self)
        guard let errorElement = text.range(of: "<Error"),
              let codeStart = text.range(of: "<Code>", range: errorElement.upperBound..<text.endIndex),
              let codeEnd = text.range(of: "</Code>", range: codeStart.upperBound..<text.endIndex) else {
            return nil
        }
        let code = text[codeStart.upperBound..<codeEnd.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...maximumOriginCodeLength).contains(code.unicodeScalars.count),
              code.unicodeScalars.allSatisfy(isOriginCodeCharacter) else {
            return nil
        }
        return code
    }

    private static func isOriginCodeCharacter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case "A"..."Z", "a"..."z", "0"..."9", ".", "_", "-":
            return true
        default:
            return false
        }
    }
}

class URLSessionDownloadService: NSObject, DownloadService {
    private let stateLock = NSRecursiveLock()
    private var session: URLSession!
    private var backgroundSession: URLSession!
    private var progressHandlers: [URLSessionTask: (DownloadProgress) -> Void] = [:]
    private var completionHandlers: [URLSessionTask: (Result<URL, Error>) -> Void] = [:]
    private var destinations: [URLSessionTask: String] = [:]
    private var fileSizeHandlers: [URLSessionTask: (Int64) -> Void] = [:]

    override init() {
        super.init()

        // Foreground session (existing behavior)
        let defaultConfig = URLSessionConfiguration.default
        session = URLSession(configuration: defaultConfig, delegate: self, delegateQueue: nil)

        // Background session for persistent downloads
        let backgroundConfig = URLSessionConfiguration.background(
            withIdentifier: "com.hotupdater.background.download"
        )
        backgroundConfig.isDiscretionary = false
        if #available(macOS 11.0, *) {
            backgroundConfig.sessionSendsLaunchEvents = true
        }
        backgroundSession = URLSession(configuration: backgroundConfig, delegate: self, delegateQueue: nil)
    }

    func downloadFile(from url: URL, to destination: String, fileSizeHandler: ((Int64) -> Void)?, progressHandler: @escaping (DownloadProgress) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask? {
        // UIKit state is read on the main thread before taking the task-state lock.
        // Determine if we should use background session
        #if !os(macOS)
        let appState = Thread.isMainThread
            ? UIApplication.shared.applicationState
            : DispatchQueue.main.sync { UIApplication.shared.applicationState }
        let useBackgroundSession = (appState == .background || appState == .inactive)
        #else
        let useBackgroundSession = false
        #endif

        stateLock.lock()
        defer { stateLock.unlock() }
        let selectedSession = useBackgroundSession ? backgroundSession : session
        let task = selectedSession?.downloadTask(with: url)

        guard let task = task else {
            return nil
        }

        progressHandlers[task] = progressHandler
        completionHandlers[task] = completion
        destinations[task] = destination
        if let handler = fileSizeHandler {
            fileSizeHandlers[task] = handler
        }

        task.resume()
        return task
    }
}

extension URLSessionDownloadService: URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        stateLock.lock()
        defer { stateLock.unlock() }
        let completion = completionHandlers[downloadTask]
        let destination = destinations[downloadTask]

        defer {
            progressHandlers.removeValue(forKey: downloadTask)
            completionHandlers.removeValue(forKey: downloadTask)
            destinations.removeValue(forKey: downloadTask)
            fileSizeHandlers.removeValue(forKey: downloadTask)
        }

        guard let destination = destination else {
            completion?(.failure(NSError(domain: "HotUpdaterError", code: 1, userInfo: [NSLocalizedDescriptionKey: "Destination path not found"])))
            return
        }

        // URLSession saves error bodies too, so reject them before they reach verification.
        if let httpError = DownloadError.httpStatusError(for: downloadTask.response, body: location) {
            NSLog("[DownloadService] Download failed: \(httpError)")
            try? FileManager.default.removeItem(at: location)
            completion?(.failure(httpError))
            return
        }

        // Verify file size
        let expectedSize = downloadTask.response?.expectedContentLength ?? -1
        let actualSize: Int64?
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: location.path)
            actualSize = attributes[.size] as? Int64
        } catch {
            NSLog("[DownloadService] Failed to get file attributes: \(error.localizedDescription)")
            actualSize = nil
        }

        if expectedSize > 0, let actualSize = actualSize, actualSize != expectedSize {
            NSLog("[DownloadService] Download incomplete: \(actualSize) / \(expectedSize) bytes")
            // Delete incomplete file
            try? FileManager.default.removeItem(at: location)
            completion?(.failure(DownloadError.incompleteDownload(expected: expectedSize, actual: actualSize)))
            return
        }

        do {
            let destinationURL = URL(fileURLWithPath: destination)

            // Delete existing file if needed
            if FileManager.default.fileExists(atPath: destination) {
                try FileManager.default.removeItem(at: destinationURL)
            }

            try persistDownloadedFile(from: location, to: destinationURL)
            NSLog("[DownloadService] Download completed successfully: \(actualSize ?? 0) bytes")
            completion?(.success(destinationURL))
        } catch {
            NSLog("[DownloadService] Failed to copy downloaded file: \(error.localizedDescription)")
            completion?(.failure(error))
        }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        stateLock.lock()
        defer { stateLock.unlock() }
        let completion = completionHandlers[task]
        defer {
            progressHandlers.removeValue(forKey: task)
            completionHandlers.removeValue(forKey: task)
            destinations.removeValue(forKey: task)
            fileSizeHandlers.removeValue(forKey: task)
        }

        if let error = error {
            completion?(.failure(error))
        }
    }
    
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        stateLock.lock()
        defer { stateLock.unlock() }
        let progressHandler = progressHandlers[downloadTask]

        // Call file size handler on first callback when size is known
        if totalBytesWritten == bytesWritten && bytesWritten > 0 {
            if let fileSizeHandler = fileSizeHandlers[downloadTask] {
                if totalBytesExpectedToWrite > 0 {
                    fileSizeHandler(totalBytesExpectedToWrite)
                } else {
                    NSLog("[DownloadService] Content-Length not available, proceeding without disk space check")
                }
                fileSizeHandlers.removeValue(forKey: downloadTask)
            }
        }

        if totalBytesExpectedToWrite > 0 {
            let progress = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
            progressHandler?(DownloadProgress(progress: progress, downloadedBytes: totalBytesWritten, totalBytes: totalBytesExpectedToWrite))

        } else {
            progressHandler?(DownloadProgress(progress: 0, downloadedBytes: totalBytesWritten, totalBytes: nil))

        }
    }
}

private extension URLSessionDownloadService {
    func persistDownloadedFile(from location: URL, to destinationURL: URL) throws {
        do {
            try FileManager.default.moveItem(at: location, to: destinationURL)
        } catch {
            NSLog("[DownloadService] Move failed, falling back to copy: \(error.localizedDescription)")
            try FileManager.default.copyItem(at: location, to: destinationURL)
        }
    }
}
