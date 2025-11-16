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
