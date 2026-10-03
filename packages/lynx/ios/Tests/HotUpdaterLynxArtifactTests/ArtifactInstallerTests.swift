import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class ArtifactInstallerTests: XCTestCase {
    private let profile = "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"
    private let expectedFiles: Set<String> = [
        "assets/OFL.txt", "assets/bootstrap.js", "assets/probe.png", "assets/probe.ttf",
        "detail.lynx.bundle", "dynamic/component.lynx.bundle", "hot-updater-lynx.json", "main.lynx.bundle",
    ]
    private func temporaryRoot() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("lynx-artifact-tests-\(UUID().uuidString)") }
    private func receipt(_ name: String = "react-ios") async throws -> LynxArtifactRequest {
        guard let origin = ProcessInfo.processInfo.environment["LYNX_ARTIFACT_TEST_ORIGIN"] else { throw XCTSkip("Requires task-owned real CLI artifact service") }
        let (data, response) = try await URLSession.shared.data(from: URL(string: "\(origin)/receipts/\(name).json")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(LynxArtifactRequest.self, from: data)
    }
    private func publicKey() throws -> String {
        guard let file = ProcessInfo.processInfo.environment["LYNX_ARTIFACT_TEST_PUBLIC_KEY"] else { throw XCTSkip("Requires fixed native test public key") }
        return try String(contentsOfFile: file)
    }

    func testNativeRuntimeIdentityMustBeConfiguredBeforeCreatingStore() throws {
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        for invalid in ["", " \n\t"] {
            XCTAssertThrowsError(try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: invalid)))
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        }
        XCTAssertEqual(LynxArtifactConfiguration(runtimeId: profile).platform, "ios")
    }

    func testRealHTTPPreparationRequiresLockedFinalizationAndRetainsImmutableBytes() async throws {
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        let request = try await receipt()
        let prepared = try await installer.prepare(request)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("bundles").path), [])
        XCTAssertThrowsError(try installer.commit(prepared, finalize: { _ in }))
        enum Revoked: Error { case stale }
        XCTAssertThrowsError(try installer.commit(prepared, finalize: { _ in throw Revoked.stale }))
        let stateLock = NSLock()
        var selected: String?
        let installed = try installer.commit(prepared) { publish in
            stateLock.lock(); defer { stateLock.unlock() }
            XCTAssertNil(selected)
            selected = try publish().bundleId
        }
        XCTAssertEqual(installed.bundleId, request.bundleId)
        XCTAssertEqual(selected, request.bundleId)
        XCTAssertEqual(Set(installed.files.keys), expectedFiles)
        XCTAssertEqual(installed.pageEntries, ["detail.lynx.bundle", "main.lynx.bundle"])
        XCTAssertThrowsError(try installer.commit(prepared, finalize: { _ = try $0() }))
        let original = try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry))
        async let one = installer.prepare(request)
        async let two = installer.prepare(request)
        let tokens = try await [one, two]
        let first = try installer.commit(tokens[0], finalize: { _ = try $0() })
        let second = try installer.commit(tokens[1], finalize: { _ = try $0() })
        XCTAssertEqual(first.directory, second.directory)
        XCTAssertEqual(try Data(contentsOf: first.directory.appendingPathComponent(first.entry)), original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
    }

    func testConfiguredSignatureRequiresSignedManifest() async throws {
        let key = try publicKey()
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile, publicKeyPEM: key))
        let signed = try await receipt("react-ios-signed")
        XCTAssertTrue(signed.manifestFileHash?.hasPrefix("sig:") == true)
        let prepared = try await installer.prepare(signed)
        let installed = try installer.commit(prepared, finalize: { _ = try $0() })
        let original = try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry))
        do { _ = try await installer.prepare(try await receipt()); XCTFail("Unsigned manifest accepted with a configured key") }
        catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "UNSIGNED_NOT_ALLOWED") }
        let plainManifest = LynxArtifactRequest(bundleId: signed.bundleId,
            manifestUrl: signed.manifestUrl,
            manifestFileHash: installed.manifestDigest,
            assets: signed.assets,
            archiveUrl: signed.archiveUrl)
        do { _ = try await installer.prepare(plainManifest); XCTFail("Supplied unsigned manifest token accepted with configured key") }
        catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "UNSIGNED_NOT_ALLOWED") }
        let corruptSignature = LynxArtifactRequest(bundleId: signed.bundleId,
            manifestUrl: signed.manifestUrl,
            manifestFileHash: "sig:AAAA",
            assets: signed.assets,
            archiveUrl: signed.archiveUrl)
        do { _ = try await installer.prepare(corruptSignature); XCTFail("Invalid signature accepted") }
        catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "SIGNATURE_VERIFICATION_FAILED") }
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry)), original)
    }

    func testStoreLeaseAndAbandonedPreparationCleanup() async throws {
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        var installer: LynxArtifactInstaller? = try .init(root: root, configuration: .init(runtimeId: profile))
        XCTAssertThrowsError(try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile)))
        var prepared: LynxPreparedArtifact? = try await installer!.prepare(try await receipt())
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path).isEmpty)
        installer = nil
        let next = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        // A live preparation retains its own lease across store-owner replacement.
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path).isEmpty)
        XCTAssertThrowsError(try next.commit(try XCTUnwrap(prepared), finalize: { _ = try $0() }))
        prepared = nil
        next.close()
        let reopened = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        defer { reopened.close() }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("bundles").path), [])
    }
    func testMalformedHTTPArtifactsNeverReplaceConfirmedTree() async throws {
        struct Fixture: Decodable { let name: String; let request: LynxArtifactRequest }
        guard let origin = ProcessInfo.processInfo.environment["LYNX_ARTIFACT_TEST_ORIGIN"] else { throw XCTSkip("Requires HTTP negative fixtures") }
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(origin)/files/qa/ios/index.json")!)
        let fixtures = try JSONDecoder().decode([Fixture].self, from: data)
        let expectedRejections = [
            "duplicate-bundle-key": "Duplicate or invalid metadata JSON key",
            "duplicate-asset-hash-key": "Duplicate or invalid metadata JSON key",
            "deep-manifest": "Metadata JSON depth limit exceeded",
            "oversized-manifest": "Artifact download exceeds limit",
            "manifest-bundle-mismatch": "Manifest transfer identity or coverage mismatch",
            "missing-sidecar": "Manifest transfer identity or coverage mismatch",
            "descriptor-coverage": "Target descriptors do not exactly cover the manifest",
            "descriptor-hash-mismatch": "Target descriptor or transfer metadata differs from manifest",
            "duplicate-entry-key": "Duplicate or invalid metadata JSON key",
            "duplicate-sidecar-bundle-key": "Duplicate or invalid metadata JSON key",
            "deep-sidecar": "Metadata JSON depth limit exceeded",
            "oversized-sidecar": "Metadata size/type limit exceeded",
            "wrong-platform": "INCOMPATIBLE: Lynx platform or runtime identity mismatch",
            "wrong-runtime": "INCOMPATIBLE: Lynx platform or runtime identity mismatch",
            "missing-page": "Invalid pageEntries membership",
            "corrupt-original-after-archive": "File hash verification failed",
        ]
        let expectedFallbacks: Set<String> = [
            "pax-short", "pax-overflow", "path-traversal", "absolute-path", "symlink",
            "duplicate-entry", "unlisted-entry", "truncated-tar", "bad-checksum",
            "corrupt-transfer", "unsupported-zip", "unsupported-gzip",
        ]
        let expectedNames = Set(expectedRejections.keys).union(expectedFallbacks)
        XCTAssertEqual(Set(fixtures.map(\.name)), expectedNames)
        XCTAssertEqual(fixtures.count, expectedNames.count, "Duplicate or missing negative fixture")
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        let good = try await installer.prepare(try await receipt())
        let installed = try installer.commit(good, finalize: { _ = try $0() })
        let originals = try Dictionary(uniqueKeysWithValues: expectedFiles.union(["manifest.json"]).map {
            ($0, try Data(contentsOf: installed.directory.appendingPathComponent($0)))
        })
        let bundles = root.appendingPathComponent("bundles")
        let published = try FileManager.default.contentsOfDirectory(atPath: bundles.path).sorted()
        var rejections: [String: String] = [:]
        var fallbacks: Set<String> = []
        for fixture in fixtures {
            do {
                let prepared = try await installer.prepare(fixture.request)
                // Only an optional transport may fail open to authenticated originals.
                // A valid tree alone cannot prove which delivery path was exercised.
                if case .manifest(_, _, let patchedAssets) = prepared.delivery {
                    XCTAssertTrue(patchedAssets.isEmpty, fixture.name)
                    fallbacks.insert(fixture.name)
                } else {
                    XCTFail("Malformed bulk was accepted as an archive: \(fixture.name)")
                }
                XCTAssertEqual(prepared.tree.files, installed.files, fixture.name)
                XCTAssertEqual(prepared.tree.pageEntries, installed.pageEntries, fixture.name)
                let (countsData, response) = try await URLSession.shared.data(from:
                    URL(string: "\(origin)/negative/\(fixture.name)/requests")!)
                XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                let counts = try JSONDecoder().decode([String: Int].self, from: countsData)
                var expectedCounts = Dictionary(uniqueKeysWithValues: expectedFiles.map { ("original/" + $0, 1) })
                expectedCounts["manifest"] = 1
                expectedCounts["archive"] = 1
                XCTAssertEqual(counts, expectedCounts, fixture.name)
                try installer.discard(prepared)
            } catch {
                rejections[fixture.name] = error.localizedDescription
            }
            for (name, bytes) in originals {
                XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent(name)), bytes, fixture.name + ": " + name)
            }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundles.path).sorted(), published, fixture.name)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [], fixture.name)
        }
        XCTAssertEqual(rejections, expectedRejections, "Each rejection must reach its intended validation")
        XCTAssertEqual(fallbacks, expectedFallbacks, "Every malformed bulk must use verified originals")
    }

    func testRealSignedCLIBulkArchive() async throws {
        let key = try publicKey()
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile, publicKeyPEM: key))
        for name in ["react-ios-B-external2-managed-tar-br-signed"] {
            let request = try await receipt(name)
            let prepared = try await installer.prepare(request)
            let installed = try installer.commit(prepared, finalize: { _ = try $0() })
            XCTAssertEqual(Set(installed.files.keys), expectedFiles)
            XCTAssertEqual(installed.pageEntries, ["detail.lynx.bundle", "main.lynx.bundle"])
            XCTAssertEqual(installed.bundleId, request.bundleId)
        }
    }

    func testInterruptedAndCanceledHTTPPreparationsStayPrivate() async throws {
        let request = try await receipt()
        let origin = try XCTUnwrap(ProcessInfo.processInfo.environment["LYNX_ARTIFACT_TEST_ORIGIN"])
        let suffix = try XCTUnwrap(request.manifestUrl).path.replacingOccurrences(of: "/files/", with: "")
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        let truncated = LynxArtifactRequest(bundleId: request.bundleId,
            manifestUrl: URL(string: "\(origin)/qa/truncated/\(suffix)")!,
            manifestFileHash: request.manifestFileHash,
            assets: request.assets,
            archiveUrl: request.archiveUrl)
        do { _ = try await installer.prepare(truncated); XCTFail("Truncated HTTP body accepted") }
        catch { print("Truncated HTTP rejected: \(error.localizedDescription)") }
        let slow = LynxArtifactRequest(bundleId: request.bundleId,
            manifestUrl: URL(string: "\(origin)/qa/slow/\(suffix)")!,
            manifestFileHash: request.manifestFileHash,
            assets: request.assets,
            archiveUrl: request.archiveUrl)
        let operation = Task { try await installer.prepare(slow) }
        try await Task.sleep(nanoseconds: 800_000_000)
        operation.cancel()
        do { _ = try await operation.value; XCTFail("Canceled HTTP preparation accepted") }
        catch is CancellationError { }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("bundles").path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
    }

    func testCleanupRetainsLivePreparationsAndOnlyRemovesUnleasedTrees() async throws {
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        let first = try await installer.prepare(try await receipt("react-ios"))
        let running = try installer.commit(first, finalize: { _ = try $0() })
        let request = try await receipt("vue-ios")
        let next = try await installer.prepare(request)
        let unused = try installer.commit(next, finalize: { _ = try $0() })
        let lease = try await installer.prepare(request)
        XCTAssertEqual(try installer.pruneInstalled(keeping: [running.bundleId]), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: unused.directory.path))
        try installer.discard(lease)
        XCTAssertEqual(try installer.pruneInstalled(keeping: [running.bundleId]), [unused.bundleId])
        XCTAssertTrue(FileManager.default.fileExists(atPath: running.directory.appendingPathComponent(running.entry).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: unused.directory.path))
    }

}
