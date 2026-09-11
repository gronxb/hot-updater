// Copyright 2025 The Sparkling Authors. All rights reserved.
// Licensed under the Apache License Version 2.0. See examples/lynx/licenses/Sparkling-LICENSE.
// Derived from Sparkling's Apache-2.0 production template at c4ce8d25c5ea277e13752d68ff1f2a66f5704240.
// G1 local-loading spike only: placement is manual, without OTA verification.
import CryptoKit
import Foundation
import Lynx
import Sparkling
import SparklingMacro
import SparklingMethod
import SwiftUI
import UIKit

final class SpikeLaunch {
    static let shared = SpikeLaunch()
    let home: URL
    let artifact: SpikeArtifact?
    let journal: SpikeJournal?
    let info: [String: String]
    let binaryHash: String
    let scope: String
    private let lock = NSRecursiveLock()
    private var primary: SpikeContext?
    private var primaryStarted = false
    private var firstContent = false
    private var readyRequested = false
    private var invalidated = false
    private var confirmed = false
    private var loadedResources: Set<String> = []

    var root: URL { artifact!.root }
    var entry: String { artifact!.entry }
    var selection: [String: String] { artifact?.selection ?? [:] }

    private init() {
        home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("HotUpdaterLynxSpike")
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        binaryHash = (try? Data(contentsOf: Bundle.main.executableURL!)).map(SpikeArtifact.hash) ?? "unavailable"
        let requested = (try? SpikeArtifact.readSelection(home.appendingPathComponent("launch.json")))
            ?? (try? SpikeArtifact.readSelection(Bundle.main.resourceURL!.appendingPathComponent("Embedded/react-A.json"))) ?? [:]
        let requestedFramework = requested["release"]?.split(separator: "/").first.map(String.init) ?? "react"
        let framework = ["react", "vue", "octane"].contains(requestedFramework) ? requestedFramework : "react"
        scope = requested["scope"] ?? "g1-\(framework)"
        let embedded = (try? SpikeArtifact.readSelection(Bundle.main.resourceURL!.appendingPathComponent("Embedded/\(framework)-A.json"))) ?? [:]
        var startupEvents: [(String, [String: Any])] = []
        var currentJournal: SpikeJournal?
        do { currentJournal = try SpikeJournal(home: home, binaryHash: binaryHash, scope: scope) }
        catch { startupEvents.append(("journalRejected", ["error": error.localizedDescription])) }
        journal = currentJournal
        if let recovered = currentJournal?.recoveredReleaseId { startupEvents.append(("unconfirmedTermination", ["excludedReleaseId": recovered])) }
        var accepted: SpikeArtifact?
        if let currentJournal {
            let key = SpikeArtifact.hash(Data([binaryHash, SpikeArtifact.runtimeId, scope, requested["bundleId"] ?? "", requested["manifestFileHash"] ?? ""].joined(separator: "|").utf8))
            if !currentJournal.isEligible(requested) {
                startupEvents.append(("candidateExcluded", ["candidateReleaseId": requested["releaseId"] ?? "unknown"]))
            } else if let revision = requested["selectionRevision"], revision != String(currentJournal.state.selectionRevision) {
                startupEvents.append(("staleSelectionRejected", ["requestedRevision": revision, "currentRevision": currentJournal.state.selectionRevision]))
            } else if !currentJournal.canBegin(requested) {
                startupEvents.append(("exclusionCapacityReached", [:]))
            } else if let reason = currentJournal.state.incompatibleArtifacts[key] {
                startupEvents.append(("compatibilityCacheHit", ["candidateBundleId": requested["bundleId"] ?? "unknown", "key": key, "error": reason]))
            } else if requested["embedded"] != "true", !currentJournal.isConfirmed(requested), currentJournal.state.incompatibleArtifacts.count == SpikeJournal.capacity {
                startupEvents.append(("compatibilityCacheCapacityReached", [:]))
            } else {
                do { accepted = try SpikeArtifact.validate(requested, home: home) }
                catch {
                    startupEvents.append(("candidateRejected", ["candidateBundleId": requested["bundleId"] ?? "unknown", "error": error.localizedDescription]))
                    if case SpikeAdmissionError.incompatible = error {
                        do { try currentJournal.rememberIncompatible(key, reason: error.localizedDescription) }
                        catch { startupEvents.append(("journalWriteFailed", ["error": error.localizedDescription])) }
                    }
                }
            }
        }
        if accepted == nil {
            let fallbacks = [currentJournal?.state.confirmed, embedded].compactMap { $0 }
            for candidate in fallbacks {
                if let currentJournal, !currentJournal.isEligible(candidate) { continue }
                if let value = try? SpikeArtifact.validate(candidate, home: home) {
                    accepted = value
                    startupEvents.append(("fallbackSelected", ["releaseId": candidate["releaseId"] ?? "unknown"]))
                    break
                }
            }
        }
        artifact = accepted
        info = ["platform": "ios", "bundleId": accepted?.selection["bundleId"] ?? "unknown",
                "releaseId": accepted?.selection["releaseId"] ?? "unknown", "runtimeId": SpikeArtifact.runtimeId,
                "attemptId": UUID().uuidString, "contextId": UUID().uuidString]
        for (event, detail) in startupEvents { record(event, detail) }
        record("processSelected", ["release": accepted?.selection["release"] ?? "none", "root": accepted?.root.path ?? "none", "binaryHash": binaryHash, "scope": scope, "journal": journal?.file.path ?? "unavailable"])
        if let accepted { record("verified", ["manifestFileHash": accepted.selection["manifestFileHash"]!]) }
    }

