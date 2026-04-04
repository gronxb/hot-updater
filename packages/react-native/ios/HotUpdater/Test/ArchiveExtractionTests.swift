#if canImport(Testing)
import CryptoKit
import Compression
import Foundation
import Testing
import zlib

@testable import HotUpdaterArchive

struct ArchiveExtractionTests {
    @Test(arguments: ArchiveFormat.allCases)
    func extractsSupportedArchives(_ format: ArchiveFormat) throws {
        let fixture = try loadDeployedFixture(for: format)
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = workingDirectory.appendingPathComponent(format.fileName)
        try materializeArchive(fixture, to: archiveURL)
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles(fixture.expectations, in: extractionDirectory)
    }

    @Test(arguments: ArchiveFormat.allCases)
    func extractsPayloadSized300MiBArchives(_ format: ArchiveFormat) throws {
        let fixture = try loadDeployedFixture(for: format, from: .payload300MB)
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = workingDirectory.appendingPathComponent(format.fileName)
        try materializeArchive(fixture, to: archiveURL)
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles(fixture.expectations, in: extractionDirectory)
    }

    @Test(arguments: ArchiveFormat.allCases)
    func extractsArchiveSized300MiBArchives(_ format: ArchiveFormat) throws {
        let fixture = try loadDeployedFixture(for: format, from: .archive300MB)
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = workingDirectory.appendingPathComponent(format.fileName)
        try materializeArchive(fixture, to: archiveURL)
        if let archiveSize = fixture.archiveSize {
            #expect(try archiveByteCount(of: archiveURL) == archiveSize)
            #expect(archiveSize >= 300 * 1024 * 1024)
        }
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles(fixture.expectations, in: extractionDirectory)
    }

    @Test(arguments: ArchiveFormat.allCases)
    func extractsLongPaths(_ format: ArchiveFormat) throws {
        let fixture = ArchiveFixture.longPath
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = try createArchive(
            format: format,
            fixture: fixture,
            workingDirectory: workingDirectory
        )
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles(fixture.files, in: extractionDirectory)
    }

    @Test
    func skipsZipTraversalAndSymbolicLinkEntries() throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let safeFile = ArchiveFixture.File(
            path: "safe/kept.txt",
            contents: Data("kept\n".utf8)
        )
        let archiveURL = try createCustomZipArchive(
            entries: [
                ZipEntrySpec(
                    path: "../escape.txt",
                    kind: .file(Data("blocked\n".utf8))
                ),
                ZipEntrySpec(
                    path: safeFile.path,
                    kind: .file(safeFile.contents)
                ),
                ZipEntrySpec(
                    path: "safe/link.txt",
                    kind: .symbolicLink("safe/kept.txt")
                ),
            ],
            workingDirectory: workingDirectory,
            fileName: "edge.zip"
        )
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles([safeFile], in: extractionDirectory)

