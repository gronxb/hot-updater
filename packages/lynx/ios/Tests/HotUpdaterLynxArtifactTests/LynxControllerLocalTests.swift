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
    private func writeTree(at directory: URL, bundleId: String, marker: String, managedPages: Bool = false, background: Bool = false) throws -> String {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var metadataObject: [String: Any] = [
            "schemaVersion": 1, "bundleId": bundleId, "platform": "ios",
            "entry": "main.lynx.bundle", "runtimeId": runtime,
        ]
        if managedPages {
            metadataObject["pageEntries"] = ["detail.lynx.bundle", "main.lynx.bundle"]
            metadataObject["pageEssentialResources"] = [
                ["entry": "detail.lynx.bundle", "resources": ["detail.lynx.bundle"]],
                ["entry": "main.lynx.bundle", "resources": ["main.lynx.bundle"]],
            ]
        }
        if background { metadataObject["backgroundEntry"] = "background.js" }
        let metadata = try JSONSerialization.data(withJSONObject: metadataObject, options: [.sortedKeys]) + Data("\n".utf8)
        var files: [String: Data] = [
            "main.lynx.bundle": Data("entry-\(marker)".utf8),
            "assets/probe.png": Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]),
            "assets/probe.ttf": Data("FONT-\(marker)".utf8),
            "assets/bootstrap.js": Data("js-\(marker)".utf8),
            "dynamic/component.lynx.bundle": Data("dyn-\(marker)".utf8),
            "hot-updater-lynx.json": metadata,
        ]
        if background { files["background.js"] = Data("globalThis.marker = '\(marker)';".utf8) }
        if managedPages { files["detail.lynx.bundle"] = Data("detail-\(marker)".utf8) }
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

    private func plantNext(_ config: LynxControllerConfiguration, releaseId: String, bundleId: String, marker: String, managedPages: Bool = false, background: Bool = false) throws {
        let store = try home(config.root)
        let digest = try writeTree(at: store.appendingPathComponent("bundles/\(bundleId)"), bundleId: bundleId, marker: marker, managedPages: managedPages, background: background)
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

    func testReadinessCallbackRunsAfterControllerUnlocks() throws {
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
        let controller = try LynxController(configuration: configuration(
            root: root.appendingPathComponent("store"),
            embedded: embedded,
            digest: digest
        ))
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try controller.observedContent(context)

        var concurrentReadFinished = false
        var status: String?
        controller.notifyAppReady(context) { result in
            status = try? result.get().status
            let finished = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                _ = try? controller.getState(context)
                finished.signal()
            }
            concurrentReadFinished = finished.wait(
                timeout: .now() + 1
            ) == .success
        }

        XCTAssertEqual(status, "CONFIRMED")
        XCTAssertTrue(concurrentReadFinished)
    }

    func testColdUpdatePersistsAndAtomicallyConsumesLaunchTransitionId() throws {
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
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        let transitionId = try XCTUnwrap(journal.load().launchTransition?.transitionId)
        XCTAssertFalse(transitionId.isEmpty)
        try controller!.observedContent(context)
        var confirmation: LynxConfirmationResult?
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertEqual(confirmation?.transition?.kind, "UPDATE_APPLIED")
        XCTAssertEqual(confirmation?.transitionId, transitionId)
        let consumed = try journal.load()
        XCTAssertNil(consumed.pending)
        XCTAssertNil(consumed.launchTransition)
        XCTAssertNil(consumed.managedTransition)
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertNil(confirmation?.transition)
        XCTAssertNil(confirmation?.transitionId)
    }

    func testRecoveryPreservesTheUnconsumedLaunchTransitionId() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        controller = nil
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        let transitionId = try XCTUnwrap(journal.load().launchTransition?.transitionId)
        controller = nil

        controller = try LynxController(configuration: config)
        XCTAssertEqual(try journal.load().launchTransition?.transitionId, transitionId)
        XCTAssertEqual(
            try journal.load().launchTransition?.policy.kind,
            "RECOVERED"
        )
        controller = nil

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        XCTAssertEqual(try journal.load().launchTransition?.transitionId, transitionId)
        var confirmation: LynxConfirmationResult?
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertEqual(confirmation?.transition?.kind, "RECOVERED")
        XCTAssertEqual(confirmation?.transitionId, transitionId)
    }

    func testRecoveryPreservesTheUnconsumedTransitionWithRevokedConfirmedRelease() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        controller = nil
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        controller = nil
        // C's catalog revokes confirmed B; recovery must choose embedded A.
        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C")
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        let transitionId = try XCTUnwrap(journal.load().launchTransition?.transitionId)
        controller = nil

        controller = try LynxController(configuration: config)
        XCTAssertEqual(try journal.load().launchTransition?.transitionId, transitionId)
        XCTAssertEqual(
            try journal.load().launchTransition?.policy.kind,
            "RECOVERED"
        )
        controller = nil

        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        XCTAssertEqual(try journal.load().launchTransition?.transitionId, transitionId)
        try controller!.observedContent(context)
        var confirmation: LynxConfirmationResult?
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertEqual(confirmation?.transition?.kind, "RECOVERED")
        XCTAssertEqual(confirmation?.transitionId, transitionId)
        XCTAssertEqual(confirmation?.transition?.from.bundleId, bundleC)
        XCTAssertEqual(confirmation?.transition?.from.releaseId, releaseC)
        XCTAssertEqual(confirmation?.transition?.to.kind, "BUILTIN")
        XCTAssertEqual(confirmation?.transition?.to.bundleId, embeddedId)
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertNil(confirmation?.transition)
        XCTAssertNil(confirmation?.transitionId)
    }

    func testLegacyLaunchTransitionIsBackfilledAndInvalidIdsFailClosed() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        try confirm(controller!, context)
        controller = nil
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        let journalURL = try home(config.root).appendingPathComponent("state.json")
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: journalURL)) as! [String: Any]
        var launch = object["launchTransition"] as! [String: Any]
        launch.removeValue(forKey: "transitionId")
        object["launchTransition"] = launch
        object.removeValue(forKey: "pending")
        try JSONSerialization.data(withJSONObject: object).write(to: journalURL)
        controller = nil

        controller = try LynxController(configuration: config)
        let journal = LynxControllerJournal(file: journalURL)
        let backfilled = try XCTUnwrap(journal.load().launchTransition?.transitionId)
        XCTAssertFalse(backfilled.isEmpty)
        try controller!.close()
        var state = try journal.load()
        let transition = try XCTUnwrap(state.launchTransition?.policy)
        state.launchTransition = try LynxStoredLaunchTransition(
            transition,
            transitionId: ""
        )
        try journal.save(state)
        XCTAssertThrowsError(try LynxController(configuration: config))

        let source = try XCTUnwrap(state.confirmed)
        let target = try XCTUnwrap(state.next)
        state.launchTransition = nil
        state.managedTransition = .init(
            transitionId: "not-a-uuid",
            trigger: "reload",
            source: source,
            target: target,
            stack: [.init(entry: "main.lynx.bundle", parameters: [])]
        )
        try journal.save(state)
        XCTAssertThrowsError(try LynxController(configuration: config))

        state.launchTransition = try LynxStoredLaunchTransition(
            transition,
            transitionId: "not-a-uuid"
        )
        try journal.save(state)
        XCTAssertThrowsError(try LynxController(configuration: config))

        state.launchTransition = try LynxStoredLaunchTransition(
            transition,
            transitionId: "11111111-1111-4111-8111-111111111111"
        )
        state.managedTransition = .init(
            transitionId: "22222222-2222-4222-8222-222222222222",
            trigger: "reload",
            source: source,
            target: target,
            stack: [.init(entry: "main.lynx.bundle", parameters: [])]
        )
        try journal.save(state)
        XCTAssertThrowsError(try LynxController(configuration: config))
    }

    func testManagedReloadAndLaunchTransitionShareIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller: LynxController? = try LynxController(configuration: config)
        let initial = controller!.createContext(primary: true)
        _ = try controller!.begin(initial)
        try confirm(controller!, initial)
        controller = nil
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        var state = try journal.load()
        let transitionId = UUID().uuidString
        state.managedTransition = .init(
            transitionId: transitionId,
            trigger: "reload",
            source: try XCTUnwrap(state.confirmed),
            target: try XCTUnwrap(state.next),
            stack: [.init(entry: "main.lynx.bundle", parameters: [])]
        )
        try journal.save(state)

        controller = try LynxController(configuration: config)
        let context = controller!.createContext(primary: true)
        _ = try controller!.begin(context)
        XCTAssertEqual(try journal.load().launchTransition?.transitionId, transitionId)
        try controller!.observedContent(context)
        var confirmation: LynxConfirmationResult?
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertEqual(confirmation?.transitionId, transitionId)
        XCTAssertEqual(confirmation?.transition?.kind, "UPDATE_APPLIED")
    }

    func testSecondaryRequiresAnExplicitManagedPageEntry() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let controller = try LynxController(configuration: configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest))
        let secondary = controller.createContext(primary: false)
        XCTAssertThrowsError(try controller.begin(secondary))
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        XCTAssertThrowsError(try controller.begin(secondary))
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
        XCTAssertEqual(
            try controller.resource(
                "hot-updater:///main.lynx.bundle?hot-updater-generation=2",
                context: context
            ),
            Data("entry-A".utf8)
        )
        XCTAssertThrowsError(try controller.resource(
            "hot-updater:///main.lynx.bundle?hot-updater-generation=0",
            context: context
        ))
        XCTAssertThrowsError(try controller.resource(
            "hot-updater:///main.lynx.bundle?stale=1",
            context: context
        ))
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

    func testFailedFallbackReadinessWriteRequiresANewApplicationSignal() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-retry-write-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let initial = try LynxController(configuration: config)
        let initialContext = initial.createContext(primary: true)
        _ = try initial.begin(initialContext)
        try confirm(initial, initialContext)
        try initial.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let trial = try LynxController(configuration: config)
        _ = try trial.begin(trial.createContext(primary: true))
        try trial.close()
        let recovery = try LynxController(configuration: config)
        let context = recovery.createContext(primary: true)
        _ = try recovery.begin(context)
        try recovery.observedContent(context)
        let file = try home(config.root).appendingPathComponent("state.json")
        let backup = file.appendingPathExtension("backup")
        let journal = LynxControllerJournal(file: file)
        try FileManager.default.moveItem(at: file, to: backup)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        var failure: Error?
        recovery.notifyAppReady(context) { if case .failure(let error) = $0 { failure = error } }
        XCTAssertNotNil(failure)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: backup, to: file)
        try recovery.observedResource("assets/probe.png", context: context)
        try recovery.observedContent(context)
        XCTAssertEqual(try journal.load().interruptedReleases?[releaseB]?.retryReady, false)
        var status: String?
        recovery.notifyAppReady(context) { status = (try? $0.get())?.status }
        XCTAssertEqual(status, "ALREADY_CONFIRMED")
        XCTAssertEqual(try journal.load().interruptedReleases?[releaseB]?.retryReady, true)
        try recovery.close()
    }

    func testInvalidInterruptedProcessTokenFailsClosedWithoutRewritingState() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-invalid-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let initial = try LynxController(configuration: config)
        try initial.close()
        let file = try home(config.root).appendingPathComponent("state.json")
        let journal = LynxControllerJournal(file: file)
        var state = try journal.load()
        state.interruptedReleases = [releaseB: .init(bundleId: bundleB, retryReady: true, holdProcessToken: "invalid")]
        try journal.save(state)
        let original = try Data(contentsOf: file)
        XCTAssertThrowsError(try LynxController(configuration: config))
        XCTAssertEqual(try Data(contentsOf: file), original)
    }

    func testManagedFailClosedPrimaryNeverReceivesAnInterruptionRetry() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-failed-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let initial = try LynxController(configuration: config)
        let initialContext = initial.createContext(primary: true)
        _ = try initial.begin(initialContext)
        try confirm(initial, initialContext)
        try initial.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let trial = try LynxController(configuration: config)
        let context = trial.createContext(primary: true)
        _ = try trial.begin(context)
        _ = try trial.recordManagedFailClosed(reason: "reconstructionFailed", message: "Managed generation cannot run",
            stack: [.init(entry: "main.lynx.bundle", parameters: [])])
        XCTAssertThrowsError(try trial.observedContent(context))
        var readinessFailed = false
        trial.notifyAppReady(context) { if case .failure = $0 { readinessFailed = true } }
        XCTAssertTrue(readinessFailed)
        try trial.close()
        let recovery = try LynxController(configuration: config)
        let fallback = recovery.createContext(primary: true)
        _ = try recovery.begin(fallback)
        XCTAssertEqual(recovery.runningSelection.bundleId, embeddedId)
        XCTAssertEqual(try recovery.getState(fallback)["unconfirmedReleaseIds"] as? [String], [releaseB])
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        XCTAssertNil(try journal.load().interruptedReleases?[releaseB])
        try recovery.close()
    }

    func testFatalRepublishedBytesSuppressOlderInterruptedReleases() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-fatal-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let initial = try LynxController(configuration: config)
        try initial.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let trial = try LynxController(configuration: config)
        _ = try trial.begin(trial.createContext(primary: true))
        try trial.close()
        let recovery = try LynxController(configuration: config)
        try recovery.close()
        try plantNext(config, releaseId: releaseC, bundleId: bundleB, marker: "B")
        let republished = try LynxController(configuration: config)
        let context = republished.createContext(primary: true)
        _ = try republished.begin(context)
        XCTAssertEqual(republished.runningSelection.releaseId, releaseC)
        try republished.reportFailure(context, fatal: true)
        try republished.close()
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        let state = try journal.load()
        XCTAssertEqual(Set(state.unconfirmedReleaseIds), Set([releaseB, releaseC]))
        XCTAssertEqual(state.crashedBundleIds, [bundleB])
        XCTAssertTrue(state.interruptedReleases?.isEmpty != false)
    }

    func testInterruptedPrimaryWaitsForFallbackResourcesAndANewProcess() throws {
        try assertInterruptedPrimaryRetry(retryConfirms: true)
    }

    func testSecondInterruptedPrimaryBecomesPermanent() throws {
        try assertInterruptedPrimaryRetry(retryConfirms: false)
    }

    private func assertInterruptedPrimaryRetry(retryConfirms: Bool) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded,
            digest: digest, resources: ["assets/probe.png"])
        let p1 = UUID().uuidString, p2 = UUID().uuidString
        let p3 = UUID().uuidString, p4 = UUID().uuidString
        func start(_ token: String) throws -> (LynxController, LynxLaunchContext) {
            let controller = try LynxController(configuration: config, artifactFetch: nil, processToken: token)
            let context = controller.createContext(primary: true)
            _ = try controller.begin(context)
            return (controller, context)
        }
        let (initial, initialContext) = try start(p1)
        try confirm(initial, initialContext, resource: "assets/probe.png")
        try initial.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let (trial, _) = try start(p1)
        XCTAssertEqual(trial.runningSelection.bundleId, bundleB)
        try trial.close()
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        // The first recovery process also exits before its fallback is ready.
        let (recovery, _) = try start(p2)
        XCTAssertEqual(recovery.runningSelection.bundleId, embeddedId)
        XCTAssertEqual(try journal.load().interruptedReleases?[releaseB]?.retryReady, false)
        try recovery.close()
        let (laterRecovery, context) = try start(p3)
        laterRecovery.notifyAppReady(context) { XCTAssertEqual((try? $0.get())?.status, "ALREADY_CONFIRMED") }
        XCTAssertEqual(try journal.load().interruptedReleases?[releaseB]?.retryReady, false)
        try laterRecovery.observedContent(context)
        XCTAssertEqual(try journal.load().interruptedReleases?[releaseB]?.retryReady, false)
        try laterRecovery.observedResource("assets/probe.png", context: context)
        let armed = try journal.load()
        XCTAssertEqual(armed.interruptedReleases?[releaseB]?.retryReady, true)
        XCTAssertEqual(armed.interruptedReleases?[releaseB]?.holdProcessToken, p3)
        XCTAssertEqual(try laterRecovery.getState(context)["unconfirmedReleaseIds"] as? [String], [releaseB])
        // Late native resource observations must not invalidate accepted receipts.
        try laterRecovery.observedResource("assets/probe.png", context: context)
        laterRecovery.notifyAppReady(context) { XCTAssertEqual((try? $0.get())?.status, "ALREADY_CONFIRMED") }
        XCTAssertEqual(try journal.load().revision, armed.revision)
        try laterRecovery.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let (recreated, _) = try start(p3)
        XCTAssertEqual(recreated.runningSelection.bundleId, embeddedId)
        try recreated.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        let (retry, retryContext) = try start(p4)
        XCTAssertEqual(retry.runningSelection.bundleId, bundleB)
        XCTAssertEqual(try retry.getState(retryContext)["unconfirmedReleaseIds"] as? [String], [])
        if retryConfirms {
            try confirm(retry, retryContext, resource: "assets/probe.png")
            XCTAssertNil(try journal.load().interruptedReleases)
        }
        try retry.close()
        let (after, afterContext) = try start(UUID().uuidString)
        XCTAssertEqual(after.runningSelection.bundleId, retryConfirms ? bundleB : embeddedId)
        XCTAssertEqual(try after.getState(afterContext)["unconfirmedReleaseIds"] as? [String], retryConfirms ? [] : [releaseB])
        XCTAssertEqual(try after.getState(afterContext)["crashedBundleIds"] as? [String], [])
        XCTAssertNil(try journal.load().interruptedReleases?[releaseB])
        try after.close()
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

    func testUnconfirmedDetailFatalRetainsRecoveryTransitionUntilConfirmation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-page-fatal-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A", managedPages: true)
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        var controller = try LynxController(configuration: config)
        try controller.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", managedPages: true)
        controller = try LynxController(configuration: config)
        var primary = controller.createContext(primary: true)
        XCTAssertEqual(try controller.begin(primary).bundleId, bundleB)
        try confirm(controller, primary, resource: "main.lynx.bundle")
        try controller.close()

        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C", managedPages: true)
        let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
        var state = try journal.load()
        state.catalogs[catalogKey()] = try catalogJSON(releases: [(releaseC, bundleC), (releaseB, bundleB)])
        try journal.save(state)
        controller = try LynxController(configuration: config)
        primary = controller.createContext(primary: true)
        XCTAssertEqual(try controller.begin(primary).bundleId, bundleC)
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(detail, pageEntry: "detail.lynx.bundle", generationId: "failed-generation", stack: [
            .init(entry: "main.lynx.bundle"), .init(entry: "detail.lynx.bundle"),
        ], sourceContextId: primary.id)
        XCTAssertTrue(try controller.reportPageFailure(detail))
        XCTAssertThrowsError(try controller.observedContent(detail))
        try controller.close()

        controller = try LynxController(configuration: config)
        primary = controller.createContext(primary: true)
        XCTAssertEqual(try controller.begin(primary).bundleId, bundleB)
        let recovered = try controller.getState(primary)
        XCTAssertEqual(recovered["crashedBundleIds"] as? [String], [bundleC])
        XCTAssertEqual(recovered["unconfirmedReleaseIds"] as? [String], [releaseC])
        var result: LynxConfirmationResult?
        controller.notifyAppReady(primary) { result = try? $0.get() }
        XCTAssertEqual(result?.status, "ALREADY_CONFIRMED")
        XCTAssertEqual(result?.transition?.kind, "RECOVERED")
        XCTAssertEqual(result?.transition?.from.releaseId, releaseC)
        XCTAssertEqual(result?.transition?.to.releaseId, releaseB)
        controller.notifyAppReady(primary) { result = try? $0.get() }
        XCTAssertNil(result?.transition)
    }

    func testFatalBundleFailureRecordsCrashAndReleaseSuppression() throws {
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
        XCTAssertEqual(
            recovered["unconfirmedReleaseIds"] as? [String],
            [releaseB]
        )
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
        try controller!.observedContent(context)
        var confirmation: LynxConfirmationResult?
        controller!.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertEqual(confirmation?.status, "CONFIRMED")
        XCTAssertEqual(confirmation?.transition?.kind, "RECOVERED")
        XCTAssertEqual(confirmation?.transition?.from.bundleId, bundleB)
        XCTAssertEqual(confirmation?.transition?.from.releaseId, releaseB)
        XCTAssertEqual(confirmation?.transition?.to.bundleId, embeddedId)
        XCTAssertNil(confirmation?.transition?.to.releaseId)
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
            "01900000-0000-7000-8000-" + String(format: "%012x", 1000 + index)
        }
        XCTAssertFalse(state.unconfirmedReleaseIds.contains(releaseB))
        try journal.save(state)
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        XCTAssertEqual(try controller!.begin(context).bundleId, embeddedId)
        XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, true)
        XCTAssertEqual((try controller!.getState(context)["unconfirmedReleaseIds"] as! [String]).count, 128)
    }

    func testConfirmedOtaNeverExceedsRecoveryCapacity() throws {
        for historySize in [127, 128] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-local-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let embedded = root.appendingPathComponent("embedded")
            let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
            let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
            var controller: LynxController? = try LynxController(configuration: config)
            var context = controller!.createContext(primary: true)
            _ = try controller!.begin(context)
            try confirm(controller!, context)
            controller = nil
            try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B")
            controller = try LynxController(configuration: config)
            context = controller!.createContext(primary: true)
            _ = try controller!.begin(context)
            try confirm(controller!, context)
            controller = nil
            let journal = LynxControllerJournal(file: try home(config.root).appendingPathComponent("state.json"))
            var state = try journal.load()
            XCTAssertEqual(try state.confirmed?.policy.releaseId, releaseB)
            let excluded = (0..<historySize).map { "01900000-0000-7000-8000-" + String(format: "%012x", 1000 + $0) }
            XCTAssertFalse(excluded.contains(releaseB))
            state.unconfirmedReleaseIds = excluded
            try journal.save(state)
            controller = try LynxController(configuration: config)
            context = controller!.createContext(primary: true)
            XCTAssertEqual(try controller!.begin(context).bundleId, historySize == 127 ? bundleB : embeddedId)
            XCTAssertEqual(try controller!.getState(context)["unconfirmedReleaseIds"] as? [String], excluded)
            if historySize == 127 {
                XCTAssertTrue(try controller!.reportFailure(context, fatal: true, allowConfirmed: true))
                XCTAssertEqual(try journal.load().unconfirmedReleaseIds, excluded + [releaseB])
            }
        }
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
        let request = LynxArtifactRequest(bundleId: bundleB,
            manifestUrl: URL(string: "https://artifacts.test/bundle.tar.gz")!,
            manifestFileHash: String(repeating: "a", count: 64),
            assets: ["main.lynx.bundle": .init(
                fileHash: String(repeating: "b", count: 64),
                file: .init(url: URL(string: "https://artifacts.test/main")!)
            )])
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
        XCTAssertFalse(try XCTUnwrap(confirmation?.transitionId).isEmpty)
        controller.notifyAppReady(context) { confirmation = try? $0.get() }
        XCTAssertNil(confirmation?.transition)
        XCTAssertNil(confirmation?.transitionId)
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

    func testMetadataValidationReauthorizesAfterDownloadWithoutInstallingPages() async throws {
        for mode in ["valid", "changed-cohort", "closed", "missing-required-resource"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-check-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let embedded = root.appendingPathComponent("embedded")
            let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A")
            let target = root.appendingPathComponent("target")
            try writeTree(at: target, bundleId: bundleB, marker: "B", managedPages: true)
            var manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: target.appendingPathComponent("manifest.json"))) as! [String: Any]
            var assets = manifest["assets"] as! [String: [String: String]]
            if mode == "missing-required-resource" { assets.removeValue(forKey: "assets/probe.ttf") }
            manifest["assets"] = assets
            let manifestBytes = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
            let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest,
                                       resources: ["assets/probe.ttf"])
            let started = expectation(description: "Metadata fetch started")
            let gate = FetchGate()
            let controller = try LynxController(configuration: config) { source, destination, _, _ in
                let name = String(source.path.dropFirst())
                if name == "manifest.json" { try manifestBytes.write(to: destination) }
                else if name == "hot-updater-lynx.json" {
                    started.fulfill()
                    await gate.wait()
                    try FileManager.default.copyItem(at: target.appendingPathComponent(name), to: destination)
                } else {
                    XCTFail("Compatibility check downloaded page/resource: \(name)")
                    throw LynxArtifactError.invalid("Unexpected page download")
                }
            }
            let context = controller.createContext(primary: true)
            _ = try controller.begin(context)
            let current = try snapshot(controller, context, config)
            let guardValue = try controller.acceptCatalog(try catalogJSON(releases: [(releaseB, bundleB)]),
                expectedRevision: current.revision,
                contextHash: LynxCatalogPolicy.contextHash(snapshot: current, scopeKey: scopeKey), context: context)
            let selected = receipt(releaseId: releaseB, bundleId: bundleB, contextHash: guardValue.selectionContextHash)
            let request = LynxArtifactRequest(bundleId: bundleB,
                manifestUrl: URL(string: "https://artifacts.test/manifest.json")!, manifestFileHash: hash(manifestBytes),
                assets: Dictionary(uniqueKeysWithValues: assets.map { name, asset in
                    (name, LynxChangedAsset(fileHash: asset["fileHash"]!, file: .init(url: URL(string: "https://artifacts.test/\(name)")!)))
                }))
            let operation = Task { try await controller.validateSelection(guard: guardValue, receipt: selected,
                                                                          artifact: request, context: context) }
            await fulfillment(of: [started], timeout: 2)
            if mode == "changed-cohort" { try controller.setCohort("2", context: context) }
            var replacement: LynxController?
            if mode == "closed" {
                try controller.close()
                replacement = try LynxController(configuration: config)
                _ = try replacement!.begin(replacement!.createContext(primary: true))
            }
            let store = try home(config.root)
            let journal = store.appendingPathComponent("state.json")
            let before = try Data(contentsOf: journal)
            await gate.release()
            do {
                try await operation.value
                XCTAssertEqual(mode, "valid", "Invalidated metadata check succeeded")
            } catch { XCTAssertNotEqual(mode, "valid", "Valid metadata check failed: \(error)") }
            XCTAssertEqual(try Data(contentsOf: journal), before)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.appendingPathComponent(".staging").path), [])
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.appendingPathComponent("bundles").path), [])
            try replacement?.close()
            try controller.close()
        }
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
        let request = LynxArtifactRequest(bundleId: bundleB,
            manifestUrl: URL(string: "https://artifacts.test/new-incompatible.tar.gz")!,
            manifestFileHash: String(repeating: "a", count: 64),
            assets: ["main.lynx.bundle": .init(
                fileHash: String(repeating: "b", count: 64),
                file: .init(url: URL(string: "https://artifacts.test/main")!)
            )])
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
        let request = LynxArtifactRequest(bundleId: bundleB,
            manifestUrl: URL(string: "https://artifacts.test/incompatible.tar.gz")!,
            manifestFileHash: String(repeating: "a", count: 64),
            assets: ["main.lynx.bundle": .init(
                fileHash: String(repeating: "b", count: 64),
                file: .init(url: URL(string: "https://artifacts.test/main")!)
            )])
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

