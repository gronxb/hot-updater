import Foundation
import CryptoKit

/**
 * Utility class for file hash operations
 */
class HashUtils {
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

        var hasher = SHA256()
        let bufferSize = 8192

        while autoreleasepool(invoking: {
            let data = fileHandle.readData(ofLength: bufferSize)
            if data.count > 0 {
                hasher.update(data: data)
                return true
            } else {
                return false
            }
        }) { }

        let digest = hasher.finalize()
        return digest.map { String(format: "%02x", $0) }.joined()
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
