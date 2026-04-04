import Foundation

enum TarArchiveExtractor {
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

    static func containsEntries(at tarPath: String) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: tarPath))

        defer {
            try? handle.close()
        }

        var globalPaxHeaders: [String: String] = [:]
        var pendingPaxHeaders: [String: String] = [:]
        var pendingLongPath: String?
        var pendingLongLink: String?

        while true {
            let headerBlock = try ArchiveExtractionUtilities.readExactly(from: handle, count: blockSize)
            guard !isZeroBlock(headerBlock) else {
                return false
            }

            let header = try parseHeader(from: headerBlock)

            switch header.typeFlag {
            case globalPaxHeaderType:
                let paxData = try readEntryPayloadData(from: handle, size: header.size)
                globalPaxHeaders.merge(parsePaxHeaders(from: paxData)) { _, newValue in
                    newValue
                }

            case paxHeaderType:
                let paxData = try readEntryPayloadData(from: handle, size: header.size)
                pendingPaxHeaders.merge(parsePaxHeaders(from: paxData)) { _, newValue in
                    newValue
                }

            case gnuLongNameType:
                pendingLongPath = decodeLongPath(from: try readEntryPayloadData(from: handle, size: header.size))

            case gnuLongLinkType:
                pendingLongLink = decodeLongPath(from: try readEntryPayloadData(from: handle, size: header.size))

            default:
                let effectiveHeaders = globalPaxHeaders.merging(pendingPaxHeaders) { _, newValue in
                    newValue
                }
                let resolvedPath = pendingLongPath ?? effectiveHeaders["path"] ?? header.path
                _ = pendingLongLink ?? effectiveHeaders["linkpath"] ?? header.linkName

                defer {
                    pendingPaxHeaders.removeAll()
                    pendingLongPath = nil
                    pendingLongLink = nil
                }

                if let normalizedPath = ArchiveExtractionUtilities.normalizedRelativePath(from: resolvedPath),
                   !normalizedPath.isEmpty {
                    return true
                }

                try skipEntryPayload(in: handle, size: header.size)
            }
        }
    }

    static func extract(
        from tarPath: String,
        to destination: String,
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

        var globalPaxHeaders: [String: String] = [:]
        var pendingPaxHeaders: [String: String] = [:]
        var pendingLongPath: String?
        var pendingLongLink: String?

        while true {
            let headerBlock = try ArchiveExtractionUtilities.readExactly(from: handle, count: blockSize)
            guard !isZeroBlock(headerBlock) else {
                break
            }

            let header = try parseHeader(from: headerBlock)

            switch header.typeFlag {
            case globalPaxHeaderType:
                let paxData = try readEntryPayloadData(from: handle, size: header.size)
                globalPaxHeaders.merge(parsePaxHeaders(from: paxData)) { _, newValue in
                    newValue
                }

            case paxHeaderType:
                let paxData = try readEntryPayloadData(from: handle, size: header.size)
                pendingPaxHeaders.merge(parsePaxHeaders(from: paxData)) { _, newValue in
                    newValue
                }

            case gnuLongNameType:
                pendingLongPath = decodeLongPath(from: try readEntryPayloadData(from: handle, size: header.size))

            case gnuLongLinkType:
                pendingLongLink = decodeLongPath(from: try readEntryPayloadData(from: handle, size: header.size))

            default:
                let effectiveHeaders = globalPaxHeaders.merging(pendingPaxHeaders) { _, newValue in
                    newValue
                }
                let resolvedPath = pendingLongPath ?? effectiveHeaders["path"] ?? header.path
                let resolvedLinkPath = pendingLongLink ?? effectiveHeaders["linkpath"] ?? header.linkName

                defer {
                    pendingPaxHeaders.removeAll()
                    pendingLongPath = nil
                    pendingLongLink = nil
                }

                try extractEntry(
                    path: resolvedPath,
                    typeFlag: header.typeFlag,
                    size: header.size,
                    linkPath: resolvedLinkPath,
                    from: handle,
                    to: destinationRoot
                )
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
        to destinationRoot: String
    ) throws {
        guard let relativePath = ArchiveExtractionUtilities.normalizedRelativePath(from: rawPath) else {
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
            outputHandle.write(chunk)
            remainingBytes -= UInt64(chunk.count)
        }
    }

    private static func readEntryPayloadData(from handle: FileHandle, size: UInt64) throws -> Data {
        guard size > 0 else {
            return Data()
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
        try ArchiveExtractionUtilities.skipBytes(padding, in: handle)
    }

    private static func parseHeader(from block: Data) throws -> Header {
        guard block.count == blockSize else {
            throw NSError(
                domain: "TarArchiveExtractor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid TAR block size: \(block.count)"]
            )
        }

        return Header(
            path: parseTarPath(from: block),
            size: try parseTarNumber(block[124..<136]),
            typeFlag: block[156],
            linkName: parseCString(block[157..<257])
        )
    }

    private static func parseTarPath(from block: Data) -> String {
        let name = parseCString(block[0..<100])
        let prefix = parseCString(block[345..<500])

        guard !prefix.isEmpty else {
            return name
        }

        guard !name.isEmpty else {
            return prefix
        }

        return "\(prefix)/\(name)"
    }

    private static func parseCString(_ data: Data.SubSequence) -> String {
        let bytes = data.prefix { $0 != 0 }
        guard !bytes.isEmpty else {
            return ""
        }

        if let decoded = String(data: Data(bytes), encoding: .utf8) {
            return decoded
        }

        return String(decoding: bytes, as: UTF8.self)
    }

    private static func parseTarNumber(_ data: Data.SubSequence) throws -> UInt64 {
        let bytes = [UInt8](data)
        guard !bytes.allSatisfy({ $0 == 0 || $0 == 32 }) else {
            return 0
        }

        if let first = bytes.first, first & 0x80 != 0 {
            var value: UInt64 = UInt64(first & 0x7F)
            for byte in bytes.dropFirst() {
                value = (value << 8) | UInt64(byte)
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

    private static func parsePaxHeaders(from data: Data) -> [String: String] {
        var headers: [String: String] = [:]
        var index = data.startIndex

        while index < data.endIndex {
            guard let spaceIndex = data[index...].firstIndex(of: 0x20),
                  let lengthString = String(data: data[index..<spaceIndex], encoding: .ascii),
                  let recordLength = Int(lengthString),
                  recordLength > 0 else {
                break
            }

            let recordEnd = index + recordLength
            guard recordEnd <= data.endIndex else {
                break
            }

            let recordBodyStart = data.index(after: spaceIndex)
            let recordBody = data[recordBodyStart..<recordEnd]

            if let newlineIndex = recordBody.lastIndex(of: 0x0A),
               let separatorIndex = recordBody[..<newlineIndex].firstIndex(of: 0x3D),
               let key = String(data: recordBody[..<separatorIndex], encoding: .utf8),
               let value = String(data: recordBody[recordBody.index(after: separatorIndex)..<newlineIndex], encoding: .utf8) {
                headers[key] = value
            }

            index = recordEnd
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
