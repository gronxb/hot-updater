import Foundation

/**
 * Unified decompression service that uses Strategy pattern to handle multiple compression formats.
 * Automatically detects format by trying each strategy's validation and delegates to appropriate decompression strategy.
 */
class DecompressService {
    /// Strategies with reliable file signatures that can be validated cheaply.
    private let signatureStrategies: [DecompressionStrategy]
    /// TAR.BR has no reliable magic bytes, so it is attempted as the final fallback.
    private let tarBrStrategy: DecompressionStrategy

    init() {
        // Order matters: Try ZIP first (clear magic bytes), then TAR.GZ (GZIP magic bytes).
        // TAR.BR is attempted only after signature-based formats are ruled out.
        self.signatureStrategies = [
            ZipDecompressionStrategy(),
            TarGzDecompressionStrategy()
        ]
        self.tarBrStrategy = TarBrDecompressionStrategy()
    }

    /**
     * Extracts a compressed file to the destination directory.
     * Automatically detects compression format by trying each strategy's validation.
     * @param file Path to the compressed file
     * @param destination Path to the destination directory
     * @param progressHandler Callback for progress updates (0.0 - 1.0)
     * @throws Error if decompression fails or no valid strategy found
     */
    func unzip(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        // Collect file information for better error messages
        let fileURL = URL(fileURLWithPath: file)
        let fileName = fileURL.lastPathComponent
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: file)[.size] as? UInt64) ?? 0

        // Try each signature-based strategy first.
        for strategy in signatureStrategies {
            if strategy.isValid(file: file) {
                NSLog("[DecompressService] Using strategy for \(fileName)")
                try strategy.decompress(file: file, to: destination, progressHandler: progressHandler)
                return
            }
        }

        NSLog("[DecompressService] No ZIP/TAR.GZ signature matched for \(fileName), trying TAR.BR fallback")

        do {
            try tarBrStrategy.decompress(file: file, to: destination, progressHandler: progressHandler)
            NSLog("[DecompressService] Using TAR.BR fallback for \(fileName)")
            return
        } catch {
            let invalidArchiveError = createInvalidArchiveError(
                fileName: fileName,
                fileSize: fileSize,
                underlyingError: error
            )
            NSLog("[DecompressService] \(invalidArchiveError.localizedDescription)")
            throw invalidArchiveError
        }
    }

    /**
     * Extracts a compressed file to the destination directory (without progress tracking).
     * @param file Path to the compressed file
     * @param destination Path to the destination directory
     * @throws Error if decompression fails or no valid strategy found
     */
    func unzip(file: String, to destination: String) throws {
        try unzip(file: file, to: destination, progressHandler: { _ in })
    }

    /**
     * Validates if a file matches one of the signature-based archive formats.
     * @param file Path to the file to validate
     * @return true if the file is valid for any strategy
     */
    func isValid(file: String) -> Bool {
        for strategy in signatureStrategies {
            if strategy.isValid(file: file) {
                return true
            }
        }
        NSLog("[DecompressService] No ZIP/TAR.GZ signature matched for file: \(file). TAR.BR is handled during extraction fallback.")
        return false
    }

    private func createInvalidArchiveError(fileName: String, fileSize: UInt64, underlyingError: Error? = nil) -> NSError {
        let errorMessage = """
The downloaded bundle file is not a valid compressed archive: \(fileName) (\(fileSize) bytes)

Supported formats:
- ZIP archives (.zip)
- GZIP compressed TAR archives (.tar.gz)
- Brotli compressed TAR archives (.tar.br)
"""

        var userInfo: [String: Any] = [
            NSLocalizedDescriptionKey: errorMessage
        ]

        if let underlyingError {
            userInfo[NSUnderlyingErrorKey] = underlyingError
        }

        return NSError(
            domain: "DecompressService",
            code: 1,
            userInfo: userInfo
        )
    }
}