        let escapedURL = workingDirectory.appendingPathComponent("escape.txt")
        let skippedLinkURL = extractionDirectory.appendingPathComponent("safe/link.txt")
        #expect(FileManager.default.fileExists(atPath: escapedURL.path) == false)
        #expect(FileManager.default.fileExists(atPath: skippedLinkURL.path) == false)
    }

    @Test(arguments: TarArchiveFormat.allCases)
    func skipsTarTraversalEntries(_ format: TarArchiveFormat) throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let safeFile = ArchiveFixture.File(
            path: "safe/kept.txt",
            contents: Data("kept\n".utf8)
        )
        let archiveURL = try createCompressedTarArchive(
            format: format,
            entries: [
                TarEntrySpec(
                    path: "../escape.txt",
                    kind: .file(Data("blocked\n".utf8))
                ),
                TarEntrySpec(
                    path: safeFile.path,
                    kind: .file(safeFile.contents)
                ),
            ],
            workingDirectory: workingDirectory,
            fileName: "traversal-\(format.fileName)"
        )
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles([safeFile], in: extractionDirectory)

        let escapedURL = workingDirectory.appendingPathComponent("escape.txt")
        #expect(FileManager.default.fileExists(atPath: escapedURL.path) == false)
    }

    @Test(arguments: TarArchiveFormat.allCases)
    func skipsTarSymbolicLinkEntries(_ format: TarArchiveFormat) throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let safeFile = ArchiveFixture.File(
            path: "safe/kept.txt",
            contents: Data("kept\n".utf8)
        )
        let archiveURL = try createCompressedTarArchive(
            format: format,
            entries: [
                TarEntrySpec(
                    path: safeFile.path,
                    kind: .file(safeFile.contents)
                ),
                TarEntrySpec(
                    path: "safe/link.txt",
                    kind: .symbolicLink("safe/kept.txt")
                ),
            ],
            workingDirectory: workingDirectory,
            fileName: "links-\(format.fileName)"
        )
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        let progressValues = try extractArchive(at: archiveURL, to: extractionDirectory)
        assertExtractionCompleted(progressValues)
        try assertExtractedFiles([safeFile], in: extractionDirectory)

        let skippedLinkURL = extractionDirectory.appendingPathComponent("safe/link.txt")
        #expect(FileManager.default.fileExists(atPath: skippedLinkURL.path) == false)
    }

    @Test
    func rejectsZip64Archives() throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = try createCustomZipArchive(
            entries: [
                ZipEntrySpec(
                    path: "zip64.txt",
                    kind: .file(Data("zip64\n".utf8)),
                    forceZip64: true
                )
            ],
            workingDirectory: workingDirectory,
            fileName: "zip64.zip"
        )
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        assertThrows(containsAny: ["ZIP64 archives are not supported"]) {
            try DecompressService().unzip(
                file: archiveURL.path,
                to: extractionDirectory.path
            )
        }
    }

    @Test
    func rejectsZipChecksumMismatch() throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let contents = Data("checksum\n".utf8)
        let archiveURL = try createCustomZipArchive(
            entries: [
                ZipEntrySpec(
                    path: "checksum.txt",
                    kind: .file(contents),
                    checksumOverride: computeCRC32(contents) &+ 1
                )
            ],
            workingDirectory: workingDirectory,
            fileName: "checksum.zip"
        )
        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        assertThrows(containsAny: ["checksum mismatch"]) {
            try DecompressService().unzip(
                file: archiveURL.path,
                to: extractionDirectory.path
            )
        }
    }

    @Test(arguments: TarArchiveFormat.allCases)
    func rejectsCorruptedTarArchives(_ format: TarArchiveFormat) throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = try createCompressedTarArchive(
            format: format,
            fixture: .sample,
            workingDirectory: workingDirectory,
            fileName: "valid-\(format.fileName)"
        )
        let corruptedURL = workingDirectory.appendingPathComponent("corrupted-\(format.fileName)")
        var corruptedData = try Data(contentsOf: archiveURL)
        corruptedData.removeLast(min(32, max(1, corruptedData.count / 3)))
        try corruptedData.write(to: corruptedURL)

        let extractionDirectory = workingDirectory.appendingPathComponent(
            "extracted",
            isDirectory: true
        )

        assertThrows(
            containsAny: [
                "Unexpected end of archive",
                "GZIP decompression failed",
                "Brotli decompression",
                "not a valid compressed archive"
            ]
        ) {
            try DecompressService().unzip(
                file: corruptedURL.path,
                to: extractionDirectory.path
            )
        }
    }

    @Test
    func rejectsTarEntrySizesThatOverflowOffsetSkipping() throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = try createMalformedTarArchive(
            path: "../escape.txt",
            rawSizeField: makeTarBinarySizeField(UInt64.max),
            typeFlag: tarRegularFileType,
            workingDirectory: workingDirectory,
            fileName: "overflow-skip.tar"
        )

        assertThrows(containsAny: ["Archive offset overflow while skipping"]) {
            _ = try TarArchiveExtractor.containsEntries(at: archiveURL.path)
        }
    }

    @Test
    func rejectsOversizedTarMetadataPayloadsBeforeIntConversion() throws {
        let workingDirectory = try makeWorkingDirectory()

        defer {
            cleanupWorkingDirectory(workingDirectory)
        }

        let archiveURL = try createMalformedTarArchive(
            path: "PaxHeaders.0",
            rawSizeField: makeTarBinarySizeField(UInt64(Int.max) + 1),
            typeFlag: tarPaxHeaderType,
            workingDirectory: workingDirectory,
            fileName: "oversized-pax.tar"
        )

        assertThrows(containsAny: ["TAR payload exceeds supported in-memory size"]) {
            _ = try TarArchiveExtractor.containsEntries(at: archiveURL.path)
        }
    }
}

enum ArchiveFormat: CaseIterable {
    case zip
    case tarBr
    case tarGz

