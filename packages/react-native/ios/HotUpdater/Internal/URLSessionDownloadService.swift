import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
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
    case incompleteDownload
    case invalidContentLength
}

class URLSessionDownloadService: NSObject, DownloadService {
    private var session: URLSession!
    private var progressHandlers: [URLSessionTask: (Double) -> Void] = [:]
    private var completionHandlers: [URLSessionTask: (Result<URL, Error>) -> Void] = [:]
    private var destinations: [URLSessionTask: String] = [:]

    override init() {
        super.init()
        let configuration = URLSessionConfiguration.default
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    // Test-only initializer with custom configuration
    init(configuration: URLSessionConfiguration) {
        super.init()
        self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
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
        let task = session.downloadTask(with: url)
        progressHandlers[task] = progressHandler
        completionHandlers[task] = completion
        destinations[task] = destination
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
            completion?(.failure(DownloadError.incompleteDownload))
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