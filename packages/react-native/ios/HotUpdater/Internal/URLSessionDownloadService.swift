import Foundation

protocol DownloadService {
    /**
     * Downloads a file from a URL.
     * @param url The URL to download from
     * @param destination The local path to save to
     * @param progressHandler Callback for download progress updates
     * @param completion Callback with result of the download
     * @return The download task (optional)
     */
    func downloadFile(from url: URL, to destination: String, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask?
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
        
        do {
            let destinationURL = URL(fileURLWithPath: destination)
            try FileManager.default.copyItem(at: location, to: destinationURL)
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