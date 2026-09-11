import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxControllerTests: XCTestCase {
    private let runtime = "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2"
    private func fixture() async throws -> (URL, LynxControllerConfiguration, Data, LynxArtifactRequest) {
        guard let origin = ProcessInfo.processInfo.environment["LYNX_ARTIFACT_TEST_ORIGIN"],
              let embeddedPath = ProcessInfo.processInfo.environment["LYNX_CONTROLLER_EMBEDDED"] else { throw XCTSkip("Requires frozen native embedded fixture and real CLI service") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lynx-controller-\(UUID().uuidString)")
        let embedded = URL(fileURLWithPath: embeddedPath)
        let manifest = try Data(contentsOf: embedded.appendingPathComponent("manifest.json"))
        let manifestJSON = try JSONSerialization.jsonObject(with: manifest) as! [String: Any]
        let (receiptData, _) = try await URLSession.shared.data(from: URL(string: origin + "/receipts/react-ios.json")!)
        let receipt = try JSONSerialization.jsonObject(with: receiptData) as! [String: Any]
        let (catalog, _) = try await URLSession.shared.data(from: URL(string: receipt["catalogUrl"] as! String)!)
        let config = LynxControllerConfiguration(root: root, runtimeId: runtime, binaryIdentity: "test-native-binary-v1",
            embeddedDirectory: embedded, embeddedBundleId: manifestJSON["bundleId"] as! String,
            embeddedManifestDigest: HashUtils.calculateSHA256(fileURL: embedded.appendingPathComponent("manifest.json"))!,
            minimumBundleId: "00000000-0000-0000-0000-000000000000", appVersion: "1.0.0", channel: receipt["channel"] as! String, cohort: "1")
        return (root, config, catalog, try JSONDecoder().decode(LynxArtifactRequest.self, from: receiptData))
    }
    private func snapshot(_ controller: LynxController, _ context: LynxLaunchContext) throws -> LynxPolicySnapshot {
        let state = try controller.getState(context)
        let expectedKey = Data((state["channel"] as! String).utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(state["channelKey"] as? String, expectedKey)
        return LynxPolicySnapshot(revision: state["revision"] as! String, platform: "ios", appVersion: state["appVersion"] as! String,
            channel: state["channel"] as! String, embeddedBundleId: state["embeddedBundleId"] as! String,
            minimumBundleId: state["minimumBundleId"] as! String, cohort: state["cohort"] as! String,
            runningSelection: try LynxCatalogPolicy.parseReceipt(state["runningSelection"] as! [String: Any]),
            nextSelection: try (state["nextSelection"] as? [String: Any]).map(LynxCatalogPolicy.parseReceipt),
            crashedBundleIds: state["crashedBundleIds"] as! [String], unconfirmedReleaseIds: state["unconfirmedReleaseIds"] as! [String])
    }
    private func confirm(_ controller: LynxController, _ context: LynxLaunchContext) throws {
        try controller.observedContent(context)
        var result: String?
        controller.notifyAppReady(context) { reply in result = try? reply.get() }
        XCTAssertEqual(result, "CONFIRMED")
    }
    private func prepare(_ controller: LynxController, _ context: LynxLaunchContext, _ bytes: Data, _ artifact: LynxArtifactRequest) async throws -> String {
        let native = try snapshot(controller, context)
        let catalog = try LynxCatalogPolicy.parseCatalog(json: bytes, snapshot: native)
        let guardValue = try controller.acceptCatalog(bytes, expectedRevision: native.revision, contextHash: LynxCatalogPolicy.contextHash(snapshot: native), context: context)
        let selected = try XCTUnwrap(LynxCatalogPolicy.desired(catalog: catalog, snapshot: native))
        return try await controller.prepareSelection(guard: guardValue, receipt: selected.receipt, artifact: artifact, context: context)
    }

    func testCatalogPreparationStageAndUnknownTerminationPreserveConfirmed() async throws {
        let (root, config, catalog, artifact) = try await fixture(); defer { try? FileManager.default.removeItem(at: root) }
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true)
        _ = try controller!.begin(context); try confirm(controller!, context)
        let running = controller!.runningSelection
        let token = try await prepare(controller!, context, catalog, artifact)
        XCTAssertTrue(try controller!.getState(context)["nextSelection"] is NSNull)
        let result = try controller!.stageSelection(token, context: context)
        XCTAssertEqual(result["requiresRestart"] as? Bool, true)
        XCTAssertEqual(controller!.runningSelection, running)
        XCTAssertThrowsError(try controller!.stageSelection(token, context: context))
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true)
        let installed = try controller!.begin(context)
        XCTAssertEqual(installed.bundleId, artifact.bundleId)
        XCTAssertNotEqual(controller!.runningSelection.releaseId, nil)
        let release = controller!.runningSelection.releaseId!
        // A process dies after native begin, before attributable application readiness.
        controller = nil
        let cohortChanged = LynxControllerConfiguration(root: config.root, runtimeId: config.runtimeId, binaryIdentity: config.binaryIdentity,
            embeddedDirectory: config.embeddedDirectory, embeddedBundleId: config.embeddedBundleId,
            embeddedManifestDigest: config.embeddedManifestDigest, minimumBundleId: config.minimumBundleId,
            appVersion: config.appVersion, channel: config.channel, cohort: "2")
        controller = try LynxController(configuration: cohortChanged)
        context = controller!.createContext(primary: true); _ = try controller!.begin(context)
        let recovered = try controller!.getState(context)
        XCTAssertEqual(recovered["cohort"] as? String, "2")
        XCTAssertEqual(controller!.runningSelection.bundleId, config.embeddedBundleId)
        XCTAssertEqual(recovered["unconfirmedReleaseIds"] as? [String], [release])
        XCTAssertEqual(recovered["crashedBundleIds"] as? [String], [])
        XCTAssertTrue(recovered["nextSelection"] is NSNull)
    }

    func testNativeContextsAndReadinessAreAttributed() async throws {
        let (root, config, _, _) = try await fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let controller = try LynxController(configuration: config)
        let secondary = controller.createContext(primary: false)
        XCTAssertThrowsError(try controller.begin(secondary))
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary); _ = try controller.begin(secondary)
        XCTAssertThrowsError(try controller.begin(controller.createContext(primary: true)))
        var secondaryRejected = false
        controller.notifyAppReady(secondary) { if case .failure = $0 { secondaryRejected = true } }
        XCTAssertTrue(secondaryRejected)
        var ready: String?
        var primaryFailed = false
        controller.notifyAppReady(primary) { result in ready = try? result.get(); if case .failure = result { primaryFailed = true } }
        XCTAssertNil(ready)
        secondaryRejected = false
        controller.notifyAppReady(secondary) { if case .failure = $0 { secondaryRejected = true } }
        XCTAssertTrue(secondaryRejected)
        XCTAssertFalse(primaryFailed)
        try controller.observedContent(primary)
        XCTAssertEqual(ready, "CONFIRMED")
        controller.notifyAppReady(primary) { ready = try? $0.get() }
        XCTAssertEqual(ready, "ALREADY_CONFIRMED")
        controller.destroy(primary)
        XCTAssertThrowsError(try controller.getState(primary))
        XCTAssertThrowsError(try controller.resource("hot-updater:///main.lynx.bundle", context: primary))
        XCTAssertThrowsError(try controller.resource("hot-updater:///unlisted.js", context: secondary))
    }

    func testAcceptanceRevocationInvalidatesPreparedTokenWithoutChangingRunning() async throws {
        let (root, config, bytes, artifact) = try await fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let controller = try LynxController(configuration: config)
        let context = controller.createContext(primary: true); _ = try controller.begin(context); try confirm(controller, context)
        let token = try await prepare(controller, context, bytes, artifact)
        var revoked = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        revoked["generation"] = (revoked["generation"] as! Int) + 1
        revoked["catalogHash"] = "sha256:" + String(repeating: "b", count: 64)
        revoked["releases"] = []; revoked["rollbackReleases"] = []
        let current = try snapshot(controller, context)
        _ = try controller.acceptCatalog(JSONSerialization.data(withJSONObject: revoked), expectedRevision: current.revision,
            contextHash: LynxCatalogPolicy.contextHash(snapshot: current), context: context)
        XCTAssertThrowsError(try controller.stageSelection(token, context: context))
        XCTAssertEqual(controller.runningSelection.bundleId, config.embeddedBundleId)
        XCTAssertTrue(try controller.getState(context)["nextSelection"] is NSNull)
    }
    func testEmbeddedReleaseUnknownOrFatalSuppressionKeepsBuiltinUsable() async throws {
        for knownFatal in [false, true] {
        let (root, config, original, _) = try await fixture(); defer { try? FileManager.default.removeItem(at: root) }
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true); _ = try controller!.begin(context)
        var wire = try JSONSerialization.jsonObject(with: original) as! [String: Any]
        var descriptor = (wire["releases"] as! [[String: Any]])[0]
        descriptor["kind"] = "EMBEDDED"; descriptor["bundleId"] = NSNull()
        wire["releases"] = [descriptor]; wire["rollbackReleases"] = [descriptor]
        let bytes = try JSONSerialization.data(withJSONObject: wire)
        let current = try snapshot(controller!, context)
        let catalog = try LynxCatalogPolicy.parseCatalog(json: bytes, snapshot: current)
        let guardValue = try controller!.acceptCatalog(bytes, expectedRevision: current.revision, contextHash: LynxCatalogPolicy.contextHash(snapshot: current), context: context)
        let receipt = try XCTUnwrap(LynxCatalogPolicy.desired(catalog: catalog, snapshot: current)).receipt
        let token = try await controller!.prepareSelection(guard: guardValue, receipt: receipt, artifact: nil, context: context)
        XCTAssertEqual(try controller!.stageSelection(token, context: context)["requiresRestart"] as? Bool, true)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true); _ = try controller!.begin(context)
        XCTAssertEqual(controller!.runningSelection.kind, "EMBEDDED")
        if knownFatal { try controller!.reportFailure(context, fatal: true) }
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true); _ = try controller!.begin(context)
        let recovered = try controller!.getState(context)
        XCTAssertEqual(controller!.runningSelection.kind, "BUILTIN")
        XCTAssertEqual(recovered["unconfirmedReleaseIds"] as? [String], [receipt.releaseId!])
        XCTAssertEqual(recovered["crashedBundleIds"] as? [String], [])
        }
    }

    func testSameByteAuthorizedAdoptionKeepsProcessReceiptAndConfirmation() async throws {
        let (root, config, original, artifact) = try await fixture(); defer { try? FileManager.default.removeItem(at: root) }
        var controller: LynxController? = try LynxController(configuration: config)
        var context = controller!.createContext(primary: true); _ = try controller!.begin(context); try confirm(controller!, context)
        let token = try await prepare(controller!, context, original, artifact)
        _ = try controller!.stageSelection(token, context: context)
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true); _ = try controller!.begin(context); try confirm(controller!, context)
        let immutableRunning = controller!.runningSelection
        var wire = try JSONSerialization.jsonObject(with: original) as! [String: Any]
        wire["generation"] = (wire["generation"] as! Int) + 1
        wire["catalogHash"] = "sha256:" + String(repeating: "c", count: 64)
        var descriptor = (wire["releases"] as! [[String: Any]])[0]
        descriptor["releaseId"] = "01a08fff-aaaa-7000-8000-000000000003"
        wire["releases"] = [descriptor]; wire["rollbackReleases"] = [descriptor]
        let bytes = try JSONSerialization.data(withJSONObject: wire)
        let current = try snapshot(controller!, context)
        let catalog = try LynxCatalogPolicy.parseCatalog(json: bytes, snapshot: current)
        let guardValue = try controller!.acceptCatalog(bytes, expectedRevision: current.revision, contextHash: LynxCatalogPolicy.contextHash(snapshot: current), context: context)
        let receipt = try XCTUnwrap(LynxCatalogPolicy.desired(catalog: catalog, snapshot: current)).receipt
        let adopted = try await controller!.prepareSelection(guard: guardValue, receipt: receipt, artifact: nil, context: context)
        let result = try controller!.stageSelection(adopted, context: context)
        XCTAssertEqual(result["status"] as? String, "ADOPTED")
        XCTAssertEqual(result["requiresRestart"] as? Bool, false)
        XCTAssertEqual(controller!.runningSelection, immutableRunning)
        XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, true)
        // A delayed resource/content event after same-byte adoption cannot confirm old provenance again.
        XCTAssertNoThrow(try controller!.observedResource("assets/probe.png", context: context))
        XCTAssertNoThrow(try controller!.observedContent(context))
        controller = nil
        controller = try LynxController(configuration: config)
        context = controller!.createContext(primary: true); _ = try controller!.begin(context)
        XCTAssertEqual(controller!.runningSelection.releaseId, receipt.releaseId)
        XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, true)
    }

    func testFatalAndObserverConfirmationPersistenceFailuresCannotConfirm() async throws {
        for knownFatal in [false, true] {
            let (root, config, catalog, artifact) = try await fixture(); defer { try? FileManager.default.removeItem(at: root) }
            var controller: LynxController? = try LynxController(configuration: config)
            var context = controller!.createContext(primary: true); _ = try controller!.begin(context); try confirm(controller!, context)
            let token = try await prepare(controller!, context, catalog, artifact)
            _ = try controller!.stageSelection(token, context: context)
            controller = nil
            controller = try LynxController(configuration: config)
            context = controller!.createContext(primary: true); _ = try controller!.begin(context)
            let failedRelease = controller!.runningSelection.releaseId!
            let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
            let file = try XCTUnwrap(enumerator.compactMap { $0 as? URL }.first { $0.lastPathComponent == "state.json" })
            let backup = file.appendingPathExtension("backup")
            try FileManager.default.moveItem(at: file, to: backup)
            try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
            var failures = 0
            controller!.notifyAppReady(context) { if case .failure = $0 { failures += 1 } }
            XCTAssertEqual(failures, 0)
            if knownFatal { XCTAssertThrowsError(try controller!.reportFailure(context, fatal: true)) }
            else { XCTAssertThrowsError(try controller!.observedContent(context)) }
            XCTAssertEqual(failures, 1)
            try FileManager.default.removeItem(at: file)
            try FileManager.default.moveItem(at: backup, to: file)
            if knownFatal { XCTAssertThrowsError(try controller!.getState(context)) }
            else {
                // Restored storage plus an unrelated late resource must not silently retry rejected readiness.
                try controller!.observedResource("assets/probe.png", context: context)
                XCTAssertEqual(try controller!.getState(context)["runningConfirmed"] as? Bool, false)
            }
            controller = nil
            controller = try LynxController(configuration: config)
            context = controller!.createContext(primary: true); _ = try controller!.begin(context)
            XCTAssertEqual(controller!.runningSelection.bundleId, config.embeddedBundleId)
            XCTAssertEqual(try controller!.getState(context)["unconfirmedReleaseIds"] as? [String], [failedRelease])
        }
    }

}
