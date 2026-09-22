#if canImport(Testing)
import Foundation
import Compression
import Testing

@testable import HotUpdaterCore

@_silgen_name("HotUpdaterApplyBsdiffPatch")
private func hotUpdaterApplyBsdiffPatchForTest(
    _ patchPath: NSString,
    _ basePath: NSString,
    _ outputPath: NSString
) -> ObjCBool

struct BundleFileStorageServiceTests {

    @Test(arguments: ["missing", "corrupt", "invalid-format"])
    func failedPatchDownloadsOriginalInSameInstall(failure: String) throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let baseBytes = Data("previous verified hermes".utf8)
        let targetBytes = Data("new verified hermes".utf8)
        let baseHash = try #require(sha256(baseBytes, in: root))
        let targetHash = try #require(sha256(targetBytes, in: root))
        let base = try createBundleDirectory(documentsDirectory: root, bundleId: "base")
        try baseBytes.write(to: base.appendingPathComponent("index.ios.bundle"))
        try makeManifestData(bundleId: "base", assets: ["index.ios.bundle": baseHash])
            .write(to: base.appendingPathComponent("manifest.json"))
        try writeMetadata(documentsDirectory: root,
            BundleMetadata(isolationKey: testIsolationKey, stagingBundleId: "base"))
        let preferences = InMemoryPreferencesService()
        try preferences.setItem(base.appendingPathComponent("index.ios.bundle").path, forKey: "HotUpdaterBundleURL")
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": targetHash])
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let patchURL = URL(string: "https://example.com/bundle.bsdiff")!
        let invalidPatch = Data("invalid patch format".utf8)
        var responses = [manifestURL: manifest, fileURL: targetBytes]
        if failure != "missing" { responses[patchURL] = invalidPatch }
        let downloads = MappingDownloadService(contents: responses)
        let service = makeStorageService(documentsDirectory: root, preferences: preferences,
            downloadService: downloads, builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: targetHash,
                patch: BsdiffPatchDescriptor(algorithm: "bsdiff", baseBundleId: "base", baseFileHash: baseHash,
                    patchFileHash: failure == "invalid-format" ? try #require(sha256(invalidPatch, in: root)) : String(repeating: "0", count: 64),
                    patchUrl: patchURL))])
        #expect(result.failureError == nil)
        #expect(downloads.requestedURLs == [manifestURL, patchURL, fileURL])
        #expect(try Data(contentsOf: root.appendingPathComponent("bundle-store/target/index.ios.bundle")) == targetBytes)
    }

    @Test(arguments: ["before-rename", "complete", "corrupt"])
    func interruptedPromotionKeepsCompleteBundle(state: String) throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let target = try createBundleDirectory(documentsDirectory: root, bundleId: "target")
        let bytes = Data("verified existing hermes".utf8)
        try bytes.write(to: target.appendingPathComponent("index.ios.bundle"))
        try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": try #require(sha256(bytes, in: root))])
            .write(to: target.appendingPathComponent("manifest.json"))
        try writeMetadata(documentsDirectory: root,
            BundleMetadata(isolationKey: testIsolationKey, stableBundleId: "target"))
        let backup = root.appendingPathComponent("bundle-store/target.install-backup")
        if state != "before-rename" {
            try FileManager.default.copyItem(at: target, to: backup)
            if state == "corrupt" {
                try Data("truncated".utf8).write(to: target.appendingPathComponent("index.ios.bundle"))
            }
        } else {
            try FileManager.default.moveItem(at: target, to: backup)
        }
        let service = makeStorageService(documentsDirectory: root)
        let launch = service.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(launch.launchedBundleId == "target")
        #expect(FileManager.default.fileExists(atPath: target.appendingPathComponent("index.ios.bundle").path))
        #expect(try Data(contentsOf: target.appendingPathComponent("index.ios.bundle")) == bytes)
        #expect(!FileManager.default.fileExists(atPath: backup.path))
    }

    @Test
    func downloadedBundleWithoutManifestOrMetadataCannotLaunch() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let target = try createBundleDirectory(documentsDirectory: root, bundleId: "target")
        try writeBundle(in: target, bundleFileName: "index.ios.bundle")
        try Data("target".utf8).write(to: target.appendingPathComponent("BUNDLE_ID"))
        let preferences = InMemoryPreferencesService()
        try preferences.setItem(target.appendingPathComponent("index.ios.bundle").path, forKey: "HotUpdaterBundleURL")
        let service = makeStorageService(documentsDirectory: root, preferences: preferences)
        #expect(try service.findBundleFile(in: target.path, expectedBundleId: "target").get() == nil)
        #expect(service.getBundleId() == nil)
        #expect(service.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == nil)
        // A complete downloaded folder alone still cannot replace durable activation metadata.
        try writeManifest(in: target, bundleId: "target")
        let nextProcess = makeStorageService(documentsDirectory: root, preferences: preferences)
        #expect(nextProcess.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == nil)
    }

    @Test
    func metadataWriteFailureDoesNotActivateTarget() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        // A non-writable metadata destination is a deterministic persistence fault.
        let blockedMetadata = root.appendingPathComponent("bundle-store/metadata.json")
        try FileManager.default.createDirectory(at: blockedMetadata, withIntermediateDirectories: true)
        try Data("prevent atomic replacement".utf8).write(to: blockedMetadata.appendingPathComponent("occupied"))
        let bytes = Data("valid target hermes".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash])
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let preferences = InMemoryPreferencesService()
        let downloads = MappingDownloadService(contents: [manifestURL: manifest, fileURL: bytes])
        let service = makeStorageService(documentsDirectory: root, preferences: preferences,
            downloadService: downloads, builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)])
        let nextProcess = makeStorageService(documentsDirectory: root, preferences: preferences)
        let launch = nextProcess.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(result.failureError != nil, "A17: activation metadata persistence failure must not be success")
        #expect(launch.launchedBundleId != "target", "Failed install must not activate an untracked target")
    }

    @Test
    func failedReplacementPreservesExistingTarget() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let bytes = Data("valid already installed hermes".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash])
        let target = try createBundleDirectory(documentsDirectory: root, bundleId: "target")
        try manifest.write(to: target.appendingPathComponent("manifest.json"))
        try bytes.write(to: target.appendingPathComponent("index.ios.bundle"))
        try writeMetadata(documentsDirectory: root,
            BundleMetadata(isolationKey: testIsolationKey, stableBundleId: "target"))
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let downloads = MappingDownloadService(contents: [manifestURL: manifest])
        let service = makeStorageService(documentsDirectory: root,
            fileSystem: FailingFinalPromotionFileSystem(documentsDirectory: root),
            downloadService: downloads, builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)])
        let remains = FileManager.default.fileExists(atPath: target.appendingPathComponent("index.ios.bundle").path)
        #expect(result.failureError != nil)
        #expect(remains, "A10/A17: a failed final promotion must preserve the existing stable bundle")
    }

    // Issue #1321: a hung JS thread never reports content appeared or a crash.
    @Test(arguments: [false, true], [false, true])
    func stagingLaunchRecoversOnlyWhenUnfinished(hasStableBundle: Bool, completesLaunch: Bool) throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        let stableBundleId: String? = hasStableBundle ? "stable-bundle" : nil
        if let stableBundleId {
            let directory = try createBundleDirectory(
                documentsDirectory: workingDirectory, bundleId: stableBundleId
            )
            try writeBundle(in: directory, bundleFileName: "index.ios.bundle")
            try writeManifest(in: directory, bundleId: stableBundleId)
        }
        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory, bundleId: "hung-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "hung-bundle")
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: stableBundleId,
                stagingBundleId: "hung-bundle",
                verificationPending: true
            )
        )
        let firstProcess = makeStorageService(
            documentsDirectory: workingDirectory, preferences: preferences
        )
        let firstLaunch = firstProcess.prepareLaunch(bundle: .main, pendingRecovery: nil)
        try #require(firstLaunch.launchedBundleId == "hung-bundle")
        try #require(firstLaunch.shouldRollbackOnCrash)

        // Repeated lookups in the current process must not consume its own marker.
        #expect(firstProcess.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "hung-bundle")
        #expect(!firstProcess.getCrashHistory().contains("hung-bundle"))
        if completesLaunch {
            firstProcess.markLaunchCompleted(bundleId: "hung-bundle")
        }

        // Simulate process termination without a crash marker.
        let secondProcess = makeStorageService(
            documentsDirectory: workingDirectory, preferences: preferences
        )
        let nextLaunch = secondProcess.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(nextLaunch.launchedBundleId == (completesLaunch ? "hung-bundle" : stableBundleId))
        #expect(!nextLaunch.shouldRollbackOnCrash)
        #expect(secondProcess.getCrashHistory().contains("hung-bundle") == !completesLaunch)
        if !completesLaunch {
            #expect(secondProcess.notifyAppReady()["status"] as? String == "RECOVERED")
        }
        let thirdProcess = makeStorageService(
            documentsDirectory: workingDirectory, preferences: preferences
        )
        #expect(thirdProcess.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == nextLaunch.launchedBundleId)
    }

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
        try writeManifest(
            in: stableDirectory,
            bundleId: "stable-bundle",
            assetPaths: ["main.jsbundle"]
        )

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
    func notifyAppReadyReturnsUnchangedWithoutRecordedTransition() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)

        #expect(service.notifyAppReady()["status"] as? String == "UNCHANGED")
    }

    @Test
    func markLaunchCompletedRecordsUpdateAppliedTransition() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            builtInBundleId: "builtin-bundle"
        )
        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "next-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "next-bundle")
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: nil,
                stagingBundleId: "next-bundle",
                verificationPending: true,
                pendingTransition: PendingBundleTransition(
                    fromBundleId: "builtin-bundle",
                    toBundleId: "next-bundle",
                    updateStrategy: .fingerprint
                )
            )
        )

        #expect(service.notifyAppReady()["status"] as? String == "PENDING")

        service.markLaunchCompleted(bundleId: "next-bundle")
        let report = service.notifyAppReady()

        #expect(report["status"] as? String == "UPDATE_APPLIED")
        #expect(report["fromBundleId"] as? String == "builtin-bundle")
        #expect(report["toBundleId"] as? String == "next-bundle")
        #expect(report["updateStrategy"] as? String == "fingerprint")
    }

    @Test
    func prepareLaunchRecordsRecoveredTransitionAfterPendingRollback() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            builtInBundleId: "builtin-bundle"
        )
        let stableDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "stable-bundle"
        )
        try writeBundle(in: stableDirectory, bundleFileName: "main.jsbundle")
        try writeManifest(
            in: stableDirectory,
            bundleId: "stable-bundle",
            assetPaths: ["main.jsbundle"]
        )

        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "next-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "next-bundle")

        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: "stable-bundle",
                stagingBundleId: "next-bundle",
                verificationPending: true,
                pendingTransition: PendingBundleTransition(
                    fromBundleId: "stable-bundle",
                    toBundleId: "next-bundle",
                    updateStrategy: .appVersion
                )
            )
        )

        let selection = service.prepareLaunch(
            bundle: .main,
            pendingRecovery: PendingCrashRecovery(
                launchedBundleId: "next-bundle",
                shouldRollback: true
            )
        )
        let report = service.notifyAppReady()

        #expect(selection.launchedBundleId == "stable-bundle")
        #expect(report["status"] as? String == "RECOVERED")
        #expect(report["fromBundleId"] as? String == "next-bundle")
        #expect(report["toBundleId"] as? String == "stable-bundle")
        #expect(report["updateStrategy"] as? String == "appVersion")
    }

    @Test
    func prepareLaunchRecordsRecoveredTransitionToBuiltInBundle() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            builtInBundleId: "builtin-bundle"
        )
        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "next-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "next-bundle")

        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: nil,
                stagingBundleId: "next-bundle",
                verificationPending: true,
                pendingTransition: PendingBundleTransition(
                    fromBundleId: "builtin-bundle",
                    toBundleId: "next-bundle",
                    updateStrategy: .fingerprint
                )
            )
        )

        let selection = service.prepareLaunch(
            bundle: .main,
            pendingRecovery: PendingCrashRecovery(
                launchedBundleId: "next-bundle",
                shouldRollback: true
            )
        )
        let report = service.notifyAppReady()

        #expect(selection.launchedBundleId == nil)
        #expect(report["status"] as? String == "RECOVERED")
        #expect(report["fromBundleId"] as? String == "next-bundle")
        #expect(report["toBundleId"] as? String == "builtin-bundle")
        #expect(report["updateStrategy"] as? String == "fingerprint")
    }

    @Test
    func installIdPersistsForTheSameAppInstall() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)
        let firstInstallId = service.getInstallId()
        let secondInstallId = makeStorageService(documentsDirectory: workingDirectory).getInstallId()

        #expect(firstInstallId.isEmpty == false)
        #expect(firstInstallId == secondInstallId)
    }

    @Test
    func setUserPersistsAndClearsTheUserEnvelope() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)
        service.setUser(userId: " user-123 ", username: " alice ")

        let userIdentityURL = workingDirectory
            .appendingPathComponent("bundle-store", isDirectory: true)
            .appendingPathComponent(UserIdentity.userIdentityFilename)
        let storedIdentity = try #require(UserIdentity.load(from: userIdentityURL))
        #expect(storedIdentity.userId == "user-123")
        #expect(storedIdentity.username == "alice")

        service.setUser(userId: nil, username: "  ")
        #expect(FileManager.default.fileExists(atPath: userIdentityURL.path) == false)
    }

    @Test
    func manifestDrivenInstallReusesMatchingBuiltInAssetBeforeFirstOTA() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }
        let bundleData = Data("target-bundle".utf8)
        let imageData = Data("target-image".utf8)
        let assets = [
            "index.ios.bundle": try #require(sha256(bundleData, in: workingDirectory)),
            "assets/image.png": try #require(sha256(imageData, in: workingDirectory)),
        ]
        let manifestData = try makeManifestData(bundleId: "target-bundle", assets: assets)
        let manifestURL = try #require(URL(string: "https://example.com/manifest.json"))
        let bundleURL = try #require(URL(string: "https://example.com/index.ios.bundle"))
        let imageURL = try #require(URL(string: "https://example.com/assets/image.png"))
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifestData,
            bundleURL: bundleData,
        ])
        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [
                "assets/image.png": imageData,
            ])
        )
        let result = updateBundle(
            service,
            bundleId: "target-bundle",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifestData, in: workingDirectory)),
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: assets["index.ios.bundle"]!
                ),
                "assets/image.png": ChangedAssetDescriptor(
                    fileUrl: imageURL,
                    fileHash: assets["assets/image.png"]!
                ),
            ]
        )

        if case .failure(let error) = result {
            Issue.record("Manifest install failed: \(error)")
        }
        let targetDirectory = workingDirectory
            .appendingPathComponent("bundle-store/target-bundle", isDirectory: true)
        #expect(try Data(contentsOf: targetDirectory.appendingPathComponent("index.ios.bundle")) == bundleData)
        #expect(try Data(contentsOf: targetDirectory.appendingPathComponent("assets/image.png")) == imageData)
        #expect(loadMetadata(documentsDirectory: workingDirectory)?.stagingBundleId == "target-bundle")
        #expect(downloads.requestedURLs == [manifestURL, bundleURL])
    }

    @Test
    func manifestDrivenInstallDownloadsOriginalWhenMatchingCurrentAssetIsCorrupt() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }
        let preferences = InMemoryPreferencesService()
        let targetData = Data("verified-target-bundle".utf8)
        let targetHash = try #require(sha256(targetData, in: workingDirectory))
        let activeDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "active-bundle"
        )
        try Data("corrupt".utf8).write(to: activeDirectory.appendingPathComponent("index.ios.bundle"))
        try makeManifestData(
            bundleId: "active-bundle",
            assets: ["index.ios.bundle": targetHash]
        ).write(to: activeDirectory.appendingPathComponent("manifest.json"))
        try preferences.setItem(
            activeDirectory.appendingPathComponent("index.ios.bundle").path,
            forKey: "HotUpdaterBundleURL"
        )
        let manifestURL = try #require(URL(string: "https://example.com/manifest.json"))
        let assetURL = try #require(URL(string: "https://example.com/index.ios.bundle"))
        let targetManifest = try makeManifestData(
            bundleId: "target-bundle",
            assets: ["index.ios.bundle": targetHash]
        )
        let downloads = MappingDownloadService(contents: [
            manifestURL: targetManifest,
            assetURL: targetData,
        ])
        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            preferences: preferences,
            downloadService: downloads
        )

        let result = updateBundle(
            service,
            bundleId: "target-bundle",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(targetManifest, in: workingDirectory)),
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: assetURL,
                    fileHash: targetHash
                ),
            ]
        )

        if case .failure(let error) = result {
            Issue.record("Manifest install failed: \(error)")
        }
        let installedBundle = workingDirectory
            .appendingPathComponent("bundle-store/target-bundle/index.ios.bundle")
        #expect(try Data(contentsOf: installedBundle) == targetData)
        #expect(downloads.requestedURLs.contains(assetURL))
    }

    @Test
    func builtInResolverRecoversFromCorruptCacheAndInvalidatesOnBundleReplacement() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let cacheURL = workingDirectory.appendingPathComponent("builtin-index-v1.json")
        let firstData = Data("first-built-in-image".utf8)
        let firstBundle = try makeFixtureBundle(
            in: workingDirectory,
            name: "First.bundle",
            version: "1",
            assetData: firstData
        )
        let resolver = IOSBuiltInAssetResolver(cacheURL: cacheURL)
        resolver.use(bundle: firstBundle)
        let firstDestination = workingDirectory.appendingPathComponent("first.png")

        #expect(resolver.copyIfMatches(
            assetPath: "assets/image.png",
            expectedHash: try #require(sha256(firstData, in: workingDirectory)),
            destination: firstDestination.path
        ))
        try Data("{".utf8).write(to: cacheURL)
        let secondDestination = workingDirectory.appendingPathComponent("second.png")
        #expect(resolver.copyIfMatches(
            assetPath: "assets/image.png",
            expectedHash: try #require(sha256(firstData, in: workingDirectory)),
            destination: secondDestination.path
        ))

        let replacementData = Data("replacement-built-in-image".utf8)
        let replacementBundle = try makeFixtureBundle(
            in: workingDirectory,
            name: "Replacement.bundle",
            version: "2",
            assetData: replacementData
        )
        resolver.use(bundle: replacementBundle)
        let replacementDestination = workingDirectory.appendingPathComponent("replacement.png")
        #expect(resolver.copyIfMatches(
            assetPath: "assets/image.png",
            expectedHash: try #require(sha256(replacementData, in: workingDirectory)),
            destination: replacementDestination.path
        ))
        #expect(try Data(contentsOf: replacementDestination) == replacementData)
        let cachedPayload = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: cacheURL)) as? [String: Any]
        )
        #expect((cachedPayload["packageIdentity"] as? String)?.contains("|2|") == true)
    }

    @Test
    func builtInResolverRejectsEscapingLogicalPath() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let fixtureBundle = try makeFixtureBundle(
            in: workingDirectory,
            name: "Fixture.bundle",
            version: "1",
            assetData: Data("image".utf8)
        )
        let resolver = IOSBuiltInAssetResolver(
            cacheURL: workingDirectory.appendingPathComponent("builtin-index-v1.json")
        )
        resolver.use(bundle: fixtureBundle)

        #expect(resolver.copyIfMatches(
            assetPath: "../outside.png",
            expectedHash: "unused",
            destination: workingDirectory.appendingPathComponent("destination.png").path
        ) == false)
    }

    @Test
    func prepareLaunchRollsBackBundleWithMissingManifestAsset() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)
        let stableDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "stable-bundle"
        )
        try writeBundle(in: stableDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stableDirectory, bundleId: "stable-bundle")

        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "staging-bundle"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(
            in: stagingDirectory,
            bundleId: "staging-bundle",
            assetPaths: ["index.ios.bundle", "assets/missing.png"]
        )
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: "stable-bundle",
                stagingBundleId: "staging-bundle",
                verificationPending: true
            )
        )

        let selection = service.prepareLaunch(bundle: .main, pendingRecovery: nil)

        #expect(selection.launchedBundleId == "stable-bundle")
        #expect(FileManager.default.fileExists(atPath: stagingDirectory.path) == false)
    }

    @Test
    func getCachedBundleURLValidatesNestedManifestBundle() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let preferences = InMemoryPreferencesService()
        let service = makeStorageService(
            documentsDirectory: workingDirectory,
            preferences: preferences
        )
        let bundleDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "nested-bundle"
        )
        let nestedDirectory = bundleDirectory.appendingPathComponent("dist", isDirectory: true)
        try FileManager.default.createDirectory(
            at: nestedDirectory,
            withIntermediateDirectories: true
        )
        try writeBundle(in: nestedDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(
            in: bundleDirectory,
            bundleId: "nested-bundle",
            assetPaths: ["dist/index.ios.bundle"]
        )
        let bundleURL = nestedDirectory.appendingPathComponent("index.ios.bundle")
        try preferences.setItem(bundleURL.path, forKey: "HotUpdaterBundleURL")
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(isolationKey: testIsolationKey, stableBundleId: "nested-bundle")
        )

        #expect(service.getCachedBundleURL() == bundleURL)
        #expect(service.getBundleId() == "nested-bundle")
    }

    @Test
    func preservesNestedBundlePathAfterDirectoryMove() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)
        let sourceDirectory = workingDirectory.appendingPathComponent("nested-bundle.tmp")
        let destinationDirectory = workingDirectory.appendingPathComponent("nested-bundle")
        let nestedDirectory = sourceDirectory.appendingPathComponent("dist", isDirectory: true)
        try FileManager.default.createDirectory(
            at: nestedDirectory,
            withIntermediateDirectories: true
        )
        try writeBundle(in: nestedDirectory, bundleFileName: "index.ios.bundle")
        let sourceBundleURL = nestedDirectory.appendingPathComponent("index.ios.bundle")

        let resolvedPath = try service.resolveBundlePathAfterMove(
            sourceBundleURL.path,
            from: sourceDirectory.path,
            to: destinationDirectory.path
        )

        #expect(
            resolvedPath == destinationDirectory
                .appendingPathComponent("dist/index.ios.bundle")
                .path
        )
    }

    @Test
    func catalogHighWaterRejectsReplayAndSurvivesChannelReset() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let service = makeStorageService(documentsDirectory: workingDirectory)

        #expect(service.acceptReleaseCatalog(
            catalogId: "project-a",
            scopeKey: "scope-production",
            generation: 2,
            catalogHash: "hash-2",
            channel: "production",
            selectionContextHash: "context-2"
        ))
        #expect(service.acceptReleaseCatalog(
            catalogId: "project-a",
            scopeKey: "scope-production",
            generation: 1,
            catalogHash: "hash-1",
            channel: "production",
            selectionContextHash: "context-1"
        ) == false)
        #expect(service.acceptReleaseCatalog(
            catalogId: "project-a",
            scopeKey: "scope-production",
            generation: 2,
            catalogHash: "different-hash",
            channel: "production",
            selectionContextHash: "context-2"
        ) == false)

        #expect(try service.resetChannel().get())
        let metadata = try #require(loadMetadata(documentsDirectory: workingDirectory))
        #expect(
            metadata.highestSeenCatalogs["project-a|scope-production"]
                == CatalogHighWater(generation: 2, catalogHash: "hash-2")
        )
    }

    @Test
    func sameBundleAdoptionRefreshesReceiptWithoutChangingBytes() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let service = makeStorageService(documentsDirectory: workingDirectory)
        let bundleDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "bundle-one"
        )
        try writeBundle(in: bundleDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: bundleDirectory, bundleId: "bundle-one")
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stagingBundleId: "bundle-one",
                stagingSelection: releaseSelection(
                    releaseId: "release-one",
                    bundleId: "bundle-one",
                    generation: 1,
                    catalogHash: "hash-1",
                    selectionContextHash: "context-1"
                )
            )
        )
        #expect(service.acceptReleaseCatalog(
            catalogId: "project-a",
            scopeKey: "scope-production",
            generation: 2,
            catalogHash: "hash-2",
            channel: "production",
            selectionContextHash: "context-2"
        ))
        let nextSelection = releaseSelection(
            releaseId: "release-two",
            bundleId: "bundle-one",
            generation: 2,
            catalogHash: "hash-2",
            selectionContextHash: "context-2"
        )

        #expect(service.commitReleaseSelection(nextSelection))

        let metadata = try #require(loadMetadata(documentsDirectory: workingDirectory))
        #expect(FileManager.default.fileExists(atPath: bundleDirectory.path))
        #expect(metadata.stagingSelection?.releaseId == "release-two")
        #expect(metadata.stagingSelection?.generation == 2)
        #expect(metadata.verificationPending == false)
    }

    @Test
    func crashRestoresCompleteStableReceiptButRetainsNewerHighWater() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let service = makeStorageService(documentsDirectory: workingDirectory)
        let stableDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "bundle-one"
        )
        try writeBundle(in: stableDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stableDirectory, bundleId: "bundle-one")
        let stagingDirectory = try createBundleDirectory(
            documentsDirectory: workingDirectory,
            bundleId: "bundle-two"
        )
        try writeBundle(in: stagingDirectory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: stagingDirectory, bundleId: "bundle-two")
        let stableSelection = releaseSelection(
            releaseId: "release-one",
            bundleId: "bundle-one",
            generation: 1,
            catalogHash: "hash-1",
            selectionContextHash: "context-1"
        )
        let stagingSelection = releaseSelection(
            releaseId: "release-two",
            bundleId: "bundle-two",
            generation: 2,
            catalogHash: "hash-2",
            selectionContextHash: "context-2"
        )
        try writeMetadata(
            documentsDirectory: workingDirectory,
            BundleMetadata(
                isolationKey: testIsolationKey,
                stableBundleId: "bundle-one",
                stagingBundleId: "bundle-two",
                stableSelection: stableSelection,
                stagingSelection: stagingSelection,
                verificationPending: true,
                pendingTransition: PendingBundleTransition(
                    fromBundleId: "bundle-one",
                    toBundleId: "bundle-two",
                    updateStrategy: .appVersion
                ),
                pendingSelectionTransition: PendingSelectionTransition(
                    fromReleaseId: "release-one",
                    fromBundleId: "bundle-one",
                    toReleaseId: "release-two",
                    toBundleId: "bundle-two"
                ),
                highestSeenCatalogs: [
                    "project-a|scope-production": CatalogHighWater(
                        generation: 2,
                        catalogHash: "hash-2"
                    ),
                ],
                currentSelectionContexts: [
                    "project-a|scope-production": "production\ncontext-2",
                ]
            )
        )

        let launch = service.prepareLaunch(
            bundle: .main,
            pendingRecovery: PendingCrashRecovery(
                launchedBundleId: "bundle-two",
                shouldRollback: true
            )
        )
        let report = service.notifyAppReady()
        let metadata = try #require(loadMetadata(documentsDirectory: workingDirectory))

        #expect(launch.launchedBundleId == "bundle-one")
        #expect(report["status"] as? String == "RECOVERED")
        #expect(report["fromReleaseId"] as? String == "release-two")
        #expect(report["toReleaseId"] as? String == "release-one")
        #expect(metadata.stagingSelection?.releaseId == "release-one")
        #expect(
            metadata.highestSeenCatalogs["project-a|scope-production"]
                == CatalogHighWater(generation: 2, catalogHash: "hash-2")
        )
        #expect(service.getCrashHistory().contains("bundle-two"))
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
    @Test(arguments: ["missing", "mismatch", "extra", "missing-original"])
    func rejectsInconsistentDescriptorMapEvenWhenBuiltinMatches(kind: String) throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let bytes = Data("target hermes".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash])
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let downloads = MappingDownloadService(contents: [manifestURL: manifest])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: ["index.ios.bundle": bytes]))
        var descriptors = ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)]
        switch kind {
        case "missing": descriptors = [:]
        case "mismatch": descriptors["index.ios.bundle"] = ChangedAssetDescriptor(fileUrl: fileURL, fileHash: String(repeating: "0", count: 64))
        case "missing-original": descriptors["index.ios.bundle"] = ChangedAssetDescriptor(fileUrl: nil, fileHash: hash)
        default: descriptors["extra.png"] = ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)
        }
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)), assets: descriptors)
        #expect(result.failureError != nil, "inconsistent descriptor maps must fail closed")
        #expect(loadMetadata(documentsDirectory: root)?.stagingBundleId == nil)
    }

    @Test
    func resumesVerifiedStagingAssetAfterInterruption() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let bytes = Data("completed before process termination".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash])
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let tmp = root.appendingPathComponent("bundle-store/target.tmp")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        try bytes.write(to: tmp.appendingPathComponent("index.ios.bundle"))
        // The retry can retrieve the manifest, but must reuse the already verified file.
        let downloads = MappingDownloadService(contents: [manifestURL: manifest])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)])
        #expect(result.failureError == nil, "reuse completed staging bytes after rechecking their target hash")
        #expect(downloads.requestedURLs == [manifestURL])
    }

    @Test
    func repairsCorruptPreviouslyInstalledTargetBeforeActivation() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let bytes = Data("verified target".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash])
        let target = try createBundleDirectory(documentsDirectory: root, bundleId: "target")
        try manifest.write(to: target.appendingPathComponent("manifest.json"))
        try Data("CORRUPT".utf8).write(to: target.appendingPathComponent("index.ios.bundle"))
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let downloads = MappingDownloadService(contents: [manifestURL: manifest, fileURL: bytes])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)])
        #expect(result.failureError == nil)
        #expect(try Data(contentsOf: target.appendingPathComponent("index.ios.bundle")) == bytes,
            "cached target bytes must be verified/repaired before staging")
    }

    @Test
    func progressCountsOnlyNetworkAssets() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let bytes = Data("target hermes".utf8)
        let image = Data("embedded image".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let imageHash = try #require(sha256(image, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash, "assets/image.png": imageHash])
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let imageURL = URL(string: "https://example.com/image.png")!
        let downloads = MappingDownloadService(contents: [manifestURL: manifest, fileURL: bytes])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: ["assets/image.png": image]))
        let done = DispatchSemaphore(value: 0)
        var payloads: [UpdateProgressPayload] = []
        service.updateBundle(bundleId: "target", manifestUrl: manifestURL,
            manifestFileHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash),
                     "assets/image.png": ChangedAssetDescriptor(fileUrl: imageURL, fileHash: imageHash)],
            progressHandler: { payloads.append($0) }, completion: { result in
                if case .failure(let error) = result { Issue.record("unexpected failure: \(error)") }
                done.signal()
            })
        #expect(done.wait(timeout: .now() + 5) == .success)
        #expect(downloads.requestedURLs == [manifestURL, fileURL])
        #expect(payloads.last?.details?.totalFilesCount == 1,
            "locally reused files must not count as downloads")
    }

    @Test
    func freshOriginalInstallControl() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let bytes = Data("fresh original".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let manifest = try makeManifestData(bundleId: "target", assets: ["index.ios.bundle": hash])
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let fileURL = URL(string: "https://example.com/index.ios.bundle")!
        let downloads = MappingDownloadService(contents: [manifestURL: manifest, fileURL: bytes])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: ["index.ios.bundle": ChangedAssetDescriptor(fileUrl: fileURL, fileHash: hash)])
        #expect(result.failureError == nil)
        #expect(try Data(contentsOf: root.appendingPathComponent("bundle-store/target/index.ios.bundle")) == bytes)
    }
    @Test
    func independentOriginalDownloadsOverlap() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let paths = ["index.ios.bundle"] + (0..<9).map { "assets/\($0).png" }
        let bytes = Data("target bytes".utf8)
        let hash = try #require(sha256(bytes, in: root))
        let hashes = Dictionary(uniqueKeysWithValues: paths.map { ($0, hash) })
        let manifest = try makeManifestData(bundleId: "target", assets: hashes)
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        var contents = Dictionary(uniqueKeysWithValues: paths.map { (URL(string: "https://example.com/\($0)")!, bytes) })
        contents[manifestURL] = manifest
        let downloads = DelayedAuditDownloadService(contents: contents)
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:]))
        let result = updateBundle(service, bundleId: "target", manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            assets: Dictionary(uniqueKeysWithValues: paths.map { path in
                (path, ChangedAssetDescriptor(fileUrl: URL(string: "https://example.com/\(path)")!, fileHash: hash))
            }))
        #expect(result.failureError == nil)
        #expect(downloads.maximumConcurrentAssets <= 4)
        #expect(downloads.maximumConcurrentAssets > 1,
            "Independent downloads must overlap within the fixed concurrency limit")
    }

    @Test
    func installsArchiveWithinFullNetworkTarOverheadAllowance() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let longPath = "assets/" + String(repeating: "nested/", count: 15) + "image.png"
        let files = [
            "index.ios.bundle": Data("archive bundle".utf8),
            longPath: Data("archive image".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let archiveHash = try #require(sha256(archive, in: root))
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: archiveHash,
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: max(0, (archive.count - 1) / files.count)
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let fileURLs = Dictionary(uniqueKeysWithValues: files.keys.map {
            ($0, URL(string: "https://example.com/files/\($0)")!)
        })
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            archiveURL: archive,
        ])
        let service = makeStorageService(
            documentsDirectory: root,
            downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [:])
        )
        let completed = DispatchSemaphore(value: 0)
        var result: Result<Bool, Error> = .failure(BundleStorageError.unknown(nil))
        var payloads: [UpdateProgressPayload] = []
        service.updateBundle(
            bundleId: "target",
            manifestUrl: manifestURL,
            manifestFileHash: try #require(sha256(manifest, in: root)),
            archiveUrl: archiveURL,
            assets: Dictionary(uniqueKeysWithValues: files.map { path, data in
                (path, ChangedAssetDescriptor(
                    fileUrl: fileURLs[path]!,
                    fileHash: try! #require(sha256(data, in: root))
                ))
            }),
            progressHandler: { payloads.append($0) },
            completion: { value in result = value; completed.signal() }
        )
        #expect(completed.wait(timeout: .now() + 5) == .success)
        if case .failure(let error) = result { Issue.record("archive install failed: \(error)") }
        #expect(downloads.requestedURLs == [manifestURL, archiveURL])
        let installed = root.appendingPathComponent("bundle-store/target")
        for (path, data) in files {
            #expect(try Data(contentsOf: installed.appendingPathComponent(path)) == data)
        }
        #expect(try Data(contentsOf: installed.appendingPathComponent("manifest.json")) == manifest)
        #expect(payloads.last?.details?.totalFilesCount == 1)
        #expect(payloads.last?.details?.completedFilesCount == 1)
        #expect(payloads.last?.details?.files.first?.path == "bundle.tar.br")
    }

    @Test
    func archiveBackupCleanupFailureKeepsPromotedArchive() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("archive bundle".utf8),
            "assets/image.png": Data("archive image".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 4096
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            archiveURL: archive,
        ])
        let fileSystem = FailingArchiveBackupRemovalFileSystemService(
            documentsDirectory: root
        )
        let service = makeStorageService(
            documentsDirectory: root,
            fileSystem: fileSystem,
            downloadService: downloads
        )
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: Dictionary(uniqueKeysWithValues: files.map { path, data in
                (path, ChangedAssetDescriptor(
                    fileUrl: URL(string: "https://example.com/files/\(path)")!,
                    fileHash: try! #require(sha256(data, in: root))
                ))
            })
        )
        if case .failure(let error) = result { Issue.record("archive install failed: \(error)") }
        #expect(downloads.requestedURLs == [manifestURL, archiveURL])
        let installed = root.appendingPathComponent("bundle-store/target")
        for (path, data) in files {
            #expect(try Data(contentsOf: installed.appendingPathComponent(path)) == data)
        }
        #expect(fileSystem.didFailBackupRemoval)
    }

    @Test
    func declinesFullNetworkArchiveBeyondTarOverheadAllowance() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": deterministicNoise(count: 4096, seed: 1),
            "assets/image.png": deterministicNoise(count: 4096, seed: 2),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let logicalByteSize = files.values.reduce(0) { $0 + $1.count }
        #expect(archive.count > tar.count - logicalByteSize + files.count)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 1
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let imageURL = URL(string: "https://example.com/assets/image.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            bundleURL: files["index.ios.bundle"]!,
            imageURL: files["assets/image.png"]!,
        ])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads)
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/image.png": ChangedAssetDescriptor(
                    fileUrl: imageURL,
                    fileHash: try #require(sha256(files["assets/image.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("per-file install failed: \(error)") }
        #expect(downloads.requestedURLs.contains(archiveURL) == false)
        #expect(Set(downloads.requestedURLs.dropFirst()) == Set([bundleURL, imageURL]))
    }

    @Test
    func partialLocalReuseRetainsStrictArchiveByteComparison() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("remote bundle".utf8),
            "assets/remote.png": Data("remote image".utf8),
            "assets/local.png": Data("local image".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let logicalByteSize = files.values.reduce(0) { $0 + $1.count }
        #expect(archive.count <= 2 + tar.count - logicalByteSize)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 1
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let remoteURL = URL(string: "https://example.com/assets/remote.png")!
        let localURL = URL(string: "https://example.com/assets/local.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            bundleURL: files["index.ios.bundle"]!,
            remoteURL: files["assets/remote.png"]!,
        ])
        let service = makeStorageService(
            documentsDirectory: root,
            downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [
                "assets/local.png": files["assets/local.png"]!,
            ])
        )
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/remote.png": ChangedAssetDescriptor(
                    fileUrl: remoteURL,
                    fileHash: try #require(sha256(files["assets/remote.png"]!, in: root))
                ),
                "assets/local.png": ChangedAssetDescriptor(
                    fileUrl: localURL,
                    fileHash: try #require(sha256(files["assets/local.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("per-file install failed: \(error)") }
        #expect(downloads.requestedURLs.contains(archiveURL) == false)
        #expect(Set(downloads.requestedURLs.dropFirst()) == Set([bundleURL, remoteURL]))
        #expect(downloads.requestedURLs.contains(localURL) == false)
    }

    @Test
    func archiveHashFailureFallsBackOnceAndKeepsLocalReuse() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("fallback bundle".utf8),
            "assets/remote.png": Data("fallback remote".utf8),
            "assets/local.png": Data("verified local".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: String(repeating: "0", count: 64),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 4096
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let remoteURL = URL(string: "https://example.com/assets/remote.png")!
        let localURL = URL(string: "https://example.com/assets/local.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            archiveURL: archive,
            bundleURL: files["index.ios.bundle"]!,
            remoteURL: files["assets/remote.png"]!,
        ])
        let service = makeStorageService(
            documentsDirectory: root,
            downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [
                "assets/local.png": files["assets/local.png"]!,
            ])
        )
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/remote.png": ChangedAssetDescriptor(
                    fileUrl: remoteURL,
                    fileHash: try #require(sha256(files["assets/remote.png"]!, in: root))
                ),
                "assets/local.png": ChangedAssetDescriptor(
                    fileUrl: localURL,
                    fileHash: try #require(sha256(files["assets/local.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("fallback failed: \(error)") }
        #expect(downloads.requestedURLs.first == manifestURL)
        #expect(downloads.requestedURLs.dropFirst().first == archiveURL)
        #expect(downloads.requestedURLs.filter { $0 == archiveURL }.count == 1)
        #expect(Set(downloads.requestedURLs.dropFirst(2)) == Set([bundleURL, remoteURL]))
        #expect(downloads.requestedURLs.contains(localURL) == false)
    }

    @Test
    func archivePromotionFailureRestoresPreparedFilesBeforeFallback() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("fallback bundle".utf8),
            "assets/remote.png": Data("fallback remote".utf8),
            "assets/local.png": Data("verified local".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 4096
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let remoteURL = URL(string: "https://example.com/assets/remote.png")!
        let localURL = URL(string: "https://example.com/assets/local.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            archiveURL: archive,
            bundleURL: files["index.ios.bundle"]!,
            remoteURL: files["assets/remote.png"]!,
        ])
        let fileSystem = FailingArchivePromotionFileSystemService(
            documentsDirectory: root
        )
        let service = makeStorageService(
            documentsDirectory: root,
            fileSystem: fileSystem,
            downloadService: downloads,
            builtInAssetResolver: MappingBuiltInAssetResolver(contents: [
                "assets/local.png": files["assets/local.png"]!,
            ])
        )
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/remote.png": ChangedAssetDescriptor(
                    fileUrl: remoteURL,
                    fileHash: try #require(sha256(files["assets/remote.png"]!, in: root))
                ),
                "assets/local.png": ChangedAssetDescriptor(
                    fileUrl: localURL,
                    fileHash: try #require(sha256(files["assets/local.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("fallback failed: \(error)") }
        #expect(downloads.requestedURLs.first == manifestURL)
        #expect(downloads.requestedURLs.dropFirst().first == archiveURL)
        #expect(Set(downloads.requestedURLs.dropFirst(2)) == Set([bundleURL, remoteURL]))
        #expect(downloads.requestedURLs.contains(localURL) == false)
        let installed = root.appendingPathComponent("bundle-store/target")
        #expect(try Data(contentsOf: installed.appendingPathComponent("assets/local.png")) == files["assets/local.png"])
        #expect(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("bundle-store/target.tmp.archive-backup").path
        ) == false)
    }

    @Test
    func archivePromotionAndRestoreFailureAbortsWithoutPerFileFallback() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let stableDirectory = root.appendingPathComponent("bundle-store/stable")
        try FileManager.default.createDirectory(
            at: stableDirectory,
            withIntermediateDirectories: true
        )
        let stableSentinel = stableDirectory.appendingPathComponent("sentinel")
        try Data("stable".utf8).write(to: stableSentinel)
        let files = [
            "index.ios.bundle": Data("archive bundle".utf8),
            "assets/image.png": Data("archive image".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 4096
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            archiveURL: archive,
        ])
        let service = makeStorageService(
            documentsDirectory: root,
            fileSystem: FailingArchivePromotionAndRestoreFileSystemService(
                documentsDirectory: root
            ),
            downloadService: downloads
        )
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: Dictionary(uniqueKeysWithValues: files.map { path, data in
                (path, ChangedAssetDescriptor(
                    fileUrl: URL(string: "https://example.com/files/\(path)")!,
                    fileHash: try! #require(sha256(data, in: root))
                ))
            })
        )
        #expect(result.failureError != nil)
        #expect(downloads.requestedURLs == [manifestURL, archiveURL])
        #expect(try Data(contentsOf: stableSentinel) == Data("stable".utf8))
    }

    @Test(arguments: [
        Int64?.none,
        Int64?.some(9_007_199_254_740_992),
        Int64?.some(1),
    ])
    func declinesArchiveWhenPatchCannotBeatStrictByteCost(
        patchByteSize: Int64?
    ) throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("original one".utf8),
            "assets/image.png": Data("original two".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 1
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let imageURL = URL(string: "https://example.com/assets/image.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            bundleURL: files["index.ios.bundle"]!,
            imageURL: files["assets/image.png"]!,
        ])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads)
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root)),
                    patch: BsdiffPatchDescriptor(
                        algorithm: "bsdiff",
                        baseBundleId: "unavailable-base",
                        baseFileHash: String(repeating: "0", count: 64),
                        patchFileHash: String(repeating: "1", count: 64),
                        patchUrl: URL(string: "https://example.com/index.ios.bundle.patch")!,
                        byteSize: patchByteSize
                    )
                ),
                "assets/image.png": ChangedAssetDescriptor(
                    fileUrl: imageURL,
                    fileHash: try #require(sha256(files["assets/image.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("per-file install failed: \(error)") }
        #expect(downloads.requestedURLs.contains(archiveURL) == false)
        #expect(Set(downloads.requestedURLs.dropFirst()) == Set([bundleURL, imageURL]))
    }

    @Test
    func declinesArchiveWhenIndividualCostSumExceedsMaximumSafeInteger() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("original one".utf8),
            "assets/image.png": Data("original two".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: archive.count,
            tarByteSize: tar.count,
            originalDownloadByteSize: 4_503_599_627_370_496
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let imageURL = URL(string: "https://example.com/assets/image.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            bundleURL: files["index.ios.bundle"]!,
            imageURL: files["assets/image.png"]!,
        ])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads)
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/image.png": ChangedAssetDescriptor(
                    fileUrl: imageURL,
                    fileHash: try #require(sha256(files["assets/image.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("per-file install failed: \(error)") }
        #expect(downloads.requestedURLs.contains(archiveURL) == false)
        #expect(Set(downloads.requestedURLs.dropFirst()) == Set([bundleURL, imageURL]))
    }

    @Test
    func strictByteWinStillDeclinesArchiveWithNegativeTarFraming() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data(repeating: 1, count: 1024),
            "assets/image.png": Data(repeating: 2, count: 1024),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: 1,
            tarByteSize: 1024,
            originalDownloadByteSize: 100
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let imageURL = URL(string: "https://example.com/assets/image.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            bundleURL: files["index.ios.bundle"]!,
            imageURL: files["assets/image.png"]!,
        ])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads)
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/image.png": ChangedAssetDescriptor(
                    fileUrl: imageURL,
                    fileHash: try #require(sha256(files["assets/image.png"]!, in: root))
                ),
            ]
        )
        if case .failure(let error) = result { Issue.record("per-file install failed: \(error)") }
        #expect(downloads.requestedURLs.contains(archiveURL) == false)
    }

    @Test
    func strictByteWinStillDeclinesArchiveWhenLogicalSumExceedsMaximumSafeInteger() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let files = [
            "index.ios.bundle": Data("bundle".utf8),
            "assets/image.png": Data("image".utf8),
        ]
        let tar = try makeTar(files: files)
        let archive = try brotliCompress(tar)
        let manifest = try makeArchiveManifestData(
            bundleId: "target",
            files: files,
            archiveHash: try #require(sha256(archive, in: root)),
            archiveByteSize: 1,
            tarByteSize: tar.count,
            originalDownloadByteSize: 100,
            logicalByteSizeOverride: 4_503_599_627_370_496
        )
        let manifestURL = URL(string: "https://example.com/manifest.json")!
        let archiveURL = URL(string: "https://example.com/bundle.tar.br")!
        let bundleURL = URL(string: "https://example.com/index.ios.bundle")!
        let imageURL = URL(string: "https://example.com/assets/image.png")!
        let downloads = MappingDownloadService(contents: [
            manifestURL: manifest,
            bundleURL: files["index.ios.bundle"]!,
            imageURL: files["assets/image.png"]!,
        ])
        let service = makeStorageService(documentsDirectory: root, downloadService: downloads)
        let result = updateBundle(
            service,
            bundleId: "target",
            manifestURL: manifestURL,
            manifestHash: try #require(sha256(manifest, in: root)),
            archiveURL: archiveURL,
            assets: [
                "index.ios.bundle": ChangedAssetDescriptor(
                    fileUrl: bundleURL,
                    fileHash: try #require(sha256(files["index.ios.bundle"]!, in: root))
                ),
                "assets/image.png": ChangedAssetDescriptor(
                    fileUrl: imageURL,
                    fileHash: try #require(sha256(files["assets/image.png"]!, in: root))
                ),
            ]
        )
        #expect(result.failureError != nil)
        #expect(downloads.requestedURLs.contains(archiveURL) == false)
    }

    @Test
    func tarExtractorRejectsUnsafePathsAndWrongLogicalSizes() throws {
        let root = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(root) }
        let unsafeTar = try makeTar(files: ["../escape": Data("x".utf8)])
        let unsafeURL = root.appendingPathComponent("unsafe.tar")
        try unsafeTar.write(to: unsafeURL)
        #expect(throws: Error.self) {
            try TarArchiveExtractor.extract(
                from: unsafeURL.path,
                to: root.appendingPathComponent("unsafe-output").path,
                expectedFiles: ["index.ios.bundle": 1]
            )
        }

        let sizeTar = try makeTar(files: ["index.ios.bundle": Data("bytes".utf8)])
        let sizeURL = root.appendingPathComponent("size.tar")
        try sizeTar.write(to: sizeURL)
        #expect(throws: Error.self) {
            try TarArchiveExtractor.extract(
                from: sizeURL.path,
                to: root.appendingPathComponent("size-output").path,
                expectedFiles: ["index.ios.bundle": 4]
            )
        }

        let invalidMagicTar = try makeTar(
            files: ["index.ios.bundle": Data("bytes".utf8)],
            headerMagic: "badbad"
        )
        let invalidMagicURL = root.appendingPathComponent("invalid-magic.tar")
        try invalidMagicTar.write(to: invalidMagicURL)
        #expect(throws: Error.self) {
            try TarArchiveExtractor.extract(
                from: invalidMagicURL.path,
                to: root.appendingPathComponent("invalid-magic-output").path,
                expectedFiles: ["index.ios.bundle": 5]
            )
        }

        var partialTrailingBlockTar = sizeTar
        partialTrailingBlockTar.append(0)
        let partialTrailingBlockURL = root.appendingPathComponent("partial-trailing-block.tar")
        try partialTrailingBlockTar.write(to: partialTrailingBlockURL)
        #expect(throws: Error.self) {
            try TarArchiveExtractor.extract(
                from: partialTrailingBlockURL.path,
                to: root.appendingPathComponent("partial-trailing-output").path,
                expectedFiles: ["index.ios.bundle": 5]
            )
        }
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
    fileSystem: FileSystemService? = nil,
    preferences: PreferencesService = InMemoryPreferencesService(),
    downloadService: DownloadService = UnusedDownloadService(),
    builtInAssetResolver: BuiltInAssetResolver? = nil,
    builtInBundleId: String = "builtin-bundle"
) -> BundleFileStorageService {
    BundleFileStorageService(
        fileSystem: fileSystem ?? TestFileSystemService(
            documentsDirectory: documentsDirectory
        ),
        downloadService: downloadService,
        preferences: preferences,
        isolationKey: testIsolationKey,
        builtInBundleIdProvider: { builtInBundleId },
        builtInAssetResolver: builtInAssetResolver
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
    bundleId: String,
    assetPaths: [String] = ["index.ios.bundle"]
) throws {
    let assets = assetPaths.reduce(into: [String: [String: String]]()) { result, path in
        result[path] = [
            "fileHash": "bundle-hash",
        ]
    }
    let manifest: [String: Any] = [
        "bundleId": bundleId,
        "assets": assets,
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

private func makeFixtureBundle(
    in directory: URL,
    name: String,
    version: String,
    assetData: Data
) throws -> Bundle {
    let bundleURL = directory.appendingPathComponent(name, isDirectory: true)
    let assetURL = bundleURL.appendingPathComponent("assets/image.png")
    try FileManager.default.createDirectory(
        at: assetURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try assetData.write(to: assetURL)
    try Data("fixture-bundle".utf8).write(
        to: bundleURL.appendingPathComponent("main.jsbundle")
    )
    let info: [String: Any] = [
        "CFBundleIdentifier": "com.hotupdater.fixture",
        "CFBundlePackageType": "BNDL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": version,
    ]
    try PropertyListSerialization.data(
        fromPropertyList: info,
        format: .xml,
        options: 0
    ).write(to: bundleURL.appendingPathComponent("Info.plist"))
    return try #require(Bundle(url: bundleURL))
}

private func loadMetadata(documentsDirectory: URL) -> BundleMetadata? {
    let metadataURL = documentsDirectory
        .appendingPathComponent("bundle-store", isDirectory: true)
        .appendingPathComponent(BundleMetadata.metadataFilename)
    return BundleMetadata.load(
        from: metadataURL,
        expectedIsolationKey: testIsolationKey
    )
}

private func releaseSelection(
    releaseId: String,
    bundleId: String,
    generation: Int64,
    catalogHash: String,
    selectionContextHash: String
) -> PersistedSelection {
    PersistedSelection(
        kind: "BUNDLE",
        releaseId: releaseId,
        bundleId: bundleId,
        catalogId: "project-a",
        scopeKey: "scope-production",
        generation: generation,
        catalogHash: catalogHash,
        channel: "production",
        selectionContextHash: selectionContextHash
    )
}

private class TestFileSystemService: FileSystemService {
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

private final class FailingArchivePromotionFileSystemService:
    TestFileSystemService
{
    private var shouldFailArchivePromotion = true

    override func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        if shouldFailArchivePromotion,
           srcPath.hasSuffix("archive/extracted"),
           dstPath.hasSuffix("target.tmp") {
            shouldFailArchivePromotion = false
            throw NSError(
                domain: "FailingArchivePromotionFileSystemService",
                code: 1
            )
        }
        try super.moveItem(atPath: srcPath, toPath: dstPath)
    }
}

private final class FailingArchiveBackupRemovalFileSystemService:
    TestFileSystemService
{
    private(set) var didFailBackupRemoval = false

    override func removeItem(atPath path: String) throws {
        if !didFailBackupRemoval,
           path.hasSuffix(".archive-backup"),
           FileManager.default.fileExists(atPath: path) {
            didFailBackupRemoval = true
            throw NSError(
                domain: "FailingArchiveBackupRemovalFileSystemService",
                code: 1
            )
        }
        try super.removeItem(atPath: path)
    }
}

private final class FailingArchivePromotionAndRestoreFileSystemService:
    TestFileSystemService
{
    override func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        if srcPath.hasSuffix("archive/extracted") ||
            srcPath.hasSuffix("target.tmp.archive-backup") {
            throw NSError(
                domain: "FailingArchivePromotionAndRestoreFileSystemService",
                code: 1
            )
        }
        try super.moveItem(atPath: srcPath, toPath: dstPath)
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
        progressHandler: @escaping (DownloadProgress) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> URLSessionDownloadTask? {
        Issue.record("downloadFile should not be called")
        return nil
    }
}

private final class MappingDownloadService: DownloadService {
    private let contents: [URL: Data]
    private let lock = NSLock()
    private var urls: [URL] = []

    init(contents: [URL: Data]) {
        self.contents = contents
    }

    var requestedURLs: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return urls
    }

    func downloadFile(
        from url: URL,
        to destination: String,
        fileSizeHandler: ((Int64) -> Void)?,
        progressHandler: @escaping (DownloadProgress) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> URLSessionDownloadTask? {
        lock.lock()
        urls.append(url)
        lock.unlock()
        guard let data = contents[url] else {
            completion(.failure(NSError(
                domain: "MappingDownloadService",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unexpected URL: \(url)"]
            )))
            return nil
        }
        do {
            let destinationURL = URL(fileURLWithPath: destination)
            try FileManager.default.createDirectory(
                at: destinationURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: destinationURL)
            fileSizeHandler?(Int64(data.count))
            progressHandler(DownloadProgress(
                progress: 1,
                downloadedBytes: Int64(data.count),
                totalBytes: Int64(data.count)
            ))
            completion(.success(destinationURL))
        } catch {
            completion(.failure(error))
        }
        return nil
    }
}

private final class MappingBuiltInAssetResolver: BuiltInAssetResolver {
    private let contents: [String: Data]

    init(contents: [String: Data]) {
        self.contents = contents
    }

    func use(bundle _: Bundle) {}

    func copyIfMatches(
        assetPath: String,
        expectedHash: String,
        destination: String
    ) -> Bool {
        guard let data = contents[assetPath] else { return false }
        let destinationURL = URL(fileURLWithPath: destination)
        do {
            try FileManager.default.createDirectory(
                at: destinationURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: destinationURL)
            guard HashUtils.verifyHash(fileURL: destinationURL, expectedHash: expectedHash) else {
                try? FileManager.default.removeItem(at: destinationURL)
                return false
            }
            return true
        } catch {
            return false
        }
    }
}

private func makeManifestData(
    bundleId: String,
    assets: [String: String]
) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "bundleId": bundleId,
        "assets": assets.mapValues { ["fileHash": $0] },
    ])
}

private func makeArchiveManifestData(
    bundleId: String,
    files: [String: Data],
    archiveHash: String,
    archiveByteSize: Int,
    tarByteSize: Int,
    originalDownloadByteSize: Int?,
    logicalByteSizeOverride: Int? = nil
) throws -> Data {
    let scratch = try makeWorkingDirectory()
    defer { cleanupWorkingDirectory(scratch) }
    let assets = try files.reduce(into: [String: [String: Any]]()) { result, entry in
        var asset: [String: Any] = [
            "fileHash": try #require(sha256(entry.value, in: scratch)),
            "byteSize": logicalByteSizeOverride ?? entry.value.count,
        ]
        if let originalDownloadByteSize {
            asset["downloadByteSize"] = originalDownloadByteSize
        }
        result[entry.key] = asset
    }
    return try JSONSerialization.data(withJSONObject: [
        "bundleId": bundleId,
        "assets": assets,
        "archive": [
            "downloadFileHash": archiveHash,
            "downloadByteSize": archiveByteSize,
            "tarByteSize": tarByteSize,
        ],
    ])
}

private func makeTar(
    files: [String: Data],
    headerMagic: String = "ustar\0"
) throws -> Data {
    var tar = Data()
    for (index, entry) in files.sorted(by: { $0.key < $1.key }).enumerated() {
        let pathBytes = Data(entry.key.utf8)
        let headerPath: String
        if pathBytes.count > 100 {
            let pax = makePaxRecord(key: "path", value: entry.key)
            tar.append(try makeTarHeader(
                path: "PaxHeader/\(index)",
                size: pax.count,
                type: 120,
                magic: headerMagic
            ))
            tar.append(pax)
            appendTarPadding(to: &tar, payloadSize: pax.count)
            headerPath = "PaxFile/\(index)"
        } else {
            headerPath = entry.key
        }
        tar.append(try makeTarHeader(
            path: headerPath,
            size: entry.value.count,
            type: 48,
            magic: headerMagic
        ))
        tar.append(entry.value)
        appendTarPadding(to: &tar, payloadSize: entry.value.count)
    }
    tar.append(Data(repeating: 0, count: 1024))
    return tar
}

private func makeTarHeader(
    path: String,
    size: Int,
    type: UInt8,
    magic: String
) throws -> Data {
    let pathBytes = Data(path.utf8)
    let magicBytes = Data(magic.utf8)
    guard pathBytes.count <= 100, magicBytes.count == 6 else {
        throw NSError(domain: "TarTest", code: 1)
    }
    var header = Data(repeating: 0, count: 512)
    header.replaceSubrange(0..<pathBytes.count, with: pathBytes)
    writeTarOctal(0o644, to: &header, range: 100..<108)
    writeTarOctal(0, to: &header, range: 108..<116)
    writeTarOctal(0, to: &header, range: 116..<124)
    writeTarOctal(size, to: &header, range: 124..<136)
    writeTarOctal(0, to: &header, range: 136..<148)
    header.replaceSubrange(148..<156, with: Data(repeating: 32, count: 8))
    header[156] = type
    header.replaceSubrange(257..<263, with: magicBytes)
    header.replaceSubrange(263..<265, with: Data("00".utf8))
    let checksum = header.reduce(0) { $0 + Int($1) }
    let checksumText = String(format: "%06o\0 ", checksum)
    header.replaceSubrange(148..<156, with: Data(checksumText.utf8))
    return header
}

private func writeTarOctal(_ value: Int, to header: inout Data, range: Range<Int>) {
    let digits = String(value, radix: 8)
    let payload = String(repeating: "0", count: range.count - digits.count - 1) + digits + "\0"
    header.replaceSubrange(range, with: Data(payload.utf8))
}

private func appendTarPadding(to tar: inout Data, payloadSize: Int) {
    let padding = (512 - payloadSize % 512) % 512
    if padding > 0 {
        tar.append(Data(repeating: 0, count: padding))
    }
}

private func makePaxRecord(key: String, value: String) -> Data {
    let body = "\(key)=\(value)\n"
    var length = body.utf8.count + 2
    while true {
        let record = "\(length) \(body)"
        let actualLength = record.utf8.count
        if actualLength == length { return Data(record.utf8) }
        length = actualLength
    }
}

private func brotliCompress(_ input: Data) throws -> Data {
    var capacity = max(1024, input.count * 2)
    while capacity <= max(1024, input.count * 32) {
        var output = Data(count: capacity)
        let encoded = output.withUnsafeMutableBytes { outputBytes in
            input.withUnsafeBytes { inputBytes in
                compression_encode_buffer(
                    outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    capacity,
                    inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    input.count,
                    nil,
                    COMPRESSION_BROTLI
                )
            }
        }
        if encoded > 0 {
            output.count = encoded
            return output
        }
        capacity *= 2
    }
    throw NSError(domain: "BrotliTest", code: 1)
}

private func deterministicNoise(count: Int, seed: UInt64) -> Data {
    var state = seed
    return Data((0..<count).map { _ in
        state = state &* 6_364_136_223_846_793_005 &+ 1
        return UInt8(truncatingIfNeeded: state >> 32)
    })
}

private func sha256(_ data: Data, in directory: URL) -> String? {
    let fileURL = directory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: fileURL) }
    do {
        try data.write(to: fileURL)
        return HashUtils.calculateSHA256(fileURL: fileURL)
    } catch {
        return nil
    }
}

