package com.hotupdater

import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.brotli.dec.BrotliInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Implementation of UnzipService for tar.br (TAR with Brotli compression) files
 */
class TarBrUnzipService : UnzipService {
    companion object {
        private const val TAG = "TarBrUnzipService"
        private const val MIN_FILE_SIZE = 10L
    }

    override fun isValidZipFile(filePath: String): Boolean {
        val file = File(filePath)

        // Check if file exists and has minimum size
        if (!file.exists() || file.length() < MIN_FILE_SIZE) {
            Log.d(TAG, "Invalid file: doesn't exist or too small (${file.length()} bytes)")
            return false
        }

        // Try to validate by attempting to read the Brotli header
        try {
            FileInputStream(file).use { fis ->
                BufferedInputStream(fis).use { bis ->
                    BrotliInputStream(bis).use { brotli ->
                        // Try to read a small amount to validate
                        val buffer = ByteArray(100)
                        brotli.read(buffer)
                    }
                }
            }
            return true
        } catch (e: Exception) {
            Log.d(TAG, "Invalid file: not a valid Brotli compressed file: ${e.message}")
            return false
        }
    }

    override fun extractZipFile(
        filePath: String,
        destinationPath: String,
        progressCallback: (Double) -> Unit,
    ): Boolean {
        return try {
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
                    // Decompress Brotli
                    BrotliInputStream(bufferedInputStream).use { brotliInputStream ->
                        // Extract TAR
                        TarArchiveInputStream(brotliInputStream).use { tarInputStream ->
                            var entry = tarInputStream.nextEntry

                            while (entry != null) {
                                val file = File(destinationPath, entry.name)

                                // Validate that the entry path doesn't escape the destination directory
                                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                    Log.w(TAG, "Skipping potentially malicious tar entry: ${entry.name}")
                                    entry = tarInputStream.nextEntry
                                    continue
                                }

                                if (entry.isDirectory) {
                                    file.mkdirs()
                                } else {
                                    file.parentFile?.mkdirs()

                                    // Extract file
                                    FileOutputStream(file).use { output ->
                                        val buffer = ByteArray(8 * 1024)
                                        var bytesRead: Int

                                        while (tarInputStream.read(buffer).also { bytesRead = it } != -1) {
                                            output.write(buffer, 0, bytesRead)
                                            processedBytes += bytesRead
                                        }
                                    }
                                }

                                // Update progress (estimate based on processed bytes)
                                val progress = processedBytes.toDouble() / (totalSize * 2.0) // Rough estimate
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
}
