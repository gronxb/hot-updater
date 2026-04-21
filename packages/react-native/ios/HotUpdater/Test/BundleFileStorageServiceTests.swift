#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterArchive

@_silgen_name("HotUpdaterApplyBsdiffPatch")
private func hotUpdaterApplyBsdiffPatchForTest(
    _ patchPath: NSString,
    _ basePath: NSString,
    _ outputPath: NSString
) -> ObjCBool

struct BundleFileStorageServiceTests {
    @Test
    func getBundleIdFallsBackToBuiltInWhileStagingVerificationIsPending() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)
        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "staging-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "staging-bundle")
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: nil,
                stagingBundleId: "staging-bundle",
                verificationPending: true
            )
        )

        #expect(service.getBundleId() == nil)
        #expect(service.getBaseURL() == "")
        #expect(service.getManifest().isEmpty)
    }

    @Test
    func getBundleIdUsesStableBundleWhileNewStagingVerificationIsPending() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)
        let stableDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "stable-bundle"
        )
        try writeBundle(in: stableDirectory, bundleFileName: "main.jsbundle")
        try writeManifest(in: stableDirectory, bundleId: "stable-bundle")

        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "staging-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "staging-bundle")

        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: "stable-bundle",
                stagingBundleId: "staging-bundle",
                verificationPending: true
            )
        )

        #expect(service.getBundleId() == "stable-bundle")
        #expect(service.getBaseURL().hasSuffix("/bundle-store/stable-bundle"))
        #expect(service.getManifest()["bundleId"] as? String == "stable-bundle")
        #expect(service.getManifest(forBundleId: "staging-bundle")["bundleId"] as? String == "staging-bundle")
    }

    @Test
    func manifestDrivenInstallIsDisabledBeforeFirstOTA() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)

        #expect(service.canUseManifestDrivenInstall() == false)
    }

    @Test
    func manifestDrivenInstallIsEnabledForActiveOTABundleWithManifest() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let preferences = InMemoryPreferencesService()
        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            preferences: preferences
        )
        let activeDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "active-bundle"
        )
        try writeBundle(in: activeDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: activeDirectory, bundleId: "active-bundle")
        try preferences.setItem(
            activeDirectory
                .appendingPathComponent("index.ios.bundle")
                .absoluteString,
            forKey: "HotUpdaterBundleURL"
        )

        #expect(service.canUseManifestDrivenInstall())
    }

    @Test
    func appliesBsdiffPatchThroughSwiftPackageBridge() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let base = Data("console.log(\"base bundle\");\n".utf8)
        let expected = Data("console.log(\"patched bundle\");\n".utf8)
        let patch = try #require(Data(base64Encoded: bsdiffPatchFixtureBase64))

        let baseURL = workingDirectory.appendingPathComponent("base.bundle")
        let patchURL = workingDirectory.appendingPathComponent("patch.bsdiff")
        let outputURL = workingDirectory.appendingPathComponent("output.bundle")

        try base.write(to: baseURL)
        try patch.write(to: patchURL)

        let applied = hotUpdaterApplyBsdiffPatchForTest(
            patchURL.path as NSString,
            baseURL.path as NSString,
            outputURL.path as NSString
        )

        #expect(applied.boolValue)
        #expect(try Data(contentsOf: outputURL) == expected)
        let expectedHash = try #require(HashUtils.calculateSHA256(fileURL: outputURL))
        let baseHash = try #require(HashUtils.calculateSHA256(fileURL: baseURL))
        #expect(HashUtils.verifyHash(fileURL: outputURL, expectedHash: expectedHash))
        #expect(HashUtils.verifyHash(fileURL: outputURL, expectedHash: baseHash) == false)
    }

    @Test
    func rejectsInvalidBsdiffPatchThroughSwiftPackageBridge() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let baseURL = workingDirectory.appendingPathComponent("base.bundle")
        let patchURL = workingDirectory.appendingPathComponent("invalid.bsdiff")
        let outputURL = workingDirectory.appendingPathComponent("output.bundle")

        try Data("console.log(\"base bundle\");\n".utf8).write(to: baseURL)
        try Data("not-a-bsdiff-patch".utf8).write(to: patchURL)

        let applied = hotUpdaterApplyBsdiffPatchForTest(
            patchURL.path as NSString,
            baseURL.path as NSString,
            outputURL.path as NSString
        )

        #expect(applied.boolValue == false)
        #expect(FileManager.default.fileExists(atPath: outputURL.path) == false)
    }
}

