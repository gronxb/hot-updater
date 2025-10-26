import Foundation
import SWCompression

/**
 * Strategy for handling ZIP compressed files
 */
class ZipDecompressionStrategy: DecompressionStrategy {
    private static let ZIP_MAGIC_NUMBER: [UInt8] = [0x50, 0x4B, 0x03, 0x04]
    private static let MIN_ZIP_SIZE: UInt64 = 22

    func isValid(file: String) -> Bool {
        guard FileManager.default.fileExists(atPath: file) else {
            NSLog("[ZipStrategy] Invalid ZIP: file doesn't exist")
            return false
        }

        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_ZIP_SIZE else {
                NSLog("[ZipStrategy] Invalid ZIP: file too small")
                return false
            }
        } catch {
            NSLog("[ZipStrategy] Invalid ZIP: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        guard let fileHandle = FileHandle(forReadingAtPath: file) else {
            NSLog("[ZipStrategy] Invalid ZIP: cannot open file")
            return false
        }

        defer {
            fileHandle.closeFile()
        }

        let header = fileHandle.readData(ofLength: 4)
        guard header.count == 4 else {
            NSLog("[ZipStrategy] Invalid ZIP: cannot read header")
            return false
        }

        let magicBytes = [UInt8](header)
        guard magicBytes == Self.ZIP_MAGIC_NUMBER else {
            NSLog("[ZipStrategy] Invalid ZIP: wrong magic number")
            return false
        }

        guard let zipData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            NSLog("[ZipStrategy] Invalid ZIP: cannot read file data")
            return false
        }

        do {
            _ = try ZipContainer.open(container: zipData)
            return true
        } catch {
            NSLog("[ZipStrategy] Invalid ZIP: structure validation failed - \(error.localizedDescription)")
            return false
        }
    }

    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[ZipStrategy] Starting extraction of \(file) to \(destination)")

        guard let zipData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            throw NSError(
                domain: "ZipDecompressionStrategy",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read ZIP file at: \(file)"]
            )
        }

        progressHandler(0.1)

        let zipEntries: [ZipEntry]
        do {
            zipEntries = try ZipContainer.open(container: zipData)
            NSLog("[ZipStrategy] ZIP extraction successful, found \(zipEntries.count) entries")
        } catch {
            throw NSError(
                domain: "ZipDecompressionStrategy",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "ZIP extraction failed: \(error.localizedDescription)"]
            )
        }

        progressHandler(0.2)

        let destinationURL = URL(fileURLWithPath: destination)
        let canonicalDestination = destinationURL.standardized.path

        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: canonicalDestination) {
            try fileManager.createDirectory(
                atPath: canonicalDestination,
                withIntermediateDirectories: true,
                attributes: nil
            )
        }

        let totalEntries = Double(zipEntries.count)
        for (index, entry) in zipEntries.enumerated() {
            try extractZipEntry(entry, to: canonicalDestination)
            progressHandler(0.2 + (Double(index + 1) / totalEntries * 0.8))
        }

        NSLog("[ZipStrategy] Successfully extracted all entries")
    }

    private func extractZipEntry(_ entry: ZipEntry, to destination: String) throws {
        let fileManager = FileManager.default
        let entryPath = entry.info.name.trimmingCharacters(in: .init(charactersIn: "/"))

        guard !entryPath.isEmpty,
              !entryPath.contains(".."),
              !entryPath.hasPrefix("/") else {
            NSLog("[ZipStrategy] Skipping suspicious path: \(entry.info.name)")
            return
        }

        let fullPath = (destination as NSString).appendingPathComponent(entryPath)
        let fullURL = URL(fileURLWithPath: fullPath)
        let canonicalFullPath = fullURL.standardized.path
        let canonicalDestination = URL(fileURLWithPath: destination).standardized.path

        guard canonicalFullPath.hasPrefix(canonicalDestination + "/") ||
              canonicalFullPath == canonicalDestination else {
            throw NSError(
                domain: "ZipDecompressionStrategy",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Path traversal attempt detected: \(entry.info.name)"]
            )
        }

        if entry.info.type == .directory {
            if !fileManager.fileExists(atPath: canonicalFullPath) {
                try fileManager.createDirectory(
                    atPath: canonicalFullPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }
            return
        }

        if entry.info.type == .regular {
            let parentPath = (canonicalFullPath as NSString).deletingLastPathComponent
            if !fileManager.fileExists(atPath: parentPath) {
                try fileManager.createDirectory(
                    atPath: parentPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }

            guard let data = entry.data else {
                NSLog("[ZipStrategy] Skipping file with no data: \(entry.info.name)")
                return
            }

            try data.write(to: URL(fileURLWithPath: canonicalFullPath))
            NSLog("[ZipStrategy] Extracted: \(entryPath)")
        }
    }
}
