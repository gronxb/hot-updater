import Testing
import Foundation
@testable import HotUpdater

// MARK: - Mock Services

class MockFileSystemService: FileSystemService {
    var files: Set<String> = []
    var directories: Set<String> = []
    var fileContents: [String: Data] = [:]

    func fileExists(atPath path: String) -> Bool {
        return files.contains(path) || directories.contains(path)
    }

    func createDirectory(atPath path: String) -> Bool {
        directories.insert(path)
        return true
    }

    func removeItem(atPath path: String) throws {
        files.remove(path)
        directories.remove(path)
        fileContents.removeValue(forKey: path)
    }

    func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        if files.contains(srcPath) {
            files.remove(srcPath)
            files.insert(dstPath)
            if let content = fileContents[srcPath] {
                fileContents[dstPath] = content
                fileContents.removeValue(forKey: srcPath)
            }
        } else if directories.contains(srcPath) {
            directories.remove(srcPath)
            directories.insert(dstPath)
        }
    }

    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        if files.contains(srcPath) {
            files.insert(dstPath)
            if let content = fileContents[srcPath] {
                fileContents[dstPath] = content
            }
        }
    }

    func contentsOfDirectory(atPath path: String) throws -> [String] {
        let pathPrefix = path.hasSuffix("/") ? path : path + "/"
        var contents: [String] = []

        for file in files where file.hasPrefix(pathPrefix) {
            let relativePath = String(file.dropFirst(pathPrefix.count))
            if !relativePath.contains("/") {
                contents.append(relativePath)
            }
        }

        for dir in directories where dir.hasPrefix(pathPrefix) && dir != path {
            let relativePath = String(dir.dropFirst(pathPrefix.count))
            if !relativePath.contains("/") {
                contents.append(relativePath)
            }
        }

        return contents
    }

    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        return [:]
    }

    func documentsPath() -> String {
        return "/mock/documents"
    }

    // Helper method to simulate file creation
    func createFile(atPath path: String, content: Data = Data()) {
        files.insert(path)
        fileContents[path] = content
    }
}

class MockDownloadService: DownloadService {
    var downloadResult: Result<URL, Error>?
    var downloadedFiles: [(url: URL, destination: String)] = []

    @discardableResult
    func downloadFile(from url: URL,
                      to destination: String,
                      progressHandler: ((Double) -> Void)?,
                      completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionTask? {
        downloadedFiles.append((url, destination))

        DispatchQueue.global(qos: .utility).async {
            if let result = self.downloadResult {
                completion(result)
            } else {
                completion(.success(URL(fileURLWithPath: destination)))
            }
        }

        return nil
    }
}

class MockUnzipService: UnzipService {
    var shouldSucceed: Bool = true
    var unzippedFiles: [(file: String, destination: String)] = []
    var filesInZip: [String] = ["index.ios.bundle"]

    func unzip(file: String, to destination: String) throws {
        unzippedFiles.append((file, destination))

        if !shouldSucceed {
            throw NSError(domain: "MockUnzipError", code: 1, userInfo: nil)
        }

        // Simulate creating files in destination
        // This would be handled by the file system mock
    }
}

class MockPreferencesService: PreferencesService {
    var storage: [String: String] = [:]

    func setItem(_ value: String?, forKey key: String) throws {
        if let value = value {
            storage[key] = value
        } else {
            storage.removeValue(forKey: key)
        }
    }

    func getItem(forKey key: String) throws -> String? {
        return storage[key]
    }
}

// MARK: - Tests

@Suite("BundleFileStorageService Tests")
struct BundleFileStorageServiceTests {

    // MARK: - Bundle URL Tests

    @Test("Get cached bundle URL when it exists")
    func testGetCachedBundleURL() throws {
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

        let bundlePath = "/mock/documents/bundle-store/test-bundle/index.ios.bundle"
        mockFS.createFile(atPath: bundlePath)
        try mockPrefs.setItem("file://\(bundlePath)", forKey: "HotUpdaterBundleURL")

        let url = service.getCachedBundleURL()
        #expect(url?.path == bundlePath)
    }

    @Test("Get cached bundle URL returns nil when file doesn't exist")
    func testGetCachedBundleURLNonexistent() throws {
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

        try mockPrefs.setItem("file:///nonexistent/bundle.js", forKey: "HotUpdaterBundleURL")

        let url = service.getCachedBundleURL()
        #expect(url == nil)
    }

    @Test("Get fallback bundle URL")
    func testGetFallbackBundleURL() throws {
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

        let url = service.getFallbackBundleURL()
        #expect(url?.lastPathComponent == "main.jsbundle")
    }

    // MARK: - Directory Tests

    @Test("Ensure bundle store directory is created")
    func testBundleStoreDirCreation() throws {
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

        let result = service.bundleStoreDir()

        switch result {
        case .success(let path):
            #expect(path.contains("bundle-store"))
            #expect(mockFS.directories.contains(path))
        case .failure:
            Issue.record("bundleStoreDir should succeed")
        }
    }

    @Test("Ensure temp directory is created")
    func testTempDirCreation() throws {
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

        let result = service.tempDir()

        switch result {
        case .success(let path):
            #expect(path.contains("bundle-temp"))
            #expect(mockFS.directories.contains(path))
        case .failure:
            Issue.record("tempDir should succeed")
        }
    }

