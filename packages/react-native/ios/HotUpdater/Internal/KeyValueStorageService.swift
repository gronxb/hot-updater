import Foundation

/// Persistent string key-value store for client plugins, kept in
/// `Application Support/HotUpdater/storage.json` outside device backups.
///
/// Keys are opaque; JavaScript namespaces them per plugin. The file is read
/// into memory on first use, and every write replaces the whole file.
final class KeyValueStorageService {
    static let storageFilename = "storage.json"

    private let fileURL: URL
    private let lock = NSLock()
    private var items: [String: String]?

    init(directory: URL) {
        self.fileURL = directory.appendingPathComponent(Self.storageFilename)
    }

    func getItem(_ key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return loadedItems()[key]
    }

    /// Stores `value` under `key`, or removes the key when `value` is nil.
    /// Returns false when the file could not be written.
    @discardableResult
    func setItem(_ key: String, value: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        var updatedItems = loadedItems()
        updatedItems[key] = value
        // Memory stays the source of truth for this process, so the next
        // successful write also persists a value whose own write failed.
        items = updatedItems

        do {
            let data = try JSONSerialization.data(
                withJSONObject: updatedItems,
                options: [.sortedKeys]
            )
            try NoBackupStorage.write(data, to: fileURL)
            return true
        } catch {
            NSLog("[KeyValueStorage] Failed to write \(fileURL.path): \(error)")
            return false
        }
    }

    private func loadedItems() -> [String: String] {
        if let items {
            return items
        }
        let loadedItems = Self.readItems(from: fileURL)
        items = loadedItems
        return loadedItems
    }

    /// A missing, unreadable, or corrupt file reads as an empty store.
    private static func readItems(from file: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: file) else {
            return [:]
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            NSLog("[KeyValueStorage] Ignoring unreadable store at \(file.path)")
            return [:]
        }
        return object.compactMapValues { $0 as? String }
    }
}
