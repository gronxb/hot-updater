import CryptoKit
import Foundation
import HotUpdaterLynxArtifact
@testable import HotUpdaterLynxSparklingCore
import XCTest

final class SparklingForegroundAdmissionTests: XCTestCase {
    func testSilentLaunchDefersUnrecoverablePageInterruptionUntilForeground() throws {
        let fixture = try Fixture(interruptedPage: true)
        defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.journal)
        let eventsBefore = try Data(contentsOf: fixture.events)
        var creations = 0
        let admission = SparklingForegroundAdmission(create: {
            creations += 1
            return try fixture.host.createForeground()
        }, dispose: { try? $0.close() })
        defer { admission.close() }

        XCTAssertNil(try admission.activate(isForegroundActive: false))
        XCTAssertNil(try admission.activate(isForegroundActive: false))
        XCTAssertEqual(creations, 0)
        XCTAssertEqual(try Data(contentsOf: fixture.journal), before)
        XCTAssertEqual(try Data(contentsOf: fixture.events), eventsBefore)

        // There is no different complete fallback for this interrupted builtin.
        // The real recovery error must occur at foreground admission, not launch.
        XCTAssertThrowsError(try admission.activate(isForegroundActive: true)) { error in
            XCTAssertTrue(error.localizedDescription.contains("no different complete fallback"))
        }
        XCTAssertEqual(creations, 1)
        XCTAssertNil(try admission.activate(isForegroundActive: true))
        XCTAssertEqual(creations, 1)
    }

    func testRepeatedSceneActivationRetainsTheSameRealForegroundOwner() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        var creations = 0
        let admission = SparklingForegroundAdmission(create: {
            creations += 1
            return try fixture.host.createForeground()
        }, dispose: { try? $0.close() })
        defer { admission.close() }
        let foreground = try XCTUnwrap(admission.activate(isForegroundActive: true))
        XCTAssertThrowsError(try fixture.host.createForeground())
        let recovered = try Data(contentsOf: fixture.journal)
        XCTAssertNil(try admission.activate(isForegroundActive: false))
        XCTAssertTrue(try admission.activate(isForegroundActive: true) === foreground)
        XCTAssertTrue(try admission.activate(isForegroundActive: true) === foreground)
        XCTAssertEqual(creations, 1)
        XCTAssertEqual(try Data(contentsOf: fixture.journal), recovered)
        admission.close()
        let replacement = try fixture.host.createForeground()
        try replacement.close()
    }

    func testClosingBeforeSceneActivationNeverStartsForegroundRecovery() throws {
        let fixture = try Fixture(interruptedPage: true)
        defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.journal)
        var creations = 0
        let admission = SparklingForegroundAdmission(create: {
            creations += 1
            return try fixture.host.createForeground()
        }, dispose: { try? $0.close() })
        admission.close()
        admission.close()
        XCTAssertNil(try admission.activate(isForegroundActive: true))
        XCTAssertEqual(creations, 0)
        XCTAssertEqual(try Data(contentsOf: fixture.journal), before)
    }

    func testReentrantCloseDuringConstructionReleasesForegroundOwnership() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        var admission: SparklingForegroundAdmission<LynxController>!
        defer { admission = nil }
        var disposals = 0
        admission = SparklingForegroundAdmission(create: {
            let controller = try fixture.host.createForeground()
            admission.close()
            return controller
        }, dispose: {
            disposals += 1
            try? $0.close()
        })
        XCTAssertNil(try admission.activate(isForegroundActive: true))
        XCTAssertEqual(disposals, 1)
        XCTAssertNil(try admission.activate(isForegroundActive: true))
        admission.close()
        XCTAssertEqual(disposals, 1)
        let foreground = try fixture.host.createForeground()
        try foreground.close()
    }

    func testCloseFromNavigationCallbackImmediatelyRevokesPublishedController() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let admission = SparklingForegroundAdmission(create: {
            try fixture.host.createForeground()
        }, dispose: { try? $0.close() })
        let foreground = try XCTUnwrap(admission.activate(isForegroundActive: true))
        let context = foreground.createContext(primary: true)
        // Navigation events can synchronously close the scene before evaluation.
        let navigationEvent = { admission.close() }
        navigationEvent()
        XCTAssertThrowsError(try foreground.begin(context))
        let replacement = try fixture.host.createForeground()
        try replacement.close()
    }

    private struct Fixture {
        let root: URL
        let host: LynxRuntimeHost
        let journal: URL
        let events: URL

        init(interruptedPage: Bool = false) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("scene-admission-\(UUID())")
            let embedded = root.appendingPathComponent("embedded")
            try FileManager.default.createDirectory(at: embedded, withIntermediateDirectories: true)
            let bundleId = "00000000-0000-0000-0000-000000000000"
            let runtime = "scene-admission-lynx-4"
            let metadata = try JSONSerialization.data(withJSONObject: [
                "schemaVersion": 1, "bundleId": bundleId, "platform": "ios",
                "entry": "main.lynx.bundle", "runtimeId": runtime,
                "pageEntries": ["detail.lynx.bundle", "main.lynx.bundle"],
                "pageEssentialResources": [
                    ["entry": "detail.lynx.bundle", "resources": ["detail.lynx.bundle"]],
                    ["entry": "main.lynx.bundle", "resources": ["main.lynx.bundle"]],
                ],
            ], options: [.sortedKeys])
            let files = ["main.lynx.bundle": Data("main".utf8),
                         "detail.lynx.bundle": Data("detail".utf8),
                         "hot-updater-lynx.json": metadata]
            var assets: [String: [String: String]] = [:]
            for (name, bytes) in files {
                try bytes.write(to: embedded.appendingPathComponent(name))
                assets[name] = ["fileHash": Self.hash(bytes)]
            }
            let manifest = try JSONSerialization.data(withJSONObject: ["bundleId": bundleId, "assets": assets], options: [.sortedKeys])
            try manifest.write(to: embedded.appendingPathComponent("manifest.json"))
            host = try LynxRuntimeHost.get(configuration: .init(
                root: root.appendingPathComponent("store"), runtimeId: runtime,
                binaryIdentity: "binary", embeddedDirectory: embedded,
                embeddedBundleId: bundleId, embeddedManifestDigest: Self.hash(manifest),
                minimumBundleId: bundleId, appVersion: "1.0.0", channel: "production", cohort: "1"
            ))
            let controller = try host.createForeground()
            defer { try? controller.close() }
            events = controller.generationEventJournalURL
            journal = events.deletingLastPathComponent().appendingPathComponent("state.json")
            // Native controller signals are simulated; no Lynx engine is run here.
            let generation = UUID().uuidString
            let primary = controller.createContext(primary: true)
            _ = try controller.begin(primary, pageEntry: "main.lynx.bundle", generationId: generation,
                                     stack: [.init(entry: "main.lynx.bundle")])
            try controller.observedContent(primary)
            try controller.observedResource("main.lynx.bundle", context: primary)
            var status: String?
            controller.notifyAppReady(primary) { status = try? $0.get().status }
            XCTAssertEqual(status, "CONFIRMED")
            if interruptedPage {
                let secondary = controller.createContext(primary: false)
                _ = try controller.begin(secondary, pageEntry: "detail.lynx.bundle", generationId: generation,
                                         stack: [.init(entry: "main.lynx.bundle"), .init(entry: "detail.lynx.bundle")],
                                         sourceContextId: primary.id)
            }
            try Data("{\"events\":[]}".utf8).write(to: events)
        }

        private static func hash(_ bytes: Data) -> String {
            SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }

        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
