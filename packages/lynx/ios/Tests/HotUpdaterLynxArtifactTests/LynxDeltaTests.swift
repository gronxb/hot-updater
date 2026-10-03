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
        func count(_ url: URL) -> Int { lock.lock(); defer { lock.unlock() }; return values.filter { $0 == url }.count }
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
                          files input: [String: Data],
                          brotliDownloads: [String: Data] = [:]) throws -> Tree {
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
        var assets: [String: [String: Any]] = [:]
        for (path, data) in files {
            let file = directory.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: file)
            assets[path] = ["fileHash": hash(data), "byteSize": data.count,
                            "downloadFileHash": hash(brotliDownloads[path] ?? data),
                            "downloadByteSize": (brotliDownloads[path] ?? data).count]
            if brotliDownloads[path] != nil { assets[path]!["downloadCompression"] = "br" }
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

    private func decodeBridgeRequest(_ value: [String: Any]) throws -> LynxArtifactRequest {
        try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        )
    }

    private func metadataFiles(runtime: String? = nil) throws -> [String: Data] {
        let entries = ["detail.lynx.bundle", "main.lynx.bundle"]
        return [
            "main.lynx.bundle": Data("main page".utf8),
            "detail.lynx.bundle": Data("detail page".utf8),
            "assets/image.png": Data([1, 2, 3]),
            "hot-updater-lynx.json": try JSONSerialization.data(withJSONObject: [
                "schemaVersion": 1, "bundleId": targetBundleId,
                "platform": "ios", "runtimeId": runtime ?? runtimeId,
                "entry": "main.lynx.bundle", "pageEntries": entries,
                "pageEssentialResources": entries.map { ["entry": $0, "resources": ["assets/image.png", $0]] },
            ], options: [.sortedKeys]),
        ]
    }

    private func metadataTransfer(_ files: [String: Data], brotliDownloads: [String: Data] = [:]) throws -> (request: LynxArtifactRequest, payloads: [URL: Data]) {
        let assets = Dictionary(uniqueKeysWithValues: files.map { path, data in
            var asset: [String: Any] = ["fileHash": hash(data), "byteSize": data.count]
            if let compressed = brotliDownloads[path] {
                asset["downloadCompression"] = "br"
                asset["downloadFileHash"] = hash(compressed)
                asset["downloadByteSize"] = compressed.count
            }
            return (path, asset)
        })
        let manifest = try JSONSerialization.data(withJSONObject: [
            "bundleId": targetBundleId, "assets": assets,
        ], options: [.sortedKeys])
        var payloads = Dictionary(uniqueKeysWithValues: files.map { (url($0.key), brotliDownloads[$0.key] ?? $0.value) })
        payloads[url("manifest")] = manifest
        return (LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: url("manifest"), manifestFileHash: hash(manifest),
            assets: Dictionary(uniqueKeysWithValues: files.map { (path, data) in
                (path, LynxChangedAsset(fileHash: hash(data), file: .init(url: url(path), compression: brotliDownloads[path] == nil ? nil : "br")))
            })), payloads)
    }

    func testMetadataCheckDownloadsOnlyManifestAndSidecarThenInstallationReusesThem() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let files = try metadataFiles()
        let transfer = try metadataTransfer(files)
        let recorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId),
            fetch: fetcher(transfer.payloads, recorder: recorder))
        for _ in 0..<2 {
            let paths = try await installer.validateMetadata(transfer.request)
            XCTAssertEqual(paths, Set(files.keys))
        }
        for name in ["manifest", "hot-updater-lynx.json"] { XCTAssertEqual(recorder.count(url(name)), 1) }
        for name in ["main.lynx.bundle", "detail.lynx.bundle", "assets/image.png"] { XCTAssertEqual(recorder.count(url(name)), 0) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("bundles").path), [])
        let prepared = try await installer.prepare(transfer.request)
        let installed = try installer.commit(prepared) { publish in _ = try publish() }
        XCTAssertEqual(installed.pageEntries, ["detail.lynx.bundle", "main.lynx.bundle"])
        for name in Array(files.keys) + ["manifest"] { XCTAssertEqual(recorder.count(url(name)), 1, name) }
    }

    func testMetadataCheckDefersCorruptPageRejectionUntilInstallation() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let transfer = try metadataTransfer(metadataFiles())
        var payloads = transfer.payloads
        payloads[url("detail.lynx.bundle")] = Data("tampered".utf8)
        let recorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId),
            fetch: fetcher(payloads, recorder: recorder))
        _ = try await installer.validateMetadata(transfer.request)
        do { _ = try await installer.prepare(transfer.request); XCTFail("Corrupt page was installed") }
        catch { }
        XCTAssertEqual(recorder.count(url("hot-updater-lynx.json")), 1)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("bundles").path), [])
    }

    func testMetadataCheckRejectsTamperedManifestOrSidecarBeforeDownloadingPages() async throws {
        for name in ["manifest", "hot-updater-lynx.json"] {
            let root = temporaryRoot()
            defer { try? FileManager.default.removeItem(at: root) }
            let transfer = try metadataTransfer(metadataFiles())
            var payloads = transfer.payloads
            payloads[url(name)]!.append(Data(" ".utf8))
            let recorder = FetchRecorder()
            let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId),
                fetch: fetcher(payloads, recorder: recorder))
            do { _ = try await installer.validateMetadata(transfer.request); XCTFail("Tampered metadata was accepted") }
            catch { }
            XCTAssertEqual(recorder.count(url("main.lynx.bundle")), 0)
            XCTAssertEqual(recorder.count(url("hot-updater-lynx.json")), name == "manifest" ? 0 : 1)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
        }
    }

    func testChangedManifestForSameBundleCannotReuseMetadataCache() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let transfer = try metadataTransfer(metadataFiles())
        let incompatible = try metadataTransfer(metadataFiles(runtime: "different-runtime"))
        let recorder = FetchRecorder()
        let validFetch = fetcher(transfer.payloads, recorder: recorder)
        let invalidFetch = fetcher(incompatible.payloads, recorder: recorder)
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId)) { source, destination, limit, empty in
            let fetch = recorder.count(self.url("manifest")) == 0 ? validFetch : invalidFetch
            // The sidecar for the first transfer must come from the same authenticated manifest.
            if source == self.url("hot-updater-lynx.json"), recorder.count(self.url("manifest")) == 1 {
                try await validFetch(source, destination, limit, empty)
            } else { try await fetch(source, destination, limit, empty) }
        }
        _ = try await installer.validateMetadata(transfer.request)
        do { _ = try await installer.validateMetadata(incompatible.request); XCTFail("Stale cache hid incompatibility") }
        catch { guard case LynxArtifactError.incompatible = error else { return XCTFail("Unexpected error: \(error)") } }
        XCTAssertEqual(recorder.count(url("manifest")), 2)
        XCTAssertEqual(recorder.count(url("hot-updater-lynx.json")), 2)
        XCTAssertEqual(recorder.count(url("main.lynx.bundle")), 0)
    }

    func testMetadataCheckAuthenticatesCompressedSidecarAndReusesExpandedBytes() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let sidecar = Data(#"{"schemaVersion":1,"bundleId":"01900000-0000-7000-8000-000000000202","platform":"ios","runtimeId":"sparkling-lynx-3.9.0-primjs-ios-delta-tests","entry":"main.lynx.bundle"}"#.utf8)
        let compressed = Data(base64Encoded: "G6oAgIzUYk2Z7mTRNfLh36sAfNGITh2WPp0cd1BsSypq2cUDoSzMU5aUBPPrHye3THeQCbJzKoYyLQBCRiGEEAR4BBEQQwmFYLAB2nlH2M7paEcN3xv4DO1U0/BOD2kWmaBla8dup3beaUNBn06EggjYhBKSxSkM")!
        let files = ["main.lynx.bundle": Data("main".utf8), "hot-updater-lynx.json": sidecar]
        let transfer = try metadataTransfer(files, brotliDownloads: ["hot-updater-lynx.json": compressed])
        let recorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId),
            fetch: fetcher(transfer.payloads, recorder: recorder))
        _ = try await installer.validateMetadata(transfer.request)
        XCTAssertEqual(recorder.count(url("main.lynx.bundle")), 0)
        let prepared = try await installer.prepare(transfer.request)
        let installed = try installer.commit(prepared) { publish in _ = try publish() }
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent("hot-updater-lynx.json")), sidecar)
        XCTAssertEqual(recorder.count(url("hot-updater-lynx.json")), 1)
    }

    func testMetadataCheckRejectsOversizedSidecarBeforeDownloadingPages() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        var files = try metadataFiles()
        files["hot-updater-lynx.json"]!.append(Data(repeating: 32, count: 16 * 1024))
        let transfer = try metadataTransfer(files)
        let recorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId),
            fetch: fetcher(transfer.payloads, recorder: recorder))
        do { _ = try await installer.validateMetadata(transfer.request); XCTFail("Oversized metadata was accepted") }
        catch { }
        XCTAssertEqual(recorder.maximumBytes(for: url("hot-updater-lynx.json")), 16 * 1024)
        XCTAssertEqual(recorder.count(url("main.lynx.bundle")), 0)
    }

    func testCanceledMetadataCheckRemovesStageAndDoesNotCachePartialMetadata() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let transfer = try metadataTransfer(metadataFiles())
        let recorder = FetchRecorder()
        let sidecarStarted = expectation(description: "Sidecar download started")
        let fetch = fetcher(transfer.payloads, recorder: recorder)
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: runtimeId)) { source, destination, limit, empty in
            if source == self.url("hot-updater-lynx.json"), recorder.count(self.url("manifest")) == 1 {
                sidecarStarted.fulfill()
                try await Task.sleep(nanoseconds: 10_000_000_000)
            }
            try await fetch(source, destination, limit, empty)
        }
        let operation = Task { try await installer.validateMetadata(transfer.request) }
        await fulfillment(of: [sidecarStarted], timeout: 2)
        operation.cancel()
        do { _ = try await operation.value; XCTFail("Canceled metadata check succeeded") }
        catch is CancellationError { }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
        _ = try await installer.validateMetadata(transfer.request)
        XCTAssertEqual(recorder.count(url("manifest")), 2)
        XCTAssertEqual(recorder.count(url("main.lynx.bundle")), 0)
    }

    func testBridgeShapedDescriptorsAllowMissingOptionalKeysAndPrepare() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let base = try makeTree(
            at: root.appendingPathComponent("base"),
            bundleId: baseBundleId,
            files: ["main.lynx.bundle": Data("console.log(\"base bundle\");\n".utf8)]
        )
        let target = try makeTree(
            at: root.appendingPathComponent("target"),
            bundleId: targetBundleId,
            files: ["main.lynx.bundle": Data("console.log(\"patched bundle\");\n".utf8)]
        )
        let manifestURL = url("bridge-manifest")
        let patchURL = url("bridge-main.patch")
        let metadataURL = url("bridge-metadata")
        let request = try decodeBridgeRequest([
            "artifactProtocolVersion": 1,
            "bundleId": targetBundleId,
            "manifestFileHash": target.digest,
            "manifestUrl": manifestURL.absoluteString,
            "assets": [
                "main.lynx.bundle": [
                    "fileHash": hash(target.files["main.lynx.bundle"]!),
                    "file": ["url": url("unused-main").absoluteString],
                    "patch": [
                        "algorithm": "bsdiff",
                        "baseBundleId": baseBundleId,
                        "baseFileHash": hash(base.files["main.lynx.bundle"]!),
                        "patchFileHash": hash(patchBytes),
                        "patchUrl": patchURL.absoluteString,
                    ],
                ],
                "hot-updater-lynx.json": [
                    "fileHash": hash(target.files["hot-updater-lynx.json"]!),
                    "file": ["url": metadataURL.absoluteString],
                ],
            ],
        ])

        XCTAssertNil(request.assets?["main.lynx.bundle"]?.file?.compression)
        XCTAssertNil(request.assets?["hot-updater-lynx.json"]?.patch)
        XCTAssertNil(request.assets?["hot-updater-lynx.json"]?.file?.compression)
        XCTAssertNoThrow(try request.validate())

        let recorder = FetchRecorder()
        let stage = root.appendingPathComponent("stage")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        let result = try await LynxDelta.prepare(
            request,
            base: base.installed,
            stage: stage,
            configuration: .init(runtimeId: runtimeId),
            fetch: fetcher([
                manifestURL: target.manifest,
                patchURL: patchBytes,
                metadataURL: target.files["hot-updater-lynx.json"]!,
            ], recorder: recorder)
        )

        XCTAssertTrue(recorder.contains(patchURL))
        XCTAssertTrue(recorder.contains(metadataURL))
        XCTAssertEqual(result.patchedAssets.map(\.path), ["main.lynx.bundle"])
    }

    func testBridgeShapedDescriptorWithoutFileOrPatchFailsSemanticValidation() throws {
        let request = try decodeBridgeRequest([
            "artifactProtocolVersion": 1,
            "bundleId": targetBundleId,
            "manifestFileHash": String(repeating: "a", count: 64),
            "manifestUrl": url("bridge-manifest").absoluteString,
            "assets": [
                "main.lynx.bundle": [
                    "fileHash": String(repeating: "b", count: 64),
                ],
            ],
        ])

        XCTAssertNil(request.assets?["main.lynx.bundle"]?.file)
        XCTAssertNil(request.assets?["main.lynx.bundle"]?.patch)
        XCTAssertThrowsError(try request.validate()) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "Invalid changed asset descriptor"
            )
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
        let request = LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: hash(manifest),
            assets: changed)
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

    func testManifestAndOriginalTransfersUseSharedNativeLimits() async throws {
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
            LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: target.digest,
            assets: changes),
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
            ],
            brotliDownloads: ["assets/brotli.txt": brotliBytes]
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
                file: .init(url: url("unused-main")),
                patch: .init(
                    baseBundleId: baseBundleId,
                    baseFileHash: hash(base.files["main.lynx.bundle"]!),
                    patchFileHash: hash(patchBytes),
                    patchUrl: patchURL
                )
            ),
            "assets/unchanged.bin": .init(
                fileHash: hash(target.files["assets/unchanged.bin"]!),
                file: .init(url: url("unused-unchanged"))
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
        let request = LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: target.digest,
            assets: changes)
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

    func testCorruptManifestRejectsBeforeAnyArchiveDownload() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let manifestURL = url("corrupt-manifest")
        let archiveURL = url("must-not-download-archive")
        let recorder = FetchRecorder()
        let installer = try LynxArtifactInstaller(
            root: root, configuration: .init(runtimeId: runtimeId),
            fetch: fetcher([manifestURL: Data("corrupt".utf8)], recorder: recorder)
        )
        let request = LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: String(repeating: "0", count: 64),
            assets: placeholderAssets,
            archiveUrl: archiveURL)
        do {
            _ = try await installer.prepare(request)
            XCTFail("Corrupt manifest accepted")
        } catch let error as SignatureVerificationError {
            XCTAssertEqual(error.errorCodeString, "FILE_HASH_MISMATCH")
        }
        XCTAssertTrue(recorder.contains(manifestURL))
        XCTAssertFalse(recorder.contains(archiveURL))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: root.appendingPathComponent(".staging").path
        ), [])
    }

    private var placeholderAssets: [String: LynxChangedAsset] {
        ["main.lynx.bundle": .init(fileHash: String(repeating: "a", count: 64),
                                   file: .init(url: url("main")))]
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
        let request = LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: String(repeating: "b", count: 64),
            assets: placeholderAssets,
            archiveUrl: archiveURL)
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
            LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: String(repeating: "a", count: 64),
            assets: [:],
            archiveUrl: url("archive")),
            LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: String(repeating: "a", count: 64),
            assets: [
                    "../escape": .init(
                        fileHash: String(repeating: "b", count: 64),
                        file: .init(url: url("escape"))
                    ),
                ]),
            LynxArtifactRequest(bundleId: targetBundleId,
            manifestUrl: manifestURL,
            manifestFileHash: String(repeating: "a", count: 64),
            assets: [
                    "main.lynx.bundle": .init(
                        fileHash: String(repeating: "b", count: 64),
                        file: .init(url: url("main"), compression: "gzip")
                    ),
                ]),
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

    func testArchiveOnlyRequestIsRejectedEvenWithManifestTrustToken() throws {
        let hash = String(repeating: "a", count: 64)
        XCTAssertThrowsError(try LynxArtifactRequest(bundleId: targetBundleId,
            manifestFileHash: hash,
            archiveUrl: url("archive")).validate())
        XCTAssertThrowsError(try LynxArtifactRequest(bundleId: targetBundleId,
            manifestFileHash: hash).validate())
    }

    func testAuthenticatedBulkArchiveAndFallbackKeepTheSameManifestAuthority() async throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: package.deletingLastPathComponent().appendingPathComponent("test-utils/fixtures/lynx/manifest-v1-bulk.json"))) as! [String: Any]
        let fixture = fixtures["ios"] as! [String: Any]
        let id = fixture["bundleId"] as! String
        let files = (fixture["files"] as! [String: String]).mapValues { Data(base64Encoded: $0)! }
        for mode in ["valid", "corrupt-transfer", "wrong-tar-size", "embedded-manifest", "corrupt-original"] {
            let root = temporaryRoot()
            defer { try? FileManager.default.removeItem(at: root) }
            let archives = fixture["archives"] as! [String: [String: Any]]
            let bulk = archives[mode == "embedded-manifest" ? "embeddedManifest" : "valid"]!
            let archiveBytes = Data(base64Encoded: bulk["bytes"] as! String)!
            let assets = files.mapValues { bytes in
                ["fileHash": hash(bytes), "byteSize": bytes.count,
                 "downloadFileHash": hash(bytes), "downloadByteSize": bytes.count] as [String: Any]
            }
            let manifest = try JSONSerialization.data(withJSONObject: [
                "bundleId": id, "assets": assets,
                "archive": ["downloadFileHash": hash(archiveBytes), "downloadByteSize": archiveBytes.count,
                            "tarByteSize": (bulk["tarByteSize"] as! Int) + (mode == "wrong-tar-size" ? 1 : 0)],
            ], options: [.sortedKeys])
            let manifestURL = url("bulk-manifest")
            let archiveURL = url("bulk-archive")
            let descriptors = files.mapValues { LynxChangedAsset(fileHash: hash($0)) }
            let originalURLs = Dictionary(uniqueKeysWithValues: files.keys.map { ($0, url("original/" + $0)) })
            let request = LynxArtifactRequest(bundleId: id, manifestUrl: manifestURL, manifestFileHash: hash(manifest),
                assets: descriptors.map { name, descriptor in
                    (name, LynxChangedAsset(fileHash: descriptor.fileHash, file: .init(url: originalURLs[name]!)))
                }.reduce(into: [:]) { $0[$1.0] = $1.1 }, archiveUrl: archiveURL)
            var payloads = Dictionary(uniqueKeysWithValues: files.map { (originalURLs[$0.key]!, $0.value) })
            payloads[manifestURL] = manifest
            var transferred = archiveBytes
            if mode == "corrupt-transfer" || mode == "corrupt-original" { transferred[0] ^= 1 }
            payloads[archiveURL] = transferred
            if mode == "corrupt-original" { payloads[originalURLs["main.lynx.bundle"]!] = Data(repeating: 0, count: files["main.lynx.bundle"]!.count) }
            let recorder = FetchRecorder()
            let installer = try LynxArtifactInstaller(root: root,
                configuration: .init(runtimeId: fixture["runtimeId"] as! String),
                fetch: fetcher(payloads, recorder: recorder))
            if mode == "corrupt-original" {
                do { _ = try await installer.prepare(request); XCTFail("Corrupt original accepted") }
                catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "FILE_HASH_MISMATCH") }
                XCTAssertTrue(recorder.contains(originalURLs["main.lynx.bundle"]!))
                XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
            } else {
                let prepared = try await installer.prepare(request)
                if case .archive = prepared.delivery { XCTAssertEqual(mode, "valid") }
                else { XCTAssertNotEqual(mode, "valid") }
                let installed = try installer.commit(prepared) { publish in _ = try publish() }
                for (path, bytes) in files {
                    XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent(path)), bytes, "\(mode)/\(path)")
                    XCTAssertEqual(recorder.contains(originalURLs[path]!), mode != "valid", "\(mode)/\(path)")
                }
                XCTAssertEqual(installed.manifestDigest, hash(manifest))
            }
            XCTAssertTrue(recorder.contains(archiveURL), "\(mode) must exercise bulk transport")
            XCTAssertEqual(recorder.maximumBytes(for: archiveURL), UInt64(archiveBytes.count))
        }
    }

    func testWireDescriptorStillRequiresFileHashAndNestedFileURL() throws {
        let hash = String(repeating: "a", count: 64)
        let complete = """
        {
          "bundleId":"\(targetBundleId)",
          "artifactProtocolVersion":1,
          "manifestUrl":"https://artifacts.test/manifest",
          "manifestFileHash":"\(hash)",
          "assets":{
            "main.lynx.bundle":{
              "fileHash":"\(hash)",
              "file":{"url":"https://artifacts.test/main"},
              "patch":null
            }
          }
        }
        """
        let decoded = try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: Data(complete.utf8)
        )
        XCTAssertNoThrow(try decoded.validate())

        var missingFileHashObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(complete.utf8)) as? [String: Any]
        )
        var changedAssets = missingFileHashObject["assets"] as! [String: Any]
        var main = changedAssets["main.lynx.bundle"] as! [String: Any]
        main.removeValue(forKey: "fileHash")
        changedAssets["main.lynx.bundle"] = main
        missingFileHashObject["assets"] = changedAssets
        XCTAssertThrowsError(try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: JSONSerialization.data(withJSONObject: missingFileHashObject)
        ))

        var missingURLObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(complete.utf8)) as? [String: Any]
        )
        changedAssets = missingURLObject["assets"] as! [String: Any]
        main = changedAssets["main.lynx.bundle"] as! [String: Any]
        main["file"] = [:]
        changedAssets["main.lynx.bundle"] = main
        missingURLObject["assets"] = changedAssets
        XCTAssertThrowsError(try JSONDecoder().decode(
            LynxArtifactRequest.self,
            from: JSONSerialization.data(withJSONObject: missingURLObject)
        ))
    }
}
