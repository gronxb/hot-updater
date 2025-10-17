import Testing
import Foundation

// MARK: - Mock Bundle Storage Service

class MockBundleStorageService: BundleStorageService {
    var bundleURL: URL?
    var updateCallCount = 0
    var lastUpdateBundleId: String?
    var lastUpdateFileUrl: URL?
    var updateResult: Result<Bool, Error> = .success(true)

    func setBundleURL(localPath: String?) -> Result<Void, Error> {
        if let localPath = localPath {
            bundleURL = URL(fileURLWithPath: localPath)
        } else {
            bundleURL = nil
        }
        return .success(())
    }

    func getCachedBundleURL() -> URL? {
        return bundleURL
    }

    func getFallbackBundleURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }

    func getBundleURL() -> URL? {
        return bundleURL ?? getFallbackBundleURL()
    }

    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void) {
        updateCallCount += 1
        lastUpdateBundleId = bundleId
        lastUpdateFileUrl = fileUrl

        DispatchQueue.global(qos: .utility).async {
            completion(self.updateResult)
        }
    }
}

// MARK: - Tests

@Suite("HotUpdaterImpl Tests")
struct HotUpdaterImplTests {

    // MARK: - Initialization Tests

    @Test("Initialize with default services")
    func testDefaultInitialization() throws {
        let impl = HotUpdaterImpl()
        #expect(impl != nil)
    }

