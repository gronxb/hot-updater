import Foundation
#if !os(macOS)
import UIKit
#endif

protocol DownloadService {
    /**
     * Gets the file size from the URL without downloading.
     * @param url The URL to check
     * @param completion Callback with file size or error
     */
    func getFileSize(from url: URL, completion: @escaping (Result<Int64, Error>) -> Void)

    /**
     * Downloads a file from a URL.
     * @param url The URL to download from
     * @param destination The local path to save to
     * @param progressHandler Callback for download progress updates
     * @param completion Callback with downloaded file URL or error
     * @return The download task (optional)
     */
    func downloadFile(from url: URL, to destination: String, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask?
}


enum DownloadError: Error {
    case incompleteDownload(expected: Int64, actual: Int64)
    case invalidContentLength
}

// Task state for persistence and recovery
struct TaskState: Codable {
    let taskIdentifier: Int
    let destination: String
    let bundleId: String
    let startedAt: TimeInterval
}

class URLSessionDownloadService: NSObject, DownloadService {
    private var session: URLSession!
    private var backgroundSession: URLSession!
    private var progressHandlers: [URLSessionTask: (Double) -> Void] = [:]
    private var completionHandlers: [URLSessionTask: (Result<URL, Error>) -> Void] = [:]
    private var destinations: [URLSessionTask: String] = [:]
    private var taskStates: [Int: TaskState] = [:]

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
        backgroundConfig.sessionSendsLaunchEvents = true
        backgroundSession = URLSession(configuration: backgroundConfig, delegate: self, delegateQueue: nil)

        // Load persisted task states
        taskStates = loadTaskStates()
    }

    // MARK: - State Persistence

    private var stateFileURL: URL {
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documentsPath.appendingPathComponent("download-state.json")
    }

    private func saveTaskState(_ state: TaskState) {
        taskStates[state.taskIdentifier] = state

        if let data = try? JSONEncoder().encode(taskStates) {
            try? data.write(to: stateFileURL)
        }
    }

    private func loadTaskStates() -> [Int: TaskState] {
        guard let data = try? Data(contentsOf: stateFileURL),
              let states = try? JSONDecoder().decode([Int: TaskState].self, from: data) else {
            return [:]
        }
        return states
    }

    private func removeTaskState(_ taskIdentifier: Int) {
        taskStates.removeValue(forKey: taskIdentifier)

        if let data = try? JSONEncoder().encode(taskStates) {
            try? data.write(to: stateFileURL)
        }
    }

    func getFileSize(from url: URL, completion: @escaping (Result<Int64, Error>) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"

        let task = session.dataTask(with: request) { _, response, error in
            if let error = error {
                NSLog("[DownloadService] HEAD request failed: \(error.localizedDescription)")
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(DownloadError.invalidContentLength))
                return
            }

            let contentLength = httpResponse.expectedContentLength
            if contentLength > 0 {
                NSLog("[DownloadService] File size from HEAD request: \(contentLength) bytes")
                completion(.success(contentLength))
            } else {
                NSLog("[DownloadService] Invalid content length: \(contentLength)")
                completion(.failure(DownloadError.invalidContentLength))
            }
        }
        task.resume()
    }

    func downloadFile(from url: URL, to destination: String, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask? {
        // Determine if we should use background session
        #if !os(macOS)
        let appState = UIApplication.shared.applicationState
        let useBackgroundSession = (appState == .background || appState == .inactive)
        #else
        let useBackgroundSession = false
        #endif

        let selectedSession = useBackgroundSession ? backgroundSession : session
        let task = selectedSession?.downloadTask(with: url)

        guard let task = task else {
            return nil
        }

        progressHandlers[task] = progressHandler
        completionHandlers[task] = completion
        destinations[task] = destination

        // Extract bundleId from destination path (e.g., "bundle-store/{bundleId}/bundle.zip")
        let bundleId = (destination as NSString).pathComponents
            .dropFirst()
            .first(where: { $0 != "bundle-store" }) ?? "unknown"

        // Save task metadata for background recovery
        let taskState = TaskState(
            taskIdentifier: task.taskIdentifier,
            destination: destination,
            bundleId: bundleId,
            startedAt: Date().timeIntervalSince1970
        )
        saveTaskState(taskState)

        task.resume()
        return task
    }
}

extension URLSessionDownloadService: URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let completion = completionHandlers[downloadTask]
        let destination = destinations[downloadTask]

        defer {
            progressHandlers.removeValue(forKey: downloadTask)
            completionHandlers.removeValue(forKey: downloadTask)
            destinations.removeValue(forKey: downloadTask)
            removeTaskState(downloadTask.taskIdentifier)

            // 다운로드 완료 알림
            NotificationCenter.default.post(name: .downloadDidFinish, object: downloadTask)
        }

        guard let destination = destination else {
            completion?(.failure(NSError(domain: "HotUpdaterError", code: 1, userInfo: [NSLocalizedDescriptionKey: "Destination path not found"])))
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

            try FileManager.default.copyItem(at: location, to: destinationURL)
            NSLog("[DownloadService] Download completed successfully: \(actualSize ?? 0) bytes")
            completion?(.success(destinationURL))
        } catch {
            NSLog("[DownloadService] Failed to copy downloaded file: \(error.localizedDescription)")
            completion?(.failure(error))
        }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let completion = completionHandlers[task]
        defer {
            progressHandlers.removeValue(forKey: task)
            completionHandlers.removeValue(forKey: task)
            destinations.removeValue(forKey: task)
            removeTaskState(task.taskIdentifier)

            NotificationCenter.default.post(name: .downloadDidFinish, object: task)
        }

        if let error = error {
            completion?(.failure(error))
        }
    }
    
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let progressHandler = progressHandlers[downloadTask]
        
        if totalBytesExpectedToWrite > 0 {
            let progress = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
            progressHandler?(progress)
            
            let progressInfo: [String: Any] = [
                "progress": progress,
                "totalBytesReceived": totalBytesWritten,
                "totalBytesExpected": totalBytesExpectedToWrite
            ]
            NotificationCenter.default.post(name: .downloadProgressUpdate, object: downloadTask, userInfo: progressInfo)
        } else {
            progressHandler?(0)
            
            NotificationCenter.default.post(name: .downloadProgressUpdate, object: downloadTask, userInfo: ["progress": 0.0, "totalBytesReceived": 0, "totalBytesExpected": 0])
        }
    }
}