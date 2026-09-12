// Public SDK example host. Native configuration owns scope, embedded identity and compatibility.
import Darwin
import Foundation
import HotUpdaterLynxArtifact
import Lynx
import Sparkling
import SwiftUI
import UIKit

final class PublicHost {
    static let runtimeId = "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    static var requestedFramework: String? {
        let argument = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--ota-framework=") }
        guard let name = argument.map({ String($0.dropFirst("--ota-framework=".count)) }), ["react", "vue", "octane"].contains(name) else { return nil }
        return name
    }
    static var requestedChannel: String? {
        let argument = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--ota-channel=") }
        guard let channel = argument.map({ String($0.dropFirst("--ota-channel=".count)) }), !channel.isEmpty else { return nil }
        return channel
    }
    static var requestedEmbeddedDir: URL? {
        let argument = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--ota-embedded-dir=") }
        guard let path = argument.map({ String($0.dropFirst("--ota-embedded-dir=".count)) }), !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }
    static var shared: PublicHost?
    let controller: LynxController
    let context: LynxLaunchContext
    let framework: String
    let home: URL
    private let lock = NSLock()
    private var observation: NSObjectProtocol?
    private var configs: Set<ObjectIdentifier> = []
    init(framework: String) throws {
        self.framework = framework
        home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("HotUpdaterLynxPublic")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let root = Bundle.main.resourceURL!.appendingPathComponent("Embedded/Public")
        let overlay = Self.requestedEmbeddedDir
        let native = overlay == nil
            ? try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(framework + "-native.json"))) as! [String: String]
            : [:]
        let embeddedDirectory: URL
        let embeddedBundleId: String
        let digest: String
        let startupResourcePaths: Set<String>
        if let overlay {
            let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: overlay.appendingPathComponent("hot-updater-lynx.json"))) as! [String: Any]
            guard let bundleId = metadata["bundleId"] as? String, let runtimeId = metadata["runtimeId"] as? String, runtimeId == Self.runtimeId else {
                throw SpikeAdmissionError.invalid("E2E embedded configuration mismatch")
            }
            embeddedDirectory = overlay
            embeddedBundleId = bundleId
            digest = SpikeArtifact.hash(try Data(contentsOf: overlay.appendingPathComponent("manifest.json")))
            startupResourcePaths = []
        } else {
            guard native["runtimeId"] == Self.runtimeId, native["bundleId"] == "00000000-0000-0000-0000-000000000000", let manifestDigest = native["manifestDigest"] else { throw SpikeAdmissionError.invalid("Native embedded configuration mismatch") }
            embeddedDirectory = root.appendingPathComponent(framework)
            embeddedBundleId = native["bundleId"]!
            digest = manifestDigest
            startupResourcePaths = native["variant"] == "sdk1" ? ["assets/probe.png"] : ["assets/probe.png", "assets/probe.ttf", "assets/bootstrap.js", "dynamic/component.lynx.bundle"]
        }
        let publicKeyPEM = Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_PUBLIC_KEY") as? String
        let fingerprintHash = Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH") as? String
        controller = try LynxController(configuration: .init(root: home.appendingPathComponent("stores"), runtimeId: Self.runtimeId,
            binaryIdentity: SpikeArtifact.hash(Data(contentsOf: Bundle.main.executableURL!)), embeddedDirectory: embeddedDirectory,
            embeddedBundleId: embeddedBundleId, embeddedManifestDigest: digest, minimumBundleId: embeddedBundleId,
            appVersion: "1.0.0", channel: Self.requestedChannel ?? "ota-\(framework)", cohort: "1",
            publicKeyPEM: publicKeyPEM, startupResourcePaths: startupResourcePaths,
            fingerprintHash: fingerprintHash))
        context = controller.createContext(primary: true)
        observation = NotificationCenter.default.addObserver(forName: SPKWrapperLynxView.willDestroyNotification, object: nil, queue: nil) { [weak self] notice in
            guard let self, let view = notice.object as? SPKWrapperLynxView, let config = view.lynxConfig else { return }
            self.lock.lock(); let belongs = self.configs.remove(ObjectIdentifier(config)) != nil; self.lock.unlock()
            if belongs { self.controller.destroy(self.context); self.record("contextDestroyed") }
        }
        record("publicProcessSelected", ["running": controller.runningSelection.dictionary, "root": controller.runningArtifact.directory.path])
    }
    func bind(_ config: LynxConfig) {
        lock.lock(); configs.insert(ObjectIdentifier(config)); lock.unlock()
        config.register(HotUpdaterLynx.self, param: HotUpdaterLynxModuleContext(controller: controller, launch: context))
    }
    func record(_ event: String, _ detail: [String: Any] = [:]) {
        lock.lock(); defer { lock.unlock() }
        var row = detail; row["event"] = event; row["framework"] = framework; row["time"] = Date().timeIntervalSince1970
        if let state = try? controller.getState(context) { row["state"] = state }
        guard let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        let file = home.appendingPathComponent("events.jsonl")
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: file) { defer { try? handle.close() }; _ = try? handle.seekToEnd(); try? handle.write(contentsOf: bytes + Data([10])); try? handle.synchronize() }
    }
}

