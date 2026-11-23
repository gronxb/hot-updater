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

    /// Cancels the transfers that run in the app's process, which stop when
    /// the system suspends the app. Transfers of the system's background
    /// session go on.
    func cancelInProcessTransfers()
}

extension DownloadService {
    func cancelInProcessTransfers() {}
}

/// The app's state when a download starts.
enum DownloadAppState {
    case active
    case inactive
    case background
}

/// Where a download runs.
enum DownloadSessionKind: Equatable {
    /// The app's own URLSession: the transfer starts at once and stops when
    /// the system suspends the app.
    case inProcess
    /// The system's background URLSession: the transfer goes on after the
    /// system suspends the app.
    case outOfProcess

    /// The server signs each download link for a short time, so a download
    /// has to go out as soon as it starts.
    /// - An inactive app is still on screen: the system starts a background
    ///   session transfer at once and keeps it going after the user leaves.
    /// - The system runs a background session transfer started while the app
    ///   is in the background at its own discretion, possibly hours later,
    ///   after its link expired. The app's own session starts it at once,
    ///   while the update holds background time (`BackgroundExecution`).
    static func forDownload(startingIn state: DownloadAppState) -> DownloadSessionKind {
        switch state {
        case .active, .background:
            return .inProcess
        case .inactive:
            return .outOfProcess
        }
    }
}

/// Keeps the app running while an update downloads. The server signs each
/// download link for a short time on purpose, so the app requests it right
/// away: an app the system suspends mid-update would send its remaining
/// requests whenever it runs again, possibly after the links expired.
protocol BackgroundExecution {
    /// Asks for time to finish `name`. `expiration` runs when the system is
    /// about to suspend the app before the token was ended.
    func begin(name: String, expiration: @escaping () -> Void) -> BackgroundExecutionToken
}

/// Ends the background time one `begin` asked for. Ending it again does
/// nothing.
final class BackgroundExecutionToken {
    private let lock = NSLock()
    private var endAction: (() -> Void)?

    init(end: @escaping () -> Void) {
        endAction = end
    }

    func end() {
        lock.lock()
        let action = endAction
        endAction = nil
        lock.unlock()
        action?()
    }
}

/// UIKit's background tasks. macOS doesn't suspend the app, so there it asks
/// for nothing.
struct SystemBackgroundExecution: BackgroundExecution {
    func begin(name: String, expiration: @escaping () -> Void) -> BackgroundExecutionToken {
        #if !os(macOS)
        let lock = NSLock()
        var identifier = UIBackgroundTaskIdentifier.invalid
        var ended = false
        let token = BackgroundExecutionToken {
            lock.lock()
            let current = identifier
            identifier = .invalid
            ended = true
            lock.unlock()
            if current != .invalid {
                UIApplication.shared.endBackgroundTask(current)
            }
        }
        let started = UIApplication.shared.beginBackgroundTask(withName: name) {
            expiration()
            token.end()
        }
        lock.lock()
        let endedBeforeStart = ended
        if !endedBeforeStart {
            identifier = started
        }
        lock.unlock()
        // The token was ended before the system answered.
        if endedBeforeStart, started != .invalid {
            UIApplication.shared.endBackgroundTask(started)
        }
        return token
        #else
        return BackgroundExecutionToken {}
        #endif
    }
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

