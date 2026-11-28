#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct FileManagerServiceTests {
    @Test
    func isRegularFileAcceptsOnlyARegularFileItself() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("file-manager-service-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let file = root.appendingPathComponent("index.ios.bundle")
        try Data("bundle".utf8).write(to: file)
        let directory = root.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let linkToFile = root.appendingPathComponent("link.bundle")
        try FileManager.default.createSymbolicLink(at: linkToFile, withDestinationURL: file)
        let danglingLink = root.appendingPathComponent("dangling.bundle")
        try FileManager.default.createSymbolicLink(
            at: danglingLink,
            withDestinationURL: root.appendingPathComponent("gone.bundle")
        )
        let missing = root.appendingPathComponent("missing.bundle")

        let fileSystem = FileManagerService()
        let cases: [(URL, Bool)] = [
            (file, true),
            (linkToFile, false),
            (danglingLink, false),
            (directory, false),
            (missing, false),
        ]
        for (url, expected) in cases {
            #expect(fileSystem.isRegularFile(atPath: url.path) == expected, "\(url.lastPathComponent)")
            // The answer findBundleFile gave before: fileExists, then the item's own type.
            let previous = FileManager.default.fileExists(atPath: url.path)
                && (try? FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType)
                    == .typeRegular
            #expect(fileSystem.isRegularFile(atPath: url.path) == previous, "\(url.lastPathComponent)")
        }
    }
}
#endif
