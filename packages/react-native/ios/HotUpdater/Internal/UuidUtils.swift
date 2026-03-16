import Foundation

/**
 * Utility for UUIDv7 operations.
 */
class UuidUtils {
    /**
     * Masks a UUIDv7 by zeroing out all random bits (rand_a and rand_b),
     * keeping only the 48-bit timestamp, 4-bit version (7), and 2-bit variant (10).
     *
     * This produces the minimum valid UUIDv7 for a given timestamp,
     * making copy-promoted bundles (same timestamp, different random bits)
     * compare as equal.
     */
    static func maskUuidV7Rand(_ uuid: String) -> String {
        let hex = uuid.replacingOccurrences(of: "-", with: "")
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 {
            let startIndex = hex.index(hex.startIndex, offsetBy: i * 2)
            let endIndex = hex.index(startIndex, offsetBy: 2)
            bytes[i] = UInt8(hex[startIndex..<endIndex], radix: 16) ?? 0
        }

        // UUIDv7 layout:
        // bytes[0..5]  = 48-bit Unix timestamp in milliseconds
        // byte[6]      = version (high 4 bits) | rand_a (low 4 bits)
        // byte[7]      = rand_a (8 bits)
        // byte[8]      = variant (high 2 bits) | rand_b (low 6 bits)
        // bytes[9..15] = rand_b (56 bits)
        bytes[6] &= 0xf0 // keep version, clear rand_a high bits
        bytes[7] = 0x00   // clear rand_a low bits
        bytes[8] &= 0xc0  // keep variant, clear rand_b high bits
        for i in 9..<16 {
            bytes[i] = 0x00 // clear rand_b remaining bits
        }

        let out = bytes.map { String(format: "%02x", $0) }.joined()
        let s = out
        let i0 = s.startIndex
        let i8 = s.index(i0, offsetBy: 8)
        let i12 = s.index(i0, offsetBy: 12)
        let i16 = s.index(i0, offsetBy: 16)
        let i20 = s.index(i0, offsetBy: 20)
        return "\(s[i0..<i8])-\(s[i8..<i12])-\(s[i12..<i16])-\(s[i16..<i20])-\(s[i20...])"
    }
}
