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
/// The list lives in memory behind one lock, held only to read it, to change it
/// with the renames that go with the change, and to write it. Copying, checking,
/// measuring and deleting files run outside the lock: a copy goes to a partial
/// directory the shelf marks as in progress, and what goes is first renamed aside.
/// The app holds one shelf and calls it off the main thread.
final class HotUpdaterSandboxShelf {
    static let limit = 10
    private static let indexName = "index.json"
    private static let partialSuffix = ".tmp"
    private static let trashPrefix = ".trash-"

    /// The shelf's directory.
    let root: URL
    /// Main's bundle store, which holds each just-installed bundle under its ID.
    let source: URL
    let isolationKey: String
    /// Whether this build copies bundles. An iOS sandbox that shares the store
    /// app's bundle ID keeps the list but stores nothing.
    let storesBundles: Bool
    private let fileManager = FileManager.default
    private let lock = NSLock()
    /// The list, read from disk once.
    private var cached: [HotUpdaterSandboxShelfEntry]?
    /// Bundles being copied, whose partial directories reconciliation leaves alone.
    private var copying: Set<String> = []

    init(root: URL, source: URL, isolationKey: String, storesBundles: Bool) {
        self.root = root
        self.source = source
        self.isolationKey = isolationKey
        self.storesBundles = storesBundles
    }

    /// Newest first.
    var entries: [HotUpdaterSandboxShelfEntry] {
        serially { list }
    }

    private func serially<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// Under the lock.
    private var list: [HotUpdaterSandboxShelfEntry] {
        if let cached { return cached }
        let read = (try? Data(contentsOf: root.appendingPathComponent(Self.indexName)))
            .flatMap { try? JSONDecoder().decode([HotUpdaterSandboxShelfEntry].self, from: $0) } ?? []
        cached = read
        return read
    }

    /// Lists a bundle main just installed, and copies it when this build stores
    /// bundles. Best effort: a copy that fails its check lists nothing. The oldest
    /// entry past the cap goes, never `running`'s.
    func add(bundleId: String, channel: String, message: String?, nowMs: Double, running: String?) {
        guard Self.isName(bundleId) else { return }
        guard storesBundles else {
            let trash = serially { publish(bundleId: bundleId, channel: channel, message: message, nowMs: nowMs, running: running) }
            delete(trash)
            return
        }
        let partial = root.appendingPathComponent(bundleId + Self.partialSuffix, isDirectory: true)
        serially { _ = copying.insert(bundleId) }
        try? fileManager.removeItem(at: partial)
        // A clone on APFS.
        var copied = false
        do {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
            try fileManager.copyItem(at: source.appendingPathComponent(bundleId, isDirectory: true), to: partial)
            copied = Self.check(partial, bundleId: bundleId) != nil
            if !copied { NSLog("[HotUpdaterSandbox] didn't keep %@: it isn't a whole bundle", bundleId) }
        } catch {
            NSLog("[HotUpdaterSandbox] didn't keep %@: %@", bundleId, error.localizedDescription)
        }
        let trash: [URL] = serially {
            copying.remove(bundleId)
            guard copied else { return [] }
            var aside = setAside(bundleId).map { [$0] } ?? []
            do {
                try fileManager.moveItem(at: partial, to: directory(bundleId))
            } catch {
                NSLog("[HotUpdaterSandbox] didn't keep %@: %@", bundleId, error.localizedDescription)
                return aside
            }
            aside += publish(bundleId: bundleId, channel: channel, message: message, nowMs: nowMs, running: running)
            return aside
        }
        delete(trash + [partial])
    }

    /// Under the lock: the new list, and what its change set aside.
    private func publish(bundleId: String, channel: String, message: String?, nowMs: Double, running: String?) -> [URL] {
        let entry = HotUpdaterSandboxShelfEntry(
            bundleId: bundleId,
            channel: channel,
            message: message,
            isolationKey: isolationKey,
            downloadedAtMs: nowMs
        )
        // Without a copy, a row checks its channel, so one row per channel is enough.
        var next = [entry] + list.filter { $0.bundleId != bundleId && (storesBundles || $0.channel != channel) }
        var trash: [URL] = []
        while next.count > Self.limit, let oldest = next.filter({ $0.bundleId != running }).min(by: { $0.downloadedAtMs < $1.downloadedAtMs }) {
            next.removeAll { $0.bundleId == oldest.bundleId }
            if let aside = setAside(oldest.bundleId) { trash.append(aside) }
        }
        write(next)
        return trash
    }

    /// The bundle's files when they're all on this device, checked as main checks a
    /// launch. Read outside the lock: a bundle removed meanwhile reads as gone.
    func stored(_ bundleId: String) -> HotUpdaterSandboxStoredBundle? {
        guard Self.isName(bundleId) else { return nil }
        return Self.check(directory(bundleId), bundleId: bundleId)
    }

    func remove(_ bundleId: String) {
        guard Self.isName(bundleId) else { return }
        let trash: URL? = serially {
            write(list.filter { $0.bundleId != bundleId })
            return setAside(bundleId)
        }
        delete(trash.map { [$0] } ?? [])
    }

    /// Everything but what runs, or is about to.
    func clear(keeping kept: Set<String>) {
        let trash: [URL] = serially {
            let all = list
            write(all.filter { kept.contains($0.bundleId) })
            return all.filter { !kept.contains($0.bundleId) }.compactMap { setAside($0.bundleId) }
        }
        delete(trash)
    }

    /// Another build's entries go, and so do partial copies and files no entry names.
    func reconcile() {
        let trash: [URL] = serially {
            let all = list
            let kept = all.filter { $0.isolationKey == isolationKey }
            if kept.count != all.count { write(kept) }
            let names = Set(kept.map(\.bundleId))
            let inProgress = Set(copying.map { $0 + Self.partialSuffix })
            return ((try? fileManager.contentsOfDirectory(atPath: root.path)) ?? [])
                .filter { $0 != Self.indexName && !names.contains($0) && !inProgress.contains($0) }
                .compactMap { name in
                    // Leftover trash goes as it is.
                    guard !name.hasPrefix(Self.trashPrefix) else { return root.appendingPathComponent(name) }
                    return setAside(name)
                }
        }
        delete(trash)
    }

    /// What the stored copies take, in bytes. Measured outside the lock.
    func totalBytes() -> Int64 {
        entries.reduce(0) { total, entry in
            let files = fileManager.enumerator(at: directory(entry.bundleId), includingPropertiesForKeys: [.fileSizeKey])
            return total + (files?.reduce(Int64(0)) { sum, item in
                sum + Int64(((item as? URL).flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }) ?? 0)
            } ?? 0)
        }
    }

    private func directory(_ name: String) -> URL {
        root.appendingPathComponent(name, isDirectory: true)
    }

    /// Under the lock: moves a directory out of the list's way by one rename, for
    /// deleting after the lock.
    private func setAside(_ name: String) -> URL? {
        let trash = root.appendingPathComponent(Self.trashPrefix + UUID().uuidString, isDirectory: true)
        return (try? fileManager.moveItem(at: directory(name), to: trash)) != nil ? trash : nil
    }

    private func delete(_ urls: [URL]) {
        for url in urls {
            try? fileManager.removeItem(at: url)
        }
    }

    /// Under the lock. Best effort, like the copies: a full cache loses the list, never the switch.
    private func write(_ entries: [HotUpdaterSandboxShelfEntry]) {
        cached = entries
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
