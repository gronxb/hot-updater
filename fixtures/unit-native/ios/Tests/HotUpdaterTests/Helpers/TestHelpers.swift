import Foundation
import Testing

// MARK: - Test Constants

enum TestConstants {
    static let validBundleHash = "9a885c0ebee4f7a9dce994f626b1fb4cebfde6e3608fb01f714061d7c4e70e3f"
    static let corruptedBundleHash = "38893dade3c03e3521f5750c4a8ee90cd6d7b1eeb30b410a0cce483ea6ede84b"
    static let invalidBundleHash = "accc5fb6b024d45a87a6013f3aff7ddd94de4463bfd7d3814d37e090d4fd594f"

    static let mockBundleUrl = "https://mock.server/test-bundle.zip"
    static let appVersion = "1.0.0"
    static let fingerprint = "test-fingerprint"
    static let channel = "production"
    static let bundleId = "test-bundle-1"
}

// MARK: - Temporary Directory Management

final class TempDirectoryManager {
    private var tempDirectories: [URL] = []

    /// Create a temporary directory for testing
    func createTempDirectory(prefix: String = "HotUpdaterTest") -> URL {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")

        try! FileManager.default.createDirectory(
            at: tempDir,
            withIntermediateDirectories: true
        )

        tempDirectories.append(tempDir)
        return tempDir
    }

    /// Clean up all temporary directories
    func cleanupAll() {
        for tempDir in tempDirectories {
            try? FileManager.default.removeItem(at: tempDir)
        }
        tempDirectories.removeAll()
    }

    deinit {
        cleanupAll()
    }
}

// MARK: - Mock Data Generators

struct MockData {
    /// Generate UpdateInfo for testing
    static func createUpdateInfo(
        bundleId: String = TestConstants.bundleId,
        appVersion: String = TestConstants.appVersion,
        fileUrl: String = TestConstants.mockBundleUrl,
        fileHash: String? = TestConstants.validBundleHash,
        fingerprint: String = TestConstants.fingerprint,
        channel: String = TestConstants.channel
    ) -> [String: Any] {
        var info: [String: Any] = [
            "bundleId": bundleId,
            "appVersion": appVersion,
            "fileUrl": fileUrl,
            "fingerprint": fingerprint,
            "channel": channel
        ]

        if let fileHash = fileHash {
            info["fileHash"] = fileHash
        }

        return info
    }

    /// Generate BundleMetadata for testing
    static func createBundleMetadata(
        bundleId: String = TestConstants.bundleId,
        version: String = "1",
        timestamp: Int64? = nil
    ) -> [String: Any] {
        return [
            "bundleId": bundleId,
            "version": version,
            "timestamp": timestamp ?? Int64(Date().timeIntervalSince1970)
        ]
    }
}

// MARK: - File Assertions

struct FileAssertions {
    /// Assert that a file exists at the given path
    static func assertFileExists(
        _ path: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(
            FileManager.default.fileExists(atPath: path),
            "Expected file to exist at: \(path)",
            sourceLocation: sourceLocation
        )
    }

    /// Assert that a file does not exist at the given path
    static func assertFileNotExists(
        _ path: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(
            !FileManager.default.fileExists(atPath: path),
            "Expected file to not exist at: \(path)",
            sourceLocation: sourceLocation
        )
    }

    /// Assert that a directory exists at the given path
    static func assertDirectoryExists(
        _ path: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        #expect(
            exists && isDirectory.boolValue,
            "Expected directory to exist at: \(path)",
            sourceLocation: sourceLocation
        )
    }

    /// Assert that a file contains expected content
    static func assertFileContains(
        _ path: String,
        expectedContent: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let content = try String(contentsOfFile: path, encoding: .utf8)
        #expect(
            content.contains(expectedContent),
            "Expected file at \(path) to contain '\(expectedContent)'",
            sourceLocation: sourceLocation
        )
    }

    /// Assert that a bundle directory has the correct structure
    static func assertBundleStructure(
        _ bundlePath: String,
        platform: String = "ios",
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        assertDirectoryExists(bundlePath, sourceLocation: sourceLocation)

        // Check for index bundle file
        let indexBundle = (bundlePath as NSString)
            .appendingPathComponent("index.\(platform).bundle")
        assertFileExists(indexBundle, sourceLocation: sourceLocation)
    }
}

