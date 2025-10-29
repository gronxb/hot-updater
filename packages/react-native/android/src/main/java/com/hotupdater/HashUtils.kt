package com.hotupdater

import android.util.Log
import java.io.File
import java.security.MessageDigest

/**
 * Utility class for file hash operations
 */
object HashUtils {
    /**
     * Calculates SHA256 hash of a file
     * @param file The file to hash
     * @return Hex string of the hash (lowercase)
     */
    fun calculateSHA256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            var bytesRead: Int
            while (input.read(buffer).also { bytesRead = it } != -1) {
                digest.update(buffer, 0, bytesRead)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Verifies file hash
     * @param file File to verify
     * @param expectedHash Expected SHA256 hash (hex string, case-insensitive)
     * @return true if hash matches
     */
    fun verifyHash(
        file: File,
        expectedHash: String,
    ): Boolean {
        val actualHash = calculateSHA256(file)
        val matches = actualHash.equals(expectedHash, ignoreCase = true)

        if (!matches) {
            Log.d("HashUtils", "Hash mismatch - Expected: $expectedHash, Actual: $actualHash")
        }

        return matches
    }
}
