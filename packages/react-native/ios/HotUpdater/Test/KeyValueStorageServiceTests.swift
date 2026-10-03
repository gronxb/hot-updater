#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct KeyValueStorageServiceTests {
    @Test
    func setsReadsAndRemovesItems() throws {
        let directory = try workingDirectory(named: "basic")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let storage = KeyValueStorageService(directory: directory)

        #expect(storage.getItem("plugins/insights/queue") == nil)
        #expect(storage.setItem("plugins/insights/queue", value: "[1,2]"))
        #expect(storage.setItem("plugins/other/flag", value: ""))
        #expect(storage.getItem("plugins/insights/queue") == "[1,2]")
        #expect(storage.getItem("plugins/other/flag") == "")

        #expect(storage.setItem("plugins/insights/queue", value: nil))
        #expect(storage.getItem("plugins/insights/queue") == nil)
        #expect(storage.setItem("never-set", value: nil))
        #expect(try storedObject(in: directory) == ["plugins/other/flag": ""])
    }

    @Test
    func persistsAcrossInstances() throws {
        let directory = try workingDirectory(named: "persistent")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let first = KeyValueStorageService(directory: directory)
        first.setItem("a", value: "1")
        first.setItem("b", value: "two words \u{1F600}\n\"quoted\"")
        first.setItem("c", value: "3")
        first.setItem("c", value: nil)

        let second = KeyValueStorageService(directory: directory)
        #expect(second.getItem("a") == "1")
        #expect(second.getItem("b") == "two words \u{1F600}\n\"quoted\"")
        #expect(second.getItem("c") == nil)
        #expect(try storedObject(in: directory) == [
            "a": "1",
            "b": "two words \u{1F600}\n\"quoted\"",
        ])
    }

    @Test(arguments: ["{", "[\"not\",\"an\",\"object\"]", "\u{0}\u{1}binary"])
    func corruptFileReadsAsEmpty(contents: String) throws {
        let directory = try workingDirectory(named: "corrupt")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: storageFile(in: directory))

        let storage = KeyValueStorageService(directory: directory)
        #expect(storage.getItem("a") == nil)
        #expect(storage.setItem("a", value: "recovered"))

        #expect(KeyValueStorageService(directory: directory).getItem("a") == "recovered")
        #expect(try storedObject(in: directory) == ["a": "recovered"])
    }

    @Test
    func ignoresNonStringValues() throws {
        let directory = try workingDirectory(named: "mixed")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(#"{"text":"kept","number":1,"nested":{"a":"b"},"nothing":null}"#.utf8)
            .write(to: storageFile(in: directory))

        let storage = KeyValueStorageService(directory: directory)
        #expect(storage.getItem("text") == "kept")
        #expect(storage.getItem("number") == nil)
        #expect(storage.getItem("nested") == nil)
        #expect(storage.getItem("nothing") == nil)
    }

    @Test
    func loadsTheFileOnlyOnce() throws {
        let directory = try workingDirectory(named: "cached")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let storage = KeyValueStorageService(directory: directory)
        storage.setItem("a", value: "memory")

        // Another writer's change is not read back; memory stays authoritative.
        try Data(#"{"a":"disk"}"#.utf8).write(to: storageFile(in: directory))
        #expect(storage.getItem("a") == "memory")
        storage.setItem("b", value: "2")
        #expect(try storedObject(in: directory) == ["a": "memory", "b": "2"])
    }

    @Test
    func excludesDirectoryAndFileFromBackups() throws {
        let directory = try workingDirectory(named: "backup")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let storage = KeyValueStorageService(directory: directory)
        let file = storageFile(in: directory)

        storage.setItem("a", value: "1")
        #expect(isExcludedFromBackup(directory))
        // The file keeps its own flag, not only the one it inherits.
        try setExcludedFromBackup(directory, false)
        #expect(isExcludedFromBackup(file))

        // Each write replaces the file, so the flag must be applied again.
        try setExcludedFromBackup(file, false)
        storage.setItem("b", value: "2")
        #expect(isExcludedFromBackup(directory))
        try setExcludedFromBackup(directory, false)
        #expect(isExcludedFromBackup(file))
    }

    @Test
    func concurrentWritesAreAllPersisted() throws {
        let directory = try workingDirectory(named: "concurrent")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let storage = KeyValueStorageService(directory: directory)

        DispatchQueue.concurrentPerform(iterations: 64) { index in
            storage.setItem("key-\(index)", value: "value-\(index)")
            _ = storage.getItem("key-\(index / 2)")
        }

        let reloaded = KeyValueStorageService(directory: directory)
        for index in 0..<64 {
            #expect(reloaded.getItem("key-\(index)") == "value-\(index)")
        }
    }

    @Test
    func failedWriteKeepsValueForThisProcess() throws {
        let directory = try workingDirectory(named: "unwritable")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        // A directory where the file belongs makes every write fail.
        try FileManager.default.createDirectory(
            at: storageFile(in: directory),
            withIntermediateDirectories: true
        )
        try Data("occupied".utf8).write(
            to: storageFile(in: directory).appendingPathComponent("occupied")
        )
        let storage = KeyValueStorageService(directory: directory)

        #expect(storage.setItem("a", value: "1") == false)
        #expect(storage.getItem("a") == "1")
    }

    private func workingDirectory(named name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("key-value-storage-tests-\(name)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // The store creates its own directory on first write.
        return root.appendingPathComponent("HotUpdater", isDirectory: true)
    }

    private func storageFile(in directory: URL) -> URL {
        directory.appendingPathComponent(KeyValueStorageService.storageFilename)
    }

    private func storedObject(in directory: URL) throws -> [String: String] {
        let data = try Data(contentsOf: storageFile(in: directory))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
    }
}
#endif
