import Foundation

/// Installation-scoped plugin data, independent of OTA generations and binary versions.
final class LynxClientStorage {
    private static let lock = NSLock()
    private let directory: URL
    private var file: URL { directory.appendingPathComponent("client.json") }

    init(directory: URL) { self.directory = directory }

    static func applicationStorage() throws -> LynxClientStorage {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        return LynxClientStorage(directory: support.appendingPathComponent("HotUpdaterLynxClient"))
    }

    func installId() throws -> String {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var state = try read()
        if let id = state["installId"] as? String { return id }
        let id = UUID().uuidString.lowercased()
        state["installId"] = id
        try write(state)
        return id
    }

    func get(_ key: String) throws -> String? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        try validate(key, value: nil)
        return (try read()["values"] as? [String: String])?[key]
    }

    func set(_ key: String, value: String?) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        try validate(key, value: value)
        var state = try read()
        var values = state["values"] as? [String: String] ?? [:]
        values[key] = value
        state["values"] = values
        try write(state)
    }

    private func validate(_ key: String, value: String?) throws {
        guard key.hasPrefix("plugins/"), (value?.utf8.count ?? 0) <= 65_536 else {
            throw LynxArtifactError.invalid("Invalid plugin storage key or value exceeds 64 KB")
        }
    }

    private func read() throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        guard let state = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else {
            throw LynxArtifactError.invalid("Invalid plugin storage")
        }
        return state
    }

    private func write(_ state: [String: Any]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var excludedDirectory = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excludedDirectory.setResourceValues(values)
        try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]).write(to: file, options: .atomic)
    }
}
