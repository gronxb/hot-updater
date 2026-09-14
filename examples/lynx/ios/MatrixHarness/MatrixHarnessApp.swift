import HotUpdaterLynxSparkling
import Sparkling
import SparklingMacro
import SparklingMethod
import SwiftUI
import UIKit

final class MatrixHarnessAppDelegate: NSObject, UIApplicationDelegate {
    private var eventSink: MatrixEventSink?
    private var host: MatrixHost?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [
            UIApplication.LaunchOptionsKey: Any
        ]? = nil
    ) -> Bool {
        SPKServiceRegister.registerAll()
        SPKExecuteAllPrepareBootTask()
        do {
            let framework = MatrixHost.requestedFramework ?? "react"
            let sink = MatrixEventSink(framework: framework)
            eventSink = sink
            host = try MatrixHost(
                framework: framework,
                events: sink.handler
            )
            return true
        } catch {
            NSLog("Public Lynx matrix host failed: %@", error.localizedDescription)
            return false
        }
    }
}

private final class MatrixHost {
    static let runtimeId =
        "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"
    static var shared: MatrixHost?

    static var requestedFramework: String? {
        let argument = ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-framework=")
        }
        guard let name = argument.map({
            String($0.dropFirst("--ota-framework=".count))
        }), ["react", "vue", "octane"].contains(name) else { return nil }
        return name
    }

    static var requestedChannel: String? {
        let argument = ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-channel=")
        }
        guard let channel = argument.map({
            String($0.dropFirst("--ota-channel=".count))
        }), !channel.isEmpty else { return nil }
        return channel
    }

    static var requestedEmbeddedDir: URL? {
        let argument = ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-embedded-dir=")
        }
        guard let path = argument.map({
            String($0.dropFirst("--ota-embedded-dir=".count))
        }), !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }

    let managed: HotUpdaterSparklingHost

    init(
        framework: String,
        events: HotUpdaterSparklingEventHandler? = nil
    ) throws {
        let home = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("HotUpdaterLynxPublic")
        try FileManager.default.createDirectory(
            at: home,
            withIntermediateDirectories: true
        )
        let embeddedRoot = Bundle.main.resourceURL!
            .appendingPathComponent("Embedded/Public")
        let embeddedDirectory = Self.requestedEmbeddedDir
            ?? embeddedRoot.appendingPathComponent(framework)
        let native = try JSONSerialization.jsonObject(
            with: Data(contentsOf: embeddedRoot.appendingPathComponent(
                framework + "-native.json"
            ))
        ) as! [String: String]
        guard native["runtimeId"] == Self.runtimeId,
              native["variant"] != nil,
              let embeddedBundleId = native["bundleId"],
              let minimumBundleId = native["minimumBundleId"],
              let embeddedManifestDigest = native["manifestDigest"] else {
            throw HotUpdaterSparklingError.invalidEmbeddedArtifact
        }
        let configuration = try HotUpdaterSparklingConfiguration(
            storeURL: home.appendingPathComponent("stores"),
            runtimeId: Self.runtimeId,
            embeddedDirectory: embeddedDirectory,
            embeddedBundleId: embeddedBundleId,
            embeddedManifestDigest: embeddedManifestDigest,
            minimumBundleId: minimumBundleId,
            appVersion: "1.0.0",
            channel: Self.requestedChannel ?? "ota-\(framework)",
            cohort: "1",
            publicKeyPEM: Bundle.main.object(
                forInfoDictionaryKey: "HOT_UPDATER_PUBLIC_KEY"
            ) as? String,
            fingerprintHash: Bundle.main.object(
                forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH"
            ) as? String
        )
        managed = try HotUpdaterSparklingHost(
            configuration: configuration,
            events: events,
            launchConfiguration: try HotUpdaterSparklingLaunchConfiguration
                .parse(arguments: ProcessInfo.processInfo.arguments)
        )
        Self.shared = self
    }
}

private final class MatrixEventSink {
    private let framework: String
    private let lock = NSLock()

    init(framework: String) {
        self.framework = framework
    }