    var fileName: String {
        switch self {
        case .zip:
            return "bundle.zip"
        case .tarBr:
            return "bundle.tar.br"
        case .tarGz:
            return "bundle.tar.gz"
        }
    }

    var tarFormat: TarArchiveFormat? {
        switch self {
        case .zip:
            return nil
        case .tarBr:
            return .tarBr
        case .tarGz:
            return .tarGz
        }
    }

    var expectationFileName: String {
        "\(fileName).expected.json"
    }
}

enum TarArchiveFormat: CaseIterable {
    case tarBr
    case tarGz

    var fileName: String {
        switch self {
        case .tarBr:
            return "fixture.tar.br"
        case .tarGz:
            return "fixture.tar.gz"
        }
    }
}

private struct ArchiveFixture {
    struct File {
        let path: String
        let contents: Data
    }

    let files: [File]

    static let sample = ArchiveFixture(
        files: [
            File(
                path: "index.ios.bundle",
                contents: Data("console.log('fixture bundle');\n".utf8)
            ),
            File(
                path: "manifest.json",
                contents: Data(
                    #"{"bundleId":"fixture-bundle","assets":{"assets/sample.txt":{"fileHash":"fixture-hash"}}}"#.utf8
                )
            ),
            File(
                path: "assets/sample.txt",
                contents: Data("fixture asset\n".utf8)
            ),
        ]
    )

    static let longPath = ArchiveFixture(
        files: [
            File(
                path: [
                    "extremely-long-path-segment-0001",
                    "extremely-long-path-segment-0002",
                    "extremely-long-path-segment-0003",
                    "extremely-long-path-segment-0004",
                    "extremely-long-path-segment-0005",
                    "asset.txt",
                ].joined(separator: "/"),
                contents: Data("long path payload\n".utf8)
            )
        ]
    )
}

private struct DeployedArchiveFixture {
    let archiveFileName: String
    let archivePartURLs: [URL]
    let archiveSize: Int?
    let archiveURL: URL?
    let expectations: [ExtractedFileExpectation]
}

private enum DeployedFixtureSet {
    case standard
    case payload300MB
    case archive300MB

    var directoryName: String {
        switch self {
        case .standard:
            return "Deployed"
        case .payload300MB:
            return "Large300MB"
        case .archive300MB:
            return "Archive300MB"
        }
    }
}

private struct ExtractedFileExpectation: Decodable {
    let path: String
    let sha256: String
    let size: Int
}

private struct ExtractedFileManifest: Decodable {
    let archiveFileName: String
    let archivePartNames: [String]?
    let archiveSize: Int?
    let files: [ExtractedFileExpectation]
}

private enum TarEntryKind {
    case file(Data)
    case symbolicLink(String)
}

private struct TarEntrySpec {
    let path: String
    let kind: TarEntryKind
}

private enum ZipEntryKind {
    case file(Data)
    case symbolicLink(String)
}

private struct ZipEntrySpec {
    let path: String
    let kind: ZipEntryKind
    var forceZip64: Bool = false
    var checksumOverride: UInt32? = nil
}

private let tarRegularFileType = UInt8(ascii: "0")
private let tarSymbolicLinkType = UInt8(ascii: "2")
private let tarPaxHeaderType = UInt8(ascii: "x")
private let zipLocalFileHeaderSignature: UInt32 = 0x04034B50
private let zipCentralDirectoryHeaderSignature: UInt32 = 0x02014B50
private let zipEndOfCentralDirectorySignature: UInt32 = 0x06054B50
private let zipVersionMadeByUnix: UInt16 = 0x031E

private func deployedFixtureDirectory(for fixtureSet: DeployedFixtureSet) -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures", isDirectory: true)
        .appendingPathComponent(fixtureSet.directoryName, isDirectory: true)
}

private func makeWorkingDirectory() throws -> URL {
    try FileManager.default.url(
        for: .itemReplacementDirectory,
        in: .userDomainMask,
        appropriateFor: FileManager.default.temporaryDirectory,
        create: true
    )
}

private func cleanupWorkingDirectory(_ workingDirectory: URL) {
    try? FileManager.default.removeItem(at: workingDirectory)
}

