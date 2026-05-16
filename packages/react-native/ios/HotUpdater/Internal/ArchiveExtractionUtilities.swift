import Foundation

enum ArchiveExtractionUtilities {
    static let bufferSize = 64 * 1024

    static func readUpToCount(from handle: FileHandle, count: Int) throws -> Data? {
        guard count >= 0 else {
            throw NSError(
                domain: "ArchiveExtractionUtilities",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Invalid read size: \(count)"]
            )
        }

        if count == 0 {
            return Data()
        }

        if #available(macOS 10.15.4, iOS 13.4, watchOS 6.2, tvOS 13.4, *) {
            return try handle.read(upToCount: count)
        }

        return handle.readData(ofLength: count)
    }

    static func readExactly(from handle: FileHandle, count: Int) throws -> Data {
        guard count >= 0 else {
            throw NSError(
                domain: "ArchiveExtractionUtilities",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid read size: \(count)"]
            )
        }

        if count == 0 {
            return Data()
        }

        guard let data = try readUpToCount(from: handle, count: count), data.count == count else {
            throw NSError(
                domain: "ArchiveExtractionUtilities",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Unexpected end of archive while reading \(count) bytes"]
            )
        }

        return data
    }

    static func currentOffset(for handle: FileHandle) -> UInt64 {
        if #available(macOS 10.15.4, iOS 13.4, watchOS 6.2, tvOS 13.4, *) {
            return (try? handle.offset()) ?? 0
        }

        return handle.offsetInFile
    }

    static func seek(_ handle: FileHandle, to offset: UInt64) throws {
        if #available(macOS 10.15.4, iOS 13.4, watchOS 6.2, tvOS 13.4, *) {
            try handle.seek(toOffset: offset)
            return
        }

        handle.seek(toFileOffset: offset)
    }

    static func skipBytes(_ byteCount: UInt64, in handle: FileHandle) throws {
        guard byteCount > 0 else {
            return
        }

        let offset = currentOffset(for: handle)
        let (targetOffset, overflowed) = offset.addingReportingOverflow(byteCount)

        guard !overflowed else {
            throw NSError(
                domain: "ArchiveExtractionUtilities",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: "Archive offset overflow while skipping \(byteCount) bytes from offset \(offset)"]
            )
        }

        try seek(handle, to: targetOffset)
    }

    static func normalizedRelativePath(from rawPath: String) -> String? {
        let candidate = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty,
              !candidate.contains("\0"),
              !candidate.contains("\\"),
              !candidate.hasPrefix("/"),
              candidate.range(of: #"^[A-Za-z]:"#, options: .regularExpression) == nil
        else {
            return nil
        }

        let components = candidate
            .split(separator: "/")
            .map(String.init)

        guard !components.isEmpty else {
            return nil
        }

        guard components.count == candidate.split(separator: "/", omittingEmptySubsequences: false).count,
              !components.contains(".."),
              !components.contains(".") else {
            return nil
        }

        return components.joined(separator: "/")
    }

    static func extractionURL(for relativePath: String, destinationRoot: String) throws -> URL {
        let rootURL = URL(fileURLWithPath: destinationRoot, isDirectory: true)
        let targetURL = rootURL.appendingPathComponent(relativePath)
        let standardizedRoot = rootURL.standardizedFileURL.path
        let standardizedTarget = targetURL.standardizedFileURL.path

        guard standardizedTarget == standardizedRoot ||
                standardizedTarget.hasPrefix(standardizedRoot + "/") else {
            throw NSError(
                domain: "ArchiveExtractionUtilities",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Path traversal attempt detected: \(relativePath)"]
            )
        }

        return targetURL
    }

    static func ensureDirectory(at url: URL, fileManager: FileManager = .default) throws {
        var isDirectory = ObjCBool(false)
        if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) {
            if isDirectory.boolValue {
                return
            }

            try fileManager.removeItem(at: url)
        }

        try fileManager.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
    }

    static func createOutputFile(at url: URL, fileManager: FileManager = .default) throws -> FileHandle {
        try ensureDirectory(at: url.deletingLastPathComponent(), fileManager: fileManager)

        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }

        guard fileManager.createFile(atPath: url.path, contents: nil) else {
            throw NSError(
                domain: "ArchiveExtractionUtilities",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create output file at \(url.path)"]
            )
        }

        return try FileHandle(forWritingTo: url)
    }
}

extension Data {
    func archiveUInt16LE(at offset: Int) -> UInt16 {
        let byte0 = UInt16(self[offset])
        let byte1 = UInt16(self[offset + 1]) << 8
        return byte0 | byte1
    }

    func archiveUInt32LE(at offset: Int) -> UInt32 {
        let byte0 = UInt32(self[offset])
        let byte1 = UInt32(self[offset + 1]) << 8
        let byte2 = UInt32(self[offset + 2]) << 16
        let byte3 = UInt32(self[offset + 3]) << 24
        return byte0 | byte1 | byte2 | byte3
    }
}