// MARK: - Test Resource Loading

struct TestResources {
    /// Get the path to a test resource file
    static func path(for resourceName: String) -> String? {
        // In Swift Testing, resources are accessed via Bundle
        let components = resourceName.split(separator: ".")
        guard let name = components.first,
              let ext = components.last else {
            return nil
        }

        return Bundle.module.path(
            forResource: String(name),
            ofType: String(ext)
        )
    }

    /// Load test resource data
    static func data(for resourceName: String) throws -> Data {
        guard let resourcePath = path(for: resourceName) else {
            throw NSError(
                domain: "TestResources",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Resource not found: \(resourceName)"]
            )
        }
        return try Data(contentsOf: URL(fileURLWithPath: resourcePath))
    }

    /// Get URL for test resource
    static func url(for resourceName: String) -> URL? {
        guard let resourcePath = path(for: resourceName) else {
            return nil
        }
        return URL(fileURLWithPath: resourcePath)
    }
}

// MARK: - Progress Tracking

final class ProgressTracker {
    private(set) var progressValues: [Double] = []
    private let lock = NSLock()

    func track(_ progress: Double) {
        lock.lock()
        defer { lock.unlock() }
        progressValues.append(progress)
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        progressValues.removeAll()
    }

    var lastProgress: Double? {
        lock.lock()
        defer { lock.unlock() }
        return progressValues.last
    }

    var minProgress: Double? {
        lock.lock()
        defer { lock.unlock() }
        return progressValues.min()
    }

    var maxProgress: Double? {
        lock.lock()
        defer { lock.unlock() }
        return progressValues.max()
    }
}

// MARK: - Async Test Utilities

struct AsyncTestUtils {
    /// Wait for a condition to be true with timeout
    static func wait(
        timeout: TimeInterval = 5.0,
        condition: @escaping () -> Bool
    ) async throws {
        let startTime = Date()
        while !condition() {
            if Date().timeIntervalSince(startTime) > timeout {
                throw NSError(
                    domain: "AsyncTestUtils",
                    code: 408,
                    userInfo: [NSLocalizedDescriptionKey: "Timeout waiting for condition"]
                )
            }
            try await Task.sleep(nanoseconds: 100_000_000) // 100ms
        }
    }
}

// MARK: - Async Expectation

final class AsyncExpectation {
    private var continuation: CheckedContinuation<Bool, Error>?
    private let lock = NSLock()

    func fulfill(with result: Result<Bool, Error>) {
        lock.lock()
        defer { lock.unlock() }
        if let cont = continuation {
            switch result {
            case .success(let value):
                cont.resume(returning: value)
            case .failure(let error):
                cont.resume(throwing: error)
            }
            continuation = nil
        }
    }

    func value(timeout: TimeInterval) async throws -> Bool {
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            lock.lock()
            self.continuation = continuation
            lock.unlock()

            // Set timeout
            Task {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                lock.lock()
                defer { lock.unlock() }
                if let cont = self.continuation {
                    cont.resume(throwing: NSError(
                        domain: "AsyncExpectation",
                        code: 408,
                        userInfo: [NSLocalizedDescriptionKey: "Timeout after \(timeout)s"]
                    ))
                    self.continuation = nil
                }
            }
        }
    }
}

// MARK: - Test Preferences Service

final class TestPreferencesService: PreferencesService {
    private var storage: [String: String] = [:]
    private var isolationKey: String = ""
    private let baseDir: String