private func loadDeployedFixture(
    for format: ArchiveFormat,
    from fixtureSet: DeployedFixtureSet = .standard
) throws -> DeployedArchiveFixture {
    let fixtureDirectory = deployedFixtureDirectory(for: fixtureSet)
    let archiveURL = fixtureDirectory.appendingPathComponent(format.fileName)
    let expectationURL = fixtureDirectory.appendingPathComponent(
        format.expectationFileName
    )

    #expect(FileManager.default.fileExists(atPath: expectationURL.path))

    let manifestData = try Data(contentsOf: expectationURL)
    let manifest = try JSONDecoder().decode(ExtractedFileManifest.self, from: manifestData)
    let hasDirectArchive = FileManager.default.fileExists(atPath: archiveURL.path)
    let archivePartURLs = (manifest.archivePartNames ?? []).map {
        fixtureDirectory.appendingPathComponent($0)
    }

    #expect(manifest.archiveFileName == format.fileName)
    #expect(manifest.files.isEmpty == false)
    #expect(hasDirectArchive || archivePartURLs.isEmpty == false)

    for partURL in archivePartURLs {
        #expect(FileManager.default.fileExists(atPath: partURL.path))
    }

    return DeployedArchiveFixture(
        archiveFileName: manifest.archiveFileName,
        archivePartURLs: archivePartURLs,
        archiveSize: manifest.archiveSize,
        archiveURL: hasDirectArchive ? archiveURL : nil,
        expectations: manifest.files
    )
}

private func extractArchive(at archiveURL: URL, to extractionDirectory: URL) throws -> [Double] {
    var progressValues: [Double] = []
    try DecompressService().unzip(
        file: archiveURL.path,
        to: extractionDirectory.path
    ) { progress in
        progressValues.append(progress)
    }
    return progressValues
}

private func assertExtractionCompleted(_ progressValues: [Double]) {
    #expect(progressValues.isEmpty == false)
    #expect(progressValues.last == 1.0)
}

private func assertExtractedFiles(_ files: [ArchiveFixture.File], in extractionDirectory: URL) throws {
    for file in files {
        let extractedURL = extractionDirectory.appendingPathComponent(file.path)
        let extractedData = try Data(contentsOf: extractedURL)
        #expect(extractedData == file.contents)
    }
}

private func assertExtractedFiles(
    _ files: [ExtractedFileExpectation],
    in extractionDirectory: URL
) throws {
    for file in files {
        let extractedURL = extractionDirectory.appendingPathComponent(file.path)
        let hash = try computeFileSHA256(at: extractedURL)
        let attributes = try FileManager.default.attributesOfItem(
            atPath: extractedURL.path
        )
        let fileSize = (attributes[.size] as? NSNumber)?.intValue

        #expect(fileSize == file.size)
        #expect(hash == file.sha256)
    }
}

private func materializeArchive(_ fixture: DeployedArchiveFixture, to archiveURL: URL) throws {
    if let sourceArchiveURL = fixture.archiveURL {
        try FileManager.default.copyItem(at: sourceArchiveURL, to: archiveURL)
        return
    }

    guard fixture.archivePartURLs.isEmpty == false else {
        throw ArchiveFixtureError.missingArchiveSource(fixture.archiveFileName)
    }

    FileManager.default.createFile(atPath: archiveURL.path, contents: nil)
    guard let destinationHandle = FileHandle(forWritingAtPath: archiveURL.path) else {
        throw ArchiveFixtureError.failedToCreateArchive(archiveURL.path)
    }

    defer {
        try? destinationHandle.close()
    }

    for partURL in fixture.archivePartURLs {
        let partHandle = try FileHandle(forReadingFrom: partURL)

        while true {
            let chunk = try partHandle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty {
                break
            }
            try destinationHandle.write(contentsOf: chunk)
        }

        try? partHandle.close()
    }
}

private func archiveByteCount(of archiveURL: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: archiveURL.path)
    return (attributes[.size] as? NSNumber)?.intValue ?? 0
}

private func computeFileSHA256(at fileURL: URL) throws -> String {
    let fileHandle = try FileHandle(forReadingFrom: fileURL)

    defer {
        try? fileHandle.close()
    }

    var hasher = SHA256()

    while true {
        let chunk = try fileHandle.read(upToCount: 1024 * 1024) ?? Data()
        if chunk.isEmpty {
            break
        }
        hasher.update(data: chunk)
    }

    return hasher.finalize()
        .map { String(format: "%02x", $0) }
        .joined()
}

