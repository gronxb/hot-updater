import HotUpdaterLynxSparkling
import Sparkling
import SparklingMacro
import SparklingMethod
import SwiftUI
import UIKit

final class MatrixHarnessAppDelegate: NSObject, UIApplicationDelegate {
    private var eventSink: MatrixEventSink?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [
            UIApplication.LaunchOptionsKey: Any
        ]? = nil
    ) -> Bool {
        SPKServiceRegister.registerAll()
        SPKExecuteAllPrepareBootTask()
        do {
            let framework = PublicHost.requestedFramework ?? "react"
            let sink = MatrixEventSink(framework: framework)
            eventSink = sink
            PublicHost.shared = try PublicHost(
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
        MatrixHarnessViewController(host: PublicHost.shared!.managed)
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
        ])
        actions.distribution = .fillEqually
        content.addArrangedSubview(actions)
        install(try! host.makeViewControllers(count: 2))
        staleProbe = host.captureDiagnosticAuthorities()
    }

    @objc private func replacePrimary() {
        staleProbe = host.captureDiagnosticAuthorities()
        containers[0].close()
        install(try! host.makeViewControllers(count: 2))
    }

    @objc private func verifyStale() {
        staleProbe!.verifyStaleAuthorities()
    }

    @objc private func failSecondary() {
        staleProbe = host.captureDiagnosticAuthorities()
        containers[1].triggerFatalFailureForDiagnostics()
    }

    private func install(
        _ next: [HotUpdaterSparklingViewController]
    ) {
        containers.forEach { container in
            content.removeArrangedSubview(container.view)
            container.view.removeFromSuperview()
            container.willMove(toParent: nil)
            container.removeFromParent()
        }
        containers = next
        next.forEach { container in
            addChild(container)
            content.addArrangedSubview(container.view)
            container.didMove(toParent: self)
        }
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
