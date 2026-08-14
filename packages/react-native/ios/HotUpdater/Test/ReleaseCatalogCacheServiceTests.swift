#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterArchive

struct ReleaseCatalogCacheServiceTests {
    @Test
    func persistsChecksumVerifiedEntriesWithoutCredentialFilenames() throws {
        let root = try workingDirectory(named: "persistent")
        defer { try? FileManager.default.removeItem(at: root) }
        let partition = "https://updates.example.com|x-api-key=raw-secret"

        let first = ReleaseCatalogCacheService(rootDirectory: root)
        #expect(first.set(partition: partition, value: "validated-catalog"))
        #expect(
            ReleaseCatalogCacheService(rootDirectory: root).get(partition: partition)
                == "validated-catalog"
        )

        let entry = try #require(
            FileManager.default.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil
            ).first
        )
        #expect(entry.lastPathComponent.range(of: "^[0-9a-f]{64}\\.catalog$", options: .regularExpression) != nil)
        #expect(!entry.lastPathComponent.contains("raw-secret"))
        #expect(!(try String(contentsOf: entry, encoding: .utf8)).contains("raw-secret"))

        let handle = try FileHandle(forWritingTo: entry)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("corrupt".utf8))
        try handle.close()
        #expect(ReleaseCatalogCacheService(rootDirectory: root).get(partition: partition) == nil)
        #expect(!FileManager.default.fileExists(atPath: entry.path))
    }

    @Test
    func failedAtomicReplacementPreservesPreviousEntry() throws {
        let root = try workingDirectory(named: "interrupted")
        defer { try? FileManager.default.removeItem(at: root) }
        let partition = "partition"
        #expect(ReleaseCatalogCacheService(rootDirectory: root).set(partition: partition, value: "previous"))

        let interrupted = ReleaseCatalogCacheService(
            rootDirectory: root,
            atomicWriter: { data, destination in
                let interruptedWrite = destination
                    .deletingLastPathComponent()
                    .appendingPathComponent("interrupted.tmp")
                try data.write(to: interruptedWrite)
                let handle = try FileHandle(forWritingTo: interruptedWrite)
                try handle.synchronize()
                try handle.close()
                try FileManager.default.removeItem(at: interruptedWrite)
                throw TestWriteError.interrupted
            }
        )
        #expect(!interrupted.set(partition: partition, value: "replacement"))
        #expect(ReleaseCatalogCacheService(rootDirectory: root).get(partition: partition) == "previous")
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).count == 1)
    }

    @Test
    func successfulAtomicReplacementLeavesOneCompleteEntry() throws {
        let root = try workingDirectory(named: "replacement")
        defer { try? FileManager.default.removeItem(at: root) }
        let service = ReleaseCatalogCacheService(rootDirectory: root)

        #expect(service.set(partition: "partition", value: "previous"))
        #expect(service.set(partition: "partition", value: "replacement"))

        #expect(service.get(partition: "partition") == "replacement")
        let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
        #expect(entries.count == 1)
        #expect(entries.first?.hasSuffix(".catalog") == true)
        #expect(!entries.contains { $0.hasSuffix(".tmp") })
    }

    @Test
    func removesUncommittedTemporaryFilesOnNextLaunch() throws {
        let root = try workingDirectory(named: "recovery")
        defer { try? FileManager.default.removeItem(at: root) }
        let interrupted = root.appendingPathComponent(".catalog-interrupted.tmp")
        try Data("partial".utf8).write(to: interrupted)

        _ = ReleaseCatalogCacheService(rootDirectory: root)

        #expect(!FileManager.default.fileExists(atPath: interrupted.path))
    }

    @Test
    func evictsLeastRecentlyUsedEntriesAndRejectsOversizedPayloads() throws {
        let root = try workingDirectory(named: "bounded")
        defer { try? FileManager.default.removeItem(at: root) }
        let service = ReleaseCatalogCacheService(
            rootDirectory: root,
            maxEntries: 2,
            maxEntryBytes: 16,
            maxTotalBytes: 200
        )

        #expect(service.set(partition: "one", value: "first"))
        Thread.sleep(forTimeInterval: 0.01)
        #expect(service.set(partition: "two", value: "second"))
        Thread.sleep(forTimeInterval: 0.01)
        #expect(service.set(partition: "three", value: "third"))

        #expect(service.get(partition: "one") == nil)
        #expect(service.get(partition: "two") == "second")
        #expect(service.get(partition: "three") == "third")
        #expect(!service.set(partition: "two", value: String(repeating: "x", count: 17)))
        #expect(service.get(partition: "two") == "second")
    }

    private enum TestWriteError: Error {
        case interrupted
    }

    private func workingDirectory(named name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("release-catalog-cache-tests-\(name)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
#endif