final class PublicResourceLoader: NSObject, SPKResourceLoaderProtocol {
    let host: PublicHost
    let fallback: SPKResourceLoaderProtocol
    init(_ host: PublicHost, fallback: SPKResourceLoaderProtocol) { self.host = host; self.fallback = fallback }
    private func managedURL(_ url: URL?) -> URL? {
        guard let url else { return nil }
        if url.scheme == "hot-updater" { return url }
        let root = host.controller.runningArtifact.directory.path + "/"
        if url.isFileURL, url.path.hasPrefix(root) { return URL(string: "hot-updater:///" + url.path.dropFirst(root.count)) }
        return nil
    }
    func loadResource(withURL url: URL?, completion: @escaping SPKResourceCompletionHandler) -> SPKResourceLoaderTaskProtocol? {
        if let scheme = url?.scheme, ["http", "https"].contains(scheme) { return fallback.loadResource(withURL: url, completion: completion) }
        guard let managed = managedURL(url) else {
            let error = SpikeAdmissionError.invalid("Unsupported local resource addressing; managed resources require hot-updater:///")
            host.record("publicResourceAddressRejected", ["url": url?.absoluteString ?? "nil"])
            try? host.controller.reportFailure(host.context, fatal: true)
            completion(nil, error); return nil
        }
        do {
            let data = try host.controller.resource(managed.absoluteString, context: host.context)
            let path = String(managed.path.dropFirst())
            if path.hasSuffix(".ttf") || path.hasSuffix(".otf") {
                guard let provider = CGDataProvider(data: data as CFData), let font = CGFont(provider) else { throw SpikeAdmissionError.invalid("Invalid managed font") }
                host.record("publicFontDecoded", ["path": path, "font": font.postScriptName as String? ?? "unknown"])
            }
            host.record("publicResourceLoaded", ["path": path, "sha256": SpikeArtifact.hash(data), "bytes": data.count])
            try host.controller.observedResource(path, context: host.context)
            completion(SpikeResource(data), nil)
        } catch {
            host.record("publicResourceError", ["error": error.localizedDescription])
            try? host.controller.reportFailure(host.context, fatal: true)
            completion(nil, error)
        }
        return nil
    }
    func loadImage(withURL url: URL?, completion: @escaping SPKResourceImageCompletionHandler) -> SPKResourceLoaderTaskProtocol? {
        if let scheme = url?.scheme, ["http", "https"].contains(scheme) { return fallback.loadImage(withURL: url, completion: completion) }
        guard let managed = managedURL(url) else {
            let error = SpikeAdmissionError.invalid("Unsupported local image addressing; managed resources require hot-updater:///")
            host.record("publicImageAddressRejected", ["url": url?.absoluteString ?? "nil"])
            try? host.controller.reportFailure(host.context, fatal: true)
            completion(nil, error); return nil
        }
        do {
            let data = try host.controller.resource(managed.absoluteString, context: host.context)
            guard let image = UIImage(data: data) else { throw SpikeAdmissionError.invalid("Invalid managed image") }
            let path = String(managed.path.dropFirst())
            host.record("publicImageDecoded", ["path": path, "sha256": SpikeArtifact.hash(data)])
            try host.controller.observedResource(path, context: host.context)
            completion(image, nil)
        } catch {
            host.record("publicImageError", ["error": error.localizedDescription])
            try? host.controller.reportFailure(host.context, fatal: true)
            completion(nil, error)
        }
        return nil
    }
}