    init(baseDir: String) {
        self.baseDir = baseDir
    }

    func configure(isolationKey: String) {
        self.isolationKey = isolationKey
    }

    private func prefixedKey(forKey key: String) throws -> String {
        guard !isolationKey.isEmpty else {
            throw PreferencesError.configurationError
        }
        return "\(isolationKey)\(key)"
    }

    func setItem(_ value: String?, forKey key: String) throws {
        let fullKey = try prefixedKey(forKey: key)
        if let valueToSet = value {
            storage[fullKey] = valueToSet
        } else {
            storage.removeValue(forKey: fullKey)
        }
    }

    func getItem(forKey key: String) throws -> String? {
        let fullKey = try prefixedKey(forKey: key)
        return storage[fullKey]
    }
}

// MARK: - Test File System Service

final class TestFileSystemService: FileSystemService {
    private let fileManager = FileManager.default
    private let documentsDir: String

    init(documentsDir: String) {
        self.documentsDir = documentsDir
    }

    func fileExists(atPath path: String) -> Bool {
        return fileManager.fileExists(atPath: path)
    }

    func createDirectory(atPath path: String) -> Bool {
        do {
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch {
            return false
        }
    }

    func removeItem(atPath path: String) throws {
        try fileManager.removeItem(atPath: path)
    }

    func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        try fileManager.moveItem(atPath: srcPath, toPath: dstPath)
    }

    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        try fileManager.copyItem(atPath: srcPath, toPath: dstPath)
    }

    func contentsOfDirectory(atPath path: String) throws -> [String] {
        return try fileManager.contentsOfDirectory(atPath: path)
    }

    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        return try fileManager.attributesOfItem(atPath: path)
    }

    func documentsPath() -> String {
        return documentsDir
    }
}

// MARK: - Test Download Service

/// A test download service that uses MockURLProtocol for network interception
final class TestURLSessionDownloadService: NSObject, DownloadService {
    private var session: URLSession!
    private var progressHandlers: [URLSessionTask: (Double) -> Void] = [:]
    private var completionHandlers: [URLSessionTask: (Result<URL, Error>) -> Void] = [:]
    private var destinations: [URLSessionTask: String] = [:]

    override init() {
        super.init()
        let configuration = URLSessionConfiguration.mockConfiguration
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func getFileSize(from url: URL, completion: @escaping (Result<Int64, Error>) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"

        let task = session.dataTask(with: request) { _, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(DownloadError.invalidContentLength))
                return
            }

            let contentLength = httpResponse.expectedContentLength
            if contentLength > 0 {
                completion(.success(contentLength))
            } else {
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

extension TestURLSessionDownloadService: URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let completion = completionHandlers[downloadTask]
        let destination = destinations[downloadTask]

        defer {
            progressHandlers.removeValue(forKey: downloadTask)
            completionHandlers.removeValue(forKey: downloadTask)
            destinations.removeValue(forKey: downloadTask)
        }

        guard let destination = destination else {
            completion?(.failure(NSError(domain: "HotUpdaterError", code: 1, userInfo: [NSLocalizedDescriptionKey: "Destination path not found"])))
            return
        }

        do {
            let destinationURL = URL(fileURLWithPath: destination)

            if FileManager.default.fileExists(atPath: destination) {
                try FileManager.default.removeItem(at: destinationURL)
            }

            try FileManager.default.copyItem(at: location, to: destinationURL)
            completion?(.success(destinationURL))
        } catch {
            completion?(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            let completion = completionHandlers[task]
            defer {
                progressHandlers.removeValue(forKey: task)
                completionHandlers.removeValue(forKey: task)
                destinations.removeValue(forKey: task)
            }
            completion?(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let progressHandler = progressHandlers[downloadTask]

        if totalBytesExpectedToWrite > 0 {
            let progress = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
            progressHandler?(progress)
        } else {
            progressHandler?(0)
        }
    }
}
