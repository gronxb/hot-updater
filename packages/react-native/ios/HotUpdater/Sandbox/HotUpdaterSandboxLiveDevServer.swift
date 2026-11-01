import UIKit

/// What this process runs while a dev session lasts, read by
/// `HotUpdaterSandboxDevOverride.m`. It lives and dies with the process: nothing
/// can arm a later launch, and a crash re-arms nothing.
@objc(HotUpdaterSandboxDevState)
public final class HotUpdaterSandboxDevState: NSObject {
    private static let lock = NSLock()
    private static var bundleURL: URL?
    private static var storage: [String: String] = [:]
    private static var isInstalled = false

    @objc public static func overrideInstalled() {
        lock.lock()
        isInstalled = true
        lock.unlock()
    }

    @objc(bundleURLForImpl:)
    public static func bundleURL(forImpl impl: AnyObject) -> URL? {
        lock.lock()
        let url = bundleURL
        lock.unlock()
        // Named instances keep their own bundle and their own launch.
        return url != nil && impl === HotUpdaterNativeUpdateBridge.sharedImpl ? url : nil
    }

    @objc public static func storageItem(_ key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    @objc public static func setStorageItem(_ key: String, value: String?) {
        lock.lock()
        storage[key] = value
        lock.unlock()
    }

    static var canRun: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isInstalled
    }

    static var running: URL? {
        lock.lock()
        defer { lock.unlock() }
        return bundleURL
    }

    static func set(_ url: URL?) {
        lock.lock()
        bundleURL = url
        if url == nil { storage = [:] }
        lock.unlock()
    }
}

/// A process that ran a dev session and died leaves this behind, and any crash
/// marker it wrote is the dev JavaScript's, never the selected bundle's: the next
/// process drops it before anything settles it.
enum HotUpdaterSandboxDevLeftover {
    private static var note: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("HotUpdater", isDirectory: true)
            .appendingPathComponent("sandbox-dev-running")
    }

    static func mark() {
        guard let note else { return }
        try? FileManager.default.createDirectory(at: note.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: note.path, contents: Data())
    }

    static func clear() {
        guard let note else { return }
        try? FileManager.default.removeItem(at: note)
    }

    static func dropCrashOfLastProcess() {
        guard let note, FileManager.default.fileExists(atPath: note.path) else { return }
        let marker = HotUpdaterCrashMarker.url(for: .main, documentsPath: FileManagerService().documentsPath())
        if (try? FileManager.default.removeItem(at: marker)) != nil {
            NSLog("[HotUpdaterSandbox] dropped a crash marker of the last dev process")
        }
        clear()
    }
}

/// What a person reads when a dev server can't run.
private struct DevServerFailure: Error {
    let message: String
}

/// The one owner of connecting and reloading on iOS, where a reload is in place:
/// connections run one at a time, and a launch of the normal selection that was
/// already prepared stops being watched, so the dev JavaScript's first content
/// can't verify it and its crash can't charge it.
@MainActor
final class HotUpdaterSandboxLiveDevServer: HotUpdaterSandboxDevServer {
    private static let recentHostsKey = "devServerRecentHosts"
    private static let maxRecentHosts = 5
    private static let probeSeconds: TimeInterval = 1
    private static let fetchSeconds: TimeInterval = 120

    private let start: (_ launchWasPrepared: Bool) -> Void
    private let reload: () -> Void
    private let defaults = UserDefaults(suiteName: "hot-updater-sandbox") ?? .standard
    private var answered: [String: Bool] = [:]
    private var connections: Task<Void, Never>?

    /// What the last reload couldn't do. A failed connect says so to its completion.
    private(set) var lastDevServerError: String?

    var onDevServerChange: (() -> Void)? {
        didSet {
            if onDevServerChange != nil { probe() }
        }
    }

    /// `start` runs the session's JavaScript, `reload` restarts React Native in place.
    init(start: @escaping (_ launchWasPrepared: Bool) -> Void, reload: @escaping () -> Void) {
        self.start = start
        self.reload = reload
    }

    var isRunningDevServer: Bool { HotUpdaterSandboxDevState.running != nil }

    private var runningHostURL: String? {
        HotUpdaterSandboxDevState.running.flatMap { url in
            url.scheme.flatMap { scheme in url.host.map { "\(scheme)://\($0):\(url.port ?? 8081)" } }
        }
    }

    var runningDevServerHost: String? { runningHostURL.map(HotUpdaterSandboxDevHost.display) }

    private var hostURLs: [String] {
        #if targetEnvironment(simulator)
        let isSimulator = true
        #else
        let isSimulator = false
        #endif
        return HotUpdaterSandboxDevHost.listed(
            isSimulator: isSimulator,
            recent: defaults.stringArray(forKey: Self.recentHostsKey) ?? []
        )
    }

    var devServerHosts: [HotUpdaterSandboxDevServerHost] {
        hostURLs.map { HotUpdaterSandboxDevServerHost(address: HotUpdaterSandboxDevHost.display($0), isRunning: answered[$0]) }
    }

    private func remember(_ host: String) {
        let recent = [host] + (defaults.stringArray(forKey: Self.recentHostsKey) ?? []).filter { $0 != host }
        defaults.set(Array(recent.prefix(Self.maxRecentHosts)), forKey: Self.recentHostsKey)
    }

    /// One `GET /status` per listed host, with a second to answer.
    private func probe() {
        let urls = hostURLs
        Task { @MainActor in
            await withTaskGroup(of: (String, Bool).self) { group in
                for url in urls {
                    group.addTask { (url, await Self.answers(url)) }
                }
                for await (url, isRunning) in group {
                    answered[url] = isRunning
                }
            }
            onDevServerChange?()
        }
    }

