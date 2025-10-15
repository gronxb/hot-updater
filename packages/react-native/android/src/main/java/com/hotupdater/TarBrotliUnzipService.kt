package com.hotupdater

import android.util.Log
import com.aayushatharva.brotli4j.Brotli4jLoader
import com.aayushatharva.brotli4j.decoder.BrotliInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Implementation of UnzipService using Apache Commons Compress and Brotli4j for tar+brotli extraction
 * Provides streaming decompression with path traversal protection
 */
class TarBrotliUnzipService : UnzipService {
    init {
        // Ensure Brotli native library is loaded
        try {
            Brotli4jLoader.ensureAvailability()
        } catch (e: Exception) {
            Log.e("TarBrotliUnzipService", "Failed to load Brotli4j library: ${e.message}", e)
        }
    }

    override fun extractZipFile(
        filePath: String,
        destinationPath: String,
    ): Boolean =
        try {
            val destinationDir = File(destinationPath)
            if (!destinationDir.exists()) {
                destinationDir.mkdirs()
            }

            FileInputStream(filePath).use { fileInputStream ->
                BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                    BrotliInputStream(bufferedInputStream).use { brotliInputStream ->
                        TarArchiveInputStream(brotliInputStream).use { tarInputStream ->
                            var entry = tarInputStream.nextEntry
                            while (entry != null) {
                                val file = File(destinationPath, entry.name)

                                // Validate that the entry path doesn't escape the destination directory
                                // This prevents path traversal attacks (zip slip vulnerability)
                                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                    Log.w(
                                        "TarBrotliUnzipService",
                                        "Skipping potentially malicious tar entry: ${entry.name}",
                                    )
                                    entry = tarInputStream.nextEntry
                                    continue
                                }

                                if (entry.isDirectory) {
                                    file.mkdirs()
                                } else {
                                    file.parentFile?.mkdirs()
                                    FileOutputStream(file).use { output ->
                                        tarInputStream.copyTo(output)
                                    }
                                }
                                entry = tarInputStream.nextEntry
                            }
                        }
                    }
                }
            }
            Log.d("TarBrotliUnzipService", "Successfully extracted tar.br file")
            true
        } catch (e: Exception) {
            Log.e("TarBrotliUnzipService", "Failed to extract tar.br file: ${e.message}", e)
            false
        }
}