extension LynxControllerLocalTests {
    private func backgroundFixture() throws -> (URL, LynxControllerConfiguration, LynxRuntimeHost, LynxControllerJournal) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-background-\(UUID().uuidString)")
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: embeddedId, marker: "A", background: true)
        let config = configuration(root: root.appendingPathComponent("store"), embedded: embedded, digest: digest)
        let host = try LynxRuntimeHost.get(configuration: config)
        let controller = try host.createForeground()
        try controller.close()
        return (root, config, host, LynxControllerJournal(file: host.scope.home.appendingPathComponent("state.json")))
    }

    func testColdBackgroundCopiesStagedSelectionWithoutConsumingJournalOrForegroundApply() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let before = try Data(contentsOf: journal.file)
        let task = try host.beginBackground()
        XCTAssertEqual(task.snapshot.selection.releaseId, releaseB)
        XCTAssertEqual(task.snapshot.source, "globalThis.marker = 'B';")
        XCTAssertEqual(try Data(contentsOf: journal.file), before)
        let controller = try host.createForeground()
        let context = controller.createContext(primary: true)
        XCTAssertEqual(try controller.begin(context).bundleId, bundleB)
        try confirm(controller, context)
        try task.executionEnded()
        try controller.close()
        XCTAssertEqual(try journal.load().confirmed?.policy.releaseId, releaseB)
    }

    func testBackgroundKeepsLivePendingEligibleButColdCaptureProjectsItsInterruption() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let controller = try host.createForeground()
        _ = try controller.begin(controller.createContext(primary: true))
        let before = try Data(contentsOf: journal.file)
        let live = try host.beginBackground()
        XCTAssertEqual(live.snapshot.selection.releaseId, releaseB)
        try controller.close()
        let cold = try host.beginBackground()
        XCTAssertEqual(cold.snapshot.selection.kind, "BUILTIN")
        XCTAssertEqual(try Data(contentsOf: journal.file), before)
        try live.executionEnded()
        try cold.executionEnded()
        let recovered = try host.createForeground()
        XCTAssertEqual(recovered.runningSelection.kind, "BUILTIN")
        XCTAssertEqual(try journal.load().interruptedReleases?[releaseB]?.retryReady, false)
        try recovered.close()
    }

    func testColdBackgroundPreservesConfirmedManagedReloadIncludingLegacyPendingIdentity() throws {
        for legacy in [false, true] {
            let (root, config, host, journal) = try backgroundFixture()
            defer { try? FileManager.default.removeItem(at: root) }
            try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
            var state = try journal.load()
            let selected = try XCTUnwrap(state.next)
            let transitionId = UUID().uuidString
            state.confirmed = selected
            state.managedTransition = .init(transitionId: transitionId, trigger: "reload",
                source: selected, target: selected, stack: [.init(entry: "main.lynx.bundle", parameters: [])])
            state.pending = .init(selection: selected, attemptId: UUID().uuidString,
                contextId: UUID().uuidString, transitionId: legacy ? nil : transitionId)
            try journal.save(state)
            let before = try Data(contentsOf: journal.file)
            let task = try host.beginBackground()
            XCTAssertEqual(task.snapshot.selection.releaseId, releaseB)
            XCTAssertEqual(try Data(contentsOf: journal.file), before)
            try task.executionEnded()
        }
    }

    func testBackgroundFourTaskBoundIsAtomicAndSameReleaseTasksEndIndependently() throws {
        let (root, _, host, _) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let group = DispatchGroup()
        let resultsLock = NSLock()
        var tasks: [LynxBackgroundTask] = []
        var rejected = 0
        for _ in 0..<12 {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                do {
                    let task = try host.beginBackground()
                    resultsLock.lock(); tasks.append(task); resultsLock.unlock()
                } catch {
                    resultsLock.lock(); rejected += 1; resultsLock.unlock()
                }
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
        XCTAssertEqual(tasks.count, 4)
        XCTAssertEqual(rejected, 8)
        XCTAssertEqual(Set(tasks.map { $0.snapshot.taskId }).count, 4)
        try tasks[0].executionEnded()
        let replacement = try host.beginBackground()
        try tasks[0].executionEnded()
        XCTAssertThrowsError(try host.beginBackground())
        for task in tasks.dropFirst() { try task.executionEnded() }
        try replacement.executionEnded()
    }

    func testBackgroundCopySurvivesFileRemovalAndRejectsChangedEmbeddedBytes() throws {
        let (root, config, host, _) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let task = try host.beginBackground()
        try FileManager.default.removeItem(at: host.scope.home.appendingPathComponent("bundles/\(bundleB)"))
        XCTAssertEqual(task.snapshot.source, "globalThis.marker = 'B';")
        try task.executionEnded()
        try Data("globalThis.marker = 'tampered';".utf8).write(to: config.embeddedDirectory.appendingPathComponent("background.js"))
        XCTAssertThrowsError(try host.beginBackground())
    }

    func testBackgroundFatalPersistsPinnedReceiptWithoutChangingOtherForegroundPending() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let task = try host.beginBackground()
        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C", background: true)
        let controller = try host.createForeground()
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        let before = try journal.load()
        try task.reportFatal()
        let after = try journal.load()
        XCTAssertEqual(after.pending?.attemptId, before.pending?.attemptId)
        XCTAssertEqual(try after.pending?.selection.policy.releaseId, releaseC)
        XCTAssertEqual(try after.launchTransition?.policy.to.releaseId, releaseC)
        XCTAssertEqual(after.unconfirmedReleaseIds, [releaseB])
        XCTAssertEqual(after.crashedBundleIds, [bundleB])
        XCTAssertEqual(try controller.getState(context)["runningConfirmed"] as? Bool, false)
        try confirm(controller, context)
        try task.executionEnded()
        try controller.close()
    }

    func testFailedBackgroundWriteRetainsIntentButUnrelatedConfirmedForegroundCanReadAndNotify() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let task = try host.beginBackground()
        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C", background: true)
        let controller = try host.createForeground()
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        let backup = journal.file.appendingPathExtension("backup")
        try FileManager.default.moveItem(at: journal.file, to: backup)
        try FileManager.default.createDirectory(at: journal.file, withIntermediateDirectories: false)
        XCTAssertThrowsError(try task.reportFatal())
        XCTAssertThrowsError(try task.executionEnded())
        XCTAssertThrowsError(try host.beginBackground())
        XCTAssertEqual(try controller.getState(context)["runningConfirmed"] as? Bool, true)
        var status: String?
        controller.notifyAppReady(context) { status = try? $0.get().status }
        XCTAssertEqual(status, "ALREADY_CONFIRMED")
        try controller.close()
        XCTAssertThrowsError(try host.createForeground())
        try FileManager.default.removeItem(at: journal.file)
        try FileManager.default.moveItem(at: backup, to: journal.file)
        let recovered = try host.createForeground()
        XCTAssertEqual(recovered.runningSelection.releaseId, releaseC)
        XCTAssertEqual(try journal.load().unconfirmedReleaseIds, [releaseB])
        try recovered.close()
        // Replaying the closed failed task released its independent task slot.
        let tasks = try (0..<4).map { _ in try host.beginBackground() }
        for task in tasks { try task.executionEnded() }
    }

    func testSameBundleBackgroundFatalInvalidatesReadinessBeforeFailedPersistence() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let controller = try host.createForeground()
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        var failed = false
        controller.notifyAppReady(context) { if case .failure = $0 { failed = true } }
        let task = try host.beginBackground()
        let backup = journal.file.appendingPathExtension("backup")
        try FileManager.default.moveItem(at: journal.file, to: backup)
        try FileManager.default.createDirectory(at: journal.file, withIntermediateDirectories: false)
        XCTAssertThrowsError(try task.reportFatal())
        XCTAssertTrue(failed)
        XCTAssertThrowsError(try controller.observedContent(context))
        XCTAssertThrowsError(try host.beginBackground())
        try FileManager.default.removeItem(at: journal.file)
        try FileManager.default.moveItem(at: backup, to: journal.file)
        try task.executionEnded()
        XCTAssertEqual(try journal.load().unconfirmedReleaseIds, [releaseB])
        try controller.close()
    }

    func testRetiredControllerDoubleCloseCannotReleaseNewForegroundOwner() throws {
        let (root, config, host, _) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let retired = try host.createForeground()
        try retired.close()
        let current = try host.createForeground()
        try retired.close()
        XCTAssertThrowsError(try LynxController(configuration: config))
        let task = try host.beginBackground()
        try task.executionEnded()
        try current.close()
    }

    func testBackgroundReservationCountsAgainstLaterForegroundSelection() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        var state = try journal.load()
        state.unconfirmedReleaseIds = (0..<127).map { "01900000-0000-7000-8000-" + String(format: "%012x", 1000 + $0) }
        try journal.save(state)
        let task = try host.beginBackground()
        XCTAssertEqual(task.snapshot.selection.releaseId, releaseB)
        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C", background: true)
        let controller = try host.createForeground()
        XCTAssertEqual(controller.runningSelection.kind, "BUILTIN")
        try controller.close()
        try task.reportFatal()
        XCTAssertEqual(try journal.load().unconfirmedReleaseIds.count, 128)
        try task.executionEnded()
    }

    func testBuiltinFailureMarkerSurvivesSignedEmbeddedFatalAndBlocksForegroundFallback() throws {
        let (root, _, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let task = try host.beginBackground()
        try task.reportFatal()
        try task.executionEnded()
        var state = try journal.load()
        let signed = try LynxStoredSelection(receipt(releaseId: releaseB, bundleId: embeddedId,
            contextHash: "v1:0000000000000000", kind: "EMBEDDED"), manifestDigest: host.scope.embeddedArtifact.manifestDigest)
        try state.recordFatal(signed, embeddedBundleId: embeddedId)
        try journal.save(state)
        XCTAssertEqual(try journal.load().failedEmbedded?.policy.kind, "BUILTIN")
        XCTAssertEqual(try journal.load().unconfirmedReleaseIds, [releaseB])
        XCTAssertThrowsError(try host.beginBackground())
        XCTAssertThrowsError(try host.createForeground())
    }
}