private let testIsolationKey = "test-isolation-key"
private let bsdiffPatchFixtureBase64 =
    "RU5EU0xFWS9CU0RJRkY0Mx8AAAAAAAAAQlpoOTFBWSZTWb12MIEAAAB5gEQYAADQYQAIPsXOACAAIo0A0NAaNCgAGgZMgHAtYscVxxRtTt4nmaj70g4gQSF5+T4u5IpwoSF67GEC"

private func makeWorkingDirectory() throws -> URL {
    try FileManager.default.url(
        for: .itemReplacementDirectory,
        in: .userDomainMask,
        appropriateFor: FileManager.default.temporaryDirectory,
        create: true
    )
}

private func cleanupWorkingDirectory(_ workingDirectory: URL) {
    try? FileManager.default.removeItem(at: workingDirectory)
}

private func makeStorageService(
    documentsDirectory: URL,
    preferences: PreferencesService = InMemoryPreferencesService()
) -> BundleFileStorageService {
    BundleFileStorageService(
        fileSystem: TestFileSystemService(documentsDirectory: documentsDirectory),
        downloadService: UnusedDownloadService(),
        decompressService: DecompressService(),
        preferences: preferences,
        isolationKey: testIsolationKey
    )
}

private func createBundleDirectory(
    documentsDirectory: URL,
    bundleId: String
) throws -> URL {
    let bundleDirectory = documentsDirectory
        .appendingPathComponent("bundle-store", isDirectory: true)
        .appendingPathComponent(bundleId, isDirectory: true)
    try FileManager.default.createDirectory(
        at: bundleDirectory,
        withIntermediateDirectories: true
    )
    return bundleDirectory
}

private func writeBundle(
    in bundleDirectory: URL,
    bundleFileName: String
) throws {
    let bundleURL = bundleDirectory.appendingPathComponent(bundleFileName)
    try Data("bundle-content\n".utf8).write(to: bundleURL)
}

private func writeManifest(
    in bundleDirectory: URL,
    bundleId: String
) throws {
    let manifest: [String: Any] = [
        "bundleId": bundleId,
        "assets": [
            "index.ios.bundle": [
                "fileHash": "bundle-hash",
            ],
        ],
    ]
    let data = try JSONSerialization.data(withJSONObject: manifest)
    try data.write(to: bundleDirectory.appendingPathComponent("manifest.json"))
}

private func writeMetadata(
    documentsDirectory: URL,
    _ metadata: BundleMetadata
) throws {
    let metadataURL = documentsDirectory
        .appendingPathComponent("bundle-store", isDirectory: true)
        .appendingPathComponent(BundleMetadata.metadataFilename)
    #expect(metadata.save(to: metadataURL))
}

private final class TestFileSystemService: FileSystemService {
    private let documentsDirectory: URL

    init(documentsDirectory: URL) {
        self.documentsDirectory = documentsDirectory
    }

    func fileExists(atPath path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }

    func createDirectory(atPath path: String) -> Bool {
        do {
            try FileManager.default.createDirectory(
                atPath: path,
                withIntermediateDirectories: true
            )
            return true
        } catch {
            return false
        }
    }

    func removeItem(atPath path: String) throws {
        try FileManager.default.removeItem(atPath: path)
    }

    func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        try FileManager.default.moveItem(atPath: srcPath, toPath: dstPath)
    }

    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        try FileManager.default.copyItem(atPath: srcPath, toPath: dstPath)
    }

    func contentsOfDirectory(atPath path: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: path)
    }

    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        try FileManager.default.attributesOfItem(atPath: path)
    }

    func documentsPath() -> String {
        documentsDirectory.path
    }
}

private final class InMemoryPreferencesService: PreferencesService {
    private var values: [String: String] = [:]

    func getItem(forKey key: String) throws -> String? {
        values[key]
    }

    func setItem(_ value: String?, forKey key: String) throws {
        values[key] = value
    }
}

private final class UnusedDownloadService: DownloadService {
    func downloadFile(
        from url: URL,
        to destination: String,
        fileSizeHandler: ((Int64) -> Void)?,
        progressHandler: @escaping (Double) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> URLSessionDownloadTask? {
        Issue.record("downloadFile should not be called")
        return nil
    }
}
#endif
