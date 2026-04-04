import Foundation
import zlib

enum ZipArchiveExtractor {
    private static let localFileHeaderSignature: UInt32 = 0x04034B50
    private static let centralDirectoryHeaderSignature: UInt32 = 0x02014B50
    private static let endOfCentralDirectorySignature: UInt32 = 0x06054B50
    private static let storedMethod: UInt16 = 0
    private static let deflatedMethod: UInt16 = 8
    private static let encryptedFlag: UInt16 = 1 << 0
    private static let maxCommentLength = 0xFFFF

    private struct CentralDirectoryEntry {
        let path: String
        let compressionMethod: UInt16
        let flags: UInt16
        let compressedSize: UInt64
        let uncompressedSize: UInt64
        let checksum: UInt32
        let localHeaderOffset: UInt64
        let isDirectory: Bool
    }

    private struct EndOfCentralDirectoryRecord {
        let totalEntries: UInt16
        let centralDirectoryOffset: UInt64
    }

    static func extract(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        let fileURL = URL(fileURLWithPath: file)
        let fileSize = try archiveFileSize(at: file)
        let handle = try FileHandle(forReadingFrom: fileURL)

        defer {
            try? handle.close()
        }

        let entries = try readCentralDirectoryEntries(from: handle, fileSize: fileSize)

        let destinationURL = URL(fileURLWithPath: destination)
        try ArchiveExtractionUtilities.ensureDirectory(at: destinationURL)

        let totalCompressedBytes = entries.reduce(UInt64(0)) { $0 + max($1.compressedSize, 1) }
        var processedCompressedBytes: UInt64 = 0

        for entry in entries {
            try extractEntry(entry, from: handle, to: destinationURL.standardizedFileURL.path)
            processedCompressedBytes += max(entry.compressedSize, 1)

            guard totalCompressedBytes > 0 else {
                continue
            }

            let progress = min(Double(processedCompressedBytes) / Double(totalCompressedBytes), 1.0)
            progressHandler(progress)
        }

        progressHandler(1.0)
    }

    private static func readCentralDirectoryEntries(
        from handle: FileHandle,
        fileSize: UInt64
    ) throws -> [CentralDirectoryEntry] {
        let endRecord = try locateEndOfCentralDirectory(in: handle, fileSize: fileSize)

        try ArchiveExtractionUtilities.seek(handle, to: endRecord.centralDirectoryOffset)

        var entries: [CentralDirectoryEntry] = []
        entries.reserveCapacity(Int(endRecord.totalEntries))

        for _ in 0..<endRecord.totalEntries {
            let header = try ArchiveExtractionUtilities.readExactly(from: handle, count: 46)

            guard header.archiveUInt32LE(at: 0) == centralDirectoryHeaderSignature else {
                throw NSError(
                    domain: "ZipArchiveExtractor",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid ZIP central directory header"]
                )
            }

            let flags = header.archiveUInt16LE(at: 8)
            let compressionMethod = header.archiveUInt16LE(at: 10)
            let compressedSize = header.archiveUInt32LE(at: 20)
            let uncompressedSize = header.archiveUInt32LE(at: 24)
            let fileNameLength = Int(header.archiveUInt16LE(at: 28))
            let extraFieldLength = Int(header.archiveUInt16LE(at: 30))
            let commentLength = Int(header.archiveUInt16LE(at: 32))
            let checksum = header.archiveUInt32LE(at: 16)
            let localHeaderOffset = header.archiveUInt32LE(at: 42)

            guard compressedSize != UInt32.max,
                  uncompressedSize != UInt32.max,
                  localHeaderOffset != UInt32.max else {
                throw NSError(
                    domain: "ZipArchiveExtractor",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "ZIP64 archives are not supported"]
                )
            }

            let fileNameData = try ArchiveExtractionUtilities.readExactly(from: handle, count: fileNameLength)
            let extraFieldData = try ArchiveExtractionUtilities.readExactly(from: handle, count: extraFieldLength)
            _ = extraFieldData
            if commentLength > 0 {
                try ArchiveExtractionUtilities.skipBytes(UInt64(commentLength), in: handle)
            }

            let path = decodePath(from: fileNameData)
            let isDirectory = path.hasSuffix("/")

            entries.append(
                CentralDirectoryEntry(
                    path: path,
                    compressionMethod: compressionMethod,
                    flags: flags,
                    compressedSize: UInt64(compressedSize),
                    uncompressedSize: UInt64(uncompressedSize),
                    checksum: checksum,
                    localHeaderOffset: UInt64(localHeaderOffset),
                    isDirectory: isDirectory
                )
            )
        }

