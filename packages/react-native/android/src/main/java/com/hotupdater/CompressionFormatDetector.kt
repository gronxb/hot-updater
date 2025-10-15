package com.hotupdater

import android.util.Log
import java.io.File
import java.io.FileInputStream

/**
 * Enum representing supported compression formats
 */
enum class CompressionFormat {
    ZIP,
    TAR_GZIP,
    TAR_BROTLI,
    UNKNOWN,
}

/**
 * Utility class to detect compression format based on file magic bytes
 */
object CompressionFormatDetector {
    // Magic bytes for format detection
    private const val ZIP_MAGIC_1 = 0x50.toByte() // 'P'
    private const val ZIP_MAGIC_2 = 0x4B.toByte() // 'K'
    private const val ZIP_MAGIC_3 = 0x03.toByte()
    private const val ZIP_MAGIC_4 = 0x04.toByte()

    private const val GZIP_MAGIC_1 = 0x1F.toByte()
    private const val GZIP_MAGIC_2 = 0x8B.toByte()

    /**
     * Detects the compression format of a file by reading its magic bytes
     * @param filePath Path to the file to detect
     * @return CompressionFormat enum value
     */
    fun detectFormat(filePath: String): CompressionFormat {
        return try {
            val file = File(filePath)
            if (!file.exists() || !file.isFile) {
                Log.w("CompressionFormatDetector", "File does not exist or is not a file: $filePath")
                return CompressionFormat.UNKNOWN
            }

            FileInputStream(file).use { inputStream ->
                val magicBytes = ByteArray(4)
                val bytesRead = inputStream.read(magicBytes)

                if (bytesRead < 2) {
                    Log.w("CompressionFormatDetector", "File too small to detect format: $filePath")
                    return CompressionFormat.UNKNOWN
                }

                // Check for ZIP format (PK..)
                if (
                    magicBytes[0] == ZIP_MAGIC_1 &&
                    magicBytes[1] == ZIP_MAGIC_2 &&
                    magicBytes[2] == ZIP_MAGIC_3 &&
                    magicBytes[3] == ZIP_MAGIC_4
                ) {
                    Log.d("CompressionFormatDetector", "Detected ZIP format for: $filePath")
                    return CompressionFormat.ZIP
                }

                // Check for GZIP format (0x1F8B)
                if (magicBytes[0] == GZIP_MAGIC_1 && magicBytes[1] == GZIP_MAGIC_2) {
                    Log.d("CompressionFormatDetector", "Detected TAR+GZIP format for: $filePath")
                    return CompressionFormat.TAR_GZIP
                }

                // If no recognized magic bytes, assume Brotli (no standard magic bytes)
                // In a production environment, you might want to check file extension or metadata
                Log.d(
                    "CompressionFormatDetector",
                    "Assuming TAR+BROTLI format (no standard magic bytes) for: $filePath",
                )
                return CompressionFormat.TAR_BROTLI
            }
        } catch (e: Exception) {
            Log.e("CompressionFormatDetector", "Error detecting format for $filePath: ${e.message}", e)
            CompressionFormat.UNKNOWN
        }
    }

    /**
     * Gets the appropriate UnzipService implementation for a given format
     * @param format The compression format
     * @return UnzipService instance or null if format is unknown
     */
    fun getUnzipService(format: CompressionFormat): UnzipService? = when (format) {
        CompressionFormat.ZIP -> ZipFileUnzipService()
        CompressionFormat.TAR_GZIP -> TarGzipUnzipService()
        CompressionFormat.TAR_BROTLI -> TarBrotliUnzipService()
        CompressionFormat.UNKNOWN -> {
            Log.e("CompressionFormatDetector", "Cannot create UnzipService for UNKNOWN format")
            null
        }
    }

    /**
     * Detects format and returns the appropriate UnzipService
     * @param filePath Path to the compressed file
     * @return UnzipService instance or null if format cannot be detected
     */
    fun getUnzipServiceForFile(filePath: String): UnzipService? {
        val format = detectFormat(filePath)
        return getUnzipService(format)
    }
}