    lazy var handler: HotUpdaterSparklingEventHandler = { [weak self] name, details in
        guard let self else { return }
        var event = details
        event["event"] = name
        event["observedAt"] = ISO8601DateFormatter().string(from: Date())
        event["framework"] = framework
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(
                  withJSONObject: event,
                  options: [.sortedKeys]
              ),
              let encoded = String(data: data, encoding: .utf8) else {
            NSLog("HotUpdaterLynx matrix event serialization failed: %@", name)
            return
        }
        let home = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("HotUpdaterLynxPublic")
        try? FileManager.default.createDirectory(
            at: home,
            withIntermediateDirectories: true
        )
        let file = home.appendingPathComponent("matrix-events.jsonl")
        lock.lock()
        defer { lock.unlock() }
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: file) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.write(contentsOf: Data([0x0a]))
            try? handle.close()
        }
        NSLog("HotUpdaterLynx HOT_UPDATER_MATRIX_EVENT %@", encoded)
    }
}

@main
struct SparklingMatrixHarnessApp: App {
    @UIApplicationDelegateAdaptor(MatrixHarnessAppDelegate.self)
    var appDelegate

    var body: some Scene {
        WindowGroup {
            MatrixHarnessView().ignoresSafeArea()
        }
    }
}

private struct MatrixHarnessView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        MatrixHarnessViewController(host: MatrixHost.shared!.managed)
    }

    func updateUIViewController(
        _ uiViewController: UIViewController,
        context: Context
    ) {}
}

/** QA-only shell. Every lifecycle action delegates to the packaged host API. */
private final class MatrixHarnessViewController: UIViewController {
    private let host: HotUpdaterSparklingHost
    private let content = UIStackView()
    private var containers: [HotUpdaterSparklingViewController] = []
    private var staleProbe: HotUpdaterSparklingStaleProbe?

