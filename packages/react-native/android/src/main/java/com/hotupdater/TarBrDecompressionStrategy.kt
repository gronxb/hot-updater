package com.hotupdater

import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.BrotliCompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Strategy for handling TAR+Brotli compressed files
 */
class TarBrDecompressionStrategy : DecompressionStrategy {
    companion object {
        private const val TAG = "TarBrStrategy"
        private const val MIN_FILE_SIZE = 10L
    }

    override fun isValid(filePath: String): Boolean {
        val file = File(filePath)

        if (!file.exists() || file.length() < MIN_FILE_SIZE) {
            Log.d(TAG, "Invalid file: doesn't exist or too small (${file.length()} bytes)")
            return false
        }

        // Brotli has no standard magic bytes, check file extension
        val lowercasedPath = filePath.lowercase()
        val isBrotli = lowercasedPath.endsWith(".tar.br") || lowercasedPath.endsWith(".br")

        if (!isBrotli) {
            Log.d(TAG, "Invalid file: not a .tar.br or .br file")
        }

        return isBrotli
    }

    override fun decompress(
        filePath: String,
        destinationPath: String,
        progressCallback: (Double) -> Unit,
    ): Boolean =
        try {
            val destinationDir = File(destinationPath)
            if (!destinationDir.exists()) {
                destinationDir.mkdirs()
            }

            val sourceFile = File(filePath)
            val totalSize = sourceFile.length()
            var processedBytes = 0L

            Log.d(TAG, "Extracting tar.br file: $filePath")

            FileInputStream(filePath).use { fileInputStream ->
                BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                    BrotliCompressorInputStream(bufferedInputStream).use { brotliInputStream ->
                        TarArchiveInputStream(brotliInputStream).use { tarInputStream ->
                            var entry = tarInputStream.nextEntry

                            while (entry != null) {
                                val file = File(destinationPath, entry.name)

                                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                    Log.w(TAG, "Skipping potentially malicious tar entry: ${entry.name}")
                                    entry = tarInputStream.nextEntry
                                    continue
                                }

                                if (entry.isDirectory) {
                                    file.mkdirs()
                                } else {
                                    file.parentFile?.mkdirs()

                                    FileOutputStream(file).use { output ->
                                        val buffer = ByteArray(8 * 1024)
                                        var bytesRead: Int

                                        while (tarInputStream.read(buffer).also { bytesRead = it } != -1) {
                                            output.write(buffer, 0, bytesRead)
                                            processedBytes += bytesRead
                                        }
                                    }
                                }

                                val progress = processedBytes.toDouble() / (totalSize * 2.0)
                                progressCallback.invoke(progress.coerceIn(0.0, 1.0))

                                entry = tarInputStream.nextEntry
                            }
                        }
                    }
                }
            }

            Log.d(TAG, "Successfully extracted tar.br file")
            progressCallback.invoke(1.0)
            true
        } catch (e: Exception) {
            Log.d(TAG, "Failed to extract tar.br file: ${e.message}")
            e.printStackTrace()
            false
        }
}