extension LynxControllerLocalTests {
    func testBackgroundReservationAfterPreparationBlocksSameByteAdoptionUntilTaskEnds() async throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        var stored = try journal.load()
        stored.unconfirmedReleaseIds = (0..<127).map { "01900000-0000-7000-8000-" + String(format: "%012x", 1000 + $0) }
        try journal.save(stored)
        let controller = try host.createForeground()
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        let native = try snapshot(controller, context, config)
        let bytes = try catalogJSON(releases: [(releaseC, bundleB), (releaseB, bundleB)], generation: 3)
        let accepted = try controller.acceptCatalog(bytes, expectedRevision: native.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: native), context: context)
        let selected = receipt(releaseId: releaseC, bundleId: bundleB,
            contextHash: accepted.selectionContextHash, generation: 3)
        let prepared = try await controller.prepareSelection(guard: accepted, receipt: selected, artifact: nil, context: context)
        let revision = try journal.load().revision
        let task = try host.beginBackground()
        XCTAssertEqual(task.snapshot.selection.releaseId, releaseB)
        XCTAssertEqual(try journal.load().revision, revision)
        XCTAssertThrowsError(try controller.stageSelection(prepared, context: context))
        XCTAssertEqual(controller.runningSelection.releaseId, releaseB)
        XCTAssertEqual(try journal.load().unconfirmedReleaseIds.count, 127)
        try task.executionEnded()
        let retry = try await controller.prepareSelection(guard: accepted, receipt: selected, artifact: nil, context: context)
        XCTAssertEqual(try controller.stageSelection(retry, context: context)["status"] as? String, "ADOPTED")
        XCTAssertEqual(controller.runningSelection.releaseId, releaseC)
        try controller.close()
    }

    func testBackgroundAndForegroundScopesRejectConflictingNativeConfiguration() throws {
        let (root, config, host, _) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let alias = LynxControllerConfiguration(root: config.root.appendingPathComponent("."),
            runtimeId: config.runtimeId, binaryIdentity: config.binaryIdentity,
            embeddedDirectory: config.embeddedDirectory, embeddedBundleId: config.embeddedBundleId,
            embeddedManifestDigest: config.embeddedManifestDigest, minimumBundleId: config.minimumBundleId,
            appVersion: config.appVersion, channel: config.channel, cohort: config.cohort)
        XCTAssertTrue(try LynxRuntimeHost.get(configuration: alias) === host)
        let conflict = LynxControllerConfiguration(root: config.root,
            runtimeId: config.runtimeId, binaryIdentity: config.binaryIdentity,
            embeddedDirectory: config.embeddedDirectory, embeddedBundleId: config.embeddedBundleId,
            embeddedManifestDigest: config.embeddedManifestDigest, minimumBundleId: config.minimumBundleId,
            appVersion: config.appVersion, channel: config.channel, cohort: config.cohort,
            fingerprintHash: "different-binary-fingerprint")
        XCTAssertThrowsError(try LynxRuntimeHost.get(configuration: conflict))
        XCTAssertThrowsError(try LynxController(configuration: conflict))
        let task = try host.beginBackground()
        try task.executionEnded()
    }
}

