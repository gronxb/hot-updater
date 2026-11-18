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
    // Whether the file holds `items`: a set that changes nothing then skips
    // the write. A failed write or an unreadable file clears it, so the next
    // set writes again.
    private var persisted = true

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
        // Byte-exact: Swift's == treats canonically equivalent strings as
        // equal, which JavaScript and Android don't.
        if persisted, Self.sameBytes(updatedItems[key], value) {
            return true
        }
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
            persisted = true
            return true
        } catch {
            NSLog("[KeyValueStorage] Failed to write \(fileURL.path): \(error)")
            persisted = false
            return false
        }
    }

    private static func sameBytes(_ old: String?, _ new: String?) -> Bool {
        switch (old, new) {
        case (nil, nil): return true
        case let (old?, new?): return old.utf8.elementsEqual(new.utf8)
        default: return false
        }
    }

    private func loadedItems() -> [String: String] {
        if let items {
            return items
        }
        let (loadedItems, readable) = Self.readItems(from: fileURL)
        items = loadedItems
        persisted = readable
        return loadedItems
    }

    /// A missing, unreadable, or corrupt file reads as an empty store; only a
    /// missing file or a valid one is what the store holds.
    private static func readItems(from file: URL) -> ([String: String], Bool) {
        guard let data = try? Data(contentsOf: file) else {
            return ([:], !FileManager.default.fileExists(atPath: file.path))
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            NSLog("[KeyValueStorage] Ignoring unreadable store at \(file.path)")
            return ([:], false)
        }
        return (object.compactMapValues { $0 as? String }, true)
    }
}