    func begin(_ context: SpikeContext) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard artifact != nil, context.active else { return false }
        if !context.isPrimary {
            guard primaryStarted else { record("secondaryDeferred", ["contextId": context.id]); return false }
            record("secondaryEvaluation", ["contextId": context.id])
            return true
        }
        guard primary == nil else { record("duplicatePrimaryRejected"); return false }
        primary = context
        do {
            guard let journal else { throw SpikeAdmissionError.invalid("Startup journal unavailable") }
            try journal.begin(selection, attemptId: info["attemptId"]!, contextId: context.id)
            primaryStarted = true
            record(journal.state.pending == nil ? "confirmedOrEmbeddedEvaluation" : "attempt", ["contextId": context.id, "selectionRevision": journal.state.selectionRevision])
            return true
        } catch {
            invalidated = true
            record("journalWriteFailed", ["error": error.localizedDescription])
            return false
        }
    }

    func observedContent(_ context: SpikeContext) {
        lock.lock()
        defer { lock.unlock() }
        guard primary === context, context.active else { record("unrelatedContentIgnored", ["contextId": context.id]); return }
        firstContent = true
        record("firstContent", ["contextId": context.id])
        confirmIfReady()
    }

    func resourceLoaded(_ path: String) {
        lock.lock()
        defer { lock.unlock() }
        loadedResources.insert(path)
        record("resourceValidated", ["path": path])
        confirmIfReady()
    }

    func requestReady(_ context: SpikeContext) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard primary === context, primaryStarted, context.active, !invalidated else {
            record("readyRejected", ["callerContextId": context.id, "active": context.active, "primary": context.isPrimary])
            return false
        }
        readyRequested = true
        record("notifyReady", ["boundContextId": context.id])
        confirmIfReady()
        return !invalidated
    }

    private func confirmIfReady() {
        guard let artifact, let primary, primary.active, firstContent, readyRequested, !invalidated, !confirmed,
              artifact.requiredResources.isSubset(of: loadedResources) else { return }
        do {
            guard let journal else { throw SpikeAdmissionError.invalid("Startup journal unavailable") }
            try journal.confirm(selection, attemptId: info["attemptId"]!, contextId: primary.id)
            confirmed = true
            record("confirmed", ["requiredResources": artifact.requiredResources.sorted()])
        } catch {
            invalidated = true
            record("journalWriteFailed", ["error": error.localizedDescription])
        }
    }

    func startupFailed(_ context: SpikeContext?, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        if let context, primary !== context || !context.active { record("unrelatedErrorIgnored", ["contextId": context.id]); return }
        if confirmed { record("postConfirmationError", ["error": error?.localizedDescription ?? "unknown"]); return }
        guard !invalidated else { record("duplicateStartupFailureIgnored"); return }
        invalidated = true
        do { try journal?.fail(selection, attemptId: info["attemptId"]!) }
        catch { record("journalWriteFailed", ["error": error.localizedDescription]) }
        record("startupFailure", ["error": error?.localizedDescription ?? "unknown"])
    }

    // Private G2 authority seam; the receipt is not a catalog authorization.
    func finalizeArtifact(candidate: [String: String], expectedRevision: Int, publish: () throws -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let journal, journal.state.selectionRevision == expectedRevision,
              journal.isEligible(candidate), !ProcessInfo.processInfo.arguments.contains("--artifact-revoke") else {
            throw SpikeAdmissionError.invalid("Prepared artifact authorization changed")
        }
        try publish()
    }

    func destroyed(_ context: SpikeContext, retired: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        context.active = false
        record(retired ? "contextRetired" : "contextDestroyed", ["contextId": context.id])
    }

    func record(_ event: String, _ details: [String: Any] = [:]) {
        lock.lock()
        defer { lock.unlock() }
        var row = details
        row["event"] = event
        row["time"] = Date().timeIntervalSince1970
        row["launch"] = info
        guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        let file = home.appendingPathComponent("events.jsonl")
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
            try? handle.synchronize()
        }
        NSLog("HotUpdaterLynxSpike %@", line)
    }
}

