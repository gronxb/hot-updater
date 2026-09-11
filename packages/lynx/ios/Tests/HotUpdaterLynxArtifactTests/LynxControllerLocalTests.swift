import CryptoKit
import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxControllerLocalTests: XCTestCase {
    private let runtime = "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    private let embeddedId = "00000000-0000-0000-0000-000000000000"
    private let bundleB = "01900000-0000-7000-8000-000000000020"
    private let bundleC = "01900000-0000-7000-8000-000000000030"
    private let releaseB = "01900000-0000-7000-8000-000000000120"
    private let releaseC = "01900000-0000-7000-8000-000000000130"
    private let releaseD = "01900000-0000-7000-8000-000000000140"
    private let channel = "ota-react"
    private let catalogId = "lynx-local-catalog"
    private var catalogHash: String { "sha256:" + String(repeating: "a", count: 64) }
    private var scopeKey: String { "v1:app-version:ios:b3RhLXJlYWN0" }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func catalogKey() -> String { hash(Data((catalogId + "\u{0}" + scopeKey).utf8)) }

    @discardableResult
    private func writeTree(at directory: URL, bundleId: String, marker: String) throws -> String {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let metadataObject: [String: Any] = [
            "schemaVersion": 1, "bundleId": bundleId, "platform": "ios",
            "entry": "main.lynx.bundle", "runtimeId": runtime,
        ]
        let metadata = try JSONSerialization.data(withJSONObject: metadataObject, options: [.sortedKeys]) + Data("\n".utf8)
        let files: [String: Data] = [
            "main.lynx.bundle": Data("entry-\(marker)".utf8),
            "assets/probe.png": Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]),
            "assets/probe.ttf": Data("FONT-\(marker)".utf8),
            "assets/bootstrap.js": Data("js-\(marker)".utf8),
            "dynamic/component.lynx.bundle": Data("dyn-\(marker)".utf8),
            "hot-updater-lynx.json": metadata,
        ]
        var assets: [String: [String: String]] = [:]
        for (name, bytes) in files {
            let file = directory.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: file)
            assets[name] = ["fileHash": hash(bytes)]
        }
        let manifest = try JSONSerialization.data(withJSONObject: ["bundleId": bundleId, "assets": assets], options: [.sortedKeys])
        try manifest.write(to: directory.appendingPathComponent("manifest.json"))
        return hash(manifest)
    }

    private func configuration(root: URL, embedded: URL, digest: String, resources: Set<String> = []) -> LynxControllerConfiguration {
        LynxControllerConfiguration(
            root: root, runtimeId: runtime, binaryIdentity: "local-binary-v1",
            embeddedDirectory: embedded, embeddedBundleId: embeddedId, embeddedManifestDigest: digest,
            minimumBundleId: embeddedId, appVersion: "1.0.0", channel: channel, cohort: "1",
            startupResourcePaths: resources)
    }

    private func home(_ root: URL) throws -> URL {
        let dirs = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        return try XCTUnwrap(dirs.first)
    }

    private func catalogJSON(releases: [(String, String)]) throws -> Data {
        let descriptors: [[String: Any]] = releases.map { release, bundle in
            ["releaseId": release, "kind": "BUNDLE", "bundleId": bundle, "rolloutCohortCount": 1000,
             "targetCohorts": [String](), "shouldForceUpdate": false, "message": NSNull()]
        }
        return try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1, "catalogId": catalogId, "scopeKey": scopeKey, "generation": 2,
            "catalogHash": catalogHash, "fallbackPolicy": "BUILTIN_IF_ACTIVE_INELIGIBLE",
            "releases": descriptors, "rollbackReleases": descriptors,
        ], options: [.sortedKeys])
    }

    private func receipt(releaseId: String, bundleId: String, contextHash: String) -> LynxPolicyReceipt {
        LynxPolicyReceipt(kind: "BUNDLE", releaseId: releaseId, bundleId: bundleId, catalogId: catalogId,
            scopeKey: scopeKey, generation: 2, catalogHash: catalogHash, channel: channel,
            selectionContextHash: contextHash)
    }

    private func plantNext(_ config: LynxControllerConfiguration, releaseId: String, bundleId: String, marker: String) throws {
        let store = try home(config.root)
        let digest = try writeTree(at: store.appendingPathComponent("bundles/\(bundleId)"), bundleId: bundleId, marker: marker)
        let journal = LynxControllerJournal(file: store.appendingPathComponent("state.json"))
        var state = try journal.load()
        let snapshot = LynxPolicySnapshot(
            revision: state.revision, platform: "ios", appVersion: config.appVersion, channel: channel,
            embeddedBundleId: embeddedId, minimumBundleId: embeddedId, cohort: config.cohort,
            runningSelection: receipt(releaseId: releaseId, bundleId: bundleId, contextHash: "v1:0000000000000000"),
            nextSelection: nil, crashedBundleIds: state.crashedBundleIds, unconfirmedReleaseIds: state.unconfirmedReleaseIds)
        let contextHash = LynxCatalogPolicy.contextHash(snapshot: snapshot)
        let selected = receipt(releaseId: releaseId, bundleId: bundleId, contextHash: contextHash)
        state.next = try LynxStoredSelection(selected, manifestDigest: digest)
        state.installedDigests[bundleId] = digest
        state.catalogs[catalogKey()] = try catalogJSON(releases: [(releaseId, bundleId)])
        state.highWater[catalogKey()] = LynxStoredHighWater(generation: 2, hash: catalogHash)
        try journal.save(state)
    }

    private func confirm(_ controller: LynxController, _ context: LynxLaunchContext, resource: String? = nil) throws {
        if let resource { try controller.observedResource(resource, context: context) }
        try controller.observedContent(context)
        var result: String?
        controller.notifyAppReady(context) { result = try? $0.get() }
        XCTAssertEqual(result, "CONFIRMED")
    }

    func testBuiltinLaunchConfirmsWithoutRecordingAPendingAttempt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        let context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        try confirm(controller!, context)
        let state = try controller!.getState(context)
        XCTAssertEqual(state["runningConfirmed"] as? Bool, true)
        XCTAssertEqual(state["unconfirmedReleaseIds"] as? [String], [])
        XCTAssertTrue(state["nextSelection"] is NSNull)
        controller = nil
        controller = try LynxController(configuration: config)
        let restarted = controller!.createContext(primary: true)
        _ = try controller!.begin(restarted)
        XCTAssertEqual(try controller!.getState(restarted)["runningConfirmed"] as? Bool, true)
        XCTAssertEqual(controller!.runningSelection.kind, "BUILTIN")
    }

    func testSecondaryCannotEvaluateBeforePrimaryAndCannotConfirm() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let controller = try LynxController(configuration: configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest))
        let secondary = controller.createContext(primary: false)
        XCTAssertThrowsError(try controller.begin(secondary))
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        _ = try controller.begin(secondary)
        var rejected = false
        controller.notifyAppReady(secondary) { if case .failure = $0 { rejected = true } }
        XCTAssertTrue(rejected)
        XCTAssertThrowsError(try controller.observedContent(secondary))
    }

    func testManagedResourceMissFailsClosedWithoutReadingEmbeddedFallback() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest,
            resources: ["assets/probe.png"])
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        XCTAssertThrowsError(try controller.resource("hot-updater:///missing.png", context: context))
        XCTAssertThrowsError(try controller.resource("file:///tmp/outside.png", context: context))
        let bytes = try controller.resource("hot-updater:///main.lynx.bundle", context: context)
        XCTAssertEqual(bytes, Data("entry-A".utf8))
        try controller.observedResource("assets/probe.png", context: context)
        try confirm(controller, context, resource: nil)
        XCTAssertEqual(try controller.getState(context)["runningConfirmed"] as? Bool, true)
    }

    func testCompatibilityMismatchIsRejectedBeforeTheTreeIsRunnable() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = root.appendingPathComponent("tree")
        _ = try writeTree(at: tree, bundleId: bundleB, marker: "B")
        XCTAssertThrowsError(try VerifiedLynxTree.verify(
            at: tree, bundleId: bundleB, manifestToken: nil,
            configuration: .init(runtimeId: "other-runtime"))) { error in
            guard case LynxArtifactError.incompatible = error else {
                return XCTFail("Expected incompatible, got \(error)")
            }
        }
        XCTAssertNoThrow(try VerifiedLynxTree.verify(
            at: tree, bundleId: bundleB, manifestToken: nil,
            configuration: .init(runtimeId: runtime)))
    }

    func testRestoredTreeWithWrongManifestDigestIsNotSelected() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let store = try home(config.root)
        let journal = LynxControllerJournal(file: store.appendingPathComponent("state.json"))
        var state = try journal.load()
        state.next = try LynxStoredSelection(state.next!.policy, manifestDigest: String(repeating: "0", count: 64))
        try journal.save(state)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(controller!.runningSelection.kind, "BUILTIN")
    }

    func testUnconfirmedBThenCCannotReenableB() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)

        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleB)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(try controller!.getState(context)["unconfirmedReleaseIds"] as? [String], [releaseB])

        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleC)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        let recovered = try controller!.getState(context)
        XCTAssertEqual(controller!.runningSelection.bundleId, embeddedId)
        XCTAssertEqual(Set(recovered["unconfirmedReleaseIds"] as! [String]), Set([releaseB, releaseC]))
        XCTAssertEqual(recovered["crashedBundleIds"] as? [String], [])

        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(Set(try controller!.getState(context)["unconfirmedReleaseIds"] as! [String]), Set([releaseB, releaseC]))
    }

    func testFreshAuthorizedReleaseRetriesCachedBytesWithoutInheritingReadiness() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleB)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        XCTAssertEqual(try controller!.getState(context)["unconfirmedReleaseIds"] as? [String], [releaseB])

        try plantNext(config, releaseId: releaseD, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        let launched = try controller!.begin(context)
        XCTAssertEqual(launched.bundleId, bundleB)
        XCTAssertEqual(controller!.runningSelection.releaseId, releaseD)
        XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, false)
        XCTAssertEqual(String(data: try controller!.resource("hot-updater:///main.lynx.bundle", context: context), encoding: .utf8), "entry-B")
    }

    func testFatalBundleFailureIsDistinctFromUnconfirmedExclusion() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try controller!.reportFailure(context, fatal: true)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        let recovered = try controller!.getState(context)
        XCTAssertEqual(controller!.runningSelection.bundleId, embeddedId)
        XCTAssertEqual(recovered["crashedBundleIds"] as? [String], [bundleB])
        XCTAssertEqual(recovered["unconfirmedReleaseIds"] as? [String], [])
    }

    func testDurableConfirmationFailureDoesNotAdoptTheCandidate() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let file = try home(config.root).appendingPathComponent("state.json")
        let backup = file.appendingPathExtension("backup")
        try FileManager.default.moveItem(at: file, to: backup)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        var failures = 0
        controller!.notifyAppReady(context) { if case .failure = $0 { failures += 1 } }
        XCTAssertEqual(failures, 0)
        XCTAssertThrowsError(try controller!.observedContent(context))
        XCTAssertEqual(failures, 1)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: backup, to: file)
        try controller!.observedResource("assets/probe.png", context: context)
        XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, false)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(try controller!.getState(context)["unconfirmedReleaseIds"] as? [String], [releaseB])
    }

    func testCapacityRefusesANewUnconfirmedAttemptAndKeepsConfirmed() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        let store = try home(config.root)
        let journal = LynxControllerJournal(file: store.appendingPathComponent("state.json"))
        var state = try journal.load()
        state.unconfirmedReleaseIds = (0..<128).map { index in
            "01900000-0000-7000-8000-" + String(format: "%012x", 200 + index)
        }
        try journal.save(state)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, true)
        XCTAssertEqual((try controller!.getState(context)["unconfirmedReleaseIds"] as! [String]).count, 128)
    }

    func testDestroyedPrimaryCannotConfirmAStaleReady() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let controller = try LynxController(configuration: configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest))
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try controller.observedContent(context)
        controller.destroy(context)
        var rejected = false
        controller.notifyAppReady(context) { if case .failure = $0 { rejected = true } }
        XCTAssertTrue(rejected)
        XCTAssertThrowsError(try controller.getState(context))
    }

    func testIncompleteInstalledTreeNeverBecomesActive() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let payload = try home(config.root).appendingPathComponent("bundles/\(bundleB)/main.lynx.bundle")
        try FileManager.default.removeItem(at: payload)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(controller!.runningSelection.kind, "BUILTIN")
    }

    func testCohortChangeDoesNotClearReleaseExclusions() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        controller = nil
        let cohortChanged = LynxControllerConfiguration(
            root: config.root, runtimeId: config.runtimeId, binaryIdentity: config.binaryIdentity,
            embeddedDirectory: config.embeddedDirectory, embeddedBundleId: config.embeddedBundleId,
            embeddedManifestDigest: config.embeddedManifestDigest, minimumBundleId: config.minimumBundleId,
            appVersion: config.appVersion, channel: config.channel, cohort: "2")
        controller = try LynxController(configuration: cohortChanged)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        XCTAssertEqual(try controller!.getState(context)["cohort"] as? String, "2")
        XCTAssertEqual(try controller!.getState(context)["unconfirmedReleaseIds"] as? [String], [releaseB])
        XCTAssertEqual(controller!.runningSelection.bundleId, embeddedId)
    }
}
