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
    func existingMetadataWithoutLaunchProgressStillDecodes() throws {
        let json = #"{"schema":"metadata-v1","isolation_key":"legacy","stable_bundle_id":"stable","staging_bundle_id":"pending","verification_pending":true,"updated_at":123}"#
        let metadata = try JSONDecoder().decode(BundleMetadata.self, from: Data(json.utf8))
        #expect(metadata.stagingBundleId == "pending")
        #expect(metadata.verificationPending)
        #expect(!metadata.launchInProgress)
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

    // Issue #1469: a launch that ends before first content without a crash
    // marker may be a user leaving early rather than a hang.
    @Test
    func unfinishedLaunchRetriesBundleOnceBeforeCrashHistory() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        try leaveUnfinishedLaunch(documentsDirectory: workingDirectory, preferences: preferences)

        // The next process still rolls back at once and reports RECOVERED.
        let recovered = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        #expect(recovered.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "stable-bundle")
        #expect(recovered.notifyAppReady()["status"] as? String == "RECOVERED")
        #expect(!loadCrashedHistory(documentsDirectory: workingDirectory).contains("retried-bundle"))
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).interruptedLaunch?.bundleId == "retried-bundle")
        // The session that recovered refuses the bundle, even after first content.
        recovered.markLaunchCompleted(bundleId: "stable-bundle")
        #expect(recovered.getCrashHistory().contains("retried-bundle"))
        #expect(updateErrorCode(recovered, bundleId: "retried-bundle") == "BUNDLE_IN_CRASHED_HISTORY")

        // A later process may install it again.
        let retrying = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        #expect(retrying.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "stable-bundle")
        #expect(!retrying.getCrashHistory().contains("retried-bundle"))
        try stageRetriedBundle(documentsDirectory: workingDirectory)

        // The retry ends before first content too: now crash history keeps it.
        #expect(makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
            .prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "retried-bundle")
        let next = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        #expect(next.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "stable-bundle")
        #expect(next.notifyAppReady()["status"] as? String == "RECOVERED")
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).contains("retried-bundle"))
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).interruptedLaunch == nil)
        next.markLaunchCompleted(bundleId: "stable-bundle")
        let later = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = later.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(updateErrorCode(later, bundleId: "retried-bundle") == "BUNDLE_IN_CRASHED_HISTORY")
    }

    @Test
    func retriedBundleThatReachesFirstContentIsVerified() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        try leaveUnfinishedLaunch(documentsDirectory: workingDirectory, preferences: preferences)
        let recovered = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = recovered.prepareLaunch(bundle: .main, pendingRecovery: nil)
        recovered.markLaunchCompleted(bundleId: "stable-bundle")
        _ = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
            .prepareLaunch(bundle: .main, pendingRecovery: nil)
        try stageRetriedBundle(documentsDirectory: workingDirectory)

        let retryLaunch = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        #expect(retryLaunch.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "retried-bundle")
        retryLaunch.markLaunchCompleted(bundleId: "retried-bundle")

        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).bundles.isEmpty)
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).interruptedLaunch == nil)
        let next = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
            .prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(next.launchedBundleId == "retried-bundle")
        #expect(!next.shouldRollbackOnCrash)
    }

    @Test
    func retryWaitsForSessionThatShowedContent() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        try leaveUnfinishedLaunch(documentsDirectory: workingDirectory, preferences: preferences)

        // A background launch consumes the unfinished launch and never renders.
        let background = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        #expect(background.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "stable-bundle")
        #expect(background.getCrashHistory().contains("retried-bundle"))

        // The user's next open is the first session that recovered.
        let opened = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = opened.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(opened.getCrashHistory().contains("retried-bundle"))
        opened.markLaunchCompleted(bundleId: "stable-bundle")
        #expect(opened.getCrashHistory().contains("retried-bundle"))

        let later = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = later.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(!later.getCrashHistory().contains("retried-bundle"))
    }

    @Test
    func retryReadiesAfterContentFromBuiltInBundle() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        try leaveUnfinishedLaunch(
            documentsDirectory: workingDirectory, preferences: preferences, stableBundleId: nil
        )
        let recovered = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = recovered.prepareLaunch(bundle: .main, pendingRecovery: nil)

        // First content of the built-in bundle reports no bundle ID.
        recovered.markLaunchCompleted(bundleId: nil)

        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).interruptedLaunch?.retryReady == true)
        let later = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = later.prepareLaunch(bundle: .main, pendingRecovery: nil)
        #expect(!later.getCrashHistory().contains("retried-bundle"))
    }

    @Test
    func crashOfRetriedBundleAddsItToCrashHistory() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        try leaveUnfinishedLaunch(documentsDirectory: workingDirectory, preferences: preferences)
        let recovered = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = recovered.prepareLaunch(bundle: .main, pendingRecovery: nil)
        recovered.markLaunchCompleted(bundleId: "stable-bundle")
        _ = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
            .prepareLaunch(bundle: .main, pendingRecovery: nil)
        try stageRetriedBundle(documentsDirectory: workingDirectory)
        #expect(makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
            .prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "retried-bundle")

        // That launch crashed before first content and left a crash marker.
        let next = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
            .prepareLaunch(
                bundle: .main,
                pendingRecovery: PendingCrashRecovery(launchedBundleId: "retried-bundle", shouldRollback: true)
            )

        #expect(next.launchedBundleId == "stable-bundle")
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).contains("retried-bundle"))
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).interruptedLaunch == nil)
    }

    @Test
    func clearingCrashHistoryDropsWaitingRetry() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let preferences = InMemoryPreferencesService()
        try leaveUnfinishedLaunch(documentsDirectory: workingDirectory, preferences: preferences)
        let recovered = makeStorageService(documentsDirectory: workingDirectory, preferences: preferences)
        _ = recovered.prepareLaunch(bundle: .main, pendingRecovery: nil)

        #expect(recovered.clearCrashHistory())

        #expect(!recovered.getCrashHistory().contains("retried-bundle"))
        #expect(loadCrashedHistory(documentsDirectory: workingDirectory).interruptedLaunch == nil)
    }

    @Test
    func malformedRetryRecordKeepsCrashHistory() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let storeDirectory = workingDirectory.appendingPathComponent("bundle-store", isDirectory: true)
        try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
        try Data(#"{"bundles":[{"bundleId":"crashed-bundle","crashedAt":1,"crashCount":1}],"maxHistorySize":10,"interruptedLaunch":{}}"#.utf8)
            .write(to: storeDirectory.appendingPathComponent(CrashedHistory.crashedHistoryFilename))

        let history = makeStorageService(documentsDirectory: workingDirectory).getCrashHistory()

        #expect(history.bundles.map(\.bundleId) == ["crashed-bundle"])
        #expect(history.interruptedLaunch == nil)
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
    func manifestDrivenInstallIsDisabledBeforeFirstOTA() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let service = makeStorageService(documentsDirectory: workingDirectory)

        #expect(service.canUseManifestDrivenInstall() == false)
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

        #expect(service.getCachedBundleURL() == bundleURL)
        #expect(service.getBundleId() == "nested-bundle")
        #expect(service.canUseManifestDrivenInstall())
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
    func manifestDrivenInstallRejectsUnsafeAssetPaths() throws {
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
        try writeManifest(
            in: activeDirectory,
            bundleId: "active-bundle",
            assetPaths: ["../active-bundle_evil/index.ios.bundle"]
        )
        try preferences.setItem(
            activeDirectory
                .appendingPathComponent("index.ios.bundle")
                .absoluteString,
            forKey: "HotUpdaterBundleURL"
        )

        #expect(service.canUseManifestDrivenInstall() == false)
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

private func loadCrashedHistory(documentsDirectory: URL) -> CrashedHistory {
    CrashedHistory.load(from: documentsDirectory
        .appendingPathComponent("bundle-store", isDirectory: true)
        .appendingPathComponent(CrashedHistory.crashedHistoryFilename))
}

/// Stages retried-bundle over stable-bundle, or over the built-in bundle, and
/// leaves a launch of it that ended before first content.
private func leaveUnfinishedLaunch(
    documentsDirectory: URL,
    preferences: PreferencesService,
    stableBundleId: String? = "stable-bundle"
) throws {
    for bundleId in [stableBundleId, "retried-bundle"].compactMap({ $0 }) {
        let directory = try createBundleDirectory(documentsDirectory: documentsDirectory, bundleId: bundleId)
        try writeBundle(in: directory, bundleFileName: "index.ios.bundle")
        try writeManifest(in: directory, bundleId: bundleId)
    }
    try writeMetadata(
        documentsDirectory: documentsDirectory,
        BundleMetadata(
            isolationKey: testIsolationKey,
            stableBundleId: stableBundleId,
            stagingBundleId: "retried-bundle",
            verificationPending: true
        )
    )
    let launch = makeStorageService(documentsDirectory: documentsDirectory, preferences: preferences)
    try #require(launch.prepareLaunch(bundle: .main, pendingRecovery: nil).launchedBundleId == "retried-bundle")
}

/// What an install of retried-bundle over the recovered stable bundle leaves.
private func stageRetriedBundle(documentsDirectory: URL) throws {
    let directory = try createBundleDirectory(documentsDirectory: documentsDirectory, bundleId: "retried-bundle")
    try writeBundle(in: directory, bundleFileName: "index.ios.bundle")
    try writeManifest(in: directory, bundleId: "retried-bundle")
    try writeMetadata(
        documentsDirectory: documentsDirectory,
        BundleMetadata(
            isolationKey: testIsolationKey,
            stableBundleId: "stable-bundle",
            stagingBundleId: "retried-bundle",
            verificationPending: true
        )
    )
}

/// The crash history check completes before any download starts.
private func updateErrorCode(_ service: BundleFileStorageService, bundleId: String) -> String? {
    var code: String?
    service.updateBundle(
        bundleId: bundleId,
        fileUrl: URL(string: "https://example.com/\(bundleId).zip"),
        fileHash: nil,
        manifestUrl: nil,
        manifestFileHash: nil,
        changedAssets: nil,
        progressHandler: { _ in }
    ) { result in
        if case .failure(let error) = result {
            code = (error as? BundleStorageError)?.errorCodeString
        }
    }
    return code
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
        progressHandler: @escaping (DownloadProgress) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> URLSessionDownloadTask? {
        Issue.record("downloadFile should not be called")
        return nil
    }
}
#endif
