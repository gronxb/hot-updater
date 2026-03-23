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

    // Strategies with reliable file signatures that can be validated cheaply.
    // TAR.BR is attempted only as the final fallback because Brotli has no reliable magic bytes.
    private val signatureStrategies =
        listOf(
            ZipDecompressionStrategy(),
            TarGzDecompressionStrategy(),
        )
    private val tarBrStrategy = TarBrDecompressionStrategy()

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

        // Try each signature-based strategy first.
        for (strategy in signatureStrategies) {
            if (strategy.isValid(filePath)) {
                Log.d(TAG, "Using strategy for $fileName")
                return strategy.decompress(filePath, destinationPath, progressCallback)
            }
        }

        Log.d(TAG, "No ZIP/TAR.GZ signature matched for $fileName, trying TAR.BR fallback")

        if (tarBrStrategy.decompress(filePath, destinationPath, progressCallback)) {
            Log.d(TAG, "Using TAR.BR fallback for $fileName")
            return true
        }

        val errorMessage = createInvalidArchiveMessage(fileName, fileSize)
        Log.e(TAG, errorMessage)
        return false
    }

    /**
     * Validates if a file matches one of the signature-based archive formats.
     * @param filePath Path to the file to validate
     * @return true if the file is a valid compressed archive
     */
    fun isValidZipFile(filePath: String): Boolean {
        for (strategy in signatureStrategies) {
            if (strategy.isValid(filePath)) {
                return true
            }
        }
        Log.d(TAG, "No ZIP/TAR.GZ signature matched for file: $filePath. TAR.BR is handled during extraction fallback.")
        return false
    }

    private fun createInvalidArchiveMessage(
        fileName: String,
        fileSize: Long,
    ): String =
        """
        The downloaded bundle file is not a valid compressed archive: $fileName ($fileSize bytes)

        Supported formats:
        - ZIP archives (.zip)
        - GZIP compressed TAR archives (.tar.gz)
        - Brotli compressed TAR archives (.tar.br)
        """.trimIndent()
}