extension LynxControllerLocalTests {
    func testRetiredControllerCannotReplayTaskFailureOverReplacementJournal() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let retired = try host.createForeground()
        let staleContext = retired.createContext(primary: true)
        try retired.close()
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        let current = try host.createForeground()
        let context = current.createContext(primary: true)
        _ = try current.begin(context)
        let task = try host.beginBackground()
        let backup = journal.file.appendingPathExtension("backup")
        try FileManager.default.moveItem(at: journal.file, to: backup)
        try FileManager.default.createDirectory(at: journal.file, withIntermediateDirectories: false)
        XCTAssertThrowsError(try task.reportFatal())
        try FileManager.default.removeItem(at: journal.file)
        try FileManager.default.moveItem(at: backup, to: journal.file)
        let before = try Data(contentsOf: journal.file)
        XCTAssertThrowsError(try retired.begin(staleContext))
        XCTAssertEqual(try Data(contentsOf: journal.file), before)
        try task.executionEnded()
        XCTAssertEqual(try journal.load().pending?.contextId, context.id)
        XCTAssertEqual(try journal.load().unconfirmedReleaseIds, [releaseB])
        try current.close()
    }

    func testAuthenticatedBundleReleaseOnEmbeddedBytesCanPersistFatalAndRecoverBuiltin() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-embedded-bundle-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let embedded = root.appendingPathComponent("embedded")
        let digest = try writeTree(at: embedded, bundleId: bundleB, marker: "A", background: true)
        let config = LynxControllerConfiguration(root: root.appendingPathComponent("store"), runtimeId: runtime,
            binaryIdentity: "registered-embedded-binary", embeddedDirectory: embedded, embeddedBundleId: bundleB,
            embeddedManifestDigest: digest, minimumBundleId: embeddedId, appVersion: "1.0.0", channel: channel, cohort: "1")
        let host = try LynxRuntimeHost.get(configuration: config)
        let journal = LynxControllerJournal(file: host.scope.home.appendingPathComponent("state.json"))
        let controller = try host.createForeground()
        let context = controller.createContext(primary: true)
        _ = try controller.begin(context)
        try confirm(controller, context)
        let native = try snapshot(controller, context, config)
        let accepted = try controller.acceptCatalog(try catalogJSON(releases: [(releaseB, config.embeddedBundleId)]),
            expectedRevision: native.revision, contextHash: LynxCatalogPolicy.contextHash(snapshot: native), context: context)
        let selected = receipt(releaseId: releaseB, bundleId: config.embeddedBundleId, contextHash: accepted.selectionContextHash)
        let token = try await controller.prepareSelection(guard: accepted, receipt: selected, artifact: nil, context: context)
        XCTAssertEqual(try controller.stageSelection(token, context: context)["status"] as? String, "ADOPTED")
        let task = try host.beginBackground()
        XCTAssertEqual(task.snapshot.selection.kind, "BUNDLE")
        try task.reportFatal()
        try task.executionEnded()
        XCTAssertEqual(try journal.load().failedEmbedded?.policy.kind, "BUNDLE")
        try controller.close()
        let recovered = try host.createForeground()
        XCTAssertEqual(recovered.runningSelection.kind, "BUILTIN")
        try recovered.close()
    }
}