        return entries
    }

    private static func locateEndOfCentralDirectory(
        in handle: FileHandle,
        fileSize: UInt64
    ) throws -> EndOfCentralDirectoryRecord {
        let minimumRecordLength = 22
        let searchLength = Int(min(fileSize, UInt64(maxCommentLength + minimumRecordLength)))
        let searchOffset = fileSize - UInt64(searchLength)

        try ArchiveExtractionUtilities.seek(handle, to: searchOffset)
        let tailData = try ArchiveExtractionUtilities.readExactly(from: handle, count: searchLength)

        let signatureBytes: [UInt8] = [0x50, 0x4B, 0x05, 0x06]

        guard let recordIndex = findLastSignature(signatureBytes, in: tailData) else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "ZIP end of central directory record not found"]
            )
        }

        let minimumEndIndex = recordIndex + minimumRecordLength
        guard minimumEndIndex <= tailData.count else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "ZIP end of central directory record is truncated"]
            )
        }

        let commentLength = Int(tailData.archiveUInt16LE(at: recordIndex + 20))
        guard minimumEndIndex + commentLength == tailData.count else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "ZIP central directory comment is malformed"]
            )
        }

        return EndOfCentralDirectoryRecord(
            totalEntries: tailData.archiveUInt16LE(at: recordIndex + 10),
            centralDirectoryOffset: UInt64(tailData.archiveUInt32LE(at: recordIndex + 16))
        )
    }

    private static func extractEntry(
        _ entry: CentralDirectoryEntry,
        from handle: FileHandle,
        to destinationRoot: String
    ) throws {
        guard entry.flags & encryptedFlag == 0 else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: "Encrypted ZIP entries are not supported"]
            )
        }

        guard let relativePath = ArchiveExtractionUtilities.normalizedRelativePath(from: entry.path) else {
            return
        }

        let targetURL = try ArchiveExtractionUtilities.extractionURL(
            for: relativePath,
            destinationRoot: destinationRoot
        )

        if entry.isDirectory {
            try ArchiveExtractionUtilities.ensureDirectory(at: targetURL)
            return
        }

        try ArchiveExtractionUtilities.seek(handle, to: entry.localHeaderOffset)
        let localHeader = try ArchiveExtractionUtilities.readExactly(from: handle, count: 30)

        guard localHeader.archiveUInt32LE(at: 0) == localFileHeaderSignature else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 7,
                userInfo: [NSLocalizedDescriptionKey: "Invalid ZIP local file header for \(entry.path)"]
            )
        }

        let fileNameLength = UInt64(localHeader.archiveUInt16LE(at: 26))
        let extraFieldLength = UInt64(localHeader.archiveUInt16LE(at: 28))
        let dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength

        try ArchiveExtractionUtilities.seek(handle, to: dataOffset)
        let outputHandle = try ArchiveExtractionUtilities.createOutputFile(at: targetURL)

        defer {
            try? outputHandle.close()
        }

        let extractionResult: (writtenSize: UInt64, checksum: UInt32)

        switch entry.compressionMethod {
        case storedMethod:
            extractionResult = try extractStoredEntry(
                from: handle,
                compressedSize: entry.compressedSize,
                to: outputHandle
            )
        case deflatedMethod:
            extractionResult = try extractDeflatedEntry(
                from: handle,
                compressedSize: entry.compressedSize,
                to: outputHandle
            )
        default:
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 8,
                userInfo: [NSLocalizedDescriptionKey: "Unsupported ZIP compression method \(entry.compressionMethod) for \(entry.path)"]
            )
        }

        guard extractionResult.writtenSize == entry.uncompressedSize else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 9,
                userInfo: [NSLocalizedDescriptionKey: "ZIP entry size mismatch for \(entry.path)"]
            )
        }

        guard extractionResult.checksum == entry.checksum else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "ZIP entry checksum mismatch for \(entry.path)"]
            )
        }
    }

    private static func extractStoredEntry(
        from handle: FileHandle,
        compressedSize: UInt64,
        to outputHandle: FileHandle
    ) throws -> (writtenSize: UInt64, checksum: UInt32) {
        var remainingBytes = compressedSize
        var totalWritten: UInt64 = 0
        var checksum: uLong = crc32(0, nil, 0)

        while remainingBytes > 0 {
            let chunkSize = Int(min(remainingBytes, UInt64(ArchiveExtractionUtilities.bufferSize)))
            let chunk = try ArchiveExtractionUtilities.readExactly(from: handle, count: chunkSize)
            outputHandle.write(chunk)
            totalWritten += UInt64(chunk.count)
            checksum = updateCRC32(checksum, with: chunk)
            remainingBytes -= UInt64(chunk.count)
        }

        return (totalWritten, UInt32(checksum))
    }

    private static func extractDeflatedEntry(
        from handle: FileHandle,
        compressedSize: UInt64,
        to outputHandle: FileHandle
    ) throws -> (writtenSize: UInt64, checksum: UInt32) {
        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: ArchiveExtractionUtilities.bufferSize)

        defer {
            outputBuffer.deallocate()
        }

        var stream = z_stream()
        let initStatus = inflateInit2_(
            &stream,
            -MAX_WBITS,
            ZLIB_VERSION,
            Int32(MemoryLayout<z_stream>.size)
        )

        guard initStatus == Z_OK else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 11,
                userInfo: [NSLocalizedDescriptionKey: "Failed to initialize ZIP inflater"]
            )
        }

        defer {
            inflateEnd(&stream)
        }

        var remainingBytes = compressedSize
        var totalWritten: UInt64 = 0
        var checksum: uLong = crc32(0, nil, 0)
        var reachedStreamEnd = false

        while remainingBytes > 0 {
            let chunkSize = Int(min(remainingBytes, UInt64(ArchiveExtractionUtilities.bufferSize)))
            let chunk = try ArchiveExtractionUtilities.readExactly(from: handle, count: chunkSize)
            remainingBytes -= UInt64(chunk.count)

            try chunk.withUnsafeBytes { rawBuffer in
                guard let baseAddress = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
                    return
                }

                stream.next_in = UnsafeMutablePointer(mutating: baseAddress)
                stream.avail_in = uInt(chunk.count)

                repeat {
                    stream.next_out = outputBuffer
                    stream.avail_out = uInt(ArchiveExtractionUtilities.bufferSize)

                    let status = inflate(&stream, Z_NO_FLUSH)
                    switch status {
                    case Z_OK, Z_STREAM_END:
                        let producedBytes = ArchiveExtractionUtilities.bufferSize - Int(stream.avail_out)
                        if producedBytes > 0 {
                            let outputData = Data(bytes: outputBuffer, count: producedBytes)
                            outputHandle.write(outputData)
                            totalWritten += UInt64(producedBytes)
                            checksum = updateCRC32(checksum, with: outputData)
                        }

                        if status == Z_STREAM_END {
                            guard stream.avail_in == 0, remainingBytes == 0 else {
                                throw NSError(
                                    domain: "ZipArchiveExtractor",
                                    code: 12,
                                    userInfo: [NSLocalizedDescriptionKey: "ZIP deflate stream ended unexpectedly"]
                                )
                            }

                            reachedStreamEnd = true
                        }

                    default:
                        let message = stream.msg.map { String(cString: $0) } ?? "Unknown zlib error"
                        throw NSError(
                            domain: "ZipArchiveExtractor",
                            code: 13,
                            userInfo: [NSLocalizedDescriptionKey: "ZIP deflate failed: \(message)"]
                        )
                    }
                } while stream.avail_in > 0 || stream.avail_out == 0
            }

            if reachedStreamEnd {
                break
            }
        }

        guard reachedStreamEnd || compressedSize == 0 else {
            throw NSError(
                domain: "ZipArchiveExtractor",
                code: 14,
                userInfo: [NSLocalizedDescriptionKey: "ZIP deflate stream did not terminate correctly"]
            )
        }

        return (totalWritten, UInt32(checksum))
    }

    private static func findLastSignature(_ signature: [UInt8], in data: Data) -> Int? {
        guard signature.count <= data.count else {
            return nil
        }

        let lastStartIndex = data.count - signature.count
        for startIndex in stride(from: lastStartIndex, through: 0, by: -1) {
            if Array(data[startIndex..<(startIndex + signature.count)]) == signature {
                return startIndex
            }
        }

        return nil
    }

    private static func decodePath(from data: Data) -> String {
        if let utf8Path = String(data: data, encoding: .utf8) {
            return utf8Path
        }

        return String(decoding: data, as: UTF8.self)
    }

    private static func updateCRC32(_ checksum: uLong, with data: Data) -> uLong {
        data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.bindMemory(to: Bytef.self).baseAddress else {
                return checksum
            }

            return crc32(checksum, baseAddress, uInt(data.count))
        }
    }

    private static func archiveFileSize(at path: String) throws -> UInt64 {
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        if let number = attributes[.size] as? NSNumber {
            return number.uint64Value
        }

        if let value = attributes[.size] as? UInt64 {
            return value
        }

        return 0
    }
}
