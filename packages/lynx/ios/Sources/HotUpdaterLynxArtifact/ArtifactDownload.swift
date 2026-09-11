import Foundation

// A preparation owns its session and destination. No React Native/global background-download state.
final class ArtifactDownload: NSObject, URLSessionDownloadDelegate {
    private let lock = NSLock()
    private var task: URLSessionDownloadTask?
    private var continuation: CheckedContinuation<Void, Error>?
    private var cancellation: Error?
    private var session: URLSession?
    private let destination: URL
    private init(destination: URL) { self.destination = destination }

    static func fetch(_ url: URL, to destination: URL) async throws {
        let download = ArtifactDownload(destination: destination)
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in download.start(url, continuation) }
        }, onCancel: { download.cancel(CancellationError()) })
    }
    private func start(_ url: URL, _ continuation: CheckedContinuation<Void, Error>) {
        lock.lock(); defer { lock.unlock() }
        if let cancellation { continuation.resume(throwing: cancellation); return }
        self.continuation = continuation
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session!.downloadTask(with: url)
        task!.resume()
    }
    private func cancel(_ error: Error) {
        lock.lock(); defer { lock.unlock() }
        cancellation = error
        task?.cancel()
    }
    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        let callback = continuation
        continuation = nil
        let currentSession = session
        session = nil
        let canceled = cancellation
        lock.unlock()
        currentSession?.finishTasksAndInvalidate()
        if let canceled { callback?.resume(throwing: canceled) } else { callback?.resume(with: result) }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > Int64(ArchiveLimits.compressed) || totalBytesExpectedToWrite > Int64(ArchiveLimits.compressed) {
            cancel(LynxArtifactError.invalid("Archive download exceeds limit"))
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            guard let response = downloadTask.response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw LynxArtifactError.invalid("Artifact download HTTP status rejected") }
            let bytes = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard bytes > 0, UInt64(bytes) <= ArchiveLimits.compressed,
                  response.expectedContentLength < 0 || response.expectedContentLength == Int64(bytes) else { throw LynxArtifactError.invalid("Incomplete or oversized archive download") }
            try FileManager.default.moveItem(at: location, to: destination)
            finish(.success(()))
        } catch { finish(.failure(error)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) }
    }
}
