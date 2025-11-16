import Foundation
import Testing

// MARK: - 5. Hash Verification Tests

@Suite("Hash Verification Tests")
struct HashVerificationTests {

    @Test("Hash verification success")
    func testUpdateWithHashVerification_Success() async throws {
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

        // Use the correct hash from HASHES.md
        let correctHash = TestConstants.validBundleHash

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: correctHash,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        _ = try await exp.value(timeout: 10.0)

        // Verify bundle was installed successfully
        let bundleURL = storage.getBundleURL()
        #expect(bundleURL != nil, "Bundle should be installed with correct hash")

        // Verify bundle file exists
        if let bundlePath = bundleURL?.path {
            FileAssertions.assertFileExists(bundlePath)
        }

        MockURLProtocol.reset()
    }

    @Test("Hash verification failure - Hash mismatch")
    func testUpdateWithHashVerification_Failure() async throws {
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

        // Use an incorrect hash
        let incorrectHash = "0000000000000000000000000000000000000000000000000000000000000000"

        let exp = AsyncExpectation()
        storage.updateBundle(
            bundleId: TestConstants.bundleId,
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: incorrectHash,
            progressHandler: { _ in },
            completion: { result in exp.fulfill(with: result) }
        )

        // Expect hash mismatch error
        do {
            _ = try await exp.value(timeout: 10.0)
            Issue.record("Should have thrown hash mismatch error")
        } catch {
            // Expected error
            #expect(error != nil, "Should have hash mismatch error")
        }

        // Verify no bundle was set
        let bundleURL = storage.getCachedBundleURL()
        #expect(bundleURL == nil, "No bundle should be set after hash mismatch")

        // Verify .tmp directory was cleaned up
        let storeDirResult = storage.bundleStoreDir()
        if case .success(let storeDir) = storeDirResult {
            let tmpDir = (storeDir as NSString).appendingPathComponent("\(TestConstants.bundleId).tmp")
            FileAssertions.assertFileNotExists(tmpDir)
        }

        // Verify bundle directory does not exist
        if case .success(let storeDir) = storeDirResult {
            let bundleDir = (storeDir as NSString).appendingPathComponent(TestConstants.bundleId)
            FileAssertions.assertFileNotExists(bundleDir)
        }

        MockURLProtocol.reset()
    }
}

// MARK: - 6. Concurrency Tests

@Suite("Concurrency Tests")
struct ConcurrencyTests {

    @Test("Concurrent updates - Sequential handling")
    func testConcurrentUpdates_Sequential() async throws {
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

        // Update A
        let expA = AsyncExpectation()
        storage.updateBundle(
            bundleId: "bundle-A",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in expA.fulfill(with: result) }
        )
        _ = try await expA.value(timeout: 10.0)

        // Update B after A completes
        let expB = AsyncExpectation()
        storage.updateBundle(
            bundleId: "bundle-B",
            fileUrl: URL(string: TestConstants.mockBundleUrl),
            fileHash: nil,
            progressHandler: { _ in },
            completion: { result in expB.fulfill(with: result) }
        )
        _ = try await expB.value(timeout: 10.0)

        // Verify final state - bundle B should be active
        let finalBundleURL = storage.getBundleURL()
        #expect(finalBundleURL != nil, "A bundle should be active")
        #expect(finalBundleURL?.path.contains("bundle-B") == true, "Bundle B should be the final active bundle")

        // Verify no conflicts occurred - both bundles were processed
        let storeDirResult = storage.bundleStoreDir()
        if case .success(let storeDir) = storeDirResult {
            // Bundle B should exist
            let bundleBDir = (storeDir as NSString).appendingPathComponent("bundle-B")
            FileAssertions.assertDirectoryExists(bundleBDir)

            // Note: Bundle A cleanup happens asynchronously in the background
            // We verify that B is correctly installed and active
        }

        MockURLProtocol.reset()
    }
}