final class SpikeContext {
    let launch: SpikeLaunch
    let id: String
    let isPrimary: Bool
    fileprivate var active = true
    init(_ launch: SpikeLaunch, primary: Bool) {
        self.launch = launch
        isPrimary = primary
        id = primary ? launch.info["contextId"]! : UUID().uuidString
    }
    var info: [String: String] { launch.info.merging(["contextId": id]) { _, value in value } }
}

// Sparkling posts this notification in the actual Lynx view deinitializer.
final class SpikeContexts {
    static let shared = SpikeContexts()
    private let lock = NSLock()
    private var bindings: [ObjectIdentifier: SpikeContext] = [:]
    private var observation: NSObjectProtocol?
    private init() {
        observation = NotificationCenter.default.addObserver(forName: SPKWrapperLynxView.willDestroyNotification, object: nil, queue: nil) { [weak self] notification in
            guard let view = notification.object as? SPKWrapperLynxView, let config = view.lynxConfig, let self else { return }
            self.lock.lock()
            let context = self.bindings.removeValue(forKey: ObjectIdentifier(config))
            self.lock.unlock()
            if let context { context.launch.destroyed(context) }
        }
    }
    func bind(_ config: LynxConfig, context: SpikeContext) {
        lock.lock()
        bindings[ObjectIdentifier(config)] = context
        lock.unlock()
    }
}