final class PublicLifecycle: NSObject, SPKContainerLifecycleProtocol {
    let host: PublicHost
    private var contentObserved = false
    init(_ host: PublicHost) { self.host = host }
    func containerDidFirstScreen(_ container: SPKContainerProtocol) {
        contentObserved = true
        do { try host.controller.observedContent(host.context); host.record("publicFirstContent") }
        catch { host.record("publicFirstContentRejected", ["error": error.localizedDescription]) }
    }
    func container(_ container: SPKContainerProtocol, didLoadFailedWithURL url: URL?, error: Error?) {
        host.record("publicLoadFailed", ["error": lynxErrorText(error)])
        try? host.controller.reportFailure(host.context, fatal: true)
        exit(0)
    }
    func container(_ container: SPKContainerProtocol, didRecieveError error: Error?) {
        let message = lynxErrorText(error)
        let lynx = error as? LynxError
        let lynxFatal = lynx?.isFatal == true
        let e2eCrash = message.contains("hot-updater e2e crash")
        let fatal = lynxFatal || e2eCrash
        host.record("publicRuntimeError", ["error": message, "fatal": fatal, "code": lynx?.errorCode ?? NSNull()])
        try? host.controller.reportFailure(host.context, fatal: fatal)
        if fatal {
            // Crash-recovery E2E needs a new process. Overlay warnings must not exit.
            exit(0)
        }
    }
    private func lynxErrorText(_ error: Error?) -> String {
        guard let error else { return "unknown" }
        var parts = [error.localizedDescription]
        if let lynx = error as? LynxError {
            parts.append(lynx.summaryMessage)
            parts.append(lynx.rootCause ?? "")
            parts.append(lynx.callStack ?? "")
        }
        return parts.filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

final class PublicContainerController: UIViewController {
    private var child: UIViewController?
    private var lifecycle: PublicLifecycle?
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let host = PublicHost.shared else { return }
        do {
            let artifact = try host.controller.begin(host.context)
            host.record("publicBeforeEvaluation")
            let lifecycle = PublicLifecycle(host); self.lifecycle = lifecycle
            let context = SPKContext(); context.containerLifecycleDelegate = lifecycle
            context.rawViewBuilderBlock = { raw in
                guard let builder = raw as? LynxViewBuilder, let config = builder.config else { return }
                host.bind(config)
            }
            var url = URLComponents(string: "hybrid://lynxview_page")!
            url.queryItems = [URLQueryItem(name: "bundle", value: "hot-updater:///\(artifact.entry)"), URLQueryItem(name: "hide_status_bar", value: "1"), URLQueryItem(name: "hide_nav_bar", value: "1")]
            let child = SPKRouter.create(withURL: url.string!, context: context, frame: UIScreen.main.bounds)
            self.child = child; addChild(child); child.view.frame = view.bounds; view.addSubview(child.view); child.didMove(toParent: self)
        } catch { host.record("publicLaunchRejected", ["error": error.localizedDescription]) }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); child?.view.frame = view.bounds }
}
struct PublicView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { PublicContainerController() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}
