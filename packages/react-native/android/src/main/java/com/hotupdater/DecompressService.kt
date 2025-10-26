package com.hotupdater

import android.util.Log

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
    private val strategies = listOf(
        ZipDecompressionStrategy(),
        TarGzDecompressionStrategy(),
        TarBrDecompressionStrategy()
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
        progressCallback: (Double) -> Unit
    ): Boolean {
        // Try each strategy's validation
        for (strategy in strategies) {
            if (strategy.isValid(filePath)) {
                Log.d(TAG, "Found valid strategy, delegating to decompression")
                return strategy.decompress(filePath, destinationPath, progressCallback)
            }
        }

        // No valid strategy found
        Log.e(TAG, "No valid decompression strategy found for file: $filePath")
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
