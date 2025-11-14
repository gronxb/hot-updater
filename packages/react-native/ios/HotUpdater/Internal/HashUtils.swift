import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(CommonCrypto)
import CommonCrypto
#endif

/**
 * Utility class for file hash operations
 */
class HashUtils {
    /// Buffer size for file reading operations (64KB for optimal I/O performance)
    private static let BUFFER_SIZE = 65536

    /**
     * Calculates SHA256 hash of a file
     * @param fileURL URL of the file to hash
     * @return Hex string of the hash (lowercase), or nil if error occurs
     */
    static func calculateSHA256(fileURL: URL) -> String? {
        guard let fileHandle = try? FileHandle(forReadingFrom: fileURL) else {
            NSLog("[HashUtils] Failed to open file: \(fileURL.path)")
            return nil
        }

        defer {
            try? fileHandle.close()
        }

        #if canImport(CryptoKit)
        var hasher = SHA256()

        // Read file in chunks with autoreleasepool for memory efficiency
        while autoreleasepool(invoking: {
            let data = fileHandle.readData(ofLength: BUFFER_SIZE)
            if data.count > 0 {
                hasher.update(data: data)
                return true
            } else {
                return false
            }
        }) { }

        let digest = hasher.finalize()
        return digest.map { String(format: "%02x", $0) }.joined()
        #else
        // Fallback to CommonCrypto for platforms without CryptoKit (e.g., Linux)
        var context = CC_SHA256_CTX()
        CC_SHA256_Init(&context)

        // Read file in chunks with autoreleasepool for memory efficiency
        while autoreleasepool(invoking: {
            let data = fileHandle.readData(ofLength: BUFFER_SIZE)
            if data.count > 0 {
                data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
                    _ = CC_SHA256_Update(&context, bytes.baseAddress, CC_LONG(data.count))
                }
                return true
            } else {
                return false
            }
        }) { }

        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256_Final(&hash, &context)
        return hash.map { String(format: "%02x", $0) }.joined()
        #endif
    }

    /**
     * Verifies file hash
     * @param fileURL URL of the file to verify
     * @param expectedHash Expected SHA256 hash (hex string, case-insensitive)
     * @return true if hash matches, false otherwise
     */
    static func verifyHash(fileURL: URL, expectedHash: String) -> Bool {
        guard let actualHash = calculateSHA256(fileURL: fileURL) else {
            NSLog("[HashUtils] Failed to calculate hash")
            return false
        }

        let matches = actualHash.caseInsensitiveCompare(expectedHash) == .orderedSame

        if !matches {
            NSLog("[HashUtils] Hash mismatch - Expected: \(expectedHash), Actual: \(actualHash)")
        }

        return matches
    }
}
