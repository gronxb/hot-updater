import Foundation

public enum TarArchiveExtractor {
    private static let blockSize = 512

    private static let regularFileType: UInt8 = 48
    private static let alternateRegularFileType: UInt8 = 0
    private static let hardLinkType: UInt8 = 49
    private static let symbolicLinkType: UInt8 = 50
    private static let directoryType: UInt8 = 53
    private static let contiguousFileType: UInt8 = 55
    private static let globalPaxHeaderType: UInt8 = 103
    private static let paxHeaderType: UInt8 = 120
    private static let gnuLongNameType: UInt8 = 76
    private static let gnuLongLinkType: UInt8 = 75

    private struct Header {
        let path: String
        let size: UInt64
        let typeFlag: UInt8
        let linkName: String
    }

    static func extract(
        from tarPath: String,
        to destination: String,
        strict: Bool = false,
        expectedFiles: [String: UInt64]? = nil,
        progressHandler: @escaping (Double) -> Void
    ) throws {
        let fileManager = FileManager.default
        let destinationRoot = URL(fileURLWithPath: destination).standardizedFileURL.path
        try ArchiveExtractionUtilities.ensureDirectory(at: URL(fileURLWithPath: destinationRoot), fileManager: fileManager)

        let tarSize = try archiveFileSize(at: tarPath)
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: tarPath))

        defer {
            try? handle.close()
        }

        let entryGuard = ArchiveEntryGuard()
        var extractedFiles = Set<String>()
        var hasPendingPaxHeader = false
        var globalPaxHeaders: [String: String] = [:]
        var pendingPaxHeaders: [String: String] = [:]
        var pendingLongPath: String?
        var pendingLongLink: String?

        while true {
            let headerBlock = try ArchiveExtractionUtilities.readExactly(from: handle, count: blockSize)
            guard !isZeroBlock(headerBlock) else {
                if strict {
                    let secondEndBlock = try ArchiveExtractionUtilities.readExactly(from: handle, count: blockSize)
                    guard isZeroBlock(secondEndBlock), !hasPendingPaxHeader else {
                        throw ArchiveLimits.reject("Invalid TAR termination")
                    }
                    try requireZeroPaddingToEnd(handle)
                    guard expectedFiles.map({ extractedFiles == Set($0.keys) }) ?? true else {
                        throw ArchiveLimits.reject("Archive inventory differs from manifest")
                    }
                }
                break
            }

            let header = try parseHeader(from: headerBlock)

            if strict, [globalPaxHeaderType, paxHeaderType, gnuLongNameType, gnuLongLinkType].contains(header.typeFlag), header.size > 1024 * 1024 {
                throw ArchiveLimits.reject("TAR metadata exceeds limit")
            }
            switch header.typeFlag {
            case globalPaxHeaderType:
                if strict { throw ArchiveLimits.reject("Global PAX headers are not supported") }
                let paxData = try readEntryPayloadData(from: handle, size: header.size)
                globalPaxHeaders.merge(try parsePaxHeaders(from: paxData)) { _, newValue in
                    newValue
                }

            case paxHeaderType:
                if strict && hasPendingPaxHeader { throw ArchiveLimits.reject("Consecutive PAX headers are not supported") }
                hasPendingPaxHeader = true
                let paxData = try readEntryPayloadData(from: handle, size: header.size)
                pendingPaxHeaders.merge(try parsePaxHeaders(from: paxData)) { _, newValue in
                    newValue
                }

            case gnuLongNameType:
                if strict { throw ArchiveLimits.reject("GNU long names are not supported") }
                pendingLongPath = decodeLongPath(from: try readEntryPayloadData(from: handle, size: header.size))

            case gnuLongLinkType:
                if strict { throw ArchiveLimits.reject("TAR links are not allowed") }
                pendingLongLink = decodeLongPath(from: try readEntryPayloadData(from: handle, size: header.size))

            default:
                let effectiveHeaders = globalPaxHeaders.merging(pendingPaxHeaders) { _, newValue in
                    newValue
                }
                let resolvedPath = pendingLongPath ?? effectiveHeaders["path"] ?? header.path
                let resolvedLinkPath = pendingLongLink ?? effectiveHeaders["linkpath"] ?? header.linkName
                let resolvedSize = try effectiveHeaders["size"].map(parsePaxSize) ?? header.size

                defer {
                    pendingPaxHeaders.removeAll()
                    hasPendingPaxHeader = false
                    pendingLongPath = nil
                    pendingLongLink = nil
                }

                if strict {
                    guard [directoryType, regularFileType, alternateRegularFileType].contains(header.typeFlag),
                          effectiveHeaders["linkpath"] == nil,
                          header.typeFlag != directoryType || resolvedSize == 0 else { throw ArchiveLimits.reject("Unsupported TAR entry type or link") }
                    if let expectedFiles {
                        guard header.typeFlag != directoryType, expectedFiles[resolvedPath] == resolvedSize else {
                            throw ArchiveLimits.reject("Archive entry path or size differs from manifest")
                        }
                    }
                    try entryGuard.admit(resolvedPath, size: resolvedSize, directory: header.typeFlag == directoryType)
                }
                try extractEntry(
                    path: resolvedPath,
                    typeFlag: header.typeFlag,
                    size: resolvedSize,
                    linkPath: resolvedLinkPath,
                    from: handle,
                    to: destinationRoot,
                    strict: strict
                )
                if header.typeFlag != directoryType { extractedFiles.insert(resolvedPath) }
            }

            if tarSize > 0 {
                let offset = ArchiveExtractionUtilities.currentOffset(for: handle)
                let progress = min(Double(offset) / Double(tarSize), 1.0)
                progressHandler(progress)
            }
        }

        progressHandler(1.0)
    }

    private static func extractEntry(
        path rawPath: String,
        typeFlag: UInt8,
        size: UInt64,
        linkPath: String,
        from handle: FileHandle,
        to destinationRoot: String,
        strict: Bool
    ) throws {
        guard let relativePath = ArchiveExtractionUtilities.normalizedRelativePath(from: strict && typeFlag == directoryType && rawPath.hasSuffix("/") ? String(rawPath.dropLast()) : rawPath) else {
            try skipEntryPayload(in: handle, size: size)
            return
        }

        let targetURL = try ArchiveExtractionUtilities.extractionURL(
            for: relativePath,
            destinationRoot: destinationRoot
        )

        switch typeFlag {
        case directoryType:
            try ArchiveExtractionUtilities.ensureDirectory(at: targetURL)
            try skipEntryPayload(in: handle, size: size)

        case regularFileType, alternateRegularFileType, contiguousFileType:
            let outputHandle = try ArchiveExtractionUtilities.createOutputFile(at: targetURL)

            defer {
                try? outputHandle.close()
            }

            try copyEntryPayload(from: handle, size: size, to: outputHandle)
            try skipPadding(in: handle, size: size)

        case hardLinkType, symbolicLinkType:
            NSLog("[TarArchiveExtractor] Skipping link entry: \(rawPath) -> \(linkPath)")
            try skipEntryPayload(in: handle, size: size)

        default:
            NSLog("[TarArchiveExtractor] Skipping unsupported TAR entry type: \(typeFlag) (\(rawPath))")
            try skipEntryPayload(in: handle, size: size)
        }
    }

    private static func copyEntryPayload(
        from handle: FileHandle,
        size: UInt64,
        to outputHandle: FileHandle
    ) throws {
        var remainingBytes = size

        while remainingBytes > 0 {
            let chunkSize = Int(min(remainingBytes, UInt64(ArchiveExtractionUtilities.bufferSize)))
            let chunk = try ArchiveExtractionUtilities.readExactly(from: handle, count: chunkSize)
            try Task.checkCancellation()
            try outputHandle.write(contentsOf: chunk)
            remainingBytes -= UInt64(chunk.count)
        }
    }

    private static func readEntryPayloadData(from handle: FileHandle, size: UInt64) throws -> Data {
        guard size > 0 else {
            return Data()
        }

        guard size <= UInt64(Int.max) else {
            throw NSError(
                domain: "TarArchiveExtractor",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "TAR payload exceeds supported in-memory size: \(size) bytes"]
            )
        }

        let payload = try ArchiveExtractionUtilities.readExactly(from: handle, count: Int(size))
        try skipPadding(in: handle, size: size)
        return payload
    }

    private static func skipEntryPayload(in handle: FileHandle, size: UInt64) throws {
        try ArchiveExtractionUtilities.skipBytes(size, in: handle)
        try skipPadding(in: handle, size: size)
    }

    private static func skipPadding(in handle: FileHandle, size: UInt64) throws {
        let padding = (UInt64(blockSize) - (size % UInt64(blockSize))) % UInt64(blockSize)
        let bytes = try ArchiveExtractionUtilities.readExactly(from: handle, count: Int(padding))
        guard isZeroBlock(bytes) else { throw ArchiveLimits.reject("Invalid TAR entry padding") }
    }

    private static func requireZeroPaddingToEnd(_ handle: FileHandle) throws {
        while let bytes = try ArchiveExtractionUtilities.readUpToCount(from: handle, count: blockSize), !bytes.isEmpty {
            try Task.checkCancellation()
            guard bytes.count == blockSize, isZeroBlock(bytes) else {
                throw ArchiveLimits.reject("TAR contains trailing data")
            }
        }
    }

    private static func parseHeader(from block: Data) throws -> Header {
        guard block.count == blockSize else {
            throw NSError(
                domain: "TarArchiveExtractor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid TAR block size: \(block.count)"]
            )
        }

        let checksum = try parseTarNumber(block[148..<156])
        let actual = block.indices.reduce(UInt64(0)) { sum, index in
            sum + UInt64((148..<156).contains(index) ? 32 : block[index])
        }
        guard Data(block[257..<262]) == Data("ustar".utf8), checksum == actual else {
            throw ArchiveLimits.reject("Invalid USTAR header or checksum")
        }

        return Header(
            path: try parseTarPath(from: block),
            size: try parseTarNumber(block[124..<136]),
            typeFlag: block[156],
            linkName: try parseCString(block[157..<257])
        )
    }

    private static func parseTarPath(from block: Data) throws -> String {
        let name = try parseCString(block[0..<100])
        let prefix = try parseCString(block[345..<500])

        guard !prefix.isEmpty else {
            return name
        }

        guard !name.isEmpty else {
            return prefix
        }

        return "\(prefix)/\(name)"
    }

    private static func parseCString(_ data: Data.SubSequence) throws -> String {
        let bytes = data.prefix { $0 != 0 }
        guard !bytes.isEmpty else {
            return ""
        }

        if let decoded = String(data: Data(bytes), encoding: .utf8) {
            return decoded
        }

        throw ArchiveLimits.reject("Invalid UTF-8 in TAR header")
    }

    private static func parseTarNumber(_ data: Data.SubSequence) throws -> UInt64 {
        let bytes = [UInt8](data)
        guard !bytes.allSatisfy({ $0 == 0 || $0 == 32 }) else {
            return 0
        }

        if let first = bytes.first, first & 0x80 != 0 {
            guard first & 0x40 == 0 else { throw ArchiveLimits.reject("Negative TAR size") }
            var value: UInt64 = UInt64(first & 0x7F)
            for byte in bytes.dropFirst() {
                guard value <= (UInt64.max - UInt64(byte)) / 256 else { throw ArchiveLimits.reject("TAR size overflow") }
                value = value * 256 + UInt64(byte)
            }
            return value
        }

        let stringValue = String(bytes: bytes, encoding: .ascii)?
            .trimmingCharacters(in: CharacterSet(charactersIn: "\0 "))

        guard let stringValue, !stringValue.isEmpty,
              let parsedValue = UInt64(stringValue, radix: 8) else {
            throw NSError(
                domain: "TarArchiveExtractor",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Invalid TAR numeric field"]
            )
        }

        return parsedValue
    }

    private static func parsePaxSize(_ value: String) throws -> UInt64 {
        guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }),
              let size = UInt64(value) else { throw ArchiveLimits.reject("Invalid PAX entry size") }
        return size
    }

    private static func parsePaxHeaders(from data: Data) throws -> [String: String] {
        var headers: [String: String] = [:]
        var index = data.startIndex
        while index < data.endIndex {
            guard let space = data[index...].firstIndex(of: 0x20),
                  space > index,
                  data[index..<space].allSatisfy({ (48...57).contains($0) }),
                  let lengthString = String(data: data[index..<space], encoding: .ascii),
                  let length = Int(lengthString), length > 0,
                  length <= data.endIndex - index else {
                throw ArchiveLimits.reject("Malformed TAR PAX record length")
            }
            // Subtraction above establishes this addition cannot overflow.
            let end = index + length
            let bodyStart = space + 1
            guard bodyStart < end, data[end - 1] == 0x0a,
                  let separator = data[bodyStart..<(end - 1)].firstIndex(of: 0x3d),
                  separator > bodyStart,
                  let key = String(data: data[bodyStart..<separator], encoding: .utf8),
                  let value = String(data: data[(separator + 1)..<(end - 1)], encoding: .utf8),
                  headers[key] == nil else {
                throw ArchiveLimits.reject("Malformed or duplicate TAR PAX record")
            }
            headers[key] = value
            index = end
        }
        return headers
    }

    private static func decodeLongPath(from data: Data) -> String {
        let trimmedData = data.prefix { $0 != 0 }
        guard !trimmedData.isEmpty else {
            return ""
        }

        return String(decoding: trimmedData, as: UTF8.self)
            .trimmingCharacters(in: .newlines)
    }

    private static func isZeroBlock(_ data: Data) -> Bool {
        data.allSatisfy { $0 == 0 }
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