private func assertThrows(
    containsAny fragments: [String],
    _ operation: () throws -> Void
) {
    do {
        try operation()
        #expect(Bool(false))
    } catch {
        let message = (error as NSError).localizedDescription
        #expect(fragments.contains { message.contains($0) })
    }
}

private func createArchive(
    format: ArchiveFormat,
    fixture: ArchiveFixture,
    workingDirectory: URL
) throws -> URL {
    switch format {
    case .zip:
        return try createZipArchive(
            fixture: fixture,
            workingDirectory: workingDirectory,
            fileName: format.fileName
        )
    case .tarBr, .tarGz:
        guard let tarFormat = format.tarFormat else {
            fatalError("ZIP is handled separately")
        }

        return try createCompressedTarArchive(
            format: tarFormat,
            fixture: fixture,
            workingDirectory: workingDirectory,
            fileName: format.fileName
        )
    }
}

private func createZipArchive(
    fixture: ArchiveFixture,
    workingDirectory: URL,
    fileName: String
) throws -> URL {
    let fileManager = FileManager.default
    let sourceDirectory = workingDirectory.appendingPathComponent("zip-source", isDirectory: true)
    try fileManager.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)

    for file in fixture.files {
        let fileURL = sourceDirectory.appendingPathComponent(file.path)
        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try file.contents.write(to: fileURL)
    }

    let archiveURL = workingDirectory.appendingPathComponent(fileName)
    let process = Process()
    process.currentDirectoryURL = sourceDirectory
    process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
    process.arguments = ["-q", "-r", archiveURL.path, "."]

    try process.run()
    process.waitUntilExit()

    #expect(process.terminationStatus == 0)

    return archiveURL
}

private func createCompressedTarArchive(
    format: TarArchiveFormat,
    fixture: ArchiveFixture,
    workingDirectory: URL,
    fileName: String? = nil
) throws -> URL {
    try createCompressedTarArchive(
        format: format,
        entries: fixture.files.map {
            TarEntrySpec(path: $0.path, kind: .file($0.contents))
        },
        workingDirectory: workingDirectory,
        fileName: fileName
    )
}

private func createCompressedTarArchive(
    format: TarArchiveFormat,
    entries: [TarEntrySpec],
    workingDirectory: URL,
    fileName: String? = nil
) throws -> URL {
    let tarData = try createTarArchiveData(from: entries)
    let archiveData: Data

    switch format {
    case .tarBr:
        archiveData = try compressBrotli(tarData)
    case .tarGz:
        archiveData = try compressGzip(tarData)
    }

    let archiveURL = workingDirectory.appendingPathComponent(fileName ?? format.fileName)
    try archiveData.write(to: archiveURL)
    return archiveURL
}

private func createMalformedTarArchive(
    path: String,
    rawSizeField: Data,
    typeFlag: UInt8,
    workingDirectory: URL,
    fileName: String
) throws -> URL {
    var archive = Data()
    archive.append(
        try makeTarHeader(
            path: path,
            rawSizeField: rawSizeField,
            typeFlag: typeFlag,
            linkName: ""
        )
    )
    archive.append(Data(count: 1024))

    let archiveURL = workingDirectory.appendingPathComponent(fileName)
    try archive.write(to: archiveURL)
    return archiveURL
}

private func createTarArchiveData(from entries: [TarEntrySpec]) throws -> Data {
    var archive = Data()

    for (index, entry) in entries.enumerated() {
        var paxHeaders: [String: String] = [:]
        if entry.path.lengthOfBytes(using: .utf8) > 100 {
            paxHeaders["path"] = entry.path
        }

        let payload: Data
        let typeFlag: UInt8
        let linkName: String

        switch entry.kind {
        case let .file(contents):
            payload = contents
            typeFlag = tarRegularFileType
            linkName = ""
        case let .symbolicLink(target):
            payload = Data()
            typeFlag = tarSymbolicLinkType
            linkName = target

            if target.lengthOfBytes(using: .utf8) > 100 {
                paxHeaders["linkpath"] = target
            }
        }

        if paxHeaders.isEmpty == false {
            let paxPayload = makePaxHeaderPayload(headers: paxHeaders)
            archive.append(
                try makeTarHeader(
                    path: "PaxHeaders.\(index)",
                    size: paxPayload.count,
                    typeFlag: tarPaxHeaderType,
                    linkName: ""
                )
            )
            archive.append(paxPayload)
            appendTarPadding(for: paxPayload.count, to: &archive)
        }

        archive.append(
            try makeTarHeader(
                path: entry.path.lengthOfBytes(using: .utf8) > 100
                    ? "entry-\(index)"
                    : entry.path,
                size: payload.count,
                typeFlag: typeFlag,
                linkName: linkName.lengthOfBytes(using: .utf8) > 100
                    ? "link-\(index)"
                    : linkName
            )
        )
        archive.append(payload)
        appendTarPadding(for: payload.count, to: &archive)
    }

    archive.append(Data(count: 1024))
    return archive
}