    // MARK: - Find Bundle File Tests

    @Test("Find iOS bundle file in directory")
    func testFindIOSBundleFile() throws {
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

        let bundleDir = "/mock/documents/bundle-store/test-bundle"
        mockFS.directories.insert(bundleDir)
        mockFS.createFile(atPath: bundleDir + "/index.ios.bundle")

        let result = service.findBundleFile(in: bundleDir)

        switch result {
        case .success(let path):
            #expect(path?.hasSuffix("index.ios.bundle") == true)
        case .failure:
            Issue.record("findBundleFile should succeed")
        }
    }

    @Test("Find main.jsbundle in directory")
    func testFindMainBundleFile() throws {
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

        let bundleDir = "/mock/documents/bundle-store/test-bundle"
        mockFS.directories.insert(bundleDir)
        mockFS.createFile(atPath: bundleDir + "/main.jsbundle")

        let result = service.findBundleFile(in: bundleDir)

        switch result {
        case .success(let path):
            #expect(path?.hasSuffix("main.jsbundle") == true)
        case .failure:
            Issue.record("findBundleFile should succeed")
        }
    }

    @Test("Return nil when no bundle file found")
    func testFindBundleFileNotFound() throws {
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

        let bundleDir = "/mock/documents/bundle-store/test-bundle"
        mockFS.directories.insert(bundleDir)
        mockFS.createFile(atPath: bundleDir + "/other-file.txt")

        let result = service.findBundleFile(in: bundleDir)

        switch result {
        case .success(let path):
            #expect(path == nil)
        case .failure:
            Issue.record("findBundleFile should succeed even when no bundle found")
        }
    }

    // MARK: - Cleanup Tests

    @Test("Cleanup old bundles keeps current and new bundles")
    func testCleanupOldBundles() throws {
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

        // Create three bundle directories
        let oldBundle = storeDir + "/old-bundle"
        let currentBundle = storeDir + "/current-bundle"
        let newBundle = storeDir + "/new-bundle"

        mockFS.directories.insert(oldBundle)
        mockFS.directories.insert(currentBundle)
        mockFS.directories.insert(newBundle)

        let result = service.cleanupOldBundles(currentBundleId: "current-bundle", bundleId: "new-bundle")

        switch result {
        case .success:
            #expect(!mockFS.directories.contains(oldBundle))
            #expect(mockFS.directories.contains(currentBundle))
            #expect(mockFS.directories.contains(newBundle))
        case .failure:
            Issue.record("cleanupOldBundles should succeed")
        }
    }

    @Test("Cleanup removes tmp directories")
    func testCleanupRemovesTmpDirectories() throws {
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

        let tmpDir = storeDir + "/bundle-123.tmp"
        mockFS.directories.insert(tmpDir)

        let result = service.cleanupOldBundles(currentBundleId: nil, bundleId: "new-bundle")

        switch result {
        case .success:
            #expect(!mockFS.directories.contains(tmpDir))
        case .failure:
            Issue.record("cleanupOldBundles should succeed")
        }
    }

    // MARK: - Set Bundle URL Tests

    @Test("Set bundle URL saves to preferences")
    func testSetBundleURL() throws {
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

        let bundlePath = "/mock/bundle/index.ios.bundle"
        let result = service.setBundleURL(localPath: bundlePath)

        switch result {
        case .success:
            let saved = try mockPrefs.getItem(forKey: "HotUpdaterBundleURL")
            #expect(saved == bundlePath)
        case .failure:
            Issue.record("setBundleURL should succeed")
        }
    }

    @Test("Set bundle URL to nil clears preferences")
    func testSetBundleURLNil() throws {
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

        try mockPrefs.setItem("some-value", forKey: "HotUpdaterBundleURL")
        let result = service.setBundleURL(localPath: nil)

        switch result {
        case .success:
            let saved = try mockPrefs.getItem(forKey: "HotUpdaterBundleURL")
            #expect(saved == nil)
        case .failure:
            Issue.record("setBundleURL should succeed")
        }
    }

    // MARK: - Update Bundle Integration Tests

    @Test("Update bundle resets when fileUrl is nil")
    func testUpdateBundleReset() async throws {
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

        try mockPrefs.setItem("some-bundle-path", forKey: "HotUpdaterBundleURL")

        let expectation = XCTestExpectation(description: "Update bundle completes")

        service.updateBundle(bundleId: "test-bundle", fileUrl: nil) { result in
            switch result {
            case .success:
                let saved = try? mockPrefs.getItem(forKey: "HotUpdaterBundleURL")
                #expect(saved == nil)
                expectation.fulfill()
            case .failure:
                Issue.record("updateBundle with nil should succeed")
            }
        }

        await fulfillment(of: [expectation], timeout: 5.0)
    }
}

// Helper for async expectations
class XCTestExpectation {
    let description: String
    var isFulfilled = false

    init(description: String) {
        self.description = description
    }

    func fulfill() {
        isFulfilled = true
    }
}

func fulfillment(of expectations: [XCTestExpectation], timeout: TimeInterval) async {
    let start = Date()
    while expectations.contains(where: { !$0.isFulfilled }) {
        if Date().timeIntervalSince(start) > timeout {
            Issue.record("Timeout waiting for expectations")
            return
        }
        try? await Task.sleep(nanoseconds: 100_000_000) // 0.1 second
    }
}