extension LynxControllerLocalTests {
    func testColdBackgroundRespectsRetryHoldWithoutArmingOrConsumingIt() throws {
        for (ready, sameProcess, expectedBundle) in [(false, false, embeddedId), (true, true, embeddedId), (true, false, bundleB)] {
            let (root, config, host, journal) = try backgroundFixture()
            defer { try? FileManager.default.removeItem(at: root) }
            try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
            var state = try journal.load()
            state.interruptedReleases = [releaseB: .init(bundleId: bundleB, retryReady: ready,
                holdProcessToken: sameProcess ? LynxController.processToken : UUID().uuidString)]
            try journal.save(state)
            let before = try Data(contentsOf: journal.file)
            let task = try host.beginBackground()
            XCTAssertEqual(task.snapshot.selection.bundleId, expectedBundle)
            try task.executionEnded()
            XCTAssertEqual(try Data(contentsOf: journal.file), before)
        }
    }

    func testSameReleaseBackgroundTasksKeepFinalRecoverySlotUntilLastExecutionEnds() throws {
        let (root, config, host, journal) = try backgroundFixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try plantNext(config, releaseId: releaseB, bundleId: bundleB, marker: "B", background: true)
        var state = try journal.load()
        state.unconfirmedReleaseIds = (0..<127).map { "01900000-0000-7000-8000-" + String(format: "%012x", 1000 + $0) }
        try journal.save(state)
        let tasks = try (0..<4).map { _ in try host.beginBackground() }
        XCTAssertTrue(tasks.allSatisfy { $0.snapshot.selection.releaseId == releaseB })
        try plantNext(config, releaseId: releaseC, bundleId: bundleC, marker: "C", background: true)
        let before = try Data(contentsOf: journal.file)
        for task in tasks.dropLast() { try task.executionEnded() }
        XCTAssertThrowsError(try host.beginBackground())
        XCTAssertEqual(try Data(contentsOf: journal.file), before)
        try tasks.last!.executionEnded()
        let next = try host.beginBackground()
        XCTAssertEqual(next.snapshot.selection.releaseId, releaseC)
        XCTAssertEqual(try Data(contentsOf: journal.file), before)
        try next.executionEnded()
    }
}