private func makeTarHeader(
    path: String,
    size: Int,
    typeFlag: UInt8,
    linkName: String
) throws -> Data {
    try makeTarHeader(
        path: path,
        typeFlag: typeFlag,
        linkName: linkName
    ) { writeBytes in
        let digits = String(size, radix: 8)
        let padded = String(repeating: "0", count: max(12 - digits.count - 1, 0)) + digits + "\0"
        writeBytes(Data(padded.utf8), 124, 12)
    }
}

private func makeTarHeader(
    path: String,
    rawSizeField: Data,
    typeFlag: UInt8,
    linkName: String
) throws -> Data {
    guard rawSizeField.count == 12 else {
        throw TarFixtureError.invalidSizeField(rawSizeField.count)
    }

    return try makeTarHeader(
        path: path,
        typeFlag: typeFlag,
        linkName: linkName
    ) { writeBytes in
        writeBytes(rawSizeField, 124, 12)
    }
}

private func makeTarHeader(
    path: String,
    typeFlag: UInt8,
    linkName: String,
    writeSizeField: (_ writeBytes: (_ data: Data, _ offset: Int, _ maxLength: Int) -> Void) -> Void
) throws -> Data {
    guard let pathData = path.data(using: .utf8), pathData.count <= 100 else {
        throw TarFixtureError.invalidPath(path)
    }

    guard let linkNameData = linkName.data(using: .utf8), linkNameData.count <= 100 else {
        throw TarFixtureError.invalidPath(linkName)
    }

    var header = Data(count: 512)

    func writeBytes(_ data: Data, offset: Int, maxLength: Int) {
        let prefix = data.prefix(maxLength)
        header.replaceSubrange(offset..<(offset + prefix.count), with: prefix)
    }

    writeBytes(pathData, offset: 0, maxLength: 100)
    writeBytes(Data("0000777\0".utf8), offset: 100, maxLength: 8)
    if typeFlag != tarSymbolicLinkType {
        writeBytes(Data("0000644\0".utf8), offset: 100, maxLength: 8)
    }
    writeBytes(Data("0000000\0".utf8), offset: 108, maxLength: 8)
    writeBytes(Data("0000000\0".utf8), offset: 116, maxLength: 8)
    writeSizeField(writeBytes)
    writeBytes(Data("00000000000\0".utf8), offset: 136, maxLength: 12)
    writeBytes(Data(repeating: 0x20, count: 8), offset: 148, maxLength: 8)
    writeBytes(Data([typeFlag]), offset: 156, maxLength: 1)
    writeBytes(linkNameData, offset: 157, maxLength: 100)
    writeBytes(Data("ustar\0".utf8), offset: 257, maxLength: 6)
    writeBytes(Data("00".utf8), offset: 263, maxLength: 2)

    let checksum = header.reduce(0) { $0 + Int($1) }
    let checksumString = String(format: "%06o\0 ", checksum)
    writeBytes(Data(checksumString.utf8), offset: 148, maxLength: 8)

    return header
}

private func makeTarBinarySizeField(_ value: UInt64) -> Data {
    var rawSizeField = Data(repeating: 0, count: 12)
    var bigEndianValue = value.bigEndian
    let valueBytes = withUnsafeBytes(of: &bigEndianValue) { Data($0) }
    rawSizeField.replaceSubrange(4..<12, with: valueBytes)
    rawSizeField[0] = 0x80
    return rawSizeField
}

private func appendTarPadding(for size: Int, to archive: inout Data) {
    let remainder = size % 512
    if remainder != 0 {
        archive.append(Data(count: 512 - remainder))
    }
}

private func makePaxHeaderPayload(headers: [String: String]) -> Data {
    var payload = Data()

    for key in headers.keys.sorted() {
        guard let value = headers[key] else {
            continue
        }

        payload.append(makePaxRecord(key: key, value: value))
    }

    return payload
}

