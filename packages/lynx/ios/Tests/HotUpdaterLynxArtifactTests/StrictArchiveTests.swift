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

    func testBrotliRejectsTrailingBytesBeyondTheInputBuffer() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var seed: UInt32 = 0x12345678
        let payload = Data((0..<65_532).map { _ -> UInt8 in
            seed ^= seed << 13
            seed ^= seed >> 17
            seed ^= seed << 5
            return UInt8(truncatingIfNeeded: seed)
        })
        // Node zlib Brotli quality=0, lgwin=22 emits this uncompressed block
        // for the deterministic payload. The complete stream is exactly 64 KiB.
        let compressed = Data([0x8b, 0xfd, 0xff]) + payload + Data([0x03])
        XCTAssertEqual(compressed.count, 65_536)
        let input = root.appendingPathComponent("input.br")
        let output = root.appendingPathComponent("output")
        let anotherStream = Data(base64Encoded: "CwmAYnJvdGxpLXRhcmdldC1hc3NldAM=")!
        for (stream, expected) in [(compressed, payload), (anotherStream, Data("brotli-target-asset".utf8))] {
            try stream.write(to: input)
            try StreamingTarArchiveExtractor.decompressBrotliFile(
                from: input.path, to: output.path, maximumOutputBytes: UInt64(expected.count)
            )
            XCTAssertEqual(try Data(contentsOf: output), expected)
            for suffix in [Data([0]), anotherStream] {
                try (stream + suffix).write(to: input)
                XCTAssertThrowsError(try StreamingTarArchiveExtractor.decompressBrotliFile(
                    from: input.path, to: output.path, maximumOutputBytes: UInt64(expected.count)
                )) { error in
                    XCTAssertEqual((error as NSError).code, 10)
                }
            }
        }
    }

    func testRejectsMalformedTarTerminationPaddingAndExtensions() throws {
        let file = tarEntry("entry", payload: Data("data".utf8))
        let end = Data(repeating: 0, count: 1024)
        let extended = tarEntry("PaxHeader", type: 120, payload: pax("path", "entry"))
        var invalidName = file
        invalidName[0] = 0xff
        checksum(&invalidName)
        var badChecksum = file
        badChecksum[0] = 122
        var badPadding = file
        badPadding[516] = 1
        var trailing = Data(repeating: 0, count: 512)
        trailing[0] = 1
        let cases: [(String, Data)] = [
            ("one end block", file + Data(repeating: 0, count: 512)),
            ("partial end block", file + Data(repeating: 0, count: 1023)),
            ("partial trailing block", file + end + Data([0])),
            ("nonzero trailing block", file + end + trailing),
            ("nonzero file padding", badPadding + end),
            ("dangling PAX", file + extended + end),
            ("empty dangling PAX", file + tarEntry("PaxHeader", type: 120) + end),
            ("consecutive PAX", extended + extended + file + end),
            ("global PAX", tarEntry("Global", type: 103, payload: pax("path", "entry")) + file + end),
            ("GNU long name", tarEntry("LongLink", type: 76, payload: Data("entry\0".utf8)) + file + end),
            ("duplicate PAX key", tarEntry("PaxHeader", type: 120, payload: pax("path", "entry") + pax("path", "other")) + file + end),
            ("PAX link", tarEntry("PaxHeader", type: 120, payload: pax("linkpath", "other")) + file + end),
            ("invalid UTF-8", invalidName + end),
            ("bad checksum", badChecksum + end),
        ]
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for (index, item) in cases.enumerated() {
            let archive = root.appendingPathComponent("input-\(index).tar")
            try item.1.write(to: archive)
            XCTAssertThrowsError(
                try TarArchiveExtractor.extract(from: archive.path,
                    to: root.appendingPathComponent("output-\(index)").path,
                    strict: true, progressHandler: { _ in }),
                item.0
            )
        }
    }

    func testRejectsNonOctalHeaderNumbersBeforeWritingManifestFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let payload = Data("data".utf8)
        let file = tarEntry("entry", payload: payload)
        let end = Data(repeating: 0, count: 1024)
        let input = root.appendingPathComponent("input.tar")
        let validOutput = root.appendingPathComponent("valid")
        try (file + end).write(to: input)
        try TarArchiveExtractor.extract(from: input.path, to: validOutput.path,
            strict: true, expectedFiles: ["entry": 4], progressHandler: { _ in })
        XCTAssertEqual(try Data(contentsOf: validOutput.appendingPathComponent("entry")), payload)

        var binarySize = file
        binarySize.replaceSubrange(124..<136, with: Data(repeating: 0, count: 12))
        binarySize[124] = 0x80
        binarySize[135] = UInt8(payload.count)
        checksum(&binarySize)

        var signedSize = file
        signedSize.replaceSubrange(124..<136, with: ("+" + String(repeating: "0", count: 9) + "4\0").utf8)
        checksum(&signedSize)

        // Keep the checksum's numeric value correct so only its encoding differs.
        var binaryChecksum = file
        let sum = file.prefix(512).enumerated().reduce(UInt64(0)) { sum, item in
            sum + UInt64((148..<156).contains(item.offset) ? 32 : item.element)
        }
        for offset in 0..<8 {
            binaryChecksum[155 - offset] = UInt8(truncatingIfNeeded: sum >> (offset * 8))
        }
        binaryChecksum[148] |= 0x80

        for (name, bytes) in [("binary-size", binarySize), ("signed-size", signedSize), ("binary-checksum", binaryChecksum)] {
            try (bytes + end).write(to: input)
            let output = root.appendingPathComponent(name)
            XCTAssertThrowsError(try TarArchiveExtractor.extract(from: input.path, to: output.path,
                strict: true, expectedFiles: ["entry": 4], progressHandler: { _ in }), name) { error in
                XCTAssertEqual((error as NSError).domain, "TarArchiveExtractor", name)
                XCTAssertEqual((error as NSError).code, 2, name)
            }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: output.path), [], name)
        }
    }

    func testAppliesPaxPathAndSizeToTheFollowingFileOnly() throws {
        let name = "pages/" + String(repeating: "nested-", count: 20) + "detail.bundle"
        let payload = Data("data".utf8)
        let archive = tarEntry("PaxHeader", type: 120, payload: pax("path", name) + pax("size", "4")) +
            tarEntry("placeholder", payload: payload, declaredSize: 1) +
            tarEntry("next", payload: Data("next".utf8)) + Data(repeating: 0, count: 1024)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let input = root.appendingPathComponent("input.tar")
        try archive.write(to: input)
        let output = root.appendingPathComponent("output")
        try TarArchiveExtractor.extract(from: input.path, to: output.path,
            strict: true, progressHandler: { _ in })
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent(name)), payload)
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("next")), Data("next".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("placeholder").path))
    }

    func testBindsArchivePathsAndSizesToManifestBeforeWriting() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let archive = root.appendingPathComponent("input.tar")
        try (tarEntry("entry", payload: Data("data".utf8)) + Data(repeating: 0, count: 1024)).write(to: archive)
        let wrong: [[String: UInt64]] = [["unknown": 4], ["entry": 3], ["entry": 5]]
        for (index, expected) in wrong.enumerated() {
            let output = root.appendingPathComponent("output-\(index)")
            XCTAssertThrowsError(try TarArchiveExtractor.extract(from: archive.path, to: output.path,
                strict: true, expectedFiles: expected, progressHandler: { _ in }))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: output.path), [])
        }
        XCTAssertThrowsError(try TarArchiveExtractor.extract(from: archive.path,
            to: root.appendingPathComponent("missing").path, strict: true,
            expectedFiles: ["entry": 4, "missing": 0], progressHandler: { _ in }))
        let valid = root.appendingPathComponent("valid")
        try TarArchiveExtractor.extract(from: archive.path, to: valid.path, strict: true,
            expectedFiles: ["entry": 4], progressHandler: { _ in })
        XCTAssertEqual(try Data(contentsOf: valid.appendingPathComponent("entry")), Data("data".utf8))

        try (tarEntry("empty/", type: 53) + Data(repeating: 0, count: 1024)).write(to: archive)
        let directory = root.appendingPathComponent("directory")
        XCTAssertThrowsError(try TarArchiveExtractor.extract(from: archive.path, to: directory.path,
            strict: true, expectedFiles: ["empty": 0], progressHandler: { _ in }))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

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
        let request = LynxArtifactRequest(bundleId: "01900000-0000-7000-8000-000000000202",
            manifestUrl: URL(string: "https://artifacts.test/manifest")!,
            manifestFileHash: String(repeating: "b", count: 64),
            assets: ["Straße/x.bin": asset, "strasse/y.bin": asset])

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

            let request = LynxArtifactRequest(bundleId: "01900000-0000-7000-8000-000000000202",
            manifestUrl: URL(string: "https://artifacts.test/manifest")!,
            manifestFileHash: String(repeating: "b", count: 64),
            assets: [path: asset])
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
            archive.append(tarEntry(path))
        }
        archive.append(Data(repeating: 0, count: 1_024))
        return archive
    }

    private func tarEntry(_ name: String, type: UInt8 = 48, payload: Data = Data(), declaredSize: Int? = nil) -> Data {
        var header = Data(repeating: 0, count: 512)
        header.replaceSubrange(0..<name.utf8.count, with: name.utf8)
        header[156] = type
        header.replaceSubrange(257..<262, with: "ustar".utf8)
        let size = String(declaredSize ?? payload.count, radix: 8)
        let field = String(repeating: "0", count: 11 - size.count) + size + "\0"
        header.replaceSubrange(124..<136, with: field.utf8)
        checksum(&header)
        return header + payload + Data(repeating: 0, count: (512 - payload.count % 512) % 512)
    }

    private func checksum(_ bytes: inout Data) {
        bytes.replaceSubrange(148..<156, with: Data(repeating: 32, count: 8))
        let sum = bytes.prefix(512).reduce(0) { $0 + Int($1) }
        let octal = String(sum, radix: 8)
        let field = String(repeating: "0", count: 6 - octal.count) + octal + "\0 "
        bytes.replaceSubrange(148..<156, with: field.utf8)
    }

    private func pax(_ key: String, _ value: String) -> Data {
        var length = 0
        while true {
            let bytes = Data("\(length) \(key)=\(value)\n".utf8)
            if bytes.count == length { return bytes }
            length = bytes.count
        }
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