    init(host: HotUpdaterSparklingHost) {
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        content.axis = .vertical
        content.frame = view.bounds
        content.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(content)

        let actions = UIStackView(arrangedSubviews: [
            button("Replace primary", action: #selector(replacePrimary)),
            button("Verify stale after reload", action: #selector(verifyStale)),
            button("Fail secondary", action: #selector(failSecondary)),
            button("Hold secondary", action: #selector(holdSecondary)),
            button("Reload pending", action: #selector(reloadPending)),
            button("Exercise stack boundary", action: #selector(exerciseStack)),
            button("Exercise event boundaries", action: #selector(exerciseEvents)),
            button("Exercise journal fixtures", action: #selector(exerciseJournal)),
        ])
        actions.distribution = .fillEqually
        content.addArrangedSubview(actions)
        install(try! host.makeViewController())
        staleProbe = host.captureDiagnosticAuthorities()
    }

    @objc private func replacePrimary() {
        staleProbe = host.captureDiagnosticAuthorities()
        host.triggerReloadForDiagnostics { result in
            if case .failure(let error) = result {
                NSLog("Managed reload failed: %@", error.localizedDescription)
            }
        }
    }

    @objc private func verifyStale() {
        staleProbe!.verifyStaleAuthorities()
    }

    @objc private func failSecondary() {
        staleProbe = host.captureDiagnosticAuthorities()
        host.armNextPageFatalFailureForDiagnostics()
    }

    @objc private func holdSecondary() {
        host.armNextPageAdmissionPendingForDiagnostics()
    }

    @objc private func reloadPending() {
        host.triggerReloadForDiagnostics { result in
            if case .failure(let error) = result {
                NSLog("Managed pending reload failed: %@", error.localizedDescription)
            }
        }
    }

    @objc private func exerciseStack() {
        recordDiagnostic("navigationStackBoundary") {
            try host.exerciseNavigationStackBoundaryForDiagnostics()
        }
    }

    @objc private func exerciseEvents() {
        recordDiagnostic("runtimeEventFieldBoundaries") {
            [
                "result": try host
                    .exerciseRuntimeEventFieldBoundariesForDiagnostics(),
                "receipt": try receiptSummary(
                    host.runtimeJournalFixtureReceiptForDiagnostics()
                ),
            ]
        }
    }

    @objc private func exerciseJournal() {
        recordDiagnostic("runtimeJournalFixtures") {
            let modes = [
                "retention-limit", "count-plus-one", "byte-plus-one",
                "corrupt-json", "noncanonical", "already-oversized",
            ]
            var fixtures: [[String: Any]] = []
            defer { try? host.restoreRuntimeJournalFixtureForDiagnostics() }
            for mode in modes {
                try host.installRuntimeJournalFixtureForDiagnostics(mode)
                var item: [String: Any] = [
                    "mode": mode,
                    "installed": try receiptSummary(
                        host.runtimeJournalFixtureReceiptForDiagnostics()
                    ),
                ]
                if mode != "retention-limit" {
                    guard host.appendRuntimeJournalFixtureEventForDiagnostics()
                    else { throw MatrixDiagnosticError.appendRejected }
                    item["afterAppend"] = try receiptSummary(
                        host.runtimeJournalFixtureReceiptForDiagnostics()
                    )
                }
                try host.reopenRuntimeJournalFixtureForDiagnostics()
                item["afterReopen"] = try receiptSummary(
                    host.runtimeJournalFixtureReceiptForDiagnostics()
                )
                fixtures.append(item)
            }
            try host.restoreRuntimeJournalFixtureForDiagnostics()
            return [
                "fixtures": fixtures,
                "restored": try receiptSummary(
                    host.runtimeJournalFixtureReceiptForDiagnostics()
                ),
            ]
        }
    }

    private func receiptSummary(_ receipt: [String: Any]) throws
        -> [String: Any] {
        guard let snapshot = receipt["snapshot"] as? [String: Any],
              let events = snapshot["events"] as? [[String: Any]] else {
            throw MatrixDiagnosticError.invalidReceipt
        }
        return [
            "processId": receipt["processId"]!,
            "schemaVersion": snapshot["schemaVersion"]!,
            "oldestSequence": snapshot["oldestSequence"]!,
            "latestSequence": snapshot["latestSequence"]!,
            "truncated": snapshot["truncated"]!,
            "eventCount": events.count,
            "byteLength": receipt["byteLength"]!,
            "sha256": receipt["sha256"]!,
            "canonicalUtf8": receipt["canonicalUtf8"]!,
        ]
    }

    private func recordDiagnostic(
        _ action: String,
        operation: () throws -> [String: Any]
    ) {
        let record: [String: Any]
        do {
            record = [
                "action": action,
                "processId": String(ProcessInfo.processInfo.processIdentifier),
                "ok": true,
                "data": try operation(),
            ]
        } catch {
            record = [
                "action": action,
                "processId": String(ProcessInfo.processInfo.processIdentifier),
                "ok": false,
                "error": error.localizedDescription,
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: record),
              let encoded = String(data: data, encoding: .utf8) else { return }
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("HotUpdaterLynxPublic")
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let file = directory.appendingPathComponent("matrix-diagnostics.jsonl")
        if let handle = try? FileHandle(forWritingTo: file) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data((encoded + "\n").utf8))
            try? handle.close()
        } else {
            try? Data((encoded + "\n").utf8).write(to: file)
        }
        NSLog("HOT_UPDATER_MATRIX_DIAGNOSTIC %@", encoded)
    }

    private func install(
        _ next: HotUpdaterSparklingViewController
    ) {
        containers.forEach { container in
            content.removeArrangedSubview(container.view)
            container.view.removeFromSuperview()
            container.willMove(toParent: nil)
            container.removeFromParent()
        }
        containers = [next]
        addChild(next)
        content.addArrangedSubview(next.view)
        next.didMove(toParent: self)
    }

    private func button(
        _ title: String,
        action: Selector
    ) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.accessibilityLabel = title
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }
}

private enum MatrixDiagnosticError: LocalizedError {
    case appendRejected
    case invalidReceipt

    var errorDescription: String? {
        switch self {
        case .appendRejected: return "Runtime journal append was rejected"
        case .invalidReceipt: return "Runtime journal receipt is invalid"
        }
    }
}
