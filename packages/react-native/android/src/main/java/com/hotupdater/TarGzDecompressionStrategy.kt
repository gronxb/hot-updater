package com.hotupdater

import android.util.Log
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.GZIPInputStream

/**
 * Strategy for handling TAR+GZIP compressed files
 * Uses native GZIP decoder and custom TAR parser
 */
class TarGzDecompressionStrategy : DecompressionStrategy {
    companion object {
        private const val TAG = "TarGzStrategy"
        private const val MIN_FILE_SIZE = 10L
    }

    override fun isValid(filePath: String): Boolean {
        val file = File(filePath)

        if (!file.exists() || file.length() < MIN_FILE_SIZE) {
            Log.d(TAG, "Invalid file: doesn't exist or too small (${file.length()} bytes)")
            return false
        }

        try {
            FileInputStream(file).use { fis ->
                val header = ByteArray(2)
                if (fis.read(header) != 2) {
                    Log.d(TAG, "Invalid file: cannot read header")
                    return false
                }

                // Check GZIP magic bytes (0x1F 0x8B)
                val isGzip = header[0] == 0x1F.toByte() && header[1] == 0x8B.toByte()
                if (!isGzip) {
                    Log.d(
                        TAG,
                        "Invalid file: wrong magic bytes (expected 0x1F 0x8B, got 0x${header[0].toString(16)} 0x${header[1].toString(16)})",
                    )
                }
                return isGzip
            }
        } catch (e: Exception) {
            Log.d(TAG, "Invalid file: error reading header: ${e.message}")
            return false
        }
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

            Log.d(TAG, "Extracting tar.gz file: $filePath")

            FileInputStream(filePath).use { fileInputStream ->
                BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                    GZIPInputStream(bufferedInputStream).use { gzipInputStream ->
                        TarArchiveInputStream(gzipInputStream).use { tarInputStream ->
                            var entry = tarInputStream.getNextEntry()

                            while (entry != null) {
                                val file = File(destinationPath, entry.name)

                                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                    Log.w(TAG, "Skipping potentially malicious tar entry: ${entry.name}")
                                    entry = tarInputStream.getNextEntry()
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

                                entry = tarInputStream.getNextEntry()
                            }
                        }
                    }
                }
            }

            Log.d(TAG, "Successfully extracted tar.gz file")
            progressCallback.invoke(1.0)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error extracting tar.gz file: ${e.message}", e)
            false
        }
}
