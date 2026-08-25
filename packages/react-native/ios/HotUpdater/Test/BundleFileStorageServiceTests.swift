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
    func catalogHighWaterRejectsReplayAndSurvivesChannelReset() throws {
        let workingDirectory = try makeWorkingDirectory()
        defer { cleanupWorkingDirectory(workingDirectory) }
        let service = makeStorageService(documentsDirectory: workingDirectory)

        #expect(service.acceptReleaseCatalog(
            authorityId: "project-a",
            scopeKey: "scope-production",
            generation: 2,
            catalogHash: "hash-2",
            channel: "production",
            selectionContextHash: "context-2"
        ))
        #expect(service.acceptReleaseCatalog(
            authorityId: "project-a",
            scopeKey: "scope-production",
            generation: 1,
            catalogHash: "hash-1",
            channel: "production",
            selectionContextHash: "context-1"
        ) == false)
        #expect(service.acceptReleaseCatalog(
            authorityId: "project-a",
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
            authorityId: "project-a",
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
    preferences: PreferencesService = InMemoryPreferencesService(),
    builtInBundleId: String = "builtin-bundle"
) -> BundleFileStorageService {
    BundleFileStorageService(
        fileSystem: TestFileSystemService(documentsDirectory: documentsDirectory),
        downloadService: UnusedDownloadService(),
        decompressService: DecompressService(),
        preferences: preferences,
        isolationKey: testIsolationKey,
        builtInBundleIdProvider: { builtInBundleId }
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
        authorityId: "project-a",
        scopeKey: "scope-production",
        generation: generation,
        catalogHash: catalogHash,
        channel: "production",
        selectionContextHash: selectionContextHash
    )
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
