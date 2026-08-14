import CryptoKit
import Foundation

final class ReleaseCatalogCacheService {
    private static let maxCompiledCatalogBytes = 256 * 1024
    private static let maxWireEnvelopeBytes = 4 * 1024
    private static let maxETagBytes = 1024
    private static let cacheFormatBytes = 3
    static let defaultMaxEntries = 8
    static let defaultMaxEntryBytes =
        maxCompiledCatalogBytes + maxWireEnvelopeBytes + maxETagBytes + cacheFormatBytes
    static let defaultMaxTotalBytes = defaultMaxEntries * (defaultMaxEntryBytes + 65)

    private let fileManager: FileManager
    private let rootDirectory: URL
    private let maxEntries: Int
    private let maxEntryBytes: Int
    private let maxTotalBytes: Int
    private let atomicWriter: (Data, URL) throws -> Void
    private let lock = NSLock()

    init(
        rootDirectory: URL = ReleaseCatalogCacheService.defaultRootDirectory(),
        fileManager: FileManager = .default,
        maxEntries: Int = defaultMaxEntries,
        maxEntryBytes: Int = defaultMaxEntryBytes,
        maxTotalBytes: Int = defaultMaxTotalBytes,
        atomicWriter: @escaping (Data, URL) throws -> Void = ReleaseCatalogCacheService.writeAtomically
    ) {
        self.rootDirectory = rootDirectory
        self.fileManager = fileManager
        self.maxEntries = maxEntries
        self.maxEntryBytes = maxEntryBytes
        self.maxTotalBytes = maxTotalBytes
        self.atomicWriter = atomicWriter
        recoverInterruptedWrites()
        trim()
    }

    func get(partition: String) -> String? {
        lock.lock()
        defer { lock.unlock() }

        let file = entryURL(partition: partition)
        guard let attributes = try? fileManager.attributesOfItem(atPath: file.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= maxEntryBytes + 65,
              let stored = try? Data(contentsOf: file),
              let separator = stored.firstIndex(of: 0x0a),
              separator == 64 else {
            try? fileManager.removeItem(at: file)
            return nil
        }

        let expectedDigest = String(data: stored[..<separator], encoding: .ascii)
        let payload = stored[stored.index(after: separator)...]
        guard payload.count <= maxEntryBytes,
              expectedDigest == sha256(Data(payload)),
              let value = String(data: payload, encoding: .utf8) else {
            try? fileManager.removeItem(at: file)
            return nil
        }

        try? fileManager.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: file.path
        )
        return value
    }

    @discardableResult
    func set(partition: String, value: String) -> Bool {
        guard let payload = value.data(using: .utf8), payload.count <= maxEntryBytes else {
            return false
        }

        lock.lock()
        defer { lock.unlock() }

        do {
            try fileManager.createDirectory(
                at: rootDirectory,
                withIntermediateDirectories: true
            )
            var cacheDirectory = rootDirectory
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            try? cacheDirectory.setResourceValues(resourceValues)
            var stored = Data(sha256(payload).utf8)
            stored.append(0x0a)
            stored.append(payload)
            let destination = entryURL(partition: partition)
            try atomicWriter(stored, destination)
            try? fileManager.setAttributes(
                [.modificationDate: Date()],
                ofItemAtPath: destination.path
            )
            trim()
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    func remove(partition: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        let file = entryURL(partition: partition)
        guard fileManager.fileExists(atPath: file.path) else { return true }
        do {
            try fileManager.removeItem(at: file)
            return true
        } catch {
            return false
        }
    }

    private func entryURL(partition: String) -> URL {
        rootDirectory
            .appendingPathComponent(sha256(Data(partition.utf8)))
            .appendingPathExtension("catalog")
    }

    private func recoverInterruptedWrites() {
        guard let entries = try? fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: nil,
            options: []
        ) else {
            return
        }
        for entry in entries
        where entry.lastPathComponent.hasPrefix(".catalog-") && entry.pathExtension == "tmp" {
            try? fileManager.removeItem(at: entry)
        }
    }

    private func trim() {
        let keys: Set<URLResourceKey> = [
            .contentModificationDateKey,
            .fileSizeKey,
            .isRegularFileKey,
        ]
        let entries = (try? fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ))?
            .filter { url in
                guard url.pathExtension == "catalog",
                      let values = try? url.resourceValues(forKeys: keys) else {
                    return false
                }
                return values.isRegularFile == true
            }
            .sorted { first, second in
                let firstDate = (try? first.resourceValues(forKeys: keys))?.contentModificationDate ?? .distantPast
                let secondDate = (try? second.resourceValues(forKeys: keys))?.contentModificationDate ?? .distantPast
                return firstDate > secondDate
            } ?? []

        var retainedBytes = 0
        for (index, entry) in entries.enumerated() {
            let size = (try? entry.resourceValues(forKeys: keys))?.fileSize ?? 0
            retainedBytes += size
            if index >= maxEntries || retainedBytes > maxTotalBytes {
                try? fileManager.removeItem(at: entry)
            }
        }
    }

    private func sha256(_ value: Data) -> String {
        SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
    }

    private static func writeAtomically(_ data: Data, to destination: URL) throws {
        let temporary = destination
            .deletingLastPathComponent()
            .appendingPathComponent(".catalog-\(UUID().uuidString).tmp")
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.synchronize()
            try handle.close()

            if FileManager.default.fileExists(atPath: destination.path) {
                _ = try FileManager.default.replaceItemAt(
                    destination,
                    withItemAt: temporary,
                    backupItemName: nil,
                    options: []
                )
            } else {
                try FileManager.default.moveItem(at: temporary, to: destination)
            }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    private static func defaultRootDirectory() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("HotUpdater", isDirectory: true)
            .appendingPathComponent("ReleaseCatalogCache", isDirectory: true)
    }
}
