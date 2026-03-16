package com.hotupdater

/**
 * Utility for UUIDv7 operations.
 */
object UuidUtils {
    /**
     * Masks a UUIDv7 by zeroing out all random bits (rand_a and rand_b),
     * keeping only the 48-bit timestamp, 4-bit version (7), and 2-bit variant (10).
     *
     * This produces the minimum valid UUIDv7 for a given timestamp,
     * making copy-promoted bundles (same timestamp, different random bits)
     * compare as equal.
     */
    fun maskUuidV7Rand(uuid: String): String {
        val hex = uuid.replace("-", "")
        val bytes = ByteArray(16)
        for (i in 0 until 16) {
            bytes[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }

        // UUIDv7 layout:
        // bytes[0..5]  = 48-bit Unix timestamp in milliseconds
        // byte[6]      = version (high 4 bits) | rand_a (low 4 bits)
        // byte[7]      = rand_a (8 bits)
        // byte[8]      = variant (high 2 bits) | rand_b (low 6 bits)
        // bytes[9..15] = rand_b (56 bits)
        bytes[6] = (bytes[6].toInt() and 0xf0).toByte() // keep version, clear rand_a high bits
        bytes[7] = 0x00                                  // clear rand_a low bits
        bytes[8] = (bytes[8].toInt() and 0xc0).toByte()  // keep variant, clear rand_b high bits
        for (i in 9 until 16) {
            bytes[i] = 0x00                              // clear rand_b remaining bits
        }

        val out = bytes.joinToString("") { "%02x".format(it) }
        return "${out.substring(0, 8)}-${out.substring(8, 12)}-${out.substring(12, 16)}-${out.substring(16, 20)}-${out.substring(20)}"
    }
}