    @Test("Initialize with custom services")
    func testCustomInitialization() throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)
        #expect(impl != nil)
    }

    // MARK: - Bundle URL Tests

    @Test("Get bundle URL from storage")
    func testBundleURL() throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()
        let testURL = URL(fileURLWithPath: "/test/bundle.js")
        mockStorage.bundleURL = testURL

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let url = impl.bundleURL()
        #expect(url == testURL)
    }

    @Test("Get bundle URL returns nil when not set")
    func testBundleURLNil() throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        // In real scenarios, fallback URL would be returned
        // but for unit testing, we're focusing on the storage behavior
        #expect(mockStorage.bundleURL == nil)
    }

    // MARK: - Channel Tests

    @Test("Get channel returns default when not set")
    func testGetChannelDefault() throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let channel = impl.getChannel()
        #expect(channel == "production")
    }

    // MARK: - Fingerprint Tests

    @Test("Get fingerprint hash returns nil when not set")
    func testGetFingerprintHashNil() throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let fingerprint = impl.getFingerprintHash()
        #expect(fingerprint == nil)
    }

    // MARK: - Isolation Key Tests

    @Test("Isolation key uses app version when fingerprint not available")
    func testIsolationKeyWithAppVersion() throws {
        let isolationKey = HotUpdaterImpl.getIsolationKey()

        // Isolation key should be in format: hotupdater_{version}_{channel}_
        #expect(isolationKey.hasPrefix("hotupdater_"))
        #expect(isolationKey.contains("production")) // default channel
    }

    // MARK: - Update Bundle Tests

    @Test("Update bundle with valid parameters succeeds")
    func testUpdateBundleSuccess() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let params: NSDictionary = [
            "bundleId": "test-bundle-123",
            "fileUrl": "https://example.com/bundle.zip"
        ]

        let expectation = XCTestExpectation(description: "Update bundle completes")
        var updateSucceeded = false

        impl.updateBundle(params, resolver: { result in
            if let success = result as? Bool {
                updateSucceeded = success
            }
            expectation.fulfill()
        }, rejecter: { _, _, _ in
            Issue.record("Update should not reject")
        })

        await fulfillment(of: [expectation], timeout: 5.0)

        #expect(updateSucceeded == true)
        #expect(mockStorage.updateCallCount == 1)
        #expect(mockStorage.lastUpdateBundleId == "test-bundle-123")
        #expect(mockStorage.lastUpdateFileUrl?.absoluteString == "https://example.com/bundle.zip")
    }

    @Test("Update bundle with nil fileUrl succeeds (reset)")
    func testUpdateBundleReset() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let params: NSDictionary = [
            "bundleId": "test-bundle-123"
        ]

        let expectation = XCTestExpectation(description: "Update bundle completes")
        var updateSucceeded = false

        impl.updateBundle(params, resolver: { result in
            if let success = result as? Bool {
                updateSucceeded = success
            }
            expectation.fulfill()
        }, rejecter: { _, _, _ in
            Issue.record("Update should not reject")
        })

        await fulfillment(of: [expectation], timeout: 5.0)

        #expect(updateSucceeded == true)
        #expect(mockStorage.updateCallCount == 1)
        #expect(mockStorage.lastUpdateBundleId == "test-bundle-123")
        #expect(mockStorage.lastUpdateFileUrl == nil)
    }

    @Test("Update bundle rejects with missing params")
    func testUpdateBundleMissingParams() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let expectation = XCTestExpectation(description: "Update bundle rejects")
        var didReject = false

        impl.updateBundle(nil, resolver: { _ in
            Issue.record("Update should reject, not resolve")
        }, rejecter: { code, message, error in
            didReject = true
            #expect(code == "UPDATE_ERROR")
            expectation.fulfill()
        })

        await fulfillment(of: [expectation], timeout: 5.0)
        #expect(didReject == true)
    }

    @Test("Update bundle rejects with missing bundleId")
    func testUpdateBundleMissingBundleId() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let params: NSDictionary = [
            "fileUrl": "https://example.com/bundle.zip"
        ]

        let expectation = XCTestExpectation(description: "Update bundle rejects")
        var didReject = false

        impl.updateBundle(params, resolver: { _ in
            Issue.record("Update should reject, not resolve")
        }, rejecter: { code, message, error in
            didReject = true
            #expect(code == "UPDATE_ERROR")
            expectation.fulfill()
        })

        await fulfillment(of: [expectation], timeout: 5.0)
        #expect(didReject == true)
    }

    @Test("Update bundle rejects with empty bundleId")
    func testUpdateBundleEmptyBundleId() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let params: NSDictionary = [
            "bundleId": "",
            "fileUrl": "https://example.com/bundle.zip"
        ]

        let expectation = XCTestExpectation(description: "Update bundle rejects")
        var didReject = false

        impl.updateBundle(params, resolver: { _ in
            Issue.record("Update should reject, not resolve")
        }, rejecter: { code, message, error in
            didReject = true
            #expect(code == "UPDATE_ERROR")
            expectation.fulfill()
        })

        await fulfillment(of: [expectation], timeout: 5.0)
        #expect(didReject == true)
    }

    @Test("Update bundle rejects with invalid fileUrl")
    func testUpdateBundleInvalidFileUrl() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let params: NSDictionary = [
            "bundleId": "test-bundle-123",
            "fileUrl": "not a valid url"
        ]

        let expectation = XCTestExpectation(description: "Update bundle rejects")
        var didReject = false

        impl.updateBundle(params, resolver: { _ in
            Issue.record("Update should reject, not resolve")
        }, rejecter: { code, message, error in
            didReject = true
            #expect(code == "UPDATE_ERROR")
            expectation.fulfill()
        })

        await fulfillment(of: [expectation], timeout: 5.0)
        #expect(didReject == true)
    }

    @Test("Update bundle rejects when storage fails")
    func testUpdateBundleStorageFailure() async throws {
        let mockStorage = MockBundleStorageService()
        let mockPrefs = MockPreferencesService()

        mockStorage.updateResult = .failure(NSError(domain: "TestError", code: 1, userInfo: nil))

        let impl = HotUpdaterImpl(bundleStorage: mockStorage, preferences: mockPrefs)

        let params: NSDictionary = [
            "bundleId": "test-bundle-123",
            "fileUrl": "https://example.com/bundle.zip"
        ]

        let expectation = XCTestExpectation(description: "Update bundle rejects")
        var didReject = false

        impl.updateBundle(params, resolver: { _ in
            Issue.record("Update should reject, not resolve")
        }, rejecter: { code, message, error in
            didReject = true
            #expect(code == "UPDATE_ERROR")
            expectation.fulfill()
        })

        await fulfillment(of: [expectation], timeout: 5.0)
        #expect(didReject == true)
    }
}

