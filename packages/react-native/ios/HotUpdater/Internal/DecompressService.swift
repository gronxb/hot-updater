import Foundation

/**
 * Unified decompression service that uses Strategy pattern to handle multiple compression formats.
 * Automatically detects format by trying each strategy's validation and delegates to appropriate decompression strategy.
 */
class DecompressService {
    /// Array of available strategies in order of detection priority
    private let strategies: [DecompressionStrategy]

    init() {
        // Order matters: Try ZIP first (clear magic bytes), then TAR.GZ (GZIP magic bytes), then TAR.BR (fallback)
        self.strategies = [
            ZipDecompressionStrategy(),
            TarGzDecompressionStrategy(),
            TarBrDecompressionStrategy()
        ]
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
        // Try each strategy's validation
        for strategy in strategies {
            if strategy.isValid(file: file) {
                NSLog("[DecompressService] Found valid strategy, delegating to decompression")
                try strategy.decompress(file: file, to: destination, progressHandler: progressHandler)
                return
            }
        }

        // No valid strategy found
        throw NSError(
            domain: "DecompressService",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "No valid decompression strategy found for file: \(file)"]
        )
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
     * Validates if a file is a valid compressed archive.
     * @param file Path to the file to validate
     * @return true if the file is valid for any strategy
     */
    func isValid(file: String) -> Bool {
        for strategy in strategies {
            if strategy.isValid(file: file) {
                return true
            }
        }
        NSLog("[DecompressService] No valid strategy found for file: \(file)")
        return false
    }
}
