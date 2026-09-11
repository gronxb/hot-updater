import Foundation

// Conservative limits for the provisional full-archive profile.
enum ArchiveLimits {
    static let compressed: UInt64 = 512 * 1024 * 1024
    static let expanded: UInt64 = 1024 * 1024 * 1024
    static let entries = 10_000
    static func reject(_ message: String) -> NSError {
        NSError(domain: "HotUpdaterLynxArchive", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static func checkOutput(_ handle: FileHandle, adding bytes: Int) throws {
        let offset = try handle.offset()
        guard offset <= expanded, UInt64(bytes) <= expanded - offset else { throw reject("Archive expansion limit exceeded") }
        try Task.checkCancellation()
    }
}

final class ArchiveEntryGuard {
    private var paths: [String: Bool] = [:]
    private var total: UInt64 = 0
    func admit(_ rawPath: String, size: UInt64, directory: Bool, link: Bool = false) throws {
        try Task.checkCancellation()
        let path = directory && rawPath.hasSuffix("/") ? String(rawPath.dropLast()) : rawPath
        guard !link, path.utf8.count <= 1024,
              ArchiveExtractionUtilities.normalizedRelativePath(from: path) == path else {
            throw ArchiveLimits.reject("Unsafe archive entry: \(rawPath)")
        }
        let key = path.precomposedStringWithCanonicalMapping.lowercased()
        guard paths.count < ArchiveLimits.entries, paths[key] == nil,
              !paths.contains(where: { old, isDirectory in (!isDirectory && key.hasPrefix(old + "/")) || (!directory && old.hasPrefix(key + "/")) }),
              size <= ArchiveLimits.expanded - total else { throw ArchiveLimits.reject("Duplicate, conflicting or oversized archive entry") }
        paths[key] = directory
        total += size
    }
}

enum StrictArchive {
    static func extract(_ file: URL, to directory: URL) throws {
        let handle = try FileHandle(forReadingFrom: file)
        let prefix = try handle.read(upToCount: 4) ?? Data()
        try handle.close()
        if prefix.starts(with: [0x50, 0x4b, 0x03, 0x04]) {
            try ZipArchiveExtractor.extract(file: file.path, to: directory.path, strict: true, progressHandler: { _ in })
        } else {
            let algorithm: CompressedTarAlgorithm = prefix.starts(with: [0x1f, 0x8b]) ? .gzip : .brotli
            try StreamingTarArchiveExtractor.extractCompressedTar(file: file.path, to: directory.path, algorithm: algorithm, strict: true, progressHandler: { _ in })
        }
    }
}