private func makePaxRecord(key: String, value: String) -> Data {
    let body = "\(key)=\(value)\n"
    var length = body.lengthOfBytes(using: .utf8) + 3

    while true {
        let record = "\(length) \(body)"
        let actualLength = record.lengthOfBytes(using: .utf8)
        if actualLength == length {
            return Data(record.utf8)
        }

        length = actualLength
    }
}

private func createCustomZipArchive(
    entries: [ZipEntrySpec],
    workingDirectory: URL,
    fileName: String
) throws -> URL {
    var archive = Data()
    var centralDirectory = Data()

    for entry in entries {
        let pathData = Data(entry.path.utf8)
        let payload: Data
        let externalAttributes: UInt32

        switch entry.kind {
        case let .file(contents):
            payload = contents
            externalAttributes = UInt32(0o100644) << 16
        case let .symbolicLink(target):
            payload = Data(target.utf8)
            externalAttributes = UInt32(0o120777) << 16
        }

        let actualChecksum = computeCRC32(payload)
        let recordedChecksum = entry.checksumOverride ?? actualChecksum
        let localHeaderOffset = UInt64(archive.count)
        let versionNeeded: UInt16 = entry.forceZip64 ? 45 : 20
        let localExtraField = createZip64ExtraFieldIfNeeded(
            forceZip64: entry.forceZip64,
            compressedSize: UInt64(payload.count),
            uncompressedSize: UInt64(payload.count),
            localHeaderOffset: nil
        )

        archive.appendUInt32LE(zipLocalFileHeaderSignature)
        archive.appendUInt16LE(versionNeeded)
        archive.appendUInt16LE(0)
        archive.appendUInt16LE(0)
        archive.appendUInt16LE(0)
        archive.appendUInt16LE(0)
        archive.appendUInt32LE(recordedChecksum)
        archive.appendUInt32LE(entry.forceZip64 ? UInt32.max : UInt32(payload.count))
        archive.appendUInt32LE(entry.forceZip64 ? UInt32.max : UInt32(payload.count))
        archive.appendUInt16LE(UInt16(pathData.count))
        archive.appendUInt16LE(UInt16(localExtraField.count))
        archive.append(pathData)
        archive.append(localExtraField)
        archive.append(payload)

        let centralExtraField = createZip64ExtraFieldIfNeeded(
            forceZip64: entry.forceZip64,
            compressedSize: UInt64(payload.count),
            uncompressedSize: UInt64(payload.count),
            localHeaderOffset: localHeaderOffset
        )

        centralDirectory.appendUInt32LE(zipCentralDirectoryHeaderSignature)
        centralDirectory.appendUInt16LE(zipVersionMadeByUnix)
        centralDirectory.appendUInt16LE(versionNeeded)
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt32LE(recordedChecksum)
        centralDirectory.appendUInt32LE(entry.forceZip64 ? UInt32.max : UInt32(payload.count))
        centralDirectory.appendUInt32LE(entry.forceZip64 ? UInt32.max : UInt32(payload.count))
        centralDirectory.appendUInt16LE(UInt16(pathData.count))
        centralDirectory.appendUInt16LE(UInt16(centralExtraField.count))
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt16LE(0)
        centralDirectory.appendUInt32LE(externalAttributes)
        centralDirectory.appendUInt32LE(entry.forceZip64 ? UInt32.max : UInt32(localHeaderOffset))
        centralDirectory.append(pathData)
        centralDirectory.append(centralExtraField)
    }

    let centralDirectoryOffset = UInt32(archive.count)
    archive.append(centralDirectory)

    archive.appendUInt32LE(zipEndOfCentralDirectorySignature)
    archive.appendUInt16LE(0)
    archive.appendUInt16LE(0)
    archive.appendUInt16LE(UInt16(entries.count))
    archive.appendUInt16LE(UInt16(entries.count))
    archive.appendUInt32LE(UInt32(centralDirectory.count))
    archive.appendUInt32LE(centralDirectoryOffset)
    archive.appendUInt16LE(0)

    let archiveURL = workingDirectory.appendingPathComponent(fileName)
    try archive.write(to: archiveURL)
    return archiveURL
}