    private nonisolated static func answers(_ host: String) async -> Bool {
        guard let url = URL(string: "\(host)/status") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = probeSeconds
        return await withCheckedContinuation { continuation in
            URLSession.shared.dataTask(with: request) { data, response, _ in
                let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let ok = (response as? HTTPURLResponse)?.statusCode == 200 && body.contains("packager-status:running")
                continuation.resume(returning: ok)
            }.resume()
        }
    }

    /// What a fetch of the JavaScript came to.
    private enum Fetched {
        case found
        case notFound
        case failed(String)
    }

    /// Whether the JavaScript can be read: a release build dies if React Native can't load it.
    private nonisolated static func fetch(_ bundle: URL, host: String) async -> Fetched {
        var request = URLRequest(url: bundle)
        request.timeoutInterval = fetchSeconds
        return await withCheckedContinuation { continuation in
            URLSession.shared.downloadTask(with: request) { file, response, error in
                if let file { try? FileManager.default.removeItem(at: file) }
                let name = HotUpdaterSandboxDevHost.display(host)
                if let error = error as? URLError, error.code == .appTransportSecurityRequiresSecureConnection {
                    continuation.resume(returning: .failed("App Transport Security blocks http to \(name). Use a local address, or serve the dev server over https."))
                } else if let error {
                    continuation.resume(returning: .failed("Couldn't load JavaScript from \(name). \(error.localizedDescription) Check that the dev server runs and this device can reach it."))
                } else if let status = (response as? HTTPURLResponse)?.statusCode, status == 404 {
                    continuation.resume(returning: .notFound)
                } else if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 {
                    continuation.resume(returning: .failed("\(name) answered \(status) for its JavaScript. Check the dev server's output."))
                } else {
                    continuation.resume(returning: .found)
                }
            }.resume()
        }
    }

    /// The entry an Expo server's manifest names.
    private nonisolated static func manifestEntry(host: String) async -> String? {
        guard let url = URL(string: host) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = fetchSeconds
        request.setValue("ios", forHTTPHeaderField: "expo-platform")
        request.setValue("application/expo+json,application/json", forHTTPHeaderField: "accept")
        return await withCheckedContinuation { continuation in
            URLSession.shared.dataTask(with: request) { data, _, _ in
                continuation.resume(returning: data.flatMap(HotUpdaterSandboxDevHost.entry(ofManifest:)))
            }.resume()
        }
    }

    /// The JavaScript's URL at this host, or what's wrong.
    private nonisolated static func resolveBundle(host: String) async -> Result<URL, DevServerFailure> {
        let name = HotUpdaterSandboxDevHost.display(host)
        var entry = HotUpdaterSandboxDevHost.defaultEntry
        for attempt in 0 ..< 2 {
            guard let bundle = HotUpdaterSandboxDevHost.bundleURL(host: host, entry: entry) else { break }
            switch await fetch(bundle, host: host) {
            case .found:
                return .success(bundle)
            case .failed(let message):
                return .failure(DevServerFailure(message: message))
            case .notFound:
                guard attempt == 0, let named = await manifestEntry(host: host) else {
                    return .failure(DevServerFailure(message: "\(name) has no /\(entry).bundle. Check the dev server's output."))
                }
                entry = named
            }
        }
        return .failure(DevServerFailure(message: "\(name) has no JavaScript to load. Check the dev server's output."))
    }

    func connect(host: String, completion: @escaping (String?) -> Void) {
        guard HotUpdaterSandboxDevState.canRun else {
            completion("This build of the SDK can't run a dev server. Rebuild the sandbox with this CLI's version of @hot-updater/react-native.")
            return
        }
        guard let url = HotUpdaterSandboxDevHost.normalize(host) else {
            completion("\"\(host)\" isn't a dev server address. Enter one like 192.168.0.2:8081.")
            return
        }
        let previous = connections
        connections = Task { @MainActor in
            await previous?.value
            let bundle: URL
            switch await Self.resolveBundle(host: url) {
            case .success(let resolved):
                bundle = resolved
            case .failure(let failure):
                completion(failure.message)
                return
            }
            remember(url)
            let wasPrepared = retireNormalLaunch()
            HotUpdaterSandboxDevLeftover.mark()
            HotUpdaterSandboxDevState.set(bundle)
            NSLog("[HotUpdaterSandbox] dev session on %@", url)
            completion(nil)
            start(wasPrepared)
            onDevServerChange?()
        }
    }

    /// The launch of the normal selection stops being watched and counted as
    /// started. Returns whether one was prepared, so its URL may be held already.
    private func retireNormalLaunch() -> Bool {
        let coordinator = HotUpdaterRecoveryHub.shared.coordinator
        let main = HotUpdaterInstanceEnvironment.mainName
        guard let launch = coordinator.launch(named: main), launch.generation > 0 else { return false }
        _ = launch.storage.clearLaunchStarted(bundleId: launch.bundleId)
        coordinator.finishMonitoring(name: main, generation: launch.generation)
        HotUpdaterNativeUpdateBridge.sharedImpl.resetLaunchPreparation()
        return true
    }

    /// Fetches the running host's JavaScript again. The session goes on if it can't.
    func reloadDevServer() {
        guard let host = runningHostURL else { return }
        connect(host: host) { [weak self] failure in
            self?.lastDevServerError = failure
        }
    }

    /// Only here does a dev session end, other than with its process.
    func exitDevServer() {
        guard isRunningDevServer else { return }
        HotUpdaterSandboxDevState.set(nil)
        HotUpdaterSandboxDevLeftover.clear()
        NSLog("[HotUpdaterSandbox] dev session ended")
        reload()
        onDevServerChange?()
    }
}
