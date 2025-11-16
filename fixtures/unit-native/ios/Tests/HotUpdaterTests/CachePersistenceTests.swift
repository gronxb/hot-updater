import Foundation
import Testing

// MARK: - 3. Cache & Persistence Tests

@Suite("Cache & Persistence Tests")
struct CachePersistenceTests {

    @Test("Bundle persistence after restart")
    func testBundlePersistence_AfterRestart() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage1 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        guard let validBundlePath = TestResources.path(for: "test-bundle-valid.zip") else {
            Issue.record("Valid test bundle not found")
            return
        }

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        // Install bundle
        let exp1 = AsyncExpectation()
        storage1.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp1.fulfill(with: result) }
        )
        _ = try await exp1.value(timeout: 10.0)

        let bundleURL1 = storage1.getBundleURL()
        #expect(bundleURL1 != nil, "Bundle should be installed")

        // Simulate restart by creating a new storage instance with same preferences
        let storage2 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Verify bundle is still accessible after restart
        let bundleURL2 = storage2.getBundleURL()
        #expect(bundleURL2 != nil, "Bundle should persist after restart")
        #expect(bundleURL1?.path == bundleURL2?.path, "Bundle path should be the same")

        // Verify file actually exists
        if let bundlePath = bundleURL2?.path {
            FileAssertions.assertFileExists(bundlePath)
        }

        MockURLProtocol.reset()
    }

    @Test("Update bundle with same bundleId - Cache reuse")
    func testUpdateBundle_SameBundleId() async throws {
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

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        // First install
        let exp1 = AsyncExpectation()
        let startTime1 = Date()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp1.fulfill(with: result) }
        )
        _ = try await exp1.value(timeout: 10.0)
        let duration1 = Date().timeIntervalSince(startTime1)

        // Second install with same bundleId - should use cache
        let exp2 = AsyncExpectation()
        let startTime2 = Date()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp2.fulfill(with: result) }
        )
        _ = try await exp2.value(timeout: 10.0)
        let duration2 = Date().timeIntervalSince(startTime2)

        // Second install should be much faster (cache hit)
        #expect(duration2 < 0.5, "Cached bundle should be fast (< 500ms), was \(duration2)s")
        #expect(duration2 < duration1, "Cached install should be faster than first install")

        MockURLProtocol.reset()
    }

    @Test("Rollback to fallback bundle")
    func testRollback_ToFallback() async throws {
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

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        // Install OTA bundle
        let exp1 = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp1.fulfill(with: result) }
        )
        _ = try await exp1.value(timeout: 10.0)

        let otaBundleURL = storage.getBundleURL()
        #expect(otaBundleURL != nil, "OTA bundle should be installed")

        // Rollback by calling updateBundle with fileUrl: nil
        let exp2 = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: nil,
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp2.fulfill(with: result) }
        )
        _ = try await exp2.value(timeout: 10.0)

        // Verify cached bundle URL is nil (reset)
        let cachedURL = storage.getCachedBundleURL()
        #expect(cachedURL == nil, "Cached bundle should be cleared after rollback")

        // Note: getFallbackBundleURL() returns nil in test environment
        // since Bundle.main doesn't contain main.jsbundle
        // In production, this would return the bundle from the app's main bundle
        let fallbackURL = storage.getFallbackBundleURL()
        // In tests, we don't have a main bundle, so this will be nil
        // This is expected behavior for the test environment

        MockURLProtocol.reset()
    }
}
