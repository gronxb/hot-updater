package com.hotupdater

import android.util.Log
import java.io.File

/**
 * Unified decompression service that uses Strategy pattern to handle multiple compression formats.
 * Automatically detects format by trying each strategy's validation and delegates to appropriate decompression strategy.
 */
class DecompressService {
    companion object {
        private const val TAG = "DecompressService"
    }

    // Array of available strategies in order of detection priority
    // Order matters: Try ZIP first (clear magic bytes), then TAR.GZ (GZIP magic bytes), then TAR.BR (fallback)
    private val strategies =
        listOf(
            ZipDecompressionStrategy(),
            TarGzDecompressionStrategy(),
            TarBrDecompressionStrategy(),
        )

    /**
     * Extracts a compressed file to the destination directory.
     * Automatically detects compression format by trying each strategy's validation.
     * @param filePath Path to the compressed file
     * @param destinationPath Path to the destination directory
     * @param progressCallback Callback for progress updates (0.0 - 1.0)
     * @return true if extraction was successful, false otherwise
     */
    fun extractZipFile(
        filePath: String,
        destinationPath: String,
        progressCallback: (Double) -> Unit,
    ): Boolean {
        // Collect file information for better error messages
        val file = File(filePath)
        val fileName = file.name
        val fileSize = if (file.exists()) file.length() else 0L

        // Try each strategy's validation
        for (strategy in strategies) {
            if (strategy.isValid(filePath)) {
                Log.d(TAG, "Using strategy for $fileName")
                return strategy.decompress(filePath, destinationPath, progressCallback)
            }
        }

        // No valid strategy found - provide detailed error message
        val errorMessage =
            """
            Failed to decompress file: $fileName ($fileSize bytes)

            Tried strategies: ZIP (magic bytes 0x504B0304), TAR.GZ (magic bytes 0x1F8B), TAR.BR (file extension)

            Supported formats:
            - ZIP archives (.zip)
            - GZIP compressed TAR archives (.tar.gz)
            - Brotli compressed TAR archives (.tar.br)

            Please verify the file is not corrupted and matches one of the supported formats.
            """.trimIndent()

        Log.e(TAG, errorMessage)
        return false
    }

    /**
     * Validates if a file is a valid compressed archive.
     * @param filePath Path to the file to validate
     * @return true if the file is a valid compressed archive
     */
    fun isValidZipFile(filePath: String): Boolean {
        for (strategy in strategies) {
            if (strategy.isValid(filePath)) {
                return true
            }
        }
        Log.d(TAG, "No valid strategy found for file: $filePath")
        return false
    }
}
