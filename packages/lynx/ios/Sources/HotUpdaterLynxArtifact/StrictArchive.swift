import Foundation

// Shared packaging and native acceptance limits.
enum ArchiveLimits {
    static let archive: UInt64 = 128 * 1024 * 1024
    static let expanded: UInt64 = 512 * 1024 * 1024
    static let tarStream: UInt64 = 567_581_936
    static let file: UInt64 = 128 * 1024 * 1024
    static let manifest = 1 * 1024 * 1024
    static let entries = 10_000
    static func reject(_ message: String) -> NSError {
        NSError(domain: "HotUpdaterLynxArchive", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static func checkOutput(_ handle: FileHandle, adding bytes: Int, maximumBytes: UInt64 = expanded) throws {
        let offset = try handle.offset()
        guard offset <= maximumBytes, UInt64(bytes) <= maximumBytes - offset else { throw reject("Archive expansion limit exceeded") }
        try Task.checkCancellation()
    }
    static func checkArchive(_ file: URL) throws {
        let values = try FileManager.default.attributesOfItem(atPath: file.path)
        guard values[.type] as? FileAttributeType == .typeRegular,
              let size = values[.size] as? NSNumber, size.uint64Value <= archive else {
            throw reject("Archive size/type limit exceeded")
        }
    }
}

final class ArchiveEntryGuard {
    private static let portableCaseLocale = Locale(identifier: "en_US_POSIX")
    private var paths: [String: Bool] = [:]
    private var directorySpellings: [String: String] = [:]
    private var logicalEntries: Set<String> = []
    private var total: UInt64 = 0
    init(reservingManifest: Bool = false, manifestSize: UInt64 = 0) {
        total = reservingManifest ? manifestSize : 0
        if reservingManifest {
            let key = Self.portableKey("manifest.json")
            paths[key] = false
            logicalEntries.insert(key)
        }
    }
    func admit(_ rawPath: String, size: UInt64, directory: Bool, link: Bool = false) throws {
        try Task.checkCancellation()
        let path = directory && rawPath.hasSuffix("/") ? String(rawPath.dropLast()) : rawPath
        guard !link, path.utf8.count <= 1024,
              ArchiveExtractionUtilities.normalizedRelativePath(from: path) == path else {
            throw ArchiveLimits.reject("Unsafe archive entry: \(rawPath)")
        }
        let key = Self.portableKey(path)
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        var parents: [(key: String, spelling: String)] = []
        if components.count > 1 {
            for count in 1..<components.count {
                let spelling = components[..<count].joined(separator: "/")
                parents.append((Self.portableKey(spelling), spelling))
            }
        }
        let directoryCandidates = directory ? parents + [(key, path)] : parents
        let parentKeys = parents.map(\.key)
        let newLogicalEntries = Set(parentKeys + [key]).subtracting(logicalEntries)
        guard paths[key] == nil,
              !parentKeys.contains(where: { paths[$0] == false }),
              directory || directorySpellings[key] == nil,
              !directoryCandidates.contains(where: { candidate in
                  directorySpellings[candidate.key].map { existing in
                      !existing.utf8.elementsEqual(candidate.spelling.utf8)
                  } ?? false
              }),
              logicalEntries.count <= ArchiveLimits.entries - newLogicalEntries.count,
              size <= ArchiveLimits.file,
              size <= ArchiveLimits.expanded - total else { throw ArchiveLimits.reject("Duplicate, conflicting or oversized archive entry") }
        paths[key] = directory
        for candidate in directoryCandidates where directorySpellings[candidate.key] == nil {
            directorySpellings[candidate.key] = candidate.spelling
        }
        logicalEntries.formUnion(newLogicalEntries)
        total += size
    }

    private static func portableKey(_ path: String) -> String {
        path.precomposedStringWithCanonicalMapping
            .uppercased(with: portableCaseLocale)
            .lowercased(with: portableCaseLocale)
    }
}

enum StrictArchive {
    static func extract(_ file: URL, to directory: URL) throws {
        try ArchiveLimits.checkArchive(file)
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
