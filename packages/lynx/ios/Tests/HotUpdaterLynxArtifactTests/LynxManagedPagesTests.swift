import CryptoKit
import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxManagedPagesTests: XCTestCase {
    private let bundleId = "01900000-0000-7000-8000-000000000060"
    private let runtimeId =
        "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"

    func testUnknownPageFailsBeforeAdmissionAndValidPageNeedsAllSignals() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        try confirmPrimary(controller, primary)

        let unknown = controller.createContext(primary: false)
        XCTAssertThrowsError(try controller.begin(
            unknown,
            pageEntry: "unknown.lynx.bundle",
            generationId: "generation-1",
            stack: [
                .init(entry: "main.lynx.bundle"),
                .init(entry: "unknown.lynx.bundle"),
            ]
        ))

        let detail = controller.createContext(primary: false)
        let stack = [
            LynxManagedLogicalPage(entry: "main.lynx.bundle"),
            LynxManagedLogicalPage(
                entry: "detail.lynx.bundle",
                parameters: [.init(name: "id", value: "42")]
            ),
        ]
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: stack
        )
        XCTAssertNotNil(try controller.pendingPageAttemptId(detail))
        var result: LynxConfirmationResult?
        controller.notifyAppReady(detail) { result = try? $0.get() }
        try controller.observedContent(detail)
        try controller.observedResource(
            "detail.lynx.bundle",
            context: detail
        )
        XCTAssertNil(result)
        try controller.observedResource("assets/detail.png", context: detail)
        XCTAssertEqual(result?.status, "PAGE_ADMITTED")
        XCTAssertNil(try controller.pendingPageAttemptId(detail))
        XCTAssertFalse(try controller.reportPageFailure(detail))
        var repeated: LynxConfirmationResult?
        controller.notifyAppReady(detail) { repeated = try? $0.get() }
        XCTAssertEqual(repeated?.status, "PAGE_ALREADY_ADMITTED")
        let terminals = try pageTerminals(controller, primary)
        XCTAssertEqual(terminals.count, 1)
        XCTAssertEqual(terminals.first?["terminal"] as? String, "admitted")
    }

    func testCancellationMakesLatePageSignalsStaleWithoutFailureHistory() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        try confirmPrimary(controller, primary)
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: [
                .init(entry: "main.lynx.bundle"),
                .init(entry: "detail.lynx.bundle"),
            ]
        )
        XCTAssertTrue(try controller.cancelPage(
            detail,
            reason: .sparklingClose
        ))
        controller.destroy(detail)
        XCTAssertThrowsError(try controller.observedContent(detail))
        let state = try controller.getState(primary)
        XCTAssertEqual(state["crashedBundleIds"] as? [String], [])
        XCTAssertEqual(state["unconfirmedReleaseIds"] as? [String], [])
    }

    func testReloadAcceptanceAndProcessRecoveryPreserveTheOrderedStack() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        var controller: LynxController? = try LynxController(
            configuration: fixture.configuration
        )
        let primary = controller!.createContext(primary: true)
        _ = try controller!.begin(primary)
        try confirmPrimary(controller!, primary)
        let stack = [
            LynxManagedLogicalPage(entry: "main.lynx.bundle"),
            LynxManagedLogicalPage(
                entry: "detail.lynx.bundle",
                parameters: [
                    .init(name: "id", value: "42"),
                    .init(name: "label", value: "hello world"),
                ]
            ),
        ]
        let acceptance = try controller!.acceptManagedTransition(
            primary,
            trigger: "reload",
            stack: stack
        )
        XCTAssertEqual(acceptance.status, "TRANSITION_ACCEPTED")
        XCTAssertEqual(controller!.managedTransitionId, acceptance.transitionId)
        XCTAssertThrowsError(try controller!.acceptManagedTransition(
            primary,
            trigger: "reload",
            stack: stack
        ))
        try controller!.close()
        XCTAssertThrowsError(try controller!.getState(primary))
        controller = nil

        let recovered = try LynxController(configuration: fixture.configuration)
        XCTAssertEqual(recovered.recoveryPages, stack)
        let newPrimary = recovered.createContext(primary: true)
        _ = try recovered.begin(newPrimary)
        try confirmPrimary(recovered, newPrimary)
        XCTAssertNil(recovered.managedTransitionId)
    }

    func testPendingEmbeddedPageInterruptionFailsClosedAndIsConsumed() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        var controller: LynxController? = try LynxController(
            configuration: fixture.configuration
        )
        let primary = controller!.createContext(primary: true)
        _ = try controller!.begin(primary)
        try confirmPrimary(controller!, primary)
        let stack = [
            LynxManagedLogicalPage(entry: "main.lynx.bundle"),
            LynxManagedLogicalPage(
                entry: "detail.lynx.bundle",
                parameters: [.init(name: "source", value: "deep-link")]
            ),
        ]
        let detail = controller!.createContext(primary: false)
        _ = try controller!.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-before-death",
            stack: stack
        )
        controller = nil

        XCTAssertThrowsError(try LynxController(
            configuration: fixture.configuration
        ))

        let nextLaunch = try LynxController(
            configuration: fixture.configuration
        )
        XCTAssertTrue(nextLaunch.recoveryPages.isEmpty)
        let recoveredTerminal = try XCTUnwrap(
            nextLaunch.recoveredPageAttemptTerminals.first
        )
        XCTAssertEqual(recoveredTerminal["terminal"] as? String, "process-interruption")
        let recoveredAttemptId = try XCTUnwrap(
            recoveredTerminal["pageAttemptId"] as? String
        )
        let context = nextLaunch.createContext(primary: true)
        _ = try nextLaunch.begin(context)
        let state = try nextLaunch.getState(context)
        XCTAssertEqual(state["crashedBundleIds"] as? [String], [])
        XCTAssertEqual(state["unconfirmedReleaseIds"] as? [String], [])
        let terminals = try pageTerminals(nextLaunch, context)
        XCTAssertEqual(terminals.count, 1)
        XCTAssertEqual(terminals.first?["terminal"] as? String, "process-interruption")
        XCTAssertEqual(
            terminals.first?["reason"] as? String,
            "processInterruption"
        )
        try nextLaunch.markRecoveredPageAttemptTerminalEmitted(
            recoveredAttemptId
        )
        try nextLaunch.close()
        let acknowledged = try LynxController(
            configuration: fixture.configuration
        )
        XCTAssertTrue(acknowledged.recoveredPageAttemptTerminals.isEmpty)
    }

    func testPrimaryConfirmationWaitsForPendingSecondaryTerminal() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: [
                .init(entry: "main.lynx.bundle"),
                .init(entry: "detail.lynx.bundle"),
            ]
        )

        try controller.observedResource("main.lynx.bundle", context: primary)
        try controller.observedResource("assets/shared.js", context: primary)
        try controller.observedContent(primary)
        var primaryResult: LynxConfirmationResult?
        controller.notifyAppReady(primary) { primaryResult = try? $0.get() }
        XCTAssertNil(primaryResult)

        XCTAssertTrue(try controller.cancelPage(detail, reason: .nativeBack))
        XCTAssertEqual(primaryResult?.status, "CONFIRMED")
        let terminals = try pageTerminals(controller, primary)
        XCTAssertEqual(terminals.count, 1)
        XCTAssertEqual(
            terminals.first?["terminal"] as? String,
            "authorized-cancel"
        )
        XCTAssertEqual(terminals.first?["reason"] as? String, "nativeBack")
    }

    func testSparklingClosePersistsExactAuthorizedCancelReason() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: [
                .init(entry: "main.lynx.bundle"),
                .init(entry: "detail.lynx.bundle"),
            ]
        )

        XCTAssertTrue(try controller.cancelPage(
            detail,
            reason: .sparklingClose
        ))
        let terminal = try XCTUnwrap(
            pageTerminals(controller, primary).first
        )
        XCTAssertEqual(terminal["terminal"] as? String, "authorized-cancel")
        XCTAssertEqual(terminal["reason"] as? String, "sparklingClose")
    }

    func testDirectResetRejectsPendingPageWithoutInventingCancellation() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: [
                .init(entry: "main.lynx.bundle"),
                .init(entry: "detail.lynx.bundle"),
            ]
        )
        let attemptId = try XCTUnwrap(controller.pendingPageAttemptId(detail))

        XCTAssertThrowsError(try controller.resetChannel(primary))
        XCTAssertEqual(try controller.pendingPageAttemptId(detail), attemptId)
        XCTAssertTrue(try pageTerminals(controller, primary).isEmpty)
    }

    func testManagedPageStackAcceptsSixteenAndRejectsSeventeen() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        let sixteen = [LynxManagedLogicalPage(entry: "main.lynx.bundle")]
            + Array(
                repeating: LynxManagedLogicalPage(
                    entry: "detail.lynx.bundle"
                ),
                count: 15
            )
        let accepted = controller.createContext(primary: false)
        _ = try controller.begin(
            accepted,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: sixteen
        )
        XCTAssertNotNil(try controller.pendingPageAttemptId(accepted))

        let rejected = controller.createContext(primary: false)
        XCTAssertThrowsError(try controller.begin(
            rejected,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: sixteen + [.init(entry: "detail.lynx.bundle")]
        ))
        XCTAssertNotNil(try controller.pendingPageAttemptId(accepted))
    }

    func testPersistedManagedStacksAcceptSixteenAndRejectSeventeen() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let journal = LynxControllerJournal(
            file: directory.appendingPathComponent("state.json")
        )
        let receipt = LynxPolicyReceipt(
            kind: "BUILTIN",
            releaseId: nil,
            bundleId: "embedded",
            catalogId: nil,
            scopeKey: nil,
            generation: nil,
            catalogHash: nil,
            channel: "production",
            selectionContextHash: nil
        )
        let selection = try LynxStoredSelection(
            receipt,
            manifestDigest: String(repeating: "a", count: 64)
        )
        func state(stackDepth: Int) -> LynxControllerState {
            let stack = Array(
                repeating: LynxStoredLogicalPage(
                    entry: "detail.lynx.bundle",
                    parameters: []
                ),
                count: stackDepth
            )
            var state = LynxControllerState()
            state.pendingPages = [.init(
                attemptId: "pending",
                contextId: "pending-context",
                generationId: "generation",
                processId: "1",
                startupAttemptId: "startup",
                selection: selection,
                stack: stack
            )]
            state.pageAttemptTerminals = [.init(
                attemptId: "terminal",
                contextId: "terminal-context",
                generationId: "generation",
                processId: "1",
                startupAttemptId: "startup",
                selection: selection,
                stack: stack,
                terminal: "admitted",
                reason: "admission",
                transitionId: nil,
                failureCode: nil,
                failureResourcePath: nil,
                runtimeEventEmitted: true
            )]
            state.pageAttemptTerminalCount = 1
            state.managedTransition = .init(
                transitionId: "transition",
                trigger: "reload",
                source: selection,
                target: selection,
                stack: stack
            )
            state.managedTerminalFailure = .init(
                failureId: "failure",
                reason: "verifiedFatal",
                message: "failure",
                transitionId: nil,
                processId: "1",
                selection: selection,
                stack: stack
            )
            return state
        }

        try journal.save(state(stackDepth: 16))
        XCTAssertEqual(try journal.load().pendingPages?.first?.stack.count, 16)
        try journal.save(state(stackDepth: 17))
        XCTAssertThrowsError(try journal.load())
    }

    func testManagedTransitionAtomicallyTerminalizesPendingPage() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        try confirmPrimary(controller, primary)
        let stack = [
            LynxManagedLogicalPage(entry: "main.lynx.bundle"),
            LynxManagedLogicalPage(entry: "detail.lynx.bundle"),
        ]
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: stack
        )
        let pageAttemptId = try XCTUnwrap(
            controller.pendingPageAttemptId(detail)
        )

        let acceptance = try controller.acceptManagedTransition(
            primary,
            trigger: "reload",
            stack: stack
        )
        XCTAssertThrowsError(try controller.pendingPageAttemptId(detail))
        try controller.close()
        let recovered = try LynxController(
            configuration: fixture.configuration
        )
        let recoveredPrimary = recovered.createContext(primary: true)
        _ = try recovered.begin(recoveredPrimary)
        let terminal = try XCTUnwrap(
            pageTerminals(recovered, recoveredPrimary).first
        )
        XCTAssertEqual(terminal["pageAttemptId"] as? String, pageAttemptId)
        XCTAssertEqual(terminal["terminal"] as? String, "authorized-cancel")
        XCTAssertEqual(terminal["reason"] as? String, "managedTransition")
        XCTAssertEqual(
            terminal["transitionId"] as? String,
            acceptance.transitionId
        )
    }

    func testAcceptedTransitionRevokesLateOldReadinessUntilReconstruction()
        throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        var controller: LynxController? = try LynxController(
            configuration: fixture.configuration
        )
        let oldPrimary = controller!.createContext(primary: true)
        _ = try controller!.begin(oldPrimary)
        try confirmPrimary(controller!, oldPrimary)
        let acceptance = try controller!.acceptManagedTransition(
            oldPrimary,
            trigger: "reload",
            stack: [.init(entry: "main.lynx.bundle")]
        )

        XCTAssertThrowsError(try controller!.observedResource(
            "assets/shared.js",
            context: oldPrimary
        ))
        XCTAssertThrowsError(try controller!.observedContent(oldPrimary))
        var lateReadyFailed = false
        controller!.notifyAppReady(oldPrimary) {
            if case .failure = $0 { lateReadyFailed = true }
        }
        XCTAssertTrue(lateReadyFailed)
        XCTAssertEqual(controller!.managedTransitionId, acceptance.transitionId)
        XCTAssertThrowsError(try controller!.resetChannel(oldPrimary))
        XCTAssertThrowsError(try controller!.clearCrashHistory(oldPrimary))
        XCTAssertEqual(controller!.managedTransitionId, acceptance.transitionId)
        controller = nil

        let reconstructed = try LynxController(
            configuration: fixture.configuration
        )
        let nextPrimary = reconstructed.createContext(primary: true)
        _ = try reconstructed.begin(nextPrimary)
        try reconstructed.observedResource(
            "main.lynx.bundle",
            context: nextPrimary
        )
        try reconstructed.observedResource(
            "assets/shared.js",
            context: nextPrimary
        )
        try reconstructed.observedContent(nextPrimary)
        var confirmation: LynxConfirmationResult?
        reconstructed.notifyAppReady(nextPrimary) {
            confirmation = try? $0.get()
        }
        XCTAssertNil(confirmation?.transition)
        XCTAssertNil(confirmation?.transitionId)
    }

    func testFatalPersistenceFailureDoesNotPoisonInMemoryGeneration() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let controller = try LynxController(configuration: fixture.configuration)
        let primary = controller.createContext(primary: true)
        _ = try controller.begin(primary)
        try confirmPrimary(controller, primary)
        let detail = controller.createContext(primary: false)
        _ = try controller.begin(
            detail,
            pageEntry: "detail.lynx.bundle",
            generationId: "generation-1",
            stack: [
                .init(entry: "main.lynx.bundle"),
                .init(entry: "detail.lynx.bundle"),
            ]
        )
        let pageAttemptId = try XCTUnwrap(
            controller.pendingPageAttemptId(detail)
        )
        let stateFile = controller.generationEventJournalURL
            .deletingLastPathComponent()
            .appendingPathComponent("state.json")
        try FileManager.default.removeItem(at: stateFile)
        try FileManager.default.createDirectory(
            at: stateFile,
            withIntermediateDirectories: false
        )

        XCTAssertThrowsError(try controller.reportPageFailure(detail))
        XCTAssertEqual(
            try controller.pendingPageAttemptId(detail),
            pageAttemptId
        )
        XCTAssertNoThrow(try controller.observedContent(detail))
    }

    private func pageTerminals(
        _ controller: LynxController,
        _ context: LynxLaunchContext
    ) throws -> [[String: Any]] {
        try XCTUnwrap(
            controller.getState(context)["pageAttemptTerminals"]
                as? [[String: Any]]
        )
    }

    private func confirmPrimary(
        _ controller: LynxController,
        _ context: LynxLaunchContext
    ) throws {
        try controller.observedResource("main.lynx.bundle", context: context)
        try controller.observedResource("assets/shared.js", context: context)
        try controller.observedContent(context)
        var status: String?
        controller.notifyAppReady(context) { status = try? $0.get().status }
        XCTAssertTrue(["CONFIRMED", "ALREADY_CONFIRMED"].contains(status))
    }

    private func makeFixture() throws -> (
        root: URL,
        configuration: LynxControllerConfiguration
    ) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "lynx-managed-controller-\(UUID().uuidString)"
        )
        let embedded = root.appendingPathComponent("embedded")
        try FileManager.default.createDirectory(
            at: embedded,
            withIntermediateDirectories: true
        )
        let metadata: [String: Any] = [
            "schemaVersion": 1,
            "bundleId": bundleId,
            "platform": "ios",
            "runtimeId": runtimeId,
            "entry": "main.lynx.bundle",
            "pageEntries": ["detail.lynx.bundle", "main.lynx.bundle"],
            "pageEssentialResources": [
                [
                    "entry": "detail.lynx.bundle",
                    "resources": ["assets/detail.png", "detail.lynx.bundle"],
                ],
                [
                    "entry": "main.lynx.bundle",
                    "resources": ["assets/shared.js", "main.lynx.bundle"],
                ],
            ],
        ]
        let metadataBytes = try JSONSerialization.data(
            withJSONObject: metadata,
            options: [.sortedKeys]
        )
        let files: [String: Data] = [
            "main.lynx.bundle": Data("main".utf8),
            "detail.lynx.bundle": Data("detail".utf8),
            "assets/detail.png": Data([0x89, 0x50, 0x4e, 0x47]),
            "assets/shared.js": Data("shared".utf8),
            "hot-updater-lynx.json": metadataBytes,
        ]
        var assets: [String: [String: String]] = [:]
        for (path, data) in files {
            let url = embedded.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: url)
            assets[path] = ["fileHash": hash(data)]
        }
        let manifest = try JSONSerialization.data(
            withJSONObject: ["bundleId": bundleId, "assets": assets],
            options: [.sortedKeys]
        )
        try manifest.write(to: embedded.appendingPathComponent("manifest.json"))
        return (
            root,
            .init(
                root: root.appendingPathComponent("store"),
                runtimeId: runtimeId,
                binaryIdentity: "managed-pages-test-binary",
                embeddedDirectory: embedded,
                embeddedBundleId: bundleId,
                embeddedManifestDigest: hash(manifest),
                minimumBundleId: bundleId,
                appVersion: "1.0.0",
                channel: "ota-react",
                cohort: "1"
            )
        )
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
