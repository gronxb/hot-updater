import Foundation

enum TarArchiveExtractor {
    private static let blockSize = 512
    private static let regularFileType: UInt8 = 48
    private static let alternateRegularFileType: UInt8 = 0
    private static let paxHeaderType: UInt8 = 120
    private static let maximumPaxByteSize = 1024 * 1024

    private struct Header {
        let path: String
        let size: UInt64
        let typeFlag: UInt8
    }

    static func extract(
        from tarPath: String,
        to destination: String,
        expectedFiles: [String: Int64]
    ) throws {
        let destinationURL = URL(fileURLWithPath: destination, isDirectory: true)
        try FileManager.default.createDirectory(
            at: destinationURL,
            withIntermediateDirectories: true
        )

        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: tarPath))
        defer { try? handle.close() }

        var extractedPaths = Set<String>()
        var pendingPaxHeaders: [String: String]?

        while true {
            let headerBlock = try readExactly(from: handle, count: blockSize)
            if isZeroBlock(headerBlock) {
                let secondEndBlock = try readExactly(from: handle, count: blockSize)
                guard isZeroBlock(secondEndBlock), pendingPaxHeaders == nil else {
                    throw archiveError(1, "Invalid TAR termination")
                }
                try requireZeroPaddingToEnd(handle)
                guard extractedPaths == Set(expectedFiles.keys) else {
                    throw archiveError(2, "TAR file set does not match the manifest")
                }
                return
            }

            let header = try parseHeader(headerBlock)
            if header.typeFlag == paxHeaderType {
                guard pendingPaxHeaders == nil,
                      header.size <= UInt64(maximumPaxByteSize) else {
                    throw archiveError(3, "Invalid PAX header")
                }
                let payload = try readPayload(from: handle, size: header.size)
                pendingPaxHeaders = try parsePaxHeaders(payload)
                continue
            }

            guard header.typeFlag == regularFileType ||
                    header.typeFlag == alternateRegularFileType else {
                throw archiveError(4, "Unsupported TAR entry type")
            }

            let paxHeaders = pendingPaxHeaders ?? [:]
            pendingPaxHeaders = nil
            guard paxHeaders["linkpath"] == nil else {
                throw archiveError(5, "TAR links are not allowed")
            }
            let rawPath = paxHeaders["path"] ?? header.path
            guard FileUtilities.normalizedRelativePath(from: rawPath) == rawPath,
                  rawPath != "manifest.json",
                  !extractedPaths.contains(rawPath),
                  let expectedByteSize = expectedFiles[rawPath],
                  expectedByteSize >= 0 else {
                throw archiveError(6, "TAR contains an unsafe, duplicate, or unknown path")
            }

            let entrySize: UInt64
            if let paxSize = paxHeaders["size"] {
                guard let parsedSize = UInt64(paxSize) else {
                    throw archiveError(7, "Invalid PAX entry size")
                }
                entrySize = parsedSize
            } else {
                entrySize = header.size
            }
            guard entrySize == UInt64(expectedByteSize) else {
                throw archiveError(8, "TAR entry size does not match the manifest")
            }

            let outputURL = try FileUtilities.fileURL(
                for: rawPath,
                destinationRoot: destination
            )
            try FileManager.default.createDirectory(
                at: outputURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            guard FileManager.default.createFile(atPath: outputURL.path, contents: nil) else {
                throw archiveError(9, "Failed to create TAR output file")
            }
            let output = try FileHandle(forWritingTo: outputURL)
            do {
                try copyPayload(
                    from: handle,
                    size: entrySize,
                    to: output
                )
                try output.close()
            } catch {
                try? output.close()
                try? FileManager.default.removeItem(at: outputURL)
                throw error
            }
            try readPadding(from: handle, size: entrySize)
            extractedPaths.insert(rawPath)
        }
    }

    private static func parseHeader(_ block: Data) throws -> Header {
        guard block.count == blockSize,
              Data(block[257..<262]) == Data("ustar".utf8),
              try verifyChecksum(block) else {
            throw archiveError(10, "Invalid USTAR header")
        }
        let name = try parseString(block[0..<100])
        let prefix = try parseString(block[345..<500])
        let path = prefix.isEmpty ? name : (name.isEmpty ? prefix : "\(prefix)/\(name)")
        return Header(
            path: path,
            size: try parseOctal(block[124..<136]),
            typeFlag: block[156]
        )
    }

    private static func verifyChecksum(_ block: Data) throws -> Bool {
        let expected = try parseOctal(block[148..<156])
        var actual: UInt64 = 0
        for index in block.indices {
            actual += UInt64((148..<156).contains(index) ? 32 : block[index])
        }
        return actual == expected
    }

    private static func parseOctal(_ bytes: Data.SubSequence) throws -> UInt64 {
        let value = try parseString(bytes)
            .trimmingCharacters(in: CharacterSet(charactersIn: " \0"))
        if value.isEmpty { return 0 }
        guard value.allSatisfy({ ("0"..."7").contains($0) }),
              let parsed = UInt64(value, radix: 8) else {
            throw archiveError(11, "Invalid TAR numeric field")
        }
        return parsed
    }

    private static func parseString(_ bytes: Data.SubSequence) throws -> String {
        let value = bytes.prefix { $0 != 0 }
        guard let decoded = String(data: Data(value), encoding: .utf8) else {
            throw archiveError(12, "Invalid UTF-8 in TAR header")
        }
        return decoded
    }

    private static func parsePaxHeaders(_ data: Data) throws -> [String: String] {
        var headers: [String: String] = [:]
        var offset = 0
        while offset < data.count {
            guard let space = data[offset...].firstIndex(of: 0x20),
                  let lengthText = String(data: data[offset..<space], encoding: .ascii),
                  let recordLength = Int(lengthText),
                  recordLength > space - offset + 2 else {
                throw archiveError(13, "Malformed PAX record")
            }
            let (end, overflowed) = offset.addingReportingOverflow(recordLength)
            guard !overflowed, end <= data.count, data[end - 1] == 0x0A else {
                throw archiveError(13, "Malformed PAX record")
            }
            let bodyStart = space + 1
            guard let equals = data[bodyStart..<(end - 1)].firstIndex(of: 0x3D),
                  let key = String(data: data[bodyStart..<equals], encoding: .utf8),
                  let value = String(data: data[(equals + 1)..<(end - 1)], encoding: .utf8),
                  !key.isEmpty,
                  headers[key] == nil else {
                throw archiveError(13, "Malformed PAX record")
            }
            headers[key] = value
            offset = end
        }
        return headers
    }

    private static func copyPayload(
        from input: FileHandle,
        size: UInt64,
        to output: FileHandle
    ) throws {
        var remaining = size
        while remaining > 0 {
            let count = Int(min(remaining, 64 * 1024))
            let chunk = try readExactly(from: input, count: count)
            output.write(chunk)
            remaining -= UInt64(chunk.count)
        }
    }

    private static func readPayload(from handle: FileHandle, size: UInt64) throws -> Data {
        guard size <= UInt64(Int.max) else {
            throw archiveError(14, "TAR payload is too large")
        }
        let payload = try readExactly(from: handle, count: Int(size))
        try readPadding(from: handle, size: size)
        return payload
    }

    private static func readPadding(from handle: FileHandle, size: UInt64) throws {
        let padding = (UInt64(blockSize) - size % UInt64(blockSize)) % UInt64(blockSize)
        if padding > 0 {
            let bytes = try readExactly(from: handle, count: Int(padding))
            guard bytes.allSatisfy({ $0 == 0 }) else {
                throw archiveError(15, "Invalid TAR entry padding")
            }
        }
    }

    private static func requireZeroPaddingToEnd(_ handle: FileHandle) throws {
        while true {
            let bytes = try FileUtilities.readUpToCount(
                from: handle,
                count: blockSize
            ) ?? Data()
            if bytes.isEmpty { return }
            guard bytes.count == blockSize,
                  bytes.allSatisfy({ $0 == 0 }) else {
                throw archiveError(16, "TAR contains trailing data")
            }
        }
    }

    private static func readExactly(from handle: FileHandle, count: Int) throws -> Data {
        guard let data = try FileUtilities.readUpToCount(from: handle, count: count),
              data.count == count else {
            throw archiveError(17, "Truncated TAR archive")
        }
        return data
    }

    private static func isZeroBlock(_ data: Data) -> Bool {
        data.allSatisfy { $0 == 0 }
    }

    private static func archiveError(_ code: Int, _ message: String) -> NSError {
        NSError(
            domain: "TarArchiveExtractor",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
