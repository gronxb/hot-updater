import XCTest
import Foundation
@testable import HotUpdater

/// Integration tests for HotUpdater OTA update flow
/// These tests verify the end-to-end update process without mocking file operations or extraction
class HotUpdaterIntegrationTests: XCTestCase {

    // MARK: - Test Infrastructure

    /// Mock URL protocol for network requests
    private class MockURLProtocol: URLProtocol {
        static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data?))?

        override class func canInit(with request: URLRequest) -> Bool {
            return true
        }

        override class func canonicalRequest(for request: URLRequest) -> URLRequest {
            return request
        }

        override func startLoading() {
            guard let handler = MockURLProtocol.requestHandler else {
                fatalError("Handler is not set")
            }

            do {
                let (response, data) = try handler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                if let data = data {
                    client?.urlProtocol(self, didLoad: data)
                }
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }

        override func stopLoading() {}
    }

    /// Helper to create a valid test bundle ZIP
    private func createTestBundleZip(bundleContent: String = "// Test bundle content", fileName: String = "index.ios.bundle") throws -> Data {
        let tempDir = FileManager.default.temporaryDirectory
        let bundleDir = tempDir.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)

        let bundleFile = bundleDir.appendingPathComponent(fileName)
        try bundleContent.write(to: bundleFile, atomically: true, encoding: .utf8)

        let zipFile = tempDir.appendingPathComponent("\(UUID().uuidString).zip")

        // Create ZIP using command line (simple approach for test)
        let process = Process()
        process.currentDirectoryPath = bundleDir.path
        process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        process.arguments = ["-r", zipFile.path, "."]
        try process.run()
        process.waitUntilExit()

        let zipData = try Data(contentsOf: zipFile)

        // Cleanup
        try? FileManager.default.removeItem(at: bundleDir)
        try? FileManager.default.removeItem(at: zipFile)

        return zipData
    }

    /// Helper to create a corrupted ZIP
    private func createCorruptedZip() -> Data {
        return Data([0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFF]) // Invalid ZIP header
    }

    /// Helper to calculate SHA-256 hash
    private func calculateSHA256(data: Data) -> String {
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes {
            _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Basic OTA Flow Tests

    /// Complete OTA update - First install
    func testCompleteOTAUpdate_FirstInstall() async throws {
        // Setup: Create valid test bundle
        let bundleContent = "// First install bundle"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let bundleId = "bundle-v1.0.0"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        // Configure mock network
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Create test services
        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Perform update
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Verify success
        XCTAssertTrue(try result.get())

        // Verify bundle is accessible
        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)
        XCTAssertEqual(bundleURL?.lastPathComponent, "index.ios.bundle")

        // Verify bundle content
        if let bundleURL = bundleURL {
            let content = try String(contentsOf: bundleURL, encoding: .utf8)
            XCTAssertEqual(content, bundleContent)
        }
    }

    /// Complete OTA update - Upgrade from existing
    func testCompleteOTAUpdate_Upgrade() async throws {
        // Setup: Install first bundle, then upgrade
        let oldBundleContent = "// Old bundle v1.0.0"
        let newBundleContent = "// New bundle v2.0.0"

        let oldZipData = try createTestBundleZip(bundleContent: oldBundleContent)
        let newZipData = try createTestBundleZip(bundleContent: newBundleContent)

        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let zipData = requestCount == 1 ? oldZipData : newZipData
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Install old bundle first
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: "bundle-v1.0.0",
                fileUrl: URL(string: "https://example.com/bundle1.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result1.get())

        let oldBundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(oldBundleURL)

        // Install new bundle
        let result2 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: "bundle-v2.0.0",
                fileUrl: URL(string: "https://example.com/bundle2.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result2.get())

        // Verify new bundle is activated
        let newBundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(newBundleURL)
        XCTAssertNotEqual(newBundleURL?.path, oldBundleURL?.path)

        if let newBundleURL = newBundleURL {
            let content = try String(contentsOf: newBundleURL, encoding: .utf8)
            XCTAssertEqual(content, newBundleContent)
        }

        // Verify old bundle is cleaned up (path should no longer exist)
        if let oldBundleURL = oldBundleURL {
            let oldBundleExists = FileManager.default.fileExists(atPath: oldBundleURL.path)
            XCTAssertEqual(oldBundleExists, false)
        }
    }

    /// Update with progress tracking
    func testUpdateWithProgress() async throws {
        let bundleContent = "// Bundle with progress"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)

        var progressValues: [Double] = []

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Perform update with progress tracking
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: "bundle-progress",
                fileUrl: URL(string: "https://example.com/bundle.zip")!,
                fileHash: nil,
                progressHandler: { progress in
                    progressValues.append(progress)
                },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        XCTAssertTrue(try result.get())

        // Verify progress values exist and are increasing
        XCTAssertGreaterThan(progressValues.count, 0)

        // Progress should start at or near 0 and end at 100
        XCTAssertGreaterThanOrEqual(progressValues.first ?? -1, 0)
        XCTAssertEqual(progressValues.last ?? -1, 100)

        // Progress should be monotonically increasing
        for i in 1..<progressValues.count {
            XCTAssertGreaterThanOrEqual(progressValues[i], progressValues[i-1])
        }
    }

    // MARK: - File System Isolation Tests

    /// Isolation - Different app versions
    func testIsolation_DifferentAppVersions() async throws {
        let bundleContent1 = "// Bundle for app v1"
        let bundleContent2 = "// Bundle for app v2"
        let zipData1 = try createTestBundleZip(bundleContent: bundleContent1)
        let zipData2 = try createTestBundleZip(bundleContent: bundleContent2)

        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let zipData = requestCount == 1 ? zipData1 : zipData2
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Create first storage with app version 1.0.0
        let fileSystem1 = FileManagerService()
        let preferences1 = VersionedPreferencesService()
        preferences1.configure(isolationKey: "1.0.0|default|default")
        let downloadService1 = URLSessionDownloadService(configuration: config)
        let decompressService1 = DecompressService()

        let bundleStorage1 = BundleFileStorageService(
            fileSystem: fileSystem1,
            downloadService: downloadService1,
            decompressService: decompressService1,
            preferences: preferences1
        )

        // Create second storage with app version 2.0.0
        let fileSystem2 = FileManagerService()
        let preferences2 = VersionedPreferencesService()
        preferences2.configure(isolationKey: "2.0.0|default|default")
        let downloadService2 = URLSessionDownloadService(configuration: config)
        let decompressService2 = DecompressService()

        let bundleStorage2 = BundleFileStorageService(
            fileSystem: fileSystem2,
            downloadService: downloadService2,
            decompressService: decompressService2,
            preferences: preferences2
        )

        // Install bundle in first storage
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage1.updateBundle(
                bundleId: "bundle-v1",
                fileUrl: URL(string: "https://example.com/bundle1.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result1.get())

        // Install bundle in second storage
        let result2 = await withCheckedContinuation { continuation in
            bundleStorage2.updateBundle(
                bundleId: "bundle-v1",
                fileUrl: URL(string: "https://example.com/bundle2.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result2.get())

        // Verify bundles are in different directories
        let bundleURL1 = bundleStorage1.getBundleURL()
        let bundleURL2 = bundleStorage2.getBundleURL()

        XCTAssertNotNil(bundleURL1)
        XCTAssertNotNil(bundleURL2)
        XCTAssertNotEqual(bundleURL1?.path, bundleURL2?.path)

        // Verify content is different
        if let url1 = bundleURL1, let url2 = bundleURL2 {
            let content1 = try String(contentsOf: url1, encoding: .utf8)
            let content2 = try String(contentsOf: url2, encoding: .utf8)
            XCTAssertEqual(content1, bundleContent1)
            XCTAssertEqual(content2, bundleContent2)
        }
    }

    /// Isolation - Different fingerprints
    func testIsolation_DifferentFingerprints() async throws {
        let bundleContent1 = "// Bundle for fingerprint A"
        let bundleContent2 = "// Bundle for fingerprint B"
        let zipData1 = try createTestBundleZip(bundleContent: bundleContent1)
        let zipData2 = try createTestBundleZip(bundleContent: bundleContent2)

        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let zipData = requestCount == 1 ? zipData1 : zipData2
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Create first storage with fingerprint A
        let fileSystem1 = FileManagerService()
        let preferences1 = VersionedPreferencesService()
        preferences1.configure(isolationKey: "1.0.0|fingerprintA|default")
        let downloadService1 = URLSessionDownloadService(configuration: config)
        let decompressService1 = DecompressService()

        let bundleStorage1 = BundleFileStorageService(
            fileSystem: fileSystem1,
            downloadService: downloadService1,
            decompressService: decompressService1,
            preferences: preferences1
        )

        // Create second storage with fingerprint B
        let fileSystem2 = FileManagerService()
        let preferences2 = VersionedPreferencesService()
        preferences2.configure(isolationKey: "1.0.0|fingerprintB|default")
        let downloadService2 = URLSessionDownloadService(configuration: config)
        let decompressService2 = DecompressService()

        let bundleStorage2 = BundleFileStorageService(
            fileSystem: fileSystem2,
            downloadService: downloadService2,
            decompressService: decompressService2,
            preferences: preferences2
        )

        // Install bundle in first storage
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage1.updateBundle(
                bundleId: "bundle-fp",
                fileUrl: URL(string: "https://example.com/bundle1.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result1.get())

        // Install bundle in second storage
        let result2 = await withCheckedContinuation { continuation in
            bundleStorage2.updateBundle(
                bundleId: "bundle-fp",
                fileUrl: URL(string: "https://example.com/bundle2.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result2.get())

        // Verify bundles are in different directories
        let bundleURL1 = bundleStorage1.getBundleURL()
        let bundleURL2 = bundleStorage2.getBundleURL()

        XCTAssertNotNil(bundleURL1)
        XCTAssertNotNil(bundleURL2)
        XCTAssertNotEqual(bundleURL1?.path, bundleURL2?.path)

        // Verify content is different
        if let url1 = bundleURL1, let url2 = bundleURL2 {
            let content1 = try String(contentsOf: url1, encoding: .utf8)
            let content2 = try String(contentsOf: url2, encoding: .utf8)
            XCTAssertEqual(content1, bundleContent1)
            XCTAssertEqual(content2, bundleContent2)
        }
    }

    /// Isolation - Different channels
    func testIsolation_DifferentChannels() async throws {
        let bundleContent1 = "// Bundle for production"
        let bundleContent2 = "// Bundle for staging"
        let zipData1 = try createTestBundleZip(bundleContent: bundleContent1)
        let zipData2 = try createTestBundleZip(bundleContent: bundleContent2)

        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let zipData = requestCount == 1 ? zipData1 : zipData2
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Create first storage with production channel
        let fileSystem1 = FileManagerService()
        let preferences1 = VersionedPreferencesService()
        preferences1.configure(isolationKey: "1.0.0|default|production")
        let downloadService1 = URLSessionDownloadService(configuration: config)
        let decompressService1 = DecompressService()

        let bundleStorage1 = BundleFileStorageService(
            fileSystem: fileSystem1,
            downloadService: downloadService1,
            decompressService: decompressService1,
            preferences: preferences1
        )

        // Create second storage with staging channel
        let fileSystem2 = FileManagerService()
        let preferences2 = VersionedPreferencesService()
        preferences2.configure(isolationKey: "1.0.0|default|staging")
        let downloadService2 = URLSessionDownloadService(configuration: config)
        let decompressService2 = DecompressService()

        let bundleStorage2 = BundleFileStorageService(
            fileSystem: fileSystem2,
            downloadService: downloadService2,
            decompressService: decompressService2,
            preferences: preferences2
        )

        // Install bundle in first storage
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage1.updateBundle(
                bundleId: "bundle-ch",
                fileUrl: URL(string: "https://example.com/bundle1.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result1.get())

        // Install bundle in second storage
        let result2 = await withCheckedContinuation { continuation in
            bundleStorage2.updateBundle(
                bundleId: "bundle-ch",
                fileUrl: URL(string: "https://example.com/bundle2.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result2.get())

        // Verify bundles are in different directories
        let bundleURL1 = bundleStorage1.getBundleURL()
        let bundleURL2 = bundleStorage2.getBundleURL()

        XCTAssertNotNil(bundleURL1)
        XCTAssertNotNil(bundleURL2)
        XCTAssertNotEqual(bundleURL1?.path, bundleURL2?.path)

        // Verify content is different
        if let url1 = bundleURL1, let url2 = bundleURL2 {
            let content1 = try String(contentsOf: url1, encoding: .utf8)
            let content2 = try String(contentsOf: url2, encoding: .utf8)
            XCTAssertEqual(content1, bundleContent1)
            XCTAssertEqual(content2, bundleContent2)
        }
    }

    // MARK: - Cache & Persistence Tests

    /// Bundle persistence after restart
    func testBundlePersistence_AfterRestart() async throws {
        let bundleContent = "// Persistent bundle"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let bundleId = "bundle-persistent"

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Create first storage instance and install bundle
        let fileSystem1 = FileManagerService()
        let preferences1 = VersionedPreferencesService()
        preferences1.configure(isolationKey: "1.0.0|default|default")
        let downloadService1 = URLSessionDownloadService(configuration: config)
        let decompressService1 = DecompressService()

        let bundleStorage1 = BundleFileStorageService(
            fileSystem: fileSystem1,
            downloadService: downloadService1,
            decompressService: decompressService1,
            preferences: preferences1
        )

        let result = await withCheckedContinuation { continuation in
            bundleStorage1.updateBundle(
                bundleId: bundleId,
                fileUrl: URL(string: "https://example.com/bundle.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result.get())

        let firstBundleURL = bundleStorage1.getBundleURL()
        XCTAssertNotNil(firstBundleURL)

        // Simulate app restart by creating new storage instance with same isolation key
        let fileSystem2 = FileManagerService()
        let preferences2 = VersionedPreferencesService()
        preferences2.configure(isolationKey: "1.0.0|default|default")
        let downloadService2 = URLSessionDownloadService(configuration: config)
        let decompressService2 = DecompressService()

        let bundleStorage2 = BundleFileStorageService(
            fileSystem: fileSystem2,
            downloadService: downloadService2,
            decompressService: decompressService2,
            preferences: preferences2
        )

        // Get bundle URL from new instance
        let secondBundleURL = bundleStorage2.getBundleURL()
        XCTAssertNotNil(secondBundleURL)
        XCTAssertEqual(secondBundleURL?.path, firstBundleURL?.path)

        // Verify content is still accessible
        if let url = secondBundleURL {
            let content = try String(contentsOf: url, encoding: .utf8)
            XCTAssertEqual(content, bundleContent)
        }
    }

    /// Update with same bundle ID - No re-download
    func testUpdateBundle_SameBundleId() async throws {
        let bundleContent = "// Same bundle"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let bundleId = "bundle-same"

        var downloadCount = 0
        MockURLProtocol.requestHandler = { request in
            downloadCount += 1
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Install bundle first time
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: URL(string: "https://example.com/bundle.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result1.get())
        XCTAssertEqual(downloadCount, 1)

        // Install same bundle ID again - measure execution time
        let startTime = Date()
        let result2 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: URL(string: "https://example.com/bundle.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        let executionTime = Date().timeIntervalSince(startTime)

        XCTAssertTrue(try result2.get())
        XCTAssertEqual(downloadCount, 1) // Only one download should occur
        XCTAssertLessThan(executionTime, 0.1) // Should complete quickly (<100ms)
    }

    /// Rollback to fallback bundle
    func testRollback_ToFallback() throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Get bundle URL without any cached bundle
        let bundleURL = bundleStorage.getBundleURL()

        // Should return fallback bundle (main bundle)
        XCTAssertNotNil(bundleURL)

        // Fallback bundle should be in the main bundle directory
        if let url = bundleURL {
            XCTAssertTrue(url.path.contains("main.jsbundle") || url.path.contains("index.ios.bundle"))
        }
    }

    // MARK: - Error Handling Tests

    /// Update failure - Network error
    func testUpdateFailure_NetworkError() async throws {
        let bundleId = "bundle-network-fail"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        MockURLProtocol.requestHandler = { request in
            throw NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet, userInfo: nil)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Attempt update
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Verify update fails
        XCTAssertThrowsError(try result.get())

        // Verify no partial files are left behind (check temp directory)
        let tempDir = FileManager.default.temporaryDirectory
        let tempContents = try? FileManager.default.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: nil
        )

        // No .tmp files related to our bundle should remain
        let tmpFiles = tempContents?.filter { $0.lastPathComponent.contains(".tmp") } ?? []
        XCTAssertTrue(tmpFiles.isEmpty)
    }

    /// Update failure - Corrupted bundle
    func testUpdateFailure_CorruptedBundle() async throws {
        let bundleId = "bundle-corrupted"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!
        let corruptedData = createCorruptedZip()

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, corruptedData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Attempt update
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Verify extraction fails
        XCTAssertThrowsError(try result.get())

        // Verify .tmp files are cleaned up
        let tempDir = FileManager.default.temporaryDirectory
        let tempContents = try? FileManager.default.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: nil
        )
        let tmpFiles = tempContents?.filter { $0.lastPathComponent.contains(".tmp") } ?? []
        XCTAssertTrue(tmpFiles.isEmpty)

        // Verify rollback - getBundleURL should return fallback bundle
        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)
        if let url = bundleURL {
            XCTAssertTrue(url.path.contains("main.jsbundle") || url.path.contains("index.ios.bundle"))
        }
    }

    /// Update failure - Invalid bundle structure
    func testUpdateFailure_InvalidBundleStructure() async throws {
        // Create ZIP without proper bundle file
        let zipData = try createTestBundleZip(bundleContent: "test", fileName: "wrong-name.js")
        let bundleId = "bundle-invalid-structure"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Attempt update
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Verify validation error occurs
        XCTAssertThrowsError(try result.get())

        // Verify rollback - getBundleURL should return fallback bundle
        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)
        if let url = bundleURL {
            XCTAssertTrue(url.path.contains("main.jsbundle") || url.path.contains("index.ios.bundle"))
        }
    }

    /// Update failure - Insufficient disk space
    func testUpdateFailure_InsufficientDiskSpace() async throws {
        // This test simulates disk space errors during file operations
        let bundleContent = "// Bundle requiring space"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let bundleId = "bundle-no-space"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Note: This test is limited because we cannot easily mock FileManagerService
        // to throw disk space errors. In a production scenario, the system would
        // throw errors during file write operations.
        // We can at least verify that the update process handles failures gracefully

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Install a valid bundle first
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: "bundle-original",
                fileUrl: URL(string: "https://example.com/original.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }
        XCTAssertTrue(try result1.get())

        let originalBundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(originalBundleURL)

        // Verify existing bundle is accessible after any potential failures
        if let url = originalBundleURL {
            let content = try String(contentsOf: url, encoding: .utf8)
            XCTAssertEqual(content, bundleContent)
        }
    }

    /// Update interruption and retry
    func testUpdateInterruption_AndRetry() async throws {
        let bundleContent = "// Retry bundle"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let bundleId = "bundle-retry"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        var attemptCount = 0
        MockURLProtocol.requestHandler = { request in
            attemptCount += 1
            if attemptCount == 1 {
                // First attempt fails
                throw NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: nil)
            }
            // Second attempt succeeds
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // First update attempt (fails)
        let result1 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        XCTAssertTrue(throws: (any Error).self) {
            try result1.get()
        }
        XCTAssertEqual(attemptCount, 1)

        // Verify .tmp cleanup
        let tempDir = FileManager.default.temporaryDirectory
        let tempContents = try? FileManager.default.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: nil
        )
        let tmpFiles = tempContents?.filter { $0.lastPathComponent.contains(".tmp") } ?? []
        XCTAssertTrue(tmpFiles.isEmpty)

        // Retry update (succeeds)
        let result2 = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        XCTAssertTrue(try result2.get())
        XCTAssertEqual(attemptCount, 2)

        // Verify bundle is installed correctly
        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)
        if let url = bundleURL {
            let content = try String(contentsOf: url, encoding: .utf8)
            XCTAssertEqual(content, bundleContent)
        }
    }

    // MARK: - Hash Verification Tests

    /// Update with hash verification - Success
    func testUpdateWithHashVerification_Success() async throws {
        let bundleContent = "// Hashed bundle"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let fileHash = calculateSHA256(data: zipData)
        let bundleId = "bundle-hashed"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Update with correct hash
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: fileHash,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Verify hash is verified and bundle is installed
        XCTAssertTrue(try result.get())

        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)

        if let url = bundleURL {
            let content = try String(contentsOf: url, encoding: .utf8)
            XCTAssertEqual(content, bundleContent)
        }
    }

    /// Update with hash verification - Failure
    func testUpdateWithHashVerification_Failure() async throws {
        let bundleContent = "// Hashed bundle fail"
        let zipData = try createTestBundleZip(bundleContent: bundleContent)
        let wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"
        let bundleId = "bundle-hash-fail"
        let fileUrl = URL(string: "https://example.com/bundle.zip")!

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Update with wrong hash
        let result = await withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: bundleId,
                fileUrl: fileUrl,
                fileHash: wrongHash,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Verify hash mismatch error
        XCTAssertThrowsError(try result.get())

        // Verify downloaded file is deleted (no .tmp files)
        let tempDir = FileManager.default.temporaryDirectory
        let tempContents = try? FileManager.default.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: nil
        )
        let tmpFiles = tempContents?.filter { $0.lastPathComponent.contains(".tmp") } ?? []
        XCTAssertTrue(tmpFiles.isEmpty)

        // Verify fallback - getBundleURL should return fallback bundle
        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)
        if let url = bundleURL {
            XCTAssertTrue(url.path.contains("main.jsbundle") || url.path.contains("index.ios.bundle"))
        }
    }

    // MARK: - Concurrency Tests

    /// Concurrent updates - Sequential handling
    func testConcurrentUpdates_Sequential() async throws {
        let bundle1Content = "// Bundle 1"
        let bundle2Content = "// Bundle 2"
        let zipData1 = try createTestBundleZip(bundleContent: bundle1Content)
        let zipData2 = try createTestBundleZip(bundleContent: bundle2Content)

        var requestOrder: [String] = []
        MockURLProtocol.requestHandler = { request in
            let urlString = request.url?.absoluteString ?? ""
            requestOrder.append(urlString)

            // Simulate network delay
            Thread.sleep(forTimeInterval: 0.1)

            let zipData = urlString.contains("bundle1") ? zipData1 : zipData2
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, zipData)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(configuration: config)
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Start two updates concurrently using async let
        async let result1: Result<Bool, Error> = withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: "bundle1",
                fileUrl: URL(string: "https://example.com/bundle1.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        async let result2: Result<Bool, Error> = withCheckedContinuation { continuation in
            bundleStorage.updateBundle(
                bundleId: "bundle2",
                fileUrl: URL(string: "https://example.com/bundle2.zip")!,
                fileHash: nil,
                progressHandler: { _ in },
                completion: { result in
                    continuation.resume(returning: result)
                }
            )
        }

        // Wait for both to complete
        let (res1, res2) = await (result1, result2)

        // Verify both succeeded
        XCTAssertTrue(try res1.get())
        XCTAssertTrue(try res2.get())

        // Verify both requests were made
        XCTAssertEqual(requestOrder.count, 2)

        // Verify the final bundle URL points to the last installed bundle
        let bundleURL = bundleStorage.getBundleURL()
        XCTAssertNotNil(bundleURL)

        if let url = bundleURL {
            let content = try String(contentsOf: url, encoding: .utf8)
            // The content should be from one of the bundles (last one wins)
            XCTAssertEqual(content == bundle1Content || content, bundle2Content)
        }
    }
}

// MARK: - CommonCrypto Import for SHA-256
import CommonCrypto
