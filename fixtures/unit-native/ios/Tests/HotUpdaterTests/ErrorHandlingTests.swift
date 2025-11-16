import Foundation
import Testing

// MARK: - 4. Error Handling Tests

@Suite("Error Handling Tests")
struct ErrorHandlingTests {

    @Test("Network error during download")
    func testUpdateFailure_NetworkError() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Simulate network error
        MockURLProtocol.simulateNetworkError(true)

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        // Expect failure
        do {
            _ = try await exp.value(timeout: 10.0)
            Issue.record("Should have thrown network error")
        } catch {
            // Expected error
            #expect(error != nil, "Should have error")
        }

        // Verify no bundle was set
        let bundleURL = storage.getCachedBundleURL()
        #expect(bundleURL == nil, "No bundle should be set after network error")

        // Verify no incomplete files left behind
        let storeDirResult = storage.bundleStoreDir()
        if case .success(let storeDir) = storeDirResult {
            let bundleDir = (storeDir as NSString).appendingPathComponent(TestConstants.bundleId)
            FileAssertions.assertFileNotExists(bundleDir)
        }

        MockURLProtocol.reset()
    }

    @Test("Corrupted bundle - Extraction failure")
    func testUpdateFailure_CorruptedBundle() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        guard let corruptedBundlePath = TestResources.path(for: "test-bundle-corrupted.zip") else {
            Issue.record("Corrupted test bundle not found")
            return
        }

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: corruptedBundlePath
        )

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        // Expect extraction failure
        do {
            _ = try await exp.value(timeout: 10.0)
            Issue.record("Should have thrown extraction error")
        } catch {
            // Expected error
            #expect(error != nil, "Should have extraction error")
        }

        // Verify no bundle was set
        let bundleURL = storage.getCachedBundleURL()
        #expect(bundleURL == nil, "No bundle should be set after extraction error")

        // Verify .tmp directory was cleaned up
        let storeDirResult = storage.bundleStoreDir()
        if case .success(let storeDir) = storeDirResult {
            let tmpDir = (storeDir as NSString).appendingPathComponent("\(TestConstants.bundleId).tmp")
            FileAssertions.assertFileNotExists(tmpDir)
        }

        MockURLProtocol.reset()
    }

    @Test("Invalid bundle structure - Missing index bundle")
    func testUpdateFailure_InvalidBundleStructure() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        guard let invalidBundlePath = TestResources.path(for: "test-bundle-invalid.zip") else {
            Issue.record("Invalid test bundle not found")
            return
        }

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: invalidBundlePath
        )

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        // Expect invalid bundle error
        do {
            _ = try await exp.value(timeout: 10.0)
            Issue.record("Should have thrown invalid bundle error")
        } catch {
            // Expected error
            #expect(error != nil, "Should have invalid bundle error")
        }

        // Verify no bundle was set
        let bundleURL = storage.getCachedBundleURL()
        #expect(bundleURL == nil, "No bundle should be set after validation error")

        // Verify .tmp directory was cleaned up
        let storeDirResult = storage.bundleStoreDir()
        if case .success(let storeDir) = storeDirResult {
            let tmpDir = (storeDir as NSString).appendingPathComponent("\(TestConstants.bundleId).tmp")
            FileAssertions.assertFileNotExists(tmpDir)
        }

        MockURLProtocol.reset()
    }

    @Test("Insufficient disk space")
    func testUpdateFailure_InsufficientDiskSpace() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Create a very large mock file response (larger than available disk space)
        // We'll use the Content-Length header to simulate this
        let largeFileSize: Int64 = 1_000_000_000_000 // 1TB - more than any device has
        let mockData = Data("fake data".utf8)
        let mockResponse = MockURLProtocol.MockResponse(
            data: mockData,
            statusCode: 200,
            headers: ["Content-Length": String(largeFileSize)]
        )
        MockURLProtocol.registerMockResponse(url: TestConstants.mockBundleUrl, response: mockResponse)

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        // Expect insufficient disk space error
        do {
            _ = try await exp.value(timeout: 10.0)
            Issue.record("Should have thrown insufficient disk space error")
        } catch {
            // Expected error
            #expect(error != nil, "Should have disk space error")
        }

        // Verify no bundle was set
        let bundleURL = storage.getCachedBundleURL()
        #expect(bundleURL == nil, "No bundle should be set after disk space error")

        MockURLProtocol.reset()
    }

    @Test("Update interruption and retry")
    func testUpdateInterruption_AndRetry() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        guard let validBundlePath = TestResources.path(for: "test-bundle-valid.zip") else {
            Issue.record("Valid test bundle not found")
            return
        }

        // Simulate interruption by creating a .tmp directory manually
        let storeDirResult = storage.bundleStoreDir()
        guard case .success(let storeDir) = storeDirResult else {
            Issue.record("Failed to get store directory")
            return
        }

        let tmpDir = (storeDir as NSString).appendingPathComponent("\(TestConstants.bundleId).tmp")
        try? FileManager.default.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
        // Create a dummy file to simulate interrupted state
        let dummyFile = (tmpDir as NSString).appendingPathComponent("dummy.txt")
        try? "interrupted".write(toFile: dummyFile, atomically: true, encoding: .utf8)

        // Verify .tmp exists before retry
        FileAssertions.assertDirectoryExists(tmpDir)

        // Now retry the update
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        _ = try await exp.value(timeout: 10.0)

        // Verify bundle was installed successfully
        let bundleURL = storage.getBundleURL()
        #expect(bundleURL != nil, "Bundle should be installed after retry")

        // Verify .tmp was cleaned up
        FileAssertions.assertFileNotExists(tmpDir)

        // Verify actual bundle directory exists
        let realDir = (storeDir as NSString).appendingPathComponent(TestConstants.bundleId)
        FileAssertions.assertDirectoryExists(realDir)

        MockURLProtocol.reset()
    }
}
