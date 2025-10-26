package com.hotupdater

/**
 * Interface for decompression strategies
 */
interface DecompressionStrategy {
    /**
     * Validates if a file can be decompressed by this strategy
     * @param filePath Path to the file to validate
     * @return true if the file is valid for this strategy
     */
    fun isValid(filePath: String): Boolean

    /**
     * Decompresses a file to the destination directory
     * @param filePath Path to the compressed file
     * @param destinationPath Path to the destination directory
     * @param progressCallback Callback for progress updates (0.0 - 1.0)
     * @return true if decompression was successful, false otherwise
     */
    fun decompress(
        filePath: String,
        destinationPath: String,
        progressCallback: (Double) -> Unit
    ): Boolean
}
