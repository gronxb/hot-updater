import CryptoKit
import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxDeltaTests: XCTestCase {
    private let runtimeId = "sparkling-lynx-3.9.0-primjs-ios-delta-tests"
    private let baseBundleId = "01900000-0000-7000-8000-000000000201"
    private let targetBundleId = "01900000-0000-7000-8000-000000000202"
    private let targetReleaseId = "01900000-0000-7000-8000-000000000302"
    private let patchBytes = Data(base64Encoded:
        "RU5EU0xFWS9CU0RJRkY0Mx8AAAAAAAAAQlpoOTFBWSZTWb12MIEAAAB5gEQYAADQYQAIPsXOACAAIo0A0NAaNCgAGgZMgHAtYscVxxRtTt4nmaj70g4gQSF5+T4u5IpwoSF67GEC"
    )!
    private let brotliBytes = Data(base64Encoded: "CwmAYnJvdGxpLXRhcmdldC1hc3NldAM=")!

    private struct Tree {
        let directory: URL
        let manifest: Data
        let digest: String
        let files: [String: Data]
        let installed: LynxInstalledArtifact
    }

    private final class FetchRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [URL] = []
        private var limits: [URL: UInt64] = [:]
        func record(_ url: URL, maximumBytes: UInt64? = nil) {
            lock.lock()
            values.append(url)
            if let maximumBytes { limits[url] = maximumBytes }
            lock.unlock()
        }
        func contains(_ url: URL) -> Bool { lock.lock(); defer { lock.unlock() }; return values.contains(url) }
        func maximumBytes(for url: URL) -> UInt64? {
            lock.lock(); defer { lock.unlock() }; return limits[url]
        }
    }

    private func temporaryRoot() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("lynx-delta-tests-\(UUID().uuidString)")
    }

    private func url(_ name: String) -> URL {
        URL(string: "https://artifacts.test/\(name)")!
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func makeTree(at directory: URL, bundleId: String,
                          files input: [String: Data]) throws -> Tree {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let metadata = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "bundleId": bundleId,
            "platform": "ios",
            "runtimeId": runtimeId,
            "entry": "main.lynx.bundle",
        ], options: [.sortedKeys]) + Data("\n".utf8)
        var files = input
        files["hot-updater-lynx.json"] = metadata
        var assets: [String: [String: String]] = [:]
        for (path, data) in files {
            let file = directory.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: file)
            assets[path] = ["fileHash": hash(data)]
        }
        let manifest = try JSONSerialization.data(withJSONObject: [
            "bundleId": bundleId,
            "assets": assets,
        ], options: [.sortedKeys])
        try manifest.write(to: directory.appendingPathComponent("manifest.json"))
        let digest = hash(manifest)
        let verified = try VerifiedLynxTree.verify(
            at: directory,
            bundleId: bundleId,
            manifestToken: nil,
            configuration: .init(runtimeId: runtimeId),
            expectedDigest: digest
        )
        return Tree(
            directory: directory,
            manifest: manifest,
            digest: digest,
            files: files,
            installed: .init(
                bundleId: bundleId,
                directory: directory,
                entry: verified.entry,
                manifestDigest: verified.digest,
                files: verified.files
            )
        )
    }

    private func fetcher(_ payloads: [URL: Data], recorder: FetchRecorder? = nil) -> LynxArtifactFetch {
        { source, destination, maximumBytes, allowEmpty in
            try Task.checkCancellation()
            recorder?.record(source, maximumBytes: maximumBytes)
            guard let data = payloads[source] else {
                throw LynxArtifactError.invalid("Missing test artifact")
            }
            guard UInt64(data.count) <= maximumBytes, allowEmpty || !data.isEmpty else {
                throw LynxArtifactError.invalid("Test artifact exceeds transfer contract")
            }
            try data.write(to: destination)
            try Task.checkCancellation()
        }
    }

    func testTargetManifestRejectsImplicitParentDirectoryAlias() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let base = try makeTree(
            at: root.appendingPathComponent("base"),
            bundleId: baseBundleId,
            files: ["main.lynx.bundle": Data("base".utf8)]
        )
        let manifest = try JSONSerialization.data(withJSONObject: [
            "bundleId": targetBundleId,
            "assets": [
                "Straße/x.bin": ["fileHash": hash(Data("x".utf8))],
                "strasse/y.bin": ["fileHash": hash(Data("y".utf8))],
                "hot-updater-lynx.json": ["fileHash": hash(Data("metadata".utf8))],
            ],
        ], options: [.sortedKeys])
        let manifestURL = url("aliased-manifest")
        let changed = ["Straße/x.bin", "strasse/y.bin", "hot-updater-lynx.json"]
            .reduce(into: [String: LynxChangedAsset]()) { result, path in
                result[path] = .init(
                    fileHash: hash(Data(path.utf8)),
                    file: .init(url: url(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!))
                )
            }
        let request = LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: nil,
            fileHash: nil,
            manifestFileHash: hash(manifest),
            manifestUrl: manifestURL,
            changedAssets: changed
        )
        let stage = root.appendingPathComponent("stage")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)

        do {
            _ = try await LynxDelta.prepare(
                request,
                base: base.installed,
                stage: stage,
                configuration: .init(runtimeId: runtimeId),
                fetch: fetcher([manifestURL: manifest])
            )
            XCTFail("Expected target manifest directory alias rejection")
        } catch {
            XCTAssertEqual((error as NSError).domain, "HotUpdaterLynxArchive")
            XCTAssertEqual(
                (error as NSError).localizedDescription,
                "Duplicate, conflicting or oversized archive entry"
            )
        }
    }

    func testArchiveAndDeltaTransfersUseSharedNativeLimits() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let archiveURL = url("full-archive")
        let archiveRecorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(
            root: root.appendingPathComponent("store"),
            configuration: .init(runtimeId: runtimeId),
            fetch: fetcher([:], recorder: archiveRecorder)
        )
        do {
            _ = try await installer.prepare(
                LynxArtifactRequest(
                    bundleId: targetBundleId,
                    fileUrl: archiveURL,
                    fileHash: String(repeating: "a", count: 64)
                )
            )
            XCTFail("Expected missing archive fixture")
        } catch {
            XCTAssertEqual(archiveRecorder.maximumBytes(for: archiveURL), ArchiveLimits.archive)
        }
        installer.close()

        let base = try makeTree(
            at: root.appendingPathComponent("base"),
            bundleId: baseBundleId,
            files: ["main.lynx.bundle": Data("base".utf8)]
        )
        let target = try makeTree(
            at: root.appendingPathComponent("target"),
            bundleId: targetBundleId,
            files: ["main.lynx.bundle": Data("target".utf8)]
        )
        let manifestURL = url("limit-manifest")
        let entryURL = url("limit-entry")
        let metadataURL = url("limit-metadata")
        let changes: [String: LynxChangedAsset] = [
            "main.lynx.bundle": .init(
                fileHash: hash(target.files["main.lynx.bundle"]!),
                file: .init(url: entryURL)
            ),
            "hot-updater-lynx.json": .init(
                fileHash: hash(target.files["hot-updater-lynx.json"]!),
                file: .init(url: metadataURL)
            ),
        ]
        let recorder = FetchRecorder()
        let stage = root.appendingPathComponent("stage-limits")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        _ = try await LynxDelta.prepare(
            LynxArtifactRequest(
                bundleId: targetBundleId,
                fileUrl: nil,
                fileHash: nil,
                manifestFileHash: target.digest,
                manifestUrl: manifestURL,
                changedAssets: changes
            ),
            base: base.installed,
            stage: stage,
            configuration: .init(runtimeId: runtimeId),
            fetch: fetcher([
                manifestURL: target.manifest,
                entryURL: target.files["main.lynx.bundle"]!,
                metadataURL: target.files["hot-updater-lynx.json"]!,
            ], recorder: recorder)
        )
        XCTAssertEqual(
            recorder.maximumBytes(for: manifestURL),
            UInt64(ArchiveLimits.manifest)
        )
        XCTAssertEqual(recorder.maximumBytes(for: entryURL), ArchiveLimits.file)
        XCTAssertEqual(recorder.maximumBytes(for: metadataURL), ArchiveLimits.file)
    }

    func testRealBsdiffFixtureRejectsTrailingBytesAndOutputOverflow() throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let base = root.appendingPathComponent("base")
        let patch = root.appendingPathComponent("patch")
        let output = root.appendingPathComponent("output")
        let expected = Data("console.log(\"patched bundle\");\n".utf8)
        try Data("console.log(\"base bundle\");\n".utf8).write(to: base)
        try patchBytes.write(to: patch)

        XCTAssertTrue(LynxBsdiffPatch.apply(
            patch: patch, base: base, output: output,
            maximumOutputBytes: UInt64(expected.count)
        ))
        XCTAssertEqual(try Data(contentsOf: output), expected)

        try FileManager.default.removeItem(at: output)
        try (patchBytes + Data([0])).write(to: patch)
        XCTAssertFalse(LynxBsdiffPatch.apply(
            patch: patch, base: base, output: output,
            maximumOutputBytes: UInt64(expected.count)
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))

        try patchBytes.write(to: patch)
        XCTAssertFalse(LynxBsdiffPatch.apply(
            patch: patch, base: base, output: output,
            maximumOutputBytes: UInt64(expected.count - 1)
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }

    func testManifestInstallUsesBsdiffRawBrotliAndFileFallbackThenVerifiesWithoutArchive() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let base = try makeTree(
            at: root.appendingPathComponent("base"),
            bundleId: baseBundleId,
            files: [
                "main.lynx.bundle": Data("console.log(\"base bundle\");\n".utf8),
                "assets/unchanged.bin": Data("unchanged".utf8),
                "assets/fallback.txt": Data("fallback-base".utf8),
                "assets/removed.txt": Data("removed".utf8),
            ]
        )
        let target = try makeTree(
            at: root.appendingPathComponent("target"),
            bundleId: targetBundleId,
            files: [
                "main.lynx.bundle": Data("console.log(\"patched bundle\");\n".utf8),
                "assets/unchanged.bin": Data("unchanged".utf8),
                "assets/empty.bin": Data(),
                "assets/brotli.txt": Data("brotli-target-asset".utf8),
                "assets/fallback.txt": Data("fallback-target".utf8),
            ]
        )
        let manifestURL = url("manifest")
        let patchURL = url("main.patch")
        let badPatchURL = url("bad.patch")
        let metadataURL = url("metadata")
        let emptyURL = url("empty")
        let brotliURL = url("brotli")
        let fallbackURL = url("fallback")
        let badPatch = Data("not-a-patch".utf8)
        let changes: [String: LynxChangedAsset] = [
            "main.lynx.bundle": .init(
                fileHash: hash(target.files["main.lynx.bundle"]!),
                patch: .init(
                    baseBundleId: baseBundleId,
                    baseFileHash: hash(base.files["main.lynx.bundle"]!),
                    patchFileHash: hash(patchBytes),
                    patchUrl: patchURL
                )
            ),
            "assets/empty.bin": .init(
                fileHash: hash(Data()),
                file: .init(url: emptyURL)
            ),
            "assets/brotli.txt": .init(
                fileHash: hash(target.files["assets/brotli.txt"]!),
                file: .init(url: brotliURL, compression: "br")
            ),
            "assets/fallback.txt": .init(
                fileHash: hash(target.files["assets/fallback.txt"]!),
                file: .init(url: fallbackURL),
                patch: .init(
                    baseBundleId: baseBundleId,
                    baseFileHash: hash(base.files["assets/fallback.txt"]!),
                    patchFileHash: hash(badPatch),
                    patchUrl: badPatchURL
                )
            ),
            "hot-updater-lynx.json": .init(
                fileHash: hash(target.files["hot-updater-lynx.json"]!),
                file: .init(url: metadataURL)
            ),
        ]
        let request = LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: nil,
            fileHash: nil,
            manifestFileHash: target.digest,
            manifestUrl: manifestURL,
            changedAssets: changes
        )
        let payloads: [URL: Data] = [
            manifestURL: target.manifest,
            patchURL: patchBytes,
            badPatchURL: badPatch,
            metadataURL: target.files["hot-updater-lynx.json"]!,
            emptyURL: Data(),
            brotliURL: brotliBytes,
            fallbackURL: target.files["assets/fallback.txt"]!,
        ]
        let store = root.appendingPathComponent("store")
        var installer: LynxArtifactInstaller? = try .init(
            root: store,
            configuration: .init(runtimeId: runtimeId),
            fetch: fetcher(payloads)
        )
        let prepared = try await installer!.prepare(
            request,
            base: base.installed,
            releaseId: targetReleaseId
        )
        guard case .manifest(let deliveredBase, let releaseId, let patchedAssets) = prepared.delivery else {
            return XCTFail("Expected manifest delivery evidence")
        }
        XCTAssertEqual(deliveredBase, baseBundleId)
        XCTAssertEqual(releaseId, targetReleaseId)
        let patched = try XCTUnwrap(patchedAssets.first { $0.path == "main.lynx.bundle" })
        XCTAssertEqual(patched.patchFileHash, hash(patchBytes))
        XCTAssertEqual(
            patched.reconstructedFileHash,
            hash(target.files["main.lynx.bundle"]!)
        )
        let patchEvent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(
            LynxInstallEvent.json(
                event: "HotUpdaterBsdiffPatchApplied",
                transactionId: prepared.id,
                bundleId: prepared.bundleId,
                releaseId: releaseId,
                baseBundleId: deliveredBase,
                patchedAsset: patched
            ).utf8
        )) as? [String: Any])
        let manifestEvent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(
            LynxInstallEvent.json(
                event: "HotUpdaterManifestDiffApplied",
                transactionId: prepared.id,
                bundleId: prepared.bundleId,
                releaseId: releaseId,
                baseBundleId: deliveredBase
            ).utf8
        )) as? [String: Any])
        XCTAssertEqual(patchEvent["schemaVersion"] as? Int, 1)
        XCTAssertEqual(patchEvent["event"] as? String, "HotUpdaterBsdiffPatchApplied")
        XCTAssertEqual(patchEvent["transactionId"] as? String, prepared.id)
        XCTAssertEqual(patchEvent["bundleId"] as? String, targetBundleId)
        XCTAssertEqual(patchEvent["releaseId"] as? String, targetReleaseId)
        XCTAssertEqual(patchEvent["baseBundleId"] as? String, baseBundleId)
        XCTAssertEqual(patchEvent["asset"] as? String, "main.lynx.bundle")
        XCTAssertEqual(patchEvent["patchFileHash"] as? String, hash(patchBytes))
        XCTAssertEqual(
            patchEvent["reconstructedFileHash"] as? String,
            hash(target.files["main.lynx.bundle"]!)
        )
        XCTAssertEqual(manifestEvent["event"] as? String, "HotUpdaterManifestDiffApplied")
        XCTAssertEqual(manifestEvent["transactionId"] as? String, prepared.id)
        XCTAssertEqual(manifestEvent["releaseId"] as? String, targetReleaseId)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: store.appendingPathComponent("bundles").path
        ), [])
        let installed = try installer!.commit(prepared) { publish in _ = try publish() }
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent("main.lynx.bundle")), target.files["main.lynx.bundle"])
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent("assets/empty.bin")), Data())
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent("assets/brotli.txt")), target.files["assets/brotli.txt"])
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent("assets/fallback.txt")), target.files["assets/fallback.txt"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: installed.directory.appendingPathComponent("assets/removed.txt").path))
        installer = nil

        let relaunched = try LynxArtifactInstaller(root: store, configuration: .init(runtimeId: runtimeId))
        let verified = try relaunched.inspectInstalled(
            bundleId: targetBundleId,
            expectedManifestDigest: target.digest
        )
        XCTAssertEqual(verified.files, installed.files)
        XCTAssertFalse(FileManager.default.fileExists(atPath: verified.directory.appendingPathComponent("archive").path))
    }

    func testCorruptManifestFallsBackToAuthorizedArchiveAndKeepsManifestTrustToken() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let base = try makeTree(
            at: root.appendingPathComponent("base"),
            bundleId: baseBundleId,
            files: ["main.lynx.bundle": Data("base".utf8)]
        )
        let target = try makeTree(
            at: root.appendingPathComponent("target"),
            bundleId: targetBundleId,
            files: ["main.lynx.bundle": Data("archive-target".utf8)]
        )
        let archive = root.appendingPathComponent("target.tar.gz")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        var environment = ProcessInfo.processInfo.environment
        environment["COPYFILE_DISABLE"] = "1"
        process.environment = environment
        process.arguments = ["--format", "ustar", "-czf", archive.path, "-C", target.directory.path] +
            (Array(target.files.keys) + ["manifest.json"]).sorted()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        let archiveBytes = try Data(contentsOf: archive)
        let archiveURL = url("archive")
        let manifestURL = url("corrupt-manifest")
        let payloads = [archiveURL: archiveBytes, manifestURL: Data("corrupt".utf8)]
        let request = LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: archiveURL,
            fileHash: hash(archiveBytes),
            manifestFileHash: target.digest,
            manifestUrl: manifestURL,
            changedAssets: [:]
        )
        let store = root.appendingPathComponent("store")
        let installer = try LynxArtifactInstaller(
            root: store,
            configuration: .init(runtimeId: runtimeId),
            fetch: fetcher(payloads)
        )
        let wrongToken = LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: archiveURL,
            fileHash: hash(archiveBytes),
            manifestFileHash: String(repeating: "0", count: 64),
            manifestUrl: manifestURL,
            changedAssets: [:]
        )
        do {
            _ = try await installer.prepare(wrongToken, base: base.installed)
            XCTFail("Archive fallback discarded the supplied manifest trust token")
        } catch { }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: store.appendingPathComponent(".staging").path
        ), [])

        let prepared = try await installer.prepare(request, base: base.installed)
        let installed = try installer.commit(prepared) { publish in _ = try publish() }
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry)), Data("archive-target".utf8))
    }

    func testCancellationRemovesOwnedPreparationWithoutDownloadingArchiveFallback() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let base = try makeTree(
            at: root.appendingPathComponent("base"),
            bundleId: baseBundleId,
            files: ["main.lynx.bundle": Data("base".utf8)]
        )
        let manifestURL = url("slow-manifest")
        let archiveURL = url("must-not-download-archive")
        let recorder = FetchRecorder()
        let fetch: LynxArtifactFetch = { source, _, _, _ in
            recorder.record(source)
            if source == manifestURL {
                try await Task.sleep(nanoseconds: 10_000_000_000)
            }
            throw LynxArtifactError.invalid("Unexpected fallback")
        }
        let request = LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: archiveURL,
            fileHash: String(repeating: "a", count: 64),
            manifestFileHash: String(repeating: "b", count: 64),
            manifestUrl: manifestURL,
            changedAssets: [:]
        )
        let store = root.appendingPathComponent("store")
        let installer = try LynxArtifactInstaller(
            root: store,
            configuration: .init(runtimeId: runtimeId),
            fetch: fetch
        )
        let operation = Task { try await installer.prepare(request, base: base.installed) }
        try await Task.sleep(nanoseconds: 20_000_000)
        operation.cancel()
        do {
            _ = try await operation.value
            XCTFail("Canceled manifest preparation succeeded")
        } catch is CancellationError { }
        XCTAssertTrue(recorder.contains(manifestURL))
        XCTAssertFalse(recorder.contains(archiveURL))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: store.appendingPathComponent(".staging").path
        ), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: store.appendingPathComponent("bundles").path
        ), [])
    }

    func testIncompleteOrUnsafeDescriptorsFailBeforeAnyDownload() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(
            root: root.appendingPathComponent("store"),
            configuration: .init(runtimeId: runtimeId),
            fetch: fetcher([:], recorder: recorder)
        )
        let manifestURL = url("manifest")
        let requests = [
            LynxArtifactRequest(
                bundleId: targetBundleId,
                fileUrl: url("archive"),
                fileHash: nil,
                manifestFileHash: String(repeating: "a", count: 64),
                manifestUrl: manifestURL,
                changedAssets: [:]
            ),
            LynxArtifactRequest(
                bundleId: targetBundleId,
                fileUrl: nil,
                fileHash: nil,
                manifestFileHash: String(repeating: "a", count: 64),
                manifestUrl: manifestURL,
                changedAssets: [
                    "../escape": .init(
                        fileHash: String(repeating: "b", count: 64),
                        file: .init(url: url("escape"))
                    ),
                ]
            ),
            LynxArtifactRequest(
                bundleId: targetBundleId,
                fileUrl: nil,
                fileHash: nil,
                manifestFileHash: String(repeating: "a", count: 64),
                manifestUrl: manifestURL,
                changedAssets: [
                    "main.lynx.bundle": .init(
                        fileHash: String(repeating: "b", count: 64),
                        file: .init(url: url("main"), compression: "gzip")
                    ),
                ]
            ),
        ]
        for request in requests {
            do {
                _ = try await installer.prepare(request)
                XCTFail("Unsafe or partial request reached download")
            } catch { }
        }
        XCTAssertFalse(recorder.contains(manifestURL))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: root.appendingPathComponent("store/.staging").path
        ), [])
    }

    func testArchiveOnlyRequestMayCarryManifestTrustToken() throws {
        let hash = String(repeating: "a", count: 64)
        XCTAssertNoThrow(try LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: url("archive"),
            fileHash: hash,
            manifestFileHash: hash
        ).validate())
        XCTAssertThrowsError(try LynxArtifactRequest(
            bundleId: targetBundleId,
            fileUrl: nil,
            fileHash: nil,
            manifestFileHash: hash
        ).validate())
    }

    func testWireDescriptorRequiresExplicitNullableCompressionFileAndPatch() throws {
        let hash = String(repeating: "a", count: 64)
        let missingCompression = """
        {
          "bundleId":"\(targetBundleId)",
          "fileUrl":null,
          "fileHash":null,
          "manifestUrl":"https://artifacts.test/manifest",
          "manifestFileHash":"\(hash)",
          "changedAssets":{
            "main.lynx.bundle":{
              "fileHash":"\(hash)",
              "file":{"url":"https://artifacts.test/main"},
              "patch":null
            }
          }
        }
        """
        XCTAssertThrowsError(try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: Data(missingCompression.utf8)
        ))

        let complete = missingCompression.replacingOccurrences(
            of: "\"url\":\"https://artifacts.test/main\"",
            with: "\"url\":\"https://artifacts.test/main\",\"compression\":null"
        )
        let decoded = try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: Data(complete.utf8)
        )
        XCTAssertNoThrow(try decoded.validate())

        var missingPatchObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(complete.utf8)) as? [String: Any]
        )
        var changedAssets = missingPatchObject["changedAssets"] as! [String: Any]
        var main = changedAssets["main.lynx.bundle"] as! [String: Any]
        main.removeValue(forKey: "patch")
        changedAssets["main.lynx.bundle"] = main
        missingPatchObject["changedAssets"] = changedAssets
        let missingPatch = try JSONSerialization.data(withJSONObject: missingPatchObject)
        XCTAssertThrowsError(try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: missingPatch
        ))
    }
}
