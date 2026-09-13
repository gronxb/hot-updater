import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class ArtifactInstallerTests: XCTestCase {
    private let profile = "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2"
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
        XCTAssertEqual(installed.files.count, 6)
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

    func testConfiguredSignatureAndNullableManifestPolicy() async throws {
        let key = try publicKey()
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile, publicKeyPEM: key))
        let signed = try await receipt("react-ios-signed")
        XCTAssertNil(signed.manifestFileHash)
        let prepared = try await installer.prepare(signed)
        let installed = try installer.commit(prepared, finalize: { _ = try $0() })
        let original = try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry))
        do { _ = try await installer.prepare(try await receipt()); XCTFail("Unsigned archive accepted with a configured key") }
        catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "UNSIGNED_NOT_ALLOWED") }
        let plainManifest = LynxArtifactRequest(bundleId: signed.bundleId, fileUrl: signed.fileUrl, fileHash: signed.fileHash, manifestFileHash: installed.manifestDigest)
        do { _ = try await installer.prepare(plainManifest); XCTFail("Supplied unsigned manifest token accepted with configured key") }
        catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "UNSIGNED_NOT_ALLOWED") }
        let corruptSignature = LynxArtifactRequest(bundleId: signed.bundleId, fileUrl: signed.fileUrl, fileHash: "sig:AAAA")
        do { _ = try await installer.prepare(corruptSignature); XCTFail("Invalid signature accepted") }
        catch let error as SignatureVerificationError { XCTAssertEqual(error.errorCodeString, "SIGNATURE_VERIFICATION_FAILED") }
        XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry)), original)
    }

    func testStoreLeaseAndAbandonedPreparationCleanup() async throws {
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        var installer: LynxArtifactInstaller? = try .init(root: root, configuration: .init(runtimeId: profile))
        XCTAssertThrowsError(try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile)))
        let prepared = try await installer!.prepare(try await receipt())
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path).isEmpty)
        installer = nil // Equivalent released owner lease; simulator separately tests actual process termination.
        let next = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [])
        XCTAssertThrowsError(try next.commit(prepared, finalize: { _ = try $0() }))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("bundles").path), [])
    }
    func testMalformedHTTPArtifactsNeverReplaceConfirmedTree() async throws {
        struct Fixture: Decodable { let name: String; let request: LynxArtifactRequest }
        guard let origin = ProcessInfo.processInfo.environment["LYNX_ARTIFACT_TEST_ORIGIN"] else { throw XCTSkip("Requires HTTP negative fixtures") }
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(origin)/files/qa/ios/index.json")!)
        let fixtures = try JSONDecoder().decode([Fixture].self, from: data)
        XCTAssertGreaterThan(fixtures.count, 20)
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        let good = try await installer.prepare(try await receipt())
        let installed = try installer.commit(good, finalize: { _ = try $0() })
        let original = try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry))
        for fixture in fixtures {
            do { _ = try await installer.prepare(fixture.request); XCTFail("Accepted negative fixture \(fixture.name)") }
            catch {
                print("Rejected \(fixture.name): \(error.localizedDescription)")
                let expected = ["pax-short": "PAX record", "pax-overflow": "PAX record", "oversized-sidecar": "Metadata size", "oversized-manifest": "Metadata size", "duplicate-entry-key": "Duplicate", "duplicate-bundle-key": "Duplicate", "duplicate-asset-hash-key": "Duplicate", "deep-sidecar": "depth", "zip-count-limit": "entry count", "zip-name-limit": "path length"]
                if let fragment = expected[fixture.name] { XCTAssertTrue(error.localizedDescription.contains(fragment), "\(fixture.name) failed before its intended validation: \(error)") }
            }
            XCTAssertEqual(try Data(contentsOf: installed.directory.appendingPathComponent(installed.entry)), original, fixture.name)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".staging").path), [], fixture.name)
        }
    }

    func testRealSignedCLITarFormats() async throws {
        let key = try publicKey()
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile, publicKeyPEM: key))
        for name in ["react-ios-B-external2-managed-tar-gz-signed", "react-ios-B-external2-managed-tar-br-signed"] {
            let request = try await receipt(name)
            let prepared = try await installer.prepare(request)
            let installed = try installer.commit(prepared, finalize: { _ = try $0() })
            XCTAssertEqual(installed.files.count, 6)
            XCTAssertEqual(installed.bundleId, request.bundleId)
        }
    }

    func testInterruptedAndCanceledHTTPPreparationsStayPrivate() async throws {
        let request = try await receipt()
        let suffix = try XCTUnwrap(request.fileUrl).path.replacingOccurrences(of: "/files/", with: "")
        let root = temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let installer = try LynxArtifactInstaller(root: root, configuration: .init(runtimeId: profile))
        let truncated = LynxArtifactRequest(bundleId: request.bundleId, fileUrl: URL(string: "http://127.0.0.1:18792/qa/truncated/\(suffix)")!, fileHash: request.fileHash)
        do { _ = try await installer.prepare(truncated); XCTFail("Truncated HTTP body accepted") }
        catch { print("Truncated HTTP rejected: \(error.localizedDescription)") }
        let slow = LynxArtifactRequest(bundleId: request.bundleId, fileUrl: URL(string: "http://127.0.0.1:18792/qa/slow/\(suffix)")!, fileHash: request.fileHash)
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
