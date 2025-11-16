import Foundation
import Testing

@Suite("HotUpdater E2E Integration Tests")
struct HotUpdaterIntegrationTests {

    // MARK: - Infrastructure Tests

    @Test("Basic test - Check if test framework works")
    func testBasic() async throws {
        // Simple assertion to verify tests run
        #expect(1 + 1 == 2, "Basic math should work")
    }

    @Test("Check if original sources are accessible")
    func testSourcesAccessible() async throws {
        // Verify we can create instances of classes from original sources
        let fileManager = FileManagerService()
        #expect(fileManager != nil, "FileManagerService should be accessible")

        let decompressService = DecompressService()
        #expect(decompressService != nil, "DecompressService should be accessible")
    }

    // MARK: - 1. Basic OTA Flow Tests

    @Test("Complete OTA update flow - First install")
    func testCompleteOTAUpdate_FirstInstall() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        // Setup
        let tempDir = tempDirManager.createTempDirectory()
        let fileManager = FileManagerService()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()
        let preferences = TestPreferencesService(baseDir: tempDir.path)

        // Configure preferences with isolation key
        let isolationKey = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        preferences.configure(isolationKey: isolationKey)

        // Create custom file system with temp directory
        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences
        )

        // Register mock response with valid bundle
        guard let validBundlePath = TestResources.path(for: "test-bundle-valid.zip") else {
            Issue.record("Valid test bundle not found")
            return
        }
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let progressTracker = ProgressTracker()

        // Execute update
        let expectation = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { progress in
                progressTracker.track(progress)
            },
            completion: { result in
                expectation.fulfill(with: result)
            }
        )

        // Wait for completion
        let updateResult = try await expectation.value(timeout: 10.0)

        // Verify
        #expect(updateResult == true, "Update should succeed")
        #expect(progressTracker.maxProgress ?? 0 >= 0.99, "Progress should reach near 100%")

        // Verify bundle URL is set
        let bundleURL = storage.getBundleURL()
        #expect(bundleURL != nil, "Bundle URL should be set")

        // Verify bundle file exists
        if let bundlePath = bundleURL?.path {
            FileAssertions.assertFileExists(bundlePath)
            try FileAssertions.assertFileContains(bundlePath, expectedContent: "__d(function")
        }

        // Cleanup
        MockURLProtocol.reset()
    }

    @Test("Complete OTA update flow - Upgrade from existing bundle")
    func testCompleteOTAUpdate_Upgrade() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        // Setup
        let tempDir = tempDirManager.createTempDirectory()
        let fileManager = FileManagerService()
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

        // Install v1
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let v1Expectation = AsyncExpectation()
        storage.updateBundle(
            bundleId: "bundle-v1",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in
                v1Expectation.fulfill(with: result)
            }
        )

        _ = try await v1Expectation.value(timeout: 10.0)

        let v1BundleURL = storage.getBundleURL()
        #expect(v1BundleURL != nil, "v1 bundle should be installed")

        // Install v2
        let v2Expectation = AsyncExpectation()
        storage.updateBundle(
            bundleId: "bundle-v2",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in
                v2Expectation.fulfill(with: result)
            }
        )

        _ = try await v2Expectation.value(timeout: 10.0)

        // Verify v2 is active
        let v2BundleURL = storage.getBundleURL()
        #expect(v2BundleURL != nil, "v2 bundle should be installed")
        #expect(v2BundleURL?.path.contains("bundle-v2") == true, "Active bundle should be v2")

        // Verify v2 bundle directory exists
        let storeDirResult = storage.bundleStoreDir()
        guard case .success(let storeDir) = storeDirResult else {
            Issue.record("Failed to get store directory")
            return
        }

        let v2Dir = (storeDir as NSString).appendingPathComponent("bundle-v2")
        FileAssertions.assertDirectoryExists(v2Dir)

        // Note: v1 cleanup happens asynchronously in the background
        // We verify that v2 is correctly installed and active
        // The cleanup of v1 is not guaranteed to complete immediately

        // Cleanup
        MockURLProtocol.reset()
    }

    @Test("Update with progress tracking")
    func testUpdateWithProgress() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        // Setup
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

        let progressTracker = ProgressTracker()

        let expectation = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { progress in
                progressTracker.track(progress)
            },
            completion: { result in
                expectation.fulfill(with: result)
            }
        )

        _ = try await expectation.value(timeout: 10.0)

        // Verify progress tracking
        #expect(progressTracker.progressValues.count > 0, "Should have progress updates")
        #expect(progressTracker.minProgress ?? 1.0 < 0.1, "Should start near 0%")
        #expect(progressTracker.maxProgress ?? 0 >= 0.95, "Should reach near 100%")

        // Verify progress generally increases (allow some variance due to threading)
        let values = progressTracker.progressValues
        if values.count > 1 {
            let firstHalf = values.prefix(values.count / 2).max() ?? 0
            let secondHalf = values.suffix(values.count / 2).min() ?? 1
            #expect(secondHalf >= firstHalf - 0.2, "Progress should generally increase over time")
        }

        // Cleanup
        MockURLProtocol.reset()
    }

    // MARK: - 2. File System Isolation Tests

    @Test("Isolation by different app versions")
    func testIsolation_DifferentAppVersions() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService1 = TestURLSessionDownloadService()
        let downloadService2 = TestURLSessionDownloadService()
        let decompressService1 = DecompressService()
        let decompressService2 = DecompressService()

        // Create two preferences services with different app versions
        let preferences1 = TestPreferencesService(baseDir: tempDir.path)
        let preferences2 = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey1 = "test-app-1.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"
        let isolationKey2 = "test-app-2.0.0-\(TestConstants.fingerprint)-\(TestConstants.channel)"

        preferences1.configure(isolationKey: isolationKey1)
        preferences2.configure(isolationKey: isolationKey2)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage1 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService1,
            decompressService: decompressService1,
            preferences: preferences1
        )

        let storage2 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService2,
            decompressService: decompressService2,
            preferences: preferences2
        )

        guard let validBundlePath = TestResources.path(for: "test-bundle-valid.zip") else {
            Issue.record("Valid test bundle not found")
            return
        }

        // Install bundle for app version 1.0.0
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp1 = AsyncExpectation()
        storage1.updateBundle(
            bundleId: "bundle-1",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp1.fulfill(with: result) }
        )
        let result1 = try await exp1.value(timeout: 10.0)
        #expect(result1 == true, "Bundle 1 update should succeed")

        MockURLProtocol.reset()

        // Install bundle for app version 2.0.0
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp2 = AsyncExpectation()
        storage2.updateBundle(
            bundleId: "bundle-2",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp2.fulfill(with: result) }
        )
        let result2 = try await exp2.value(timeout: 10.0)
        #expect(result2 == true, "Bundle 2 update should succeed")

        // Verify preferences are isolated (the key test for isolation)
        let prefs1Value = try? preferences1.getItem(forKey: "HotUpdaterBundleURL")
        let prefs2Value = try? preferences2.getItem(forKey: "HotUpdaterBundleURL")

        #expect(prefs1Value != nil, "Preferences 1 should have value")
        #expect(prefs2Value != nil, "Preferences 2 should have value")
        #expect(prefs1Value != prefs2Value, "Preferences should be isolated by app version")

        // Note: We can't reliably test both bundles existing on disk simultaneously
        // because cleanup from one storage might affect the other (shared file system).
        // The key isolation test is the preferences isolation above.

        // Verify at least bundle 2 exists (the most recent)
        let bundle2URL = storage2.getBundleURL()
        #expect(bundle2URL != nil, "Bundle 2 should exist")

        MockURLProtocol.reset()
    }

    @Test("Isolation by different fingerprints")
    func testIsolation_DifferentFingerprints() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()

        let preferences1 = TestPreferencesService(baseDir: tempDir.path)
        let preferences2 = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey1 = "test-app-1.0.0-fingerprint-abc123-\(TestConstants.channel)"
        let isolationKey2 = "test-app-1.0.0-fingerprint-def456-\(TestConstants.channel)"

        preferences1.configure(isolationKey: isolationKey1)
        preferences2.configure(isolationKey: isolationKey2)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage1 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences1
        )

        let storage2 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences2
        )

        guard let validBundlePath = TestResources.path(for: "test-bundle-valid.zip") else {
            Issue.record("Valid test bundle not found")
            return
        }

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp1 = AsyncExpectation()
        storage1.updateBundle(
            bundleId: "bundle-1",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp1.fulfill(with: result) }
        )
        _ = try await exp1.value(timeout: 10.0)

        MockURLProtocol.reset()
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp2 = AsyncExpectation()
        storage2.updateBundle(
            bundleId: "bundle-2",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp2.fulfill(with: result) }
        )
        _ = try await exp2.value(timeout: 10.0)

        // Verify isolation
        let prefs1Value = try? preferences1.getItem(forKey: "HotUpdaterBundleURL")
        let prefs2Value = try? preferences2.getItem(forKey: "HotUpdaterBundleURL")

        #expect(prefs1Value != nil && prefs2Value != nil, "Both preferences should have values")
        #expect(prefs1Value != prefs2Value, "Preferences should be isolated by fingerprint")

        MockURLProtocol.reset()
    }

    @Test("Isolation by different channels")
    func testIsolation_DifferentChannels() async throws {
        let tempDirManager = TempDirectoryManager()
        defer { tempDirManager.cleanupAll() }

        let tempDir = tempDirManager.createTempDirectory()
        let downloadService = TestURLSessionDownloadService()
        let decompressService = DecompressService()

        let preferences1 = TestPreferencesService(baseDir: tempDir.path)
        let preferences2 = TestPreferencesService(baseDir: tempDir.path)

        let isolationKey1 = "test-app-1.0.0-\(TestConstants.fingerprint)-production"
        let isolationKey2 = "test-app-1.0.0-\(TestConstants.fingerprint)-staging"

        preferences1.configure(isolationKey: isolationKey1)
        preferences2.configure(isolationKey: isolationKey2)

        let customFileSystem = TestFileSystemService(documentsDir: tempDir.path)

        let storage1 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences1
        )

        let storage2 = BundleFileStorageService(
            fileSystem: customFileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences2
        )

        guard let validBundlePath = TestResources.path(for: "test-bundle-valid.zip") else {
            Issue.record("Valid test bundle not found")
            return
        }

        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp1 = AsyncExpectation()
        storage1.updateBundle(
            bundleId: "bundle-prod",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp1.fulfill(with: result) }
        )
        _ = try await exp1.value(timeout: 10.0)

        MockURLProtocol.reset()
        try MockURLProtocol.registerMockResponseFromFile(
            url: TestConstants.mockBundleUrl,
            filePath: validBundlePath
        )

        let exp2 = AsyncExpectation()
        storage2.updateBundle(
            bundleId: "bundle-staging",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in exp2.fulfill(with: result) }
        )
        _ = try await exp2.value(timeout: 10.0)

        // Verify channel isolation
        let prefs1Value = try? preferences1.getItem(forKey: "HotUpdaterBundleURL")
        let prefs2Value = try? preferences2.getItem(forKey: "HotUpdaterBundleURL")

        #expect(prefs1Value != nil && prefs2Value != nil, "Both channels should have values")
        #expect(prefs1Value != prefs2Value, "Channels should be isolated")

        MockURLProtocol.reset()
    }
}
