import Foundation

/**
 * Factory for creating the appropriate UnzipService based on content encoding
 */
class UnzipServiceFactory {
    /**
     * Creates an UnzipService based on the content encoding header
     * @param contentEncoding The Content-Encoding header from HTTP response (e.g., "br", nil)
     * @return Appropriate UnzipService implementation
     */
    static func createUnzipService(contentEncoding: String?) -> UnzipService {
        guard let encoding = contentEncoding?.lowercased() else {
            NSLog("[UnzipServiceFactory] Using SSZipArchiveUnzipService (default, no Content-Encoding)")
            return SSZipArchiveUnzipService()
        }

        switch encoding {
        case "br":
            NSLog("[UnzipServiceFactory] Using TarBrotliUnzipService for Content-Encoding: br")
            return TarBrotliUnzipService()
        default:
            NSLog("[UnzipServiceFactory] Unknown Content-Encoding: \(encoding), falling back to SSZipArchiveUnzipService")
            return SSZipArchiveUnzipService()
        }
    }
}