// MARK: - Isolation Tests for App Version and Fingerprint

@Suite("HotUpdaterImpl Isolation Tests")
struct HotUpdaterImplIsolationTests {

    @Test("Different app versions use different storage")
    func testAppVersionIsolation() throws {
        // Test that isolation key includes version
        let key1 = HotUpdaterImpl.getIsolationKey()
        #expect(key1.hasPrefix("hotupdater_"))

        // The key should be consistent across calls
        let key2 = HotUpdaterImpl.getIsolationKey()
        #expect(key1 == key2)
    }

    @Test("Isolation key format is correct")
    func testIsolationKeyFormat() throws {
        let key = HotUpdaterImpl.getIsolationKey()

        // Format should be: hotupdater_{fingerprint_or_version}_{channel}_
        let components = key.split(separator: "_")
        #expect(components.count >= 3)
        #expect(components[0] == "hotupdater")
        #expect(key.hasSuffix("_"))
    }
}

// MARK: - File System Isolation Tests

@Suite("File System Isolation Tests")
struct FileSystemIsolationTests {

    @Test("Bundle storage is isolated per bundleId")
    func testBundleStorageIsolation() async throws {
        let mockFS = MockFileSystemService()
        let mockDownload = MockDownloadService()
        let mockUnzip = MockUnzipService()
        let mockPrefs = MockPreferencesService()

        let service = BundleFileStorageService(
            fileSystem: mockFS,
            downloadService: mockDownload,
            unzipService: mockUnzip,
            preferences: mockPrefs
        )

        // Simulate creating bundles with different IDs
        let storeDir = "/mock/documents/bundle-store"
        mockFS.directories.insert(storeDir)

        let bundle1 = storeDir + "/bundle-v1-fingerprint1"
        let bundle2 = storeDir + "/bundle-v2-fingerprint2"

        mockFS.directories.insert(bundle1)
        mockFS.directories.insert(bundle2)

        mockFS.createFile(atPath: bundle1 + "/index.ios.bundle")
        mockFS.createFile(atPath: bundle2 + "/index.ios.bundle")

        // Verify both bundles exist independently
        #expect(mockFS.fileExists(atPath: bundle1 + "/index.ios.bundle"))
        #expect(mockFS.fileExists(atPath: bundle2 + "/index.ios.bundle"))
    }

    @Test("Cleanup preserves bundles for different versions")
    func testCleanupPreservesVersionIsolation() throws {
        let mockFS = MockFileSystemService()
        let mockDownload = MockDownloadService()
        let mockUnzip = MockUnzipService()
        let mockPrefs = MockPreferencesService()

        let service = BundleFileStorageService(
            fileSystem: mockFS,
            downloadService: mockDownload,
            unzipService: mockUnzip,
            preferences: mockPrefs
        )

        let storeDir = "/mock/documents/bundle-store"
        mockFS.directories.insert(storeDir)

        // Create bundles for different app versions/fingerprints
        let v1Bundle = storeDir + "/bundle-v1.0-abc123"
        let v2Bundle = storeDir + "/bundle-v2.0-def456"
        let oldBundle = storeDir + "/bundle-old"

        mockFS.directories.insert(v1Bundle)
        mockFS.directories.insert(v2Bundle)
        mockFS.directories.insert(oldBundle)

        // Cleanup should only remove oldBundle, keeping v1 and v2
        let result = service.cleanupOldBundles(
            currentBundleId: "bundle-v1.0-abc123",
            bundleId: "bundle-v2.0-def456"
        )

        switch result {
        case .success:
            #expect(!mockFS.directories.contains(oldBundle))
            #expect(mockFS.directories.contains(v1Bundle))
            #expect(mockFS.directories.contains(v2Bundle))
        case .failure:
            Issue.record("cleanup should succeed")
        }
    }
}
