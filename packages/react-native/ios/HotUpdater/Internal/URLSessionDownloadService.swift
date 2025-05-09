import Foundation

protocol DownloadService {
    func downloadFile(from url: URL, to destination: String, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask?
}

class URLSessionDownloadService: NSObject, DownloadService {
    private var session: URLSession!
    private var progressHandlers: [URLSessionTask: (Double) -> Void] = [:]
    private var completionHandlers: [URLSessionTask: (Result<URL, Error>) -> Void] = [:]
    
    override init() {
        super.init()
        let configuration = URLSessionConfiguration.default
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }
    
    func downloadFile(from url: URL, to destination: String, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask? {
        let task = session.downloadTask(with: url)
        progressHandlers[task] = progressHandler
        completionHandlers[task] = completion
        task.resume()
        return task
    }
}

extension URLSessionDownloadService: URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let completion = completionHandlers[downloadTask]
        defer {
            progressHandlers.removeValue(forKey: downloadTask)
            completionHandlers.removeValue(forKey: downloadTask)
            
            // 다운로드 완료 알림
            NotificationCenter.default.post(name: .downloadDidFinish, object: downloadTask)
        }
        
        completion?(.success(location))
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let completion = completionHandlers[task]
        defer {
            progressHandlers.removeValue(forKey: task)
            completionHandlers.removeValue(forKey: task)
            
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