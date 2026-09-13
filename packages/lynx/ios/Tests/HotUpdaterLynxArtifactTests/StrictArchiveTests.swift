import CryptoKit
import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class StrictArchiveTests: XCTestCase {
    private let directoryAliases = [
        ("A", "a"),
        ("café", "cafe\u{301}"),
        ("Straße", "strasse"),
    ]

    func testPortableCollisionRejectsGreekFinalSigmaAlias() throws {
        let guardValue = ArchiveEntryGuard()
        try guardValue.admit("assets/μέρος.json", size: 1, directory: false)

        XCTAssertThrowsError(
            try guardValue.admit("assets/ΜΈΡΟσ.json", size: 1, directory: false)
        )
    }

    func testPortableCollisionRejectsSharpSExpansionAlias() throws {
        let guardValue = ArchiveEntryGuard()
        try guardValue.admit("assets/Straße.txt", size: 1, directory: false)

        XCTAssertThrowsError(
            try guardValue.admit("assets/STRASSE.txt", size: 1, directory: false)
        )
    }

    func testPortableCollisionRejectsCaseFoldedFileAncestor() throws {
        let guardValue = ArchiveEntryGuard()
        try guardValue.admit("Straße", size: 1, directory: false)

        XCTAssertThrowsError(
            try guardValue.admit(
                "strasse/entry.lynxbc",
                size: 1,
                directory: false
            )
        )

        let reverseOrder = ArchiveEntryGuard()
        try reverseOrder.admit(
            "strasse/entry.lynxbc",
            size: 1,
            directory: false
        )
        XCTAssertThrowsError(
            try reverseOrder.admit("Straße", size: 1, directory: false)
        )
    }

    func testTotalEntryBoundaryCountsManifestAndExplicitOrLogicalParents() throws {
        let logicalParents = ArchiveEntryGuard(reservingManifest: true)
        for index in 0..<4_999 {
            try logicalParents.admit(
                "dir-\(index)/entry",
                size: 0,
                directory: false
            )
        }
        try logicalParents.admit("root-entry", size: 0, directory: false)
        XCTAssertThrowsError(
            try logicalParents.admit("overflow", size: 0, directory: false)
        )

        let explicitParents = ArchiveEntryGuard(reservingManifest: true)
        for index in 0..<4_999 {
            try explicitParents.admit("dir-\(index)", size: 0, directory: true)
            try explicitParents.admit(
                "dir-\(index)/entry",
                size: 0,
                directory: false
            )
        }
        try explicitParents.admit("root-entry", size: 0, directory: false)
        XCTAssertThrowsError(
            try explicitParents.admit("overflow", size: 0, directory: false)
        )
    }

    func testPortableDirectoryAliasesAreRejectedForEveryAdmissionOrder() throws {
        for (first, second) in directoryAliases {
            let implicit = ArchiveEntryGuard()
            try implicit.admit("\(first)/x.bin", size: 0, directory: false)
            XCTAssertThrowsError(
                try implicit.admit("\(second)/y.bin", size: 0, directory: false)
            )

            let reverseImplicit = ArchiveEntryGuard()
            try reverseImplicit.admit("\(second)/x.bin", size: 0, directory: false)
            XCTAssertThrowsError(
                try reverseImplicit.admit("\(first)/y.bin", size: 0, directory: false)
            )

            let explicitFirst = ArchiveEntryGuard()
            try explicitFirst.admit(first, size: 0, directory: true)
            XCTAssertThrowsError(
                try explicitFirst.admit("\(second)/y.bin", size: 0, directory: false)
            )

            let implicitFirst = ArchiveEntryGuard()
            try implicitFirst.admit("\(first)/x.bin", size: 0, directory: false)
            XCTAssertThrowsError(
                try implicitFirst.admit(second, size: 0, directory: true)
            )

            let reverseExplicitFirst = ArchiveEntryGuard()
            try reverseExplicitFirst.admit(second, size: 0, directory: true)
            XCTAssertThrowsError(
                try reverseExplicitFirst.admit(
                    "\(first)/y.bin",
                    size: 0,
                    directory: false
                )
            )

            let reverseImplicitFirst = ArchiveEntryGuard()
            try reverseImplicitFirst.admit(
                "\(second)/x.bin",
                size: 0,
                directory: false
            )
            XCTAssertThrowsError(
                try reverseImplicitFirst.admit(first, size: 0, directory: true)
            )
        }
    }

    func testExactSharedDirectorySpellingRemainsValid() throws {
        let guardValue = ArchiveEntryGuard()
        try guardValue.admit("A", size: 0, directory: true)
        try guardValue.admit("A/x.bin", size: 0, directory: false)
        XCTAssertNoThrow(
            try guardValue.admit("A/y.bin", size: 0, directory: false)
        )

        let implicit = ArchiveEntryGuard()
        try implicit.admit("A/x.bin", size: 0, directory: false)
        XCTAssertNoThrow(
            try implicit.admit("A/y.bin", size: 0, directory: false)
        )
    }

    func testTarExtractionRejectsImplicitParentAlias() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("strict-tar-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let archive = root.appendingPathComponent("alias.tar")
        try makeTar(paths: ["A/x.bin", "a/y.bin"]).write(to: archive)

        XCTAssertThrowsError(
            try TarArchiveExtractor.extract(
                from: archive.path,
                to: root.appendingPathComponent("output").path,
                strict: true,
                progressHandler: { _ in }
            )
        )
    }

    func testManifestTransferDescriptorRejectsImplicitParentAlias() throws {
        let file = LynxChangedAsset.File(
            url: URL(string: "https://artifacts.test/asset")!
        )
        let asset = LynxChangedAsset(
            fileHash: String(repeating: "a", count: 64),
            file: file
        )
        let request = LynxArtifactRequest(
            bundleId: "01900000-0000-7000-8000-000000000202",
            fileUrl: nil,
            fileHash: nil,
            manifestFileHash: String(repeating: "b", count: 64),
            manifestUrl: URL(string: "https://artifacts.test/manifest")!,
            changedAssets: ["Straße/x.bin": asset, "strasse/y.bin": asset]
        )

        XCTAssertThrowsError(try request.validate())
    }

    func testArchiveAndManifestTransferRejectControlsDelAndAnyColon() throws {
        let invalidPaths = [
            "assets/foo:bar.bin",
            "assets/control\u{1f}.bin",
            "assets/delete\u{7f}.bin",
        ]
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("strict-path-characters-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = LynxChangedAsset.File(
            url: URL(string: "https://artifacts.test/asset")!
        )
        let asset = LynxChangedAsset(
            fileHash: String(repeating: "a", count: 64),
            file: file
        )

        for (index, path) in invalidPaths.enumerated() {
            let archive = root.appendingPathComponent("invalid-\(index).tar")
            try makeTar(paths: [path]).write(to: archive)
            XCTAssertThrowsError(
                try TarArchiveExtractor.extract(
                    from: archive.path,
                    to: root.appendingPathComponent("output-\(index)").path,
                    strict: true,
                    progressHandler: { _ in }
                )
            )

            let request = LynxArtifactRequest(
                bundleId: "01900000-0000-7000-8000-000000000202",
                fileUrl: nil,
                fileHash: nil,
                manifestFileHash: String(repeating: "b", count: 64),
                manifestUrl: URL(string: "https://artifacts.test/manifest")!,
                changedAssets: [path: asset]
            )
            XCTAssertThrowsError(try request.validate())
        }
    }

    func testSharedArchiveExpandedAndPerFileBoundaries() throws {
        XCTAssertEqual(ArchiveLimits.archive, 128 * 1024 * 1024)
        XCTAssertEqual(ArchiveLimits.expanded, 512 * 1024 * 1024)
        XCTAssertEqual(ArchiveLimits.tarStream, 567_581_936)
        XCTAssertEqual(ArchiveLimits.file, 128 * 1024 * 1024)
        XCTAssertEqual(ArchiveLimits.manifest, 1 * 1024 * 1024)

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("strict-limits-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let archive = root.appendingPathComponent("archive")
        _ = FileManager.default.createFile(atPath: archive.path, contents: nil)
        let archiveHandle = try FileHandle(forWritingTo: archive)
        try archiveHandle.truncate(atOffset: ArchiveLimits.archive)
        XCTAssertNoThrow(try ArchiveLimits.checkArchive(archive))
        try archiveHandle.truncate(atOffset: ArchiveLimits.archive + 1)
        XCTAssertThrowsError(try ArchiveLimits.checkArchive(archive))
        try archiveHandle.close()

        let output = root.appendingPathComponent("expanded")
        _ = FileManager.default.createFile(atPath: output.path, contents: nil)
        let outputHandle = try FileHandle(forWritingTo: output)
        try outputHandle.seek(toOffset: ArchiveLimits.expanded)
        XCTAssertNoThrow(try ArchiveLimits.checkOutput(outputHandle, adding: 0))
        XCTAssertThrowsError(try ArchiveLimits.checkOutput(outputHandle, adding: 1))
        try outputHandle.close()

        let framedTar = root.appendingPathComponent("framed.tar")
        _ = FileManager.default.createFile(atPath: framedTar.path, contents: nil)
        let framedTarHandle = try FileHandle(forWritingTo: framedTar)
        try framedTarHandle.seek(toOffset: ArchiveLimits.expanded)
        let maximumFramingBytes = ArchiveLimits.tarStream - ArchiveLimits.expanded
        XCTAssertEqual(maximumFramingBytes, 30_711_024)
        XCTAssertNoThrow(
            try ArchiveLimits.checkOutput(
                framedTarHandle,
                adding: Int(maximumFramingBytes),
                maximumBytes: ArchiveLimits.tarStream
            )
        )
        XCTAssertThrowsError(
            try ArchiveLimits.checkOutput(
                framedTarHandle,
                adding: Int(maximumFramingBytes + 1),
                maximumBytes: ArchiveLimits.tarStream
            )
        )
        try framedTarHandle.close()

        let exactFile = ArchiveEntryGuard()
        XCTAssertNoThrow(
            try exactFile.admit(
                "large.bin",
                size: ArchiveLimits.file,
                directory: false
            )
        )
        let oversizedFile = ArchiveEntryGuard()
        XCTAssertThrowsError(
            try oversizedFile.admit(
                "large.bin",
                size: ArchiveLimits.file + 1,
                directory: false
            )
        )

        let exactExpanded = ArchiveEntryGuard()
        for index in 0..<4 {
            try exactExpanded.admit(
                "file-\(index)",
                size: ArchiveLimits.file,
                directory: false
            )
        }
        XCTAssertThrowsError(
            try exactExpanded.admit("overflow", size: 1, directory: false)
        )
    }

    func testInstalledManifestAcceptsOneMiBAndRejectsOneByteMore() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("strict-manifest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let bundleId = "01900000-0000-7000-8000-000000000202"
        let runtimeId = "strict-archive-limit-runtime"
        let entry = Data("entry".utf8)
        let metadata = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "bundleId": bundleId,
            "platform": "ios",
            "runtimeId": runtimeId,
            "entry": "main.lynx.bundle",
        ], options: [.sortedKeys])
        try entry.write(to: root.appendingPathComponent("main.lynx.bundle"))
        try metadata.write(to: root.appendingPathComponent("hot-updater-lynx.json"))
        var manifest = try JSONSerialization.data(withJSONObject: [
            "bundleId": bundleId,
            "assets": [
                "main.lynx.bundle": ["fileHash": hash(entry)],
                "hot-updater-lynx.json": ["fileHash": hash(metadata)],
            ],
        ], options: [.sortedKeys])
        manifest.append(Data(repeating: 0x20, count: ArchiveLimits.manifest - manifest.count))
        let manifestURL = root.appendingPathComponent("manifest.json")
        try manifest.write(to: manifestURL)
        XCTAssertNoThrow(
            try VerifiedLynxTree.verify(
                at: root,
                bundleId: bundleId,
                manifestToken: nil,
                configuration: .init(runtimeId: runtimeId)
            )
        )

        let entryURL = root.appendingPathComponent("main.lynx.bundle")
        let entryHandle = try FileHandle(forWritingTo: entryURL)
        try entryHandle.truncate(atOffset: ArchiveLimits.file + 1)
        try entryHandle.close()
        XCTAssertThrowsError(
            try VerifiedLynxTree.verify(
                at: root,
                bundleId: bundleId,
                manifestToken: nil,
                configuration: .init(runtimeId: runtimeId)
            )
        )
        try entry.write(to: entryURL)

        manifest.append(0x20)
        try manifest.write(to: manifestURL)
        XCTAssertThrowsError(
            try VerifiedLynxTree.verify(
                at: root,
                bundleId: bundleId,
                manifestToken: nil,
                configuration: .init(runtimeId: runtimeId)
            )
        )
    }

    private func makeTar(paths: [String]) -> Data {
        var archive = Data()
        for path in paths {
            var header = Data(repeating: 0, count: 512)
            header.replaceSubrange(0..<path.utf8.count, with: path.utf8)
            header[156] = 48
            archive.append(header)
        }
        archive.append(Data(repeating: 0, count: 1_024))
        return archive
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
