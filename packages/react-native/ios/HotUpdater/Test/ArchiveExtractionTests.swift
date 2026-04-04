import Compression
import Foundation
import Testing
import zlib

@testable import HotUpdaterArchive

struct ArchiveExtractionTests {
    @Test(arguments: ArchiveFormat.allCases)
    func extractsSupportedArchives(_ format: ArchiveFormat) throws {
        let fixture = ArchiveFixture.sample
        let fileManager = FileManager.default
        let workingDirectory = try fileManager.url(
            for: .itemReplacementDirectory,
            in: .userDomainMask,
            appropriateFor: fileManager.temporaryDirectory,
            create: true
        )

        defer {
            try? fileManager.removeItem(at: workingDirectory)
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

        var progressValues: [Double] = []
        try DecompressService().unzip(
            file: archiveURL.path,
            to: extractionDirectory.path
        ) { progress in
            progressValues.append(progress)
        }

        #expect(progressValues.isEmpty == false)
        #expect(progressValues.last == 1.0)

        for entry in fixture.files {
            let extractedURL = extractionDirectory.appendingPathComponent(entry.path)
            let extractedData = try Data(contentsOf: extractedURL)
            #expect(extractedData == entry.contents)
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
            return "fixture.zip"
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
}

private func createArchive(
    format: ArchiveFormat,
    fixture: ArchiveFixture,
    workingDirectory: URL
) throws -> URL {
    switch format {
    case .zip:
        return try createZipArchive(fixture: fixture, workingDirectory: workingDirectory)
    case .tarBr:
        return try createCompressedTarArchive(
            format: .tarBr,
            fixture: fixture,
            workingDirectory: workingDirectory
        )
    case .tarGz:
        return try createCompressedTarArchive(
            format: .tarGz,
            fixture: fixture,
            workingDirectory: workingDirectory
        )
    }
}

private func createZipArchive(
    fixture: ArchiveFixture,
    workingDirectory: URL
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

    let archiveURL = workingDirectory.appendingPathComponent(ArchiveFormat.zip.fileName)
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
    format: ArchiveFormat,
    fixture: ArchiveFixture,
    workingDirectory: URL
) throws -> URL {
    let tarData = try createTarArchiveData(from: fixture)
    let archiveData: Data

    switch format {
    case .zip:
        fatalError("ZIP is handled separately")
    case .tarBr:
        archiveData = try compressBrotli(tarData)
    case .tarGz:
        archiveData = try compressGzip(tarData)
    }

    let archiveURL = workingDirectory.appendingPathComponent(format.fileName)
    try archiveData.write(to: archiveURL)
    return archiveURL
}

private func createTarArchiveData(from fixture: ArchiveFixture) throws -> Data {
    var archive = Data()

    for file in fixture.files {
        archive.append(try makeTarHeader(path: file.path, size: file.contents.count))
        archive.append(file.contents)

        let remainder = file.contents.count % 512
        if remainder != 0 {
            archive.append(Data(count: 512 - remainder))
        }
    }

    archive.append(Data(count: 1024))
    return archive
}

private func makeTarHeader(path: String, size: Int) throws -> Data {
    guard let pathData = path.data(using: .utf8), pathData.count <= 100 else {
        throw TarFixtureError.invalidPath(path)
    }

    var header = Data(count: 512)

    func writeBytes(_ data: Data, offset: Int, maxLength: Int) {
        let prefix = data.prefix(maxLength)
        header.replaceSubrange(offset..<(offset + prefix.count), with: prefix)
    }

    func writeOctal(_ value: Int, offset: Int, length: Int) {
        let digits = String(value, radix: 8)
        let padded = String(repeating: "0", count: max(length - digits.count - 1, 0)) + digits + "\0"
        writeBytes(Data(padded.utf8), offset: offset, maxLength: length)
    }

    writeBytes(pathData, offset: 0, maxLength: 100)
    writeOctal(0o644, offset: 100, length: 8)
    writeOctal(0, offset: 108, length: 8)
    writeOctal(0, offset: 116, length: 8)
    writeOctal(size, offset: 124, length: 12)
    writeOctal(0, offset: 136, length: 12)
    writeBytes(Data(repeating: 0x20, count: 8), offset: 148, maxLength: 8)
    writeBytes(Data("0".utf8), offset: 156, maxLength: 1)
    writeBytes(Data("ustar\0".utf8), offset: 257, maxLength: 6)
    writeBytes(Data("00".utf8), offset: 263, maxLength: 2)

    let checksum = header.reduce(0) { $0 + Int($1) }
    let checksumString = String(format: "%06o\0 ", checksum)
    writeBytes(Data(checksumString.utf8), offset: 148, maxLength: 8)

    return header
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

private enum TarFixtureError: Error {
    case compressionFailed
    case invalidPath(String)
}