@objc(HotUpdaterLynxSpike)
final class HotUpdaterLynxSpike: NSObject, LynxModule {
    static var name: String { "HotUpdaterLynxSpike" }
    static var methodLookup: [String: String] {
        ["getLaunchInfo": NSStringFromSelector(#selector(getLaunchInfo(_:))),
         "notifyReady": NSStringFromSelector(#selector(notifyReady(_:))),
         "probeError": NSStringFromSelector(#selector(probeError(_:)))]
    }
    private let context: SpikeContext?
    required init(param: Any) { context = param as? SpikeContext; super.init() }
    override required init() { context = nil; super.init() }
    @objc func getLaunchInfo(_ callback: LynxCallbackBlock?) {
        guard let context, context.active else { return failure(callback) }
        context.launch.record("getLaunchInfo", ["callerContextId": context.id])
        callback?(["ok": true, "data": context.info])
    }
    @objc func notifyReady(_ callback: LynxCallbackBlock?) {
        guard let context else { return failure(callback) }
        context.launch.record("readyReceived", ["callerContextId": context.id])
        let complete = {
            guard context.launch.requestReady(context) else { self.failure(callback); return }
            callback?(["ok": true, "data": ["accepted": true]])
        }
        if context.isPrimary, ProcessInfo.processInfo.arguments.contains("--spike-delay-ready") {
            // G1 fault injection: delay processing a real native call, not startup confirmation.
            if ProcessInfo.processInfo.arguments.contains("--spike-retire-primary") {
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .spikeRetirePrimary, object: context)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: complete)
        } else { complete() }
    }
    @objc func probeError(_ callback: LynxCallbackBlock?) {
        guard let context, context.active else { return failure(callback) }
        context.launch.record("probeError", ["callerContextId": context.id])
        callback?(["ok": false, "error": ["code": "SPIKE_EXPECTED", "message": "Native error transport verified"]])
    }
    private func failure(_ callback: LynxCallbackBlock?) {
        callback?(["ok": false, "error": ["code": "CONTEXT_REJECTED", "message": "No live designated native startup context"]])
    }
}

final class SpikeResource: NSObject, SPKResourceProtocol {
    let resourceData: Data?
    init(_ data: Data) { resourceData = data }
}

final class SpikeResourceLoader: NSObject, SPKResourceLoaderProtocol {
    let launch: SpikeLaunch
    init(_ launch: SpikeLaunch) { self.launch = launch }

    private func read(_ url: URL?, kind: String) throws -> (String, Data) {
        guard let url, url.scheme == nil || url.scheme == "asset" || url.scheme == "hot-updater", url.host == nil || url.host == "" else {
            throw SpikeAdmissionError.invalid("Unsupported managed URL")
        }
        let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        guard SpikeArtifact.validPath(relative), let artifact = launch.artifact,
              let digest = artifact.files[relative] else { throw SpikeAdmissionError.invalid("Managed path is not manifest-covered") }
        let file = artifact.root.appendingPathComponent(relative)
        guard file.resolvingSymlinksInPath().path == file.path else { throw SpikeAdmissionError.invalid("Symbolic link in managed path") }
        let data = try Data(contentsOf: file)
        guard SpikeArtifact.hash(data) == digest else { throw SpikeAdmissionError.invalid("Managed bytes changed after admission") }
        launch.record("resource", ["kind": kind, "url": url.absoluteString, "path": file.path, "sha256": digest, "bytes": data.count])
        return (relative, data)
    }
    func loadResource(withURL url: URL?, completion: @escaping SPKResourceCompletionHandler) -> SPKResourceLoaderTaskProtocol? {
        do {
            let (path, data) = try read(url, kind: "template-script-or-font")
            if path.hasSuffix(".ttf") || path.hasSuffix(".otf") {
                guard let provider = CGDataProvider(data: data as CFData), let font = CGFont(provider) else { throw SpikeAdmissionError.invalid("Invalid managed font") }
                launch.record("fontDecoded", ["path": path, "postScriptName": font.postScriptName as String? ?? "unknown"])
            }
            launch.resourceLoaded(path)
            completion(SpikeResource(data), nil)
        } catch {
            launch.record("resourceError", ["url": url?.absoluteString ?? "nil", "error": error.localizedDescription])
            launch.startupFailed(nil, error: error)
            completion(nil, error)
        }
        return nil
    }
    func loadImage(withURL url: URL?, completion: @escaping SPKResourceImageCompletionHandler) -> SPKResourceLoaderTaskProtocol? {
        do {
            let (path, data) = try read(url, kind: "image")
            guard let image = UIImage(data: data) else { throw SpikeAdmissionError.invalid("Invalid managed image") }
            launch.resourceLoaded(path)
            completion(image, nil)
        } catch {
            launch.record("imageError", ["url": url?.absoluteString ?? "nil", "error": error.localizedDescription])
            launch.startupFailed(nil, error: error)
            completion(nil, error)
        }
        return nil
    }
}

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        SPKServiceRegister.registerAll()
        SPKExecuteAllPrepareBootTask()
        if let framework = PublicHost.requestedFramework {
            do {
                let host = try PublicHost(framework: framework)
                PublicHost.shared = host
                guard let fallback = SPKKit.DIContainer.resolve(SPKResourceLoaderProtocol.self) else { return false }
                SPKKit.DIContainer.register(SPKResourceLoaderProtocol.self, scope: .container) { PublicResourceLoader(host, fallback: fallback) }
            } catch { NSLog("Public Lynx host failed: %@", error.localizedDescription); return false }
        } else {
            let launch = SpikeLaunch.shared
            SPKKit.DIContainer.register(SPKResourceLoaderProtocol.self, scope: .container) { SpikeResourceLoader(launch) }
            _ = SpikeContexts.shared
            ArtifactProbe.startIfRequested()
        }
        return true
    }
}

@main
struct SparklingGoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    var body: some Scene { WindowGroup { if PublicHost.requestedFramework != nil { PublicView().ignoresSafeArea() } else { SpikeView().ignoresSafeArea() } } }
}

