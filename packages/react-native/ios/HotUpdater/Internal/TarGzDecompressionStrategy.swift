import Foundation

/**
 * Strategy for handling TAR+GZIP compressed files
 */
class TarGzDecompressionStrategy: DecompressionStrategy {
    private static let MIN_FILE_SIZE: UInt64 = 10

    func isValid(file: String) -> Bool {
        guard FileManager.default.fileExists(atPath: file) else {
            NSLog("[TarGzStrategy] Invalid file: doesn't exist")
            return false
        }

        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_FILE_SIZE else {
                NSLog("[TarGzStrategy] Invalid file: too small")
                return false
            }
        } catch {
            NSLog("[TarGzStrategy] Invalid file: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        // Check GZIP magic bytes (0x1F 0x8B)
        guard let fileHandle = FileHandle(forReadingAtPath: file) else {
            NSLog("[TarGzStrategy] Invalid file: cannot open file")
            return false
        }

        defer {
            fileHandle.closeFile()
        }

        guard let header = try? ArchiveExtractionUtilities.readUpToCount(from: fileHandle, count: 2),
              header.count == 2 else {
            NSLog("[TarGzStrategy] Invalid file: cannot read header")
            return false
        }

        let isGzip = header[0] == 0x1F && header[1] == 0x8B
        if !isGzip {
            NSLog("[TarGzStrategy] Invalid file: wrong magic bytes (expected 0x1F 0x8B, got 0x\(String(format: "%02X", header[0])) 0x\(String(format: "%02X", header[1])))")
        }
        return isGzip
    }

    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[TarGzStrategy] Starting extraction of \(file) to \(destination)")
        try StreamingTarArchiveExtractor.extractCompressedTar(
            file: file,
            to: destination,
            algorithm: .gzip,
            progressHandler: progressHandler
        )
        NSLog("[TarGzStrategy] Successfully extracted all entries")
    }
}