    /// The size of the file a successful response leaves, or nil when the
    /// response does not tell. A 206 answers a range: when the system resumes
    /// an interrupted background download, `expectedContentLength` counts
    /// only the resumed range while the file holds every byte, so the size is
    /// the total in `Content-Range: bytes <first>-<last>/<total>`.
    static func expectedFileSize(for response: URLResponse?) -> Int64? {
        if let httpResponse = response as? HTTPURLResponse,
           httpResponse.statusCode == 206 {
            guard let contentRange = httpResponse.value(forHTTPHeaderField: "Content-Range"),
                  let separator = contentRange.lastIndex(of: "/"),
                  let total = Int64(
                      contentRange[contentRange.index(after: separator)...]
                          .trimmingCharacters(in: .whitespaces)
                  ),
                  total > 0 else {
                return nil
            }
            return total
        }
        guard let expectedContentLength = response?.expectedContentLength,
              expectedContentLength > 0 else {
            return nil
        }
        return expectedContentLength
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

extension DownloadError {
    /// Attempts per download that retries, the first one included.
    static let maximumAttempts = 3

    /// Whether a failed download may succeed if tried again: a network
    /// failure or timeout, a body that ended early, or a 408, 429, or 5xx
    /// answer. Another 4xx, a TLS failure, a cancelled task, and a local file
    /// failure would fail the same way again.
    static func isRetryable(_ error: Error) -> Bool {
        if let downloadError = error as? DownloadError {
            switch downloadError {
            case .httpStatus(let status, _):
                return status == 408 || status == 429 || status >= 500
            case .incompleteDownload:
                return true
            case .invalidContentLength:
                return false
            }
        }
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else {
            return false
        }
        switch URLError.Code(rawValue: nsError.code) {
        case .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .cannotLoadFromNetwork,
             .callIsActive,
             .dataNotAllowed,
             .internationalRoamingOff,
             .backgroundSessionWasDisconnected,
             .badServerResponse:
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
    /// Tasks of `session`, which stop when the system suspends the app.
    private var inProcessTasks: Set<URLSessionTask> = []

    /// Each instance passes its own `backgroundSessionIdentifier`: a process
    /// must not create two background sessions with one identifier.
    init(backgroundSessionIdentifier: String = HotUpdaterInstanceEnvironment.main.backgroundSessionIdentifier) {
        super.init()

        // Foreground session (existing behavior)
        let defaultConfig = URLSessionConfiguration.default
        session = URLSession(configuration: defaultConfig, delegate: self, delegateQueue: nil)

        // Background session for persistent downloads
        backgroundSession = URLSession(
            configuration: Self.makeBackgroundConfiguration(identifier: backgroundSessionIdentifier),
            delegate: self,
            delegateQueue: nil
        )
    }

    /// How long a background session transfer may take before it fails.
    /// The system retries a transfer interrupted after the app was suspended
    /// at its own discretion, so without a limit (seven days by default) a
    /// retry could go out after the links expired. Storage adapters sign
    /// download links for an hour by default.
    static let backgroundTransferTimeLimit: TimeInterval = 30 * 60

    static func makeBackgroundConfiguration(identifier: String) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.isDiscretionary = false
        configuration.timeoutIntervalForResource = backgroundTransferTimeLimit
        if #available(macOS 11.0, *) {
            configuration.sessionSendsLaunchEvents = true
        }
        return configuration
    }

    /// Cancels at once: UIKit suspends the app as soon as an expiration
    /// handler returns.
    func cancelInProcessTransfers() {
        stateLock.lock()
        let tasks = inProcessTasks
        stateLock.unlock()
        tasks.forEach { $0.cancel() }
    }

    func downloadFile(from url: URL, to destination: String, fileSizeHandler: ((Int64) -> Void)?, progressHandler: @escaping (DownloadProgress) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask? {
        // UIKit state is read on the main thread before taking the task-state lock.
        // Determine if we should use background session
        #if !os(macOS)
        let appState = Thread.isMainThread
            ? UIApplication.shared.applicationState
            : DispatchQueue.main.sync { UIApplication.shared.applicationState }
        let downloadAppState: DownloadAppState
        switch appState {
        case .active:
            downloadAppState = .active
        case .inactive:
            downloadAppState = .inactive
        default:
            downloadAppState = .background
        }
        let useBackgroundSession =
            DownloadSessionKind.forDownload(startingIn: downloadAppState) == .outOfProcess
        #else
        let useBackgroundSession = false
        #endif

        stateLock.lock()
        defer { stateLock.unlock() }
        let selectedSession = useBackgroundSession ? backgroundSession : session
        let task = selectedSession?.downloadTask(with: url)
        NSLog("[DownloadService] Starting \(url.lastPathComponent) \(useBackgroundSession ? "on the background session" : "in the app process")")

        guard let task = task else {
            return nil
        }

        progressHandlers[task] = progressHandler
        completionHandlers[task] = completion
        destinations[task] = destination
        if let handler = fileSizeHandler {
            fileSizeHandlers[task] = handler
        }
        if !useBackgroundSession {
            inProcessTasks.insert(task)
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
            inProcessTasks.remove(downloadTask)
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
        let expectedSize = DownloadError.expectedFileSize(for: downloadTask.response)
        let actualSize: Int64?
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: location.path)
            actualSize = attributes[.size] as? Int64
        } catch {
            NSLog("[DownloadService] Failed to get file attributes: \(error.localizedDescription)")
            actualSize = nil
        }

        if let expectedSize, let actualSize, actualSize != expectedSize {
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
            inProcessTasks.remove(task)
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
