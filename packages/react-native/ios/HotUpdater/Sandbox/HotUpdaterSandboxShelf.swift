#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// A bundle a sandbox switch downloaded, as the Downloaded list keeps it.
struct HotUpdaterSandboxShelfEntry: Equatable, Codable {
    let bundleId: String
    let channel: String
    /// The deploy message, when the check named one.
    let message: String?
    /// Main's key when it was downloaded: another build's bundles don't run here.
    let isolationKey: String
    let downloadedAtMs: Double
}

/// A stored bundle's files, checked: what a stored session runs.
struct HotUpdaterSandboxStoredBundle: Equatable {
    let bundleId: String
    /// The JavaScript file.
    let bundleURL: URL
    /// `file://` and the bundle's directory, as main answers `getBaseURL`.
    let baseURL: String
    let manifest: NSDictionary
}

/// The sandbox's own copies of what its switches downloaded, in the caches
/// directory, so the OS may purge them and nothing durable stays behind. Main's
/// store is only read. A row whose files are gone checks its channel instead.
///
/// Every read and write runs under one lock, held briefly: a copy runs off the
/// main thread into a partial directory the lock marks as in progress, so the main
/// thread never waits for it, and a refresh or a Clear never sees half of one.
/// Checking, moving in and listing a copy happen together under the lock. The app
/// holds one shelf.
final class HotUpdaterSandboxShelf {
    static let limit = 10
    private let lock = NSLock()
    /// Bundles being copied, whose partial directories reconciliation leaves alone.
    private var copying: Set<String> = []
    private static let indexName = "index.json"
    private static let partialSuffix = ".tmp"

    /// The shelf's directory.
    let root: URL
    /// Main's bundle store, which holds each just-installed bundle under its ID.
    let source: URL
    let isolationKey: String
    /// Whether this build copies bundles. An iOS sandbox that shares the store
    /// app's bundle ID keeps the list but stores nothing.
    let storesBundles: Bool
    private let fileManager = FileManager.default

    init(root: URL, source: URL, isolationKey: String, storesBundles: Bool) {
        self.root = root
        self.source = source
        self.isolationKey = isolationKey
        self.storesBundles = storesBundles
    }

    /// Newest first.
    var entries: [HotUpdaterSandboxShelfEntry] {
        serially { readEntries() }
    }