private func createZip64ExtraFieldIfNeeded(
    forceZip64: Bool,
    compressedSize: UInt64,
    uncompressedSize: UInt64,
    localHeaderOffset: UInt64?
) -> Data {
    guard forceZip64 else {
        return Data()
    }

    var extraField = Data()
    extraField.appendUInt16LE(0x0001)
    extraField.appendUInt16LE(localHeaderOffset == nil ? 16 : 24)
    extraField.appendUInt64LE(uncompressedSize)
    extraField.appendUInt64LE(compressedSize)

    if let localHeaderOffset {
        extraField.appendUInt64LE(localHeaderOffset)
    }

    return extraField
}

private func compressBrotli(_ data: Data) throws -> Data {
    try compress(data, algorithm: COMPRESSION_BROTLI)
}

private func compress(_ data: Data, algorithm: compression_algorithm) throws -> Data {
    var output = Data()
    let bufferSize = 64 * 1024
    let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)

    defer {
        destinationBuffer.deallocate()
    }

    var stream = compression_stream(
        dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!,
        dst_size: 0,
        src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!,
        src_size: 0,
        state: nil
    )
    let status = compression_stream_init(&stream, COMPRESSION_STREAM_ENCODE, algorithm)

    guard status != COMPRESSION_STATUS_ERROR else {
        throw TarFixtureError.compressionFailed
    }

    defer {
        compression_stream_destroy(&stream)
    }

    try data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
            return
        }

        stream.src_ptr = baseAddress
        stream.src_size = data.count

        while true {
            stream.dst_ptr = destinationBuffer
            stream.dst_size = bufferSize

            let flags = Int32(COMPRESSION_STREAM_FINALIZE.rawValue)
            let result = compression_stream_process(&stream, flags)
            let produced = bufferSize - stream.dst_size

            if produced > 0 {
                output.append(destinationBuffer, count: produced)
            }

            if result == COMPRESSION_STATUS_END {
                break
            }

            guard result == COMPRESSION_STATUS_OK else {
                throw TarFixtureError.compressionFailed
            }
        }
    }

    return output
}

private func compressGzip(_ data: Data) throws -> Data {
    let bufferSize = 64 * 1024
    let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)

    defer {
        destinationBuffer.deallocate()
    }

    var stream = z_stream()
    let initStatus = deflateInit2_(
        &stream,
        Z_DEFAULT_COMPRESSION,
        Z_DEFLATED,
        MAX_WBITS + 16,
        MAX_MEM_LEVEL,
        Z_DEFAULT_STRATEGY,
        ZLIB_VERSION,
        Int32(MemoryLayout<z_stream>.size)
    )

    guard initStatus == Z_OK else {
        throw TarFixtureError.compressionFailed
    }

    defer {
        deflateEnd(&stream)
    }

    var output = Data()

    try data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.bindMemory(to: Bytef.self).baseAddress else {
            return
        }

        stream.next_in = UnsafeMutablePointer(mutating: baseAddress)
        stream.avail_in = uInt(data.count)

        while true {
            stream.next_out = destinationBuffer
            stream.avail_out = uInt(bufferSize)

            let result = deflate(&stream, Z_FINISH)
            let produced = bufferSize - Int(stream.avail_out)

            if produced > 0 {
                output.append(destinationBuffer, count: produced)
            }

            if result == Z_STREAM_END {
                break
            }

            guard result == Z_OK else {
                throw TarFixtureError.compressionFailed
            }
        }
    }

    return output
}

private func computeCRC32(_ data: Data) -> UInt32 {
    data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.bindMemory(to: Bytef.self).baseAddress else {
            return 0
        }

        return UInt32(crc32(0, baseAddress, uInt(data.count)))
    }
}

private enum TarFixtureError: Error {
    case compressionFailed
    case invalidPath(String)
    case invalidSizeField(Int)
}

private enum ArchiveFixtureError: Error {
    case failedToCreateArchive(String)
    case missingArchiveSource(String)
}

private extension Data {
    mutating func appendUInt16LE(_ value: UInt16) {
        var littleEndian = value.littleEndian
        append(Data(bytes: &littleEndian, count: MemoryLayout<UInt16>.size))
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        var littleEndian = value.littleEndian
        append(Data(bytes: &littleEndian, count: MemoryLayout<UInt32>.size))
    }

    mutating func appendUInt64LE(_ value: UInt64) {
        var littleEndian = value.littleEndian
        append(Data(bytes: &littleEndian, count: MemoryLayout<UInt64>.size))
    }
}
#endif
