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

    private actor FetchGate {
        private var released = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            guard !released else { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        func release() {
            released = true
            let pending = waiters
            waiters.removeAll()
            pending.forEach { $0.resume() }
        }
    }

    private final class SyncFailureRecorder {
        private let lock = NSLock()
        private(set) var calls = 0

        func fail(_ directory: URL) throws {
            lock.lock()
            calls += 1
            lock.unlock()
            throw POSIXError(.EIO)
        }
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func scope(for channel: String) -> String {
        let key = Data(channel.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "v1:app-version:ios:\(key)"
    }
    private func catalogKey(_ scope: String? = nil) -> String {
        hash(Data((catalogId + "\u{0}" + (scope ?? scopeKey)).utf8))
    }

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

    private func snapshot(
        _ controller: LynxController,
        _ context: LynxLaunchContext,
        _ config: LynxControllerConfiguration
    ) throws -> LynxPolicySnapshot {
        let state = try controller.getState(context)
        return LynxPolicySnapshot(
            revision: state["revision"] as! String,
            platform: "ios",
            appVersion: config.appVersion,
            channel: state["channel"] as! String,
            embeddedBundleId: config.embeddedBundleId,
            minimumBundleId: config.minimumBundleId,
            cohort: state["cohort"] as! String,
            runningSelection: controller.runningSelection,
            nextSelection: nil,
            crashedBundleIds: state["crashedBundleIds"] as! [String],
            unconfirmedReleaseIds: state["unconfirmedReleaseIds"] as! [String],
            fingerprintHash: config.fingerprintHash
        )
    }

    private func switchSnapshot(
        _ controller: LynxController,
        _ context: LynxLaunchContext,
        _ config: LynxControllerConfiguration,
        targetChannel: String
    ) throws -> LynxPolicySnapshot {
        let state = try controller.getState(context)
        let minimumBase = LynxPolicyReceipt(
            kind: "BUILTIN", releaseId: nil, bundleId: config.minimumBundleId,
            catalogId: nil, scopeKey: nil, generation: nil, catalogHash: nil,
            channel: targetChannel, selectionContextHash: nil
        )
        return LynxPolicySnapshot(
            revision: state["revision"] as! String,
            platform: "ios",
            appVersion: config.appVersion,
            channel: targetChannel,
            embeddedBundleId: config.embeddedBundleId,
            minimumBundleId: config.minimumBundleId,
            cohort: state["cohort"] as! String,
            runningSelection: minimumBase,
            nextSelection: nil,
            crashedBundleIds: state["crashedBundleIds"] as! [String],
            unconfirmedReleaseIds: state["unconfirmedReleaseIds"] as! [String],
            fingerprintHash: config.fingerprintHash
        )
    }

    private func home(_ root: URL) throws -> URL {
        let dirs = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        return try XCTUnwrap(dirs.first)
    }

    private func catalogJSON(
        releases: [(String, String)],
        kind: String = "BUNDLE",
        generation: Int = 2,
        hash: String? = nil,
        scope: String? = nil
    ) throws -> Data {
        let descriptors: [[String: Any]] = releases.map { release, bundle in
            ["releaseId": release, "kind": kind,
             "bundleId": kind == "EMBEDDED" ? NSNull() : bundle,
             "rolloutCohortCount": 1000,
             "targetCohorts": [String](), "shouldForceUpdate": false, "message": NSNull()]
        }
        return try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1, "catalogId": catalogId, "scopeKey": scope ?? scopeKey, "generation": generation,
            "catalogHash": hash ?? catalogHash, "fallbackPolicy": "BUILTIN_IF_ACTIVE_INELIGIBLE",
            "releases": descriptors, "rollbackReleases": descriptors,
        ], options: [.sortedKeys])
    }

    private func receipt(
        releaseId: String,
        bundleId: String,
        contextHash: String,
        kind: String = "BUNDLE",
        generation: Int64 = 2,
        hash: String? = nil,
        channel: String? = nil,
        scope: String? = nil
    ) -> LynxPolicyReceipt {
        LynxPolicyReceipt(kind: kind, releaseId: releaseId, bundleId: bundleId, catalogId: catalogId,
            scopeKey: scope ?? scopeKey, generation: generation, catalogHash: hash ?? catalogHash,
            channel: channel ?? self.channel,
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
        controller.notifyAppReady(context) { result = try? $0.get().status }
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

    func testFailedConfirmedFallbackAdvancesToEmbeddedRecovery() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "lynx-local-\(UUID().uuidString)"
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(
            at: embedded,
            bundleId: embeddedId,
            marker: "A"
        )
        let config = configuration(
            root: root.appendingPathComponent("store"),
            embedded: embedded,
            digest: digest
        )

        var controller: LynxController? = try LynxController(
            configuration: config
        )
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        controller = nil

        try plantNext(
            config,
            releaseId: releaseB,
            bundleId: bundleB,
            marker: "B"
        )
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleB)
        try confirm(controller!, context)
        controller = nil

        try plantNext(
            config,
            releaseId: releaseC,
            bundleId: bundleC,
            marker: "C"
        )
        let journal = LynxControllerJournal(
            file: try home(config.root).appendingPathComponent("state.json")
        )
        var retained = try journal.load()
        retained.catalogs[catalogKey()] = try catalogJSON(releases: [
            (releaseC, bundleC),
            (releaseB, bundleB),
        ])
        try journal.save(retained)
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleC)
        XCTAssertTrue(try controller!.reportFailure(context, fatal: true))
        controller = nil

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleB)
        XCTAssertTrue(try controller!.reportFailure(
            context,
            fatal: true,
            allowConfirmed: true
        ))
        controller = nil

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
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

    func testCloseDuringPreparationAllowsReplacementAndCannotSaveStaleState() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let started = expectation(description: "artifact fetch started")
        let gate = FetchGate()
        let fetch: LynxArtifactFetch = { _, destination, _, _ in
            started.fulfill()
            await gate.wait()
            guard FileManager.default.fileExists(
                atPath: destination.deletingLastPathComponent().path
            ) else {
                throw LynxArtifactError.invalid("Replacement removed a live preparation")
            }
            throw LynxArtifactError.incompatible
        }
        let controller = try LynxController(configuration: config, artifactFetch: fetch)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let state = try controller.getState(context)
        let snapshot = LynxPolicySnapshot(
            revision: state["revision"] as! String,
            platform: "ios",
            appVersion: config.appVersion,
            channel: channel,
            embeddedBundleId: embeddedId,
            minimumBundleId: embeddedId,
            cohort: config.cohort,
            runningSelection: controller.runningSelection,
            nextSelection: nil,
            crashedBundleIds: [],
            unconfirmedReleaseIds: [],
            fingerprintHash: config.fingerprintHash
        )
        let contextHash = LynxCatalogPolicy.contextHash(snapshot: snapshot, scopeKey: scopeKey)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, bundleB)]),
            expectedRevision: snapshot.revision,
            contextHash: contextHash,
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: bundleB,
            contextHash: guardValue.selectionContextHash
        )
        let request = LynxArtifactRequest(
            bundleId: bundleB,
            fileUrl: URL(string: "https://artifacts.test/bundle.tar.gz")!,
            fileHash: String(repeating: "a", count: 64)
        )
        let preparation = Task {
            try await controller.prepareSelection(
                guard: guardValue,
                receipt: selected,
                artifact: request,
                context: context
            )
        }
        await fulfillment(of: [started], timeout: 1)
        let journal = try home(config.root).appendingPathComponent("state.json")
        let acceptedState = try Data(contentsOf: journal)

        XCTAssertNoThrow(try controller.close())
        XCTAssertNoThrow(try controller.close())
        XCTAssertThrowsError(try controller.getState(context))

        let replacement = try LynxController(configuration: config)
        let replacementContext = replacement.createContext(primary: true)
        _ = try replacement.begin(replacementContext)
        await gate.release()
        do {
            _ = try await preparation.value
            XCTFail("Retired controller retained an in-flight preparation")
        } catch {
            guard case LynxArtifactError.incompatible = error else {
                return XCTFail("Expected incompatible preparation failure, got \(error)")
            }
        }
        XCTAssertEqual(try Data(contentsOf: journal), acceptedState)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: try home(config.root).appendingPathComponent(".staging").path
        ), [])
        XCTAssertNoThrow(try replacement.close())
        XCTAssertNoThrow(try replacement.close())
        _ = try LynxController(configuration: config)
    }

    func testPostRenameDirectorySyncFailureKeepsMemoryDiskAndRestartSelectionCoherent() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let failures = SyncFailureRecorder()
        let controller = try LynxController(
            configuration: config,
            artifactFetch: nil,
            journalDirectorySync: failures.fail
        )
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let initial = try snapshot(controller, context, config)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, embeddedId)], kind: "EMBEDDED"),
            expectedRevision: initial.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: initial, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED"
        )
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        let staged = try controller.stageSelection(preparedId, context: context)
        XCTAssertEqual(staged["status"] as? String, "STAGED")
        XCTAssertGreaterThan(failures.calls, 0)
        let memoryNext = try XCTUnwrap(
            (try controller.getState(context)["nextSelection"] as? [String: Any])?["releaseId"] as? String
        )
        XCTAssertEqual(memoryNext, releaseB)

        let store = try home(config.root)
        let diskState = try LynxControllerJournal(
            file: store.appendingPathComponent("state.json")
        ).load()
        XCTAssertEqual(try diskState.next?.policy.releaseId, releaseB)
        try controller.close()

        let restarted = try LynxController(configuration: config)
        let restartedContext = restarted.createContext(primary: true)
        _ = try restarted.begin(restartedContext)
        XCTAssertEqual(restarted.runningSelection.releaseId, releaseB)
        XCTAssertEqual(restarted.runningSelection.kind, "EMBEDDED")
    }

    func testExplicitChannelSwitchPersistsSelectionAndChannelAtomically() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let beta = "beta"
        let betaScope = scope(for: beta)
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        let projected = try switchSnapshot(controller, context, config, targetChannel: beta)
        let catalog = try catalogJSON(
            releases: [(releaseB, embeddedId)],
            kind: "EMBEDDED",
            scope: betaScope
        )
        let contextHash = LynxCatalogPolicy.contextHash(snapshot: projected, scopeKey: betaScope)
        XCTAssertThrowsError(try controller.acceptCatalog(
            catalog,
            expectedRevision: projected.revision,
            contextHash: contextHash,
            targetChannel: beta,
            explicitScopeSwitch: false,
            context: context
        ))
        let guardValue = try controller.acceptCatalog(
            catalog,
            expectedRevision: projected.revision,
            contextHash: contextHash,
            targetChannel: beta,
            explicitScopeSwitch: true,
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED",
            channel: beta,
            scope: betaScope
        )
        try await controller.validateSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        _ = try controller.stageSelection(preparedId, context: context)
        let committed = try controller.getState(context)
        XCTAssertEqual(committed["channel"] as? String, beta)
        XCTAssertEqual((committed["nextSelection"] as? [String: Any])?["channel"] as? String, beta)
        XCTAssertEqual((committed["nextSelection"] as? [String: Any])?["releaseId"] as? String, releaseB)
        try controller.close()

        let restarted = try LynxController(configuration: config)
        let restartedContext = restarted.createContext(primary: true)
        _ = try restarted.begin(restartedContext)
        XCTAssertEqual(try restarted.getState(restartedContext)["channel"] as? String, beta)
        XCTAssertEqual(restarted.runningSelection.channel, beta)
        XCTAssertEqual(restarted.runningSelection.releaseId, releaseB)
    }

    func testFailedChannelSwitchKeepsOldChannelAndCleanRetrySucceeds() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let beta = "beta"
        let betaScope = scope(for: beta)
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let projected = try switchSnapshot(controller, context, config, targetChannel: beta)
        let catalog = try catalogJSON(
            releases: [(releaseB, embeddedId)],
            kind: "EMBEDDED",
            scope: betaScope
        )
        let contextHash = LynxCatalogPolicy.contextHash(snapshot: projected, scopeKey: betaScope)
        let guardValue = try controller.acceptCatalog(
            catalog,
            expectedRevision: projected.revision,
            contextHash: contextHash,
            targetChannel: beta,
            explicitScopeSwitch: true,
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED",
            channel: beta,
            scope: betaScope
        )
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        let journal = try home(config.root).appendingPathComponent("state.json")
        let backup = journal.appendingPathExtension("switch-backup")
        try FileManager.default.moveItem(at: journal, to: backup)
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: false)
        XCTAssertThrowsError(try controller.stageSelection(preparedId, context: context))
        XCTAssertEqual(try controller.getState(context)["channel"] as? String, channel)
        XCTAssertTrue(try controller.getState(context)["nextSelection"] is NSNull)
        try FileManager.default.removeItem(at: journal)
        try FileManager.default.moveItem(at: backup, to: journal)

        let retryProjection = try switchSnapshot(controller, context, config, targetChannel: beta)
        let retryGuard = try controller.acceptCatalog(
            catalog,
            expectedRevision: retryProjection.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: retryProjection, scopeKey: betaScope),
            targetChannel: beta,
            explicitScopeSwitch: true,
            context: context
        )
        let retrySelection = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: retryGuard.selectionContextHash,
            kind: "EMBEDDED",
            channel: beta,
            scope: betaScope
        )
        try await controller.validateSelection(
            guard: retryGuard,
            receipt: retrySelection,
            artifact: nil,
            context: context
        )
        let retryId = try await controller.prepareSelection(
            guard: retryGuard,
            receipt: retrySelection,
            artifact: nil,
            context: context
        )
        _ = try controller.stageSelection(retryId, context: context)
        XCTAssertEqual(try controller.getState(context)["channel"] as? String, beta)
    }

    func testFailedBetaTrialRecoversConfirmedProductionReceiptAndChannelOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        try controller!.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        let beta = "beta"
        let betaScope = scope(for: beta)
        let projected = try switchSnapshot(controller!, context, config, targetChannel: beta)
        let catalog = try catalogJSON(
            releases: [(releaseC, embeddedId)],
            kind: "EMBEDDED",
            scope: betaScope
        )
        let guardValue = try controller!.acceptCatalog(
            catalog,
            expectedRevision: projected.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: projected, scopeKey: betaScope),
            targetChannel: beta,
            explicitScopeSwitch: true,
            context: context
        )
        let selected = receipt(
            releaseId: releaseC,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED",
            channel: beta,
            scope: betaScope
        )
        let preparedId = try await controller!.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        _ = try controller!.stageSelection(preparedId, context: context)
        try controller!.close()

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(controller!.runningSelection.releaseId, releaseC)
        try controller!.close() // Leaves the unconfirmed beta trial pending.

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, bundleB)
        XCTAssertEqual(controller!.runningSelection.releaseId, releaseB)
        XCTAssertEqual(controller!.runningSelection.channel, channel)
        let recoveredState = try controller!.getState(context)
        XCTAssertEqual(recoveredState["channel"] as? String, channel)
        XCTAssertTrue(recoveredState["nextSelection"] is NSNull)
        var recovery: LynxConfirmationResult?
        controller!.notifyAppReady(context) { recovery = try? $0.get() }
        XCTAssertEqual(recovery?.status, "ALREADY_CONFIRMED")
        XCTAssertEqual(recovery?.transition?.kind, "RECOVERED")
        XCTAssertEqual(recovery?.transition?.from.releaseId, releaseC)
        XCTAssertEqual(recovery?.transition?.from.channel, beta)
        XCTAssertEqual(recovery?.transition?.to.releaseId, releaseB)
        XCTAssertEqual(recovery?.transition?.to.channel, channel)
        try controller!.close()

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        var later: LynxConfirmationResult?
        controller!.notifyAppReady(context) { later = try? $0.get() }
        XCTAssertNil(later?.transition)
    }

    func testResetChannelClearsBetaSelectionAndRestartsOnDefault() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let beta = "beta"
        let betaScope = scope(for: beta)
        var controller = try LynxController(configuration: config)
        var context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        let projected = try switchSnapshot(controller, context, config, targetChannel: beta)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, embeddedId)], kind: "EMBEDDED", scope: betaScope),
            expectedRevision: projected.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: projected, scopeKey: betaScope),
            targetChannel: beta,
            explicitScopeSwitch: true,
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED",
            channel: beta,
            scope: betaScope
        )
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        XCTAssertEqual(try controller.stageSelection(preparedId, context: context)["status"] as? String, "STAGED")
        try controller.close()
        controller = try LynxController(configuration: config)
        context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        XCTAssertEqual(controller.runningSelection.channel, beta)
        try confirm(controller, context)

        XCTAssertTrue(try controller.resetChannel(context))
        let reset = try controller.getState(context)
        XCTAssertEqual(reset["channel"] as? String, channel)
        XCTAssertTrue(reset["nextSelection"] is NSNull)
        XCTAssertTrue(reset["confirmedSelection"] is NSNull)
        try controller.close()

        let restarted = try LynxController(configuration: config)
        let restartedContext = restarted.createContext(primary: true)
        _ = try restarted.begin(restartedContext)
        XCTAssertEqual(restarted.runningSelection.kind, "BUILTIN")
        XCTAssertEqual(restarted.runningSelection.channel, channel)
        XCTAssertEqual(try restarted.getState(restartedContext)["channel"] as? String, channel)
    }

    func testSameBundleAdoptionUpdatesLiveReleaseAndReportsUnchangedTransition() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller = try LynxController(configuration: config)
        var context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        try controller.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")

        controller = try LynxController(configuration: config)
        context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        let current = try snapshot(controller, context, config)
        let nextHash = "sha256:" + String(repeating: "c", count: 64)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(
                releases: [(releaseC, bundleB)],
                generation: 3,
                hash: nextHash
            ),
            expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseC,
            bundleId: bundleB,
            contextHash: guardValue.selectionContextHash,
            generation: 3,
            hash: nextHash
        )
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        let result = try controller.stageSelection(preparedId, context: context)
        XCTAssertEqual(result["status"] as? String, "ADOPTED")
        XCTAssertEqual(result["requiresRestart"] as? Bool, false)
        XCTAssertEqual(controller.runningSelection.releaseId, releaseC)
        let state = try controller.getState(context)
        XCTAssertTrue(state["nextSelection"] is NSNull)
        XCTAssertEqual((state["confirmedSelection"] as? [String: Any])?["releaseId"] as? String, releaseC)
        var confirmation: LynxConfirmationResult?
        controller.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertEqual(confirmation?.status, "ALREADY_CONFIRMED")
        XCTAssertEqual(confirmation?.transition?.kind, "UNCHANGED")
        XCTAssertEqual(confirmation?.transition?.from.bundleId, bundleB)
        XCTAssertEqual(confirmation?.transition?.to.bundleId, bundleB)
        XCTAssertEqual(confirmation?.transition?.from.releaseId, releaseB)
        XCTAssertEqual(confirmation?.transition?.to.releaseId, releaseC)
    }

    func testCohortNormalizesBeforeCommitAndInvalidInputCannotMutateState() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try controller.setCohort(" \u{feff}Team-07\n", context: context)
        XCTAssertEqual(try controller.getState(context)["cohort"] as? String, "team-07")
        let journal = try home(config.root).appendingPathComponent("state.json")
        let committed = try Data(contentsOf: journal)
        for invalid in ["", "   ", "team_name", "team name", "0", "1001", String(repeating: "a", count: 65)] {
            XCTAssertThrowsError(try controller.setCohort(invalid, context: context))
            XCTAssertEqual(try controller.getState(context)["cohort"] as? String, "team-07")
            XCTAssertEqual(try Data(contentsOf: journal), committed)
        }
        try controller.close()
        let restarted = try LynxController(configuration: config)
        let restartedContext = restarted.createContext(primary: true)
        _ = try restarted.begin(restartedContext)
        XCTAssertEqual(try restarted.getState(restartedContext)["cohort"] as? String, "team-07")
    }

    func testRepeatedValidationDoesNotRetainPreparationCapacity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let current = try snapshot(controller, context, config)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, embeddedId)], kind: "EMBEDDED"),
            expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED"
        )
        for _ in 0..<20 {
            try await controller.validateSelection(
                guard: guardValue,
                receipt: selected,
                artifact: nil,
                context: context
            )
        }
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        XCTAssertNoThrow(try controller.stageSelection(preparedId, context: context))
    }

    func testFullIncompatibleCacheDoesNotBlockEmbeddedFallback() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let current = try snapshot(controller!, context, config)
        let guardValue = try controller!.acceptCatalog(
            try catalogJSON(releases: [(releaseB, embeddedId)], kind: "EMBEDDED"),
            expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED"
        )
        try controller!.close()
        controller = nil

        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        var state = try journal.load()
        state.incompatibleArtifacts = (0..<128).map { String(format: "cached-%03d", $0) }
        try journal.save(state)

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let preparedId = try await controller!.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        XCTAssertEqual(try controller!.stageSelection(preparedId, context: context)["status"] as? String, "STAGED")
    }

    func testFullIncompatibleCacheEvictsOldestAndAllowsLaterCachedUpdate() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let current = try snapshot(controller!, context, config)
        let guardValue = try controller!.acceptCatalog(
            try catalogJSON(releases: [(releaseB, bundleB)]),
            expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: bundleB,
            contextHash: guardValue.selectionContextHash
        )
        try controller!.close()
        controller = nil

        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        var state = try journal.load()
        let saturated = (0..<128).map { String(format: "cached-%03d", $0) }
        state.incompatibleArtifacts = saturated
        try journal.save(state)

        controller = try LynxController(
            configuration: config,
            artifactFetch: { _, _, _, _ in throw LynxArtifactError.incompatible }
        )
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let request = LynxArtifactRequest(
            bundleId: bundleB,
            fileUrl: URL(string: "https://artifacts.test/new-incompatible.tar.gz")!,
            fileHash: String(repeating: "b", count: 64)
        )
        do {
            _ = try await controller!.prepareSelection(
                guard: guardValue,
                receipt: selected,
                artifact: request,
                context: context
            )
            XCTFail("Expected incompatible artifact")
        } catch {
            guard case LynxArtifactError.incompatible = error else {
                return XCTFail("Expected incompatible artifact, got \(error)")
            }
        }
        var evicted = try journal.load()
        XCTAssertEqual(evicted.incompatibleArtifacts.count, 128)
        XCTAssertFalse(evicted.incompatibleArtifacts.contains(saturated[0]))
        XCTAssertEqual(Array(evicted.incompatibleArtifacts.prefix(2)), [saturated[1], saturated[2]])
        try controller!.close()
        controller = nil

        let installedDigest = try writeTree(
            at: try home(config.root).appendingPathComponent("bundles/\(bundleB)"),
            bundleId: bundleB,
            marker: "B"
        )
        evicted.installedDigests[bundleB] = installedDigest
        try journal.save(evicted)
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let preparedId = try await controller!.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        XCTAssertEqual(try controller!.stageSelection(preparedId, context: context)["status"] as? String, "STAGED")
    }

    func testValidationReportsIncompatibleWithoutRetainingPreparation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let controller = try LynxController(
            configuration: config,
            artifactFetch: { _, _, _, _ in throw LynxArtifactError.incompatible }
        )
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let current = try snapshot(controller, context, config)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, bundleB)]),
            expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: bundleB,
            contextHash: guardValue.selectionContextHash
        )
        let request = LynxArtifactRequest(
            bundleId: bundleB,
            fileUrl: URL(string: "https://artifacts.test/incompatible.tar.gz")!,
            fileHash: String(repeating: "a", count: 64)
        )
        for _ in 0..<20 {
            do {
                try await controller.validateSelection(
                    guard: guardValue,
                    receipt: selected,
                    artifact: request,
                    context: context
                )
                XCTFail("Expected incompatible validation")
            } catch {
                guard case LynxArtifactError.incompatible = error else {
                    return XCTFail("Expected incompatible validation, got \(error)")
                }
            }
        }
    }

    func testStageConsumesPreparationAfterAuthorizationBecomesStale() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let initial = try snapshot(controller, context, config)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, embeddedId)], kind: "EMBEDDED"),
            expectedRevision: initial.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: initial, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED"
        )
        let preparedId = try await controller.prepareSelection(
            guard: guardValue,
            receipt: selected,
            artifact: nil,
            context: context
        )
        let newerHash = "sha256:" + String(repeating: "b", count: 64)
        let current = try snapshot(controller, context, config)
        _ = try controller.acceptCatalog(
            try catalogJSON(
                releases: [(releaseC, embeddedId)],
                kind: "EMBEDDED",
                generation: 3,
                hash: newerHash
            ),
            expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey),
            context: context
        )
        XCTAssertThrowsError(try controller.stageSelection(preparedId, context: context))
        XCTAssertThrowsError(try controller.stageSelection(preparedId, context: context)) { error in
            guard case LynxArtifactError.stalePreparation = error else {
                return XCTFail("Expected consumed preparation, got \(error)")
            }
        }
    }

    func testStageConsumesPreparationAfterJournalWriteFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let initial = try snapshot(controller, context, config)
        let guardValue = try controller.acceptCatalog(
            try catalogJSON(releases: [(releaseB, embeddedId)], kind: "EMBEDDED"),
            expectedRevision: initial.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: initial, scopeKey: scopeKey),
            context: context
        )
        let selected = receipt(
            releaseId: releaseB,
            bundleId: embeddedId,
            contextHash: guardValue.selectionContextHash,
            kind: "EMBEDDED"
        )
        let journal = try home(config.root).appendingPathComponent("state.json")
        let backup = journal.appendingPathExtension("backup")
        for _ in 0..<20 {
            let preparedId = try await controller.prepareSelection(
                guard: guardValue,
                receipt: selected,
                artifact: nil,
                context: context
            )
            try FileManager.default.moveItem(at: journal, to: backup)
            try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: false)
            XCTAssertThrowsError(try controller.stageSelection(preparedId, context: context))
            try FileManager.default.removeItem(at: journal)
            try FileManager.default.moveItem(at: backup, to: journal)
            XCTAssertThrowsError(try controller.stageSelection(preparedId, context: context)) { error in
                guard case LynxArtifactError.stalePreparation = error else {
                    return XCTFail("Expected consumed preparation, got \(error)")
                }
            }
        }
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