    private func serially<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private func readEntries() -> [HotUpdaterSandboxShelfEntry] {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(Self.indexName)) else { return [] }
        return (try? JSONDecoder().decode([HotUpdaterSandboxShelfEntry].self, from: data)) ?? []
    }

    /// Lists a bundle main just installed, and copies it when this build stores
    /// bundles. Best effort: a copy that fails its check lists nothing. The oldest
    /// entry past the cap goes, never `running`'s.
    func add(bundleId: String, channel: String, message: String?, nowMs: Double, running: String?) {
        guard Self.isName(bundleId) else { return }
        guard storesBundles else {
            serially { list(bundleId: bundleId, channel: channel, message: message, nowMs: nowMs, running: running) }
            return
        }
        let partial = root.appendingPathComponent(bundleId + Self.partialSuffix, isDirectory: true)
        serially {
            copying.insert(bundleId)
            try? fileManager.removeItem(at: partial)
        }
        // Outside the lock, so reads never wait for a copy. A clone on APFS.
        var copied = true
        do {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
            try fileManager.copyItem(at: source.appendingPathComponent(bundleId, isDirectory: true), to: partial)
        } catch {
            copied = false
            NSLog("[HotUpdaterSandbox] didn't keep %@: %@", bundleId, error.localizedDescription)
        }
        serially {
            copying.remove(bundleId)
            if copied && promote(partial, bundleId: bundleId) {
                list(bundleId: bundleId, channel: channel, message: message, nowMs: nowMs, running: running)
            }
            try? fileManager.removeItem(at: partial)
        }
    }

    /// Checks a whole copy and moves it in, under the lock.
    private func promote(_ partial: URL, bundleId: String) -> Bool {
        guard Self.check(partial, bundleId: bundleId) != nil else {
            NSLog("[HotUpdaterSandbox] didn't keep %@: it isn't a whole bundle", bundleId)
            return false
        }
        try? fileManager.removeItem(at: directory(bundleId))
        do {
            try fileManager.moveItem(at: partial, to: directory(bundleId))
            return true
        } catch {
            NSLog("[HotUpdaterSandbox] didn't keep %@: %@", bundleId, error.localizedDescription)
            return false
        }
    }

    private func list(bundleId: String, channel: String, message: String?, nowMs: Double, running: String?) {
        let entry = HotUpdaterSandboxShelfEntry(
            bundleId: bundleId,
            channel: channel,
            message: message,
            isolationKey: isolationKey,
            downloadedAtMs: nowMs
        )
        // Without a copy, a row checks its channel, so one row per channel is enough.
        var next = [entry] + readEntries().filter { $0.bundleId != bundleId && (storesBundles || $0.channel != channel) }
        while next.count > Self.limit, let oldest = next.filter({ $0.bundleId != running }).min(by: { $0.downloadedAtMs < $1.downloadedAtMs }) {
            next.removeAll { $0.bundleId == oldest.bundleId }
            try? fileManager.removeItem(at: directory(oldest.bundleId))
        }
        write(next)
    }

    /// The bundle's files when they're all on this device, checked as main checks a launch.
    func stored(_ bundleId: String) -> HotUpdaterSandboxStoredBundle? {
        guard Self.isName(bundleId) else { return nil }
        return serially { Self.check(directory(bundleId), bundleId: bundleId) }
    }

    func remove(_ bundleId: String) {
        guard Self.isName(bundleId) else { return }
        serially {
            try? fileManager.removeItem(at: directory(bundleId))
            write(readEntries().filter { $0.bundleId != bundleId })
        }
    }

    /// Everything but what runs.
    func clear(keeping running: String?) {
        serially {
            let entries = readEntries()
            for entry in entries where entry.bundleId != running {
                try? fileManager.removeItem(at: directory(entry.bundleId))
            }
            write(entries.filter { $0.bundleId == running })
        }
    }

    /// Another build's entries go, and so do partial copies and files no entry names.
    func reconcile() {
        serially { reconcileSerially() }
    }

    private func reconcileSerially() {
        let entries = readEntries()
        let kept = entries.filter { $0.isolationKey == isolationKey }
        if kept.count != entries.count { write(kept) }
        let names = Set(kept.map(\.bundleId))
        let inProgress = Set(copying.map { $0 + Self.partialSuffix })
        for name in (try? fileManager.contentsOfDirectory(atPath: root.path)) ?? []
        where name != Self.indexName && !names.contains(name) && !inProgress.contains(name) {
            try? fileManager.removeItem(at: root.appendingPathComponent(name))
        }
    }

    /// What the stored copies take, in bytes.
    func totalBytes() -> Int64 {
        serially { readEntries() }.reduce(0) { total, entry in
            let files = fileManager.enumerator(at: directory(entry.bundleId), includingPropertiesForKeys: [.fileSizeKey])
            return total + (files?.reduce(Int64(0)) { sum, item in
                sum + Int64(((item as? URL).flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }) ?? 0)
            } ?? 0)
        }
    }

    private func directory(_ bundleId: String) -> URL {
        root.appendingPathComponent(bundleId, isDirectory: true)
    }

    private func write(_ entries: [HotUpdaterSandboxShelfEntry]) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        try? data.write(to: root.appendingPathComponent(Self.indexName), options: .atomic)
    }

    /// A bundle ID that names one directory of the shelf.
    private static func isName(_ bundleId: String) -> Bool {
        !bundleId.isEmpty && !bundleId.hasPrefix(".") && !bundleId.contains("/") && !bundleId.hasSuffix(partialSuffix)
    }

    /// The manifest names the bundle, each asset it lists is a regular file inside
    /// the directory, and exactly one of them is the JavaScript.
    static func check(_ directory: URL, bundleId: String) -> HotUpdaterSandboxStoredBundle? {
        let fileManager = FileManager.default
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")),
              let manifest = (try? JSONSerialization.jsonObject(with: data)) as? NSDictionary,
              (manifest["bundleId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == bundleId,
              let assets = manifest["assets"] as? [String: Any] else {
            return nil
        }
        var bundles: [URL] = []
        for path in assets.keys {
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            guard !path.hasPrefix("/"), !path.contains("\\"), !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
                return nil
            }
            let file = directory.appendingPathComponent(path)
            // Read without following links, so a link is never a regular file.
            guard (try? fileManager.attributesOfItem(atPath: file.path))?[.type] as? FileAttributeType == .typeRegular else {
                return nil
            }
            if file.lastPathComponent.hasSuffix(".bundle") || file.lastPathComponent == "main.jsbundle" {
                bundles.append(file)
            }
        }
        guard bundles.count == 1 else { return nil }
        return HotUpdaterSandboxStoredBundle(
            bundleId: bundleId,
            bundleURL: bundles[0],
            baseURL: "file://\(directory.path)",
            manifest: manifest
        )
    }
}
#endif
