import Foundation

/**
 * Strategy for handling TAR+Brotli compressed files
 */
class TarBrDecompressionStrategy: DecompressionStrategy {
    private static let MIN_FILE_SIZE: UInt64 = 10

    func isValid(file: String) -> Bool {
        guard FileManager.default.fileExists(atPath: file) else {
            NSLog("[TarBrStrategy] Invalid file: doesn't exist")
            return false
        }

        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_FILE_SIZE else {
                NSLog("[TarBrStrategy] Invalid file: too small")
                return false
            }
        } catch {
            NSLog("[TarBrStrategy] Invalid file: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        return StreamingTarArchiveExtractor.containsTarEntries(file: file, algorithm: .brotli)
    }

    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[TarBrStrategy] Starting extraction of \(file) to \(destination)")
        try StreamingTarArchiveExtractor.extractCompressedTar(
            file: file,
            to: destination,
            algorithm: .brotli,
            progressHandler: progressHandler
        )
        NSLog("[TarBrStrategy] Successfully extracted all entries")
    }
}
