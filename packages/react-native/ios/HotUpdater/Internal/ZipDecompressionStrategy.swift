import Foundation

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

        guard let header = try? ArchiveExtractionUtilities.readUpToCount(from: fileHandle, count: 4),
              header.count == 4 else {
            NSLog("[ZipStrategy] Invalid ZIP: cannot read header")
            return false
        }

        let magicBytes = [UInt8](header)
        guard magicBytes == Self.ZIP_MAGIC_NUMBER else {
            NSLog("[ZipStrategy] Invalid ZIP: wrong magic number")
            return false
        }

        return true
    }

    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[ZipStrategy] Starting extraction of \(file) to \(destination)")
        try ZipArchiveExtractor.extract(file: file, to: destination, progressHandler: progressHandler)
        NSLog("[ZipStrategy] Successfully extracted all entries")
    }
}