final class SpikeLifecycle: NSObject, SPKContainerLifecycleProtocol {
    let context: SpikeContext
    init(_ context: SpikeContext) { self.context = context }
    func containerDidFirstScreen(_ container: SPKContainerProtocol) { context.launch.observedContent(context) }
    func container(_ container: SPKContainerProtocol, didLoadFailedWithURL url: URL?, error: Error?) { context.launch.startupFailed(context, error: error) }
    func container(_ container: SPKContainerProtocol, didRecieveError error: Error?) {
        let fatal = (error as? LynxError)?.isFatal == true
        context.launch.record("runtimeError", ["error": error?.localizedDescription ?? "unknown", "fatal": fatal, "callerContextId": context.id])
        if fatal { context.launch.startupFailed(context, error: error) }
    }
}

extension Notification.Name { static let spikeRetirePrimary = Notification.Name("HotUpdaterLynxSpike.retirePrimary") }

final class SpikeContainerController: UIViewController {
    private var contexts: [(UIViewController, SpikeContext, SpikeLifecycle)] = []
    private var retirement: NSObjectProtocol?
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        let launch = SpikeLaunch.shared
        if ProcessInfo.processInfo.arguments.contains("--spike-no-primary") {
            showMessage("G1: primary Lynx context not opened")
            return
        }
        if ProcessInfo.processInfo.arguments.contains("--spike-secondary-first") { attach(primary: false) }
        attach(primary: true)
        if ProcessInfo.processInfo.arguments.contains("--spike-duplicate-primary") { attach(primary: true) }
        if ProcessInfo.processInfo.arguments.contains("--spike-secondary") { attach(primary: false) }
        retirement = NotificationCenter.default.addObserver(forName: .spikeRetirePrimary, object: nil, queue: .main) { [weak self] notification in
            guard let self, let context = notification.object as? SpikeContext,
                  let index = self.contexts.firstIndex(where: { $0.1 === context }) else { return }
            let controller = self.contexts[index].0
            controller.willMove(toParent: nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
            self.contexts.remove(at: index)
            context.launch.destroyed(context, retired: true)
            context.launch.record("primaryControllerRemoved", ["contextId": context.id])
            self.showMessage("G1: primary context retired before queued readiness")
        }
        if launch.artifact == nil { showMessage("G1: no eligible compatible local fixture") }
    }
    private func attach(primary: Bool) {
        let launch = SpikeLaunch.shared
        let context = SpikeContext(launch, primary: primary)
        guard launch.begin(context) else { if primary { showMessage("G1: primary launch refused") }; return }
        let lifecycle = SpikeLifecycle(context)
        let spkContext = SPKContext()
        spkContext.containerLifecycleDelegate = lifecycle
        spkContext.rawViewBuilderBlock = { raw in
            guard let builder = raw as? LynxViewBuilder, let config = builder.config else { return }
            config.register(HotUpdaterLynxSpike.self, param: context)
            SpikeContexts.shared.bind(config, context: context)
        }
        var components = URLComponents(string: "hybrid://lynxview_page")!
        components.queryItems = [URLQueryItem(name: "bundle", value: "asset:///\(launch.entry)"), URLQueryItem(name: "hide_status_bar", value: "1"), URLQueryItem(name: "hide_nav_bar", value: "1")]
        let controller = SPKRouter.create(withURL: components.string!, context: spkContext, frame: UIScreen.main.bounds)
        contexts.append((controller, context, lifecycle))
        addChild(controller)
        controller.view.frame = view.bounds
        view.addSubview(controller.view)
        controller.didMove(toParent: self)
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        for (index, item) in contexts.enumerated() {
            let height = view.bounds.height / CGFloat(contexts.count)
            item.0.view.frame = CGRect(x: 0, y: height * CGFloat(index), width: view.bounds.width, height: height)
        }
    }
    private func showMessage(_ message: String) {
        let label = UILabel(frame: UIScreen.main.bounds)
        label.text = message
        label.numberOfLines = 0
        view.addSubview(label)
    }
    deinit { if let retirement { NotificationCenter.default.removeObserver(retirement) } }
}

struct SpikeView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { SpikeContainerController() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}
