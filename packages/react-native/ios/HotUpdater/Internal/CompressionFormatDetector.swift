import Foundation

/**
 * Enum representing supported compression formats.
 */
enum CompressionFormat {
    case zip
    case tarGzip
    case tarBrotli
    case unknown
}

/**
 * Utility class for detecting compression format from file magic bytes.
 */
class CompressionFormatDetector {

    /**
     * Detects the compression format of a file by reading its magic bytes.
     * @param filePath Path to the file to detect
     * @return The detected compression format
     */
    static func detectFormat(atPath filePath: String) -> CompressionFormat {
        guard let fileHandle = FileHandle(forReadingAtPath: filePath) else {
            NSLog("[CompressionFormatDetector] Failed to open file: \(filePath)")
            return .unknown
        }

        defer {
            fileHandle.closeFile()
        }

        // Read first 8 bytes for magic byte detection
        let magicBytes = fileHandle.readData(ofLength: 8)

        guard magicBytes.count >= 2 else {
            NSLog("[CompressionFormatDetector] File too small to detect format")
            return .unknown
        }

        // Check for ZIP format: PK.. (0x504B0304 or 0x504B0506)
        if magicBytes.count >= 4 {
            let zipMagic = magicBytes.prefix(4)
            if zipMagic[0] == 0x50 && zipMagic[1] == 0x4B &&
               (zipMagic[2] == 0x03 || zipMagic[2] == 0x05) {
                NSLog("[CompressionFormatDetector] Detected ZIP format")
                return .zip
            }
        }

        // Check for GZIP format: 0x1F8B
        if magicBytes[0] == 0x1F && magicBytes[1] == 0x8B {
            NSLog("[CompressionFormatDetector] Detected GZIP format (tar.gz)")
            return .tarGzip
        }

        // Brotli doesn't have a standard magic byte signature
        // We'll use file extension as fallback
        let fileExtension = (filePath as NSString).pathExtension.lowercased()
        if fileExtension == "br" {
            NSLog("[CompressionFormatDetector] Detected Brotli format by extension (tar.br)")
            return .tarBrotli
        }

        NSLog("[CompressionFormatDetector] Unknown compression format for file: \(filePath)")
        return .unknown
    }

    /**
     * Creates the appropriate UnzipService for the given file.
     * Falls back to ZIP format if detection fails for backward compatibility.
     * @param filePath Path to the file
     * @return An UnzipService instance appropriate for the file format
     */
    static func createUnzipService(forFile filePath: String) -> UnzipService {
        let format = detectFormat(atPath: filePath)

        switch format {
        case .zip:
            NSLog("[CompressionFormatDetector] Using SSZipArchiveUnzipService")
            return SSZipArchiveUnzipService()

        case .tarGzip:
            NSLog("[CompressionFormatDetector] Using TarGzipUnzipService")
            return TarGzipUnzipService()

        case .tarBrotli:
            NSLog("[CompressionFormatDetector] Using TarBrotliUnzipService")
            return TarBrotliUnzipService()

        case .unknown:
            // Fallback to ZIP for backward compatibility
            NSLog("[CompressionFormatDetector] Unknown format, defaulting to SSZipArchiveUnzipService")
            return SSZipArchiveUnzipService()
        }
    }
}