private func updateBundle(
    _ service: BundleFileStorageService,
    bundleId: String,
    manifestURL: URL,
    manifestHash: String,
    archiveURL: URL? = nil,
    assets: [String: ChangedAssetDescriptor]
) -> Result<Bool, Error> {
    let completed = DispatchSemaphore(value: 0)
    var result: Result<Bool, Error> = .failure(BundleStorageError.unknown(nil))
    service.updateBundle(
        bundleId: bundleId,
        manifestUrl: manifestURL,
        manifestFileHash: manifestHash,
        archiveUrl: archiveURL,
        assets: assets,
        progressHandler: { _ in }
    ) {
        result = $0
        completed.signal()
    }
    if completed.wait(timeout: .now() + 5) == .timedOut {
        return .failure(NSError(
            domain: "BundleFileStorageServiceTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for update"]
        ))
    }
    return result
}
private final class DelayedAuditDownloadService: DownloadService {
    private let contents: [URL: Data]
    private let lock = NSLock()
    private var activeAssets = 0
    private var maximum = 0
    init(contents: [URL: Data]) { self.contents = contents }
    var maximumConcurrentAssets: Int {
        lock.lock()
        defer { lock.unlock() }
        return maximum
    }
    func downloadFile(from url: URL, to destination: String,
        fileSizeHandler: ((Int64) -> Void)?,
        progressHandler: @escaping (DownloadProgress) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask? {
        let isAsset = url.lastPathComponent != "manifest.json"
        lock.lock()
        if isAsset {
            activeAssets += 1
            maximum = max(maximum, activeAssets)
        }
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            let result: Result<URL, Error>
            do {
                guard let bytes = self.contents[url] else {
                    throw NSError(domain: "audit", code: 1)
                }
                let target = URL(fileURLWithPath: destination)
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try bytes.write(to: target)
                result = .success(target)
            } catch { result = .failure(error) }
            self.lock.lock()
            if isAsset { self.activeAssets -= 1 }
            self.lock.unlock()
            completion(result)
        }
        return nil
    }
}

private final class FailingFinalPromotionFileSystem: TestFileSystemService {
    override func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        if srcPath.hasSuffix("/target.tmp"), dstPath.hasSuffix("/target") {
            throw NSError(domain: "PRDReviewInjectedFinalMoveFailure", code: 1)
        }
        try super.moveItem(atPath: srcPath, toPath: dstPath)
    }
}

#endif
