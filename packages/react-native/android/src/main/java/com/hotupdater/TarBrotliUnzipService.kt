package com.hotupdater

import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.brotli.dec.BrotliInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Implementation of UnzipService for tar.br (TAR + Brotli) archives
 */
class TarBrotliUnzipService : UnzipService {
    companion object {
        private const val TAG = "TarBrotliUnzipService"
        private const val BROTLI_MAGIC_NUMBER = 0xCE
    }

    override fun isValidZipFile(filePath: String): Boolean {
        val file = File(filePath)

        // Check if file exists and has minimum size
        if (!file.exists() || file.length() < 10) {
            Log.d(TAG, "Invalid TAR.BR: file doesn't exist or too small (${file.length()} bytes)")
            return false
        }

        // Check Brotli magic number (first byte should be 0xCE for some Brotli streams)
        // Note: Brotli doesn't have a fixed magic number, but we can try to decompress
        try {
            FileInputStream(file).use { fis ->
                BufferedInputStream(fis).use { bis ->
                    BrotliInputStream(bis).use { brotli ->
                        TarArchiveInputStream(brotli).use { tar ->
                            // Try to read the first entry
                            val firstEntry = tar.nextEntry
                            if (firstEntry == null) {
                                Log.d(TAG, "Invalid TAR.BR: no entries found")
                                return false
                            }
                            // Successfully read first entry
                            return true
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "Invalid TAR.BR: validation error: ${e.message}")
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

            // First pass: count total entries for progress tracking
            val totalEntries =
                try {
                    FileInputStream(filePath).use { fis ->
                        BufferedInputStream(fis).use { bis ->
                            BrotliInputStream(bis).use { brotli ->
                                TarArchiveInputStream(brotli).use { tar ->
                                    var count = 0
                                    while (tar.nextEntry != null) {
                                        count++
                                    }
                                    count
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "Failed to count entries: ${e.message}")
                    0
                }

            if (totalEntries == 0) {
                Log.d(TAG, "No entries found in TAR.BR")
                return false
            }

            Log.d(TAG, "Extracting $totalEntries entries from TAR.BR")

            var extractedFileCount = 0
            var processedEntries = 0

            // Second pass: extract files
            FileInputStream(filePath).use { fis ->
                BufferedInputStream(fis).use { bis ->
                    BrotliInputStream(bis).use { brotli ->
                        TarArchiveInputStream(brotli).use { tar ->
                            var entry: TarArchiveEntry? = tar.nextEntry
                            while (entry != null) {
                                val file = File(destinationPath, entry.name)

                                // Validate that the entry path doesn't escape the destination directory
                                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                    Log.w(TAG, "Skipping potentially malicious tar entry: ${entry.name}")
                                    entry = tar.nextEntry
                                    processedEntries++
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

                                        while (tar.read(buffer).also { bytesRead = it } != -1) {
                                            output.write(buffer, 0, bytesRead)
                                        }
                                    }

                                    extractedFileCount++
                                }

                                processedEntries++

                                // Update progress
                                val progress = processedEntries.toDouble() / totalEntries
                                progressCallback.invoke(progress)

                                entry = tar.nextEntry
                            }
                        }
                    }
                }
            }

            if (extractedFileCount == 0) {
                Log.d(TAG, "No files extracted from TAR.BR")
                return false
            }

            Log.d(TAG, "Successfully extracted $extractedFileCount files")
            progressCallback.invoke(1.0)
            true
        } catch (e: Exception) {
            Log.d(TAG, "TAR.BR extraction failed: ${e.message}")
            e.printStackTrace()
            false
        }
    }
}
