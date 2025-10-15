package com.hotupdater

import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Implementation of UnzipService using Apache Commons Compress for tar+gzip extraction
 * Provides streaming decompression with path traversal protection
 */
class TarGzipUnzipService : UnzipService {
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
                    GzipCompressorInputStream(bufferedInputStream).use { gzipInputStream ->
                        TarArchiveInputStream(gzipInputStream).use { tarInputStream ->
                            var entry = tarInputStream.nextEntry
                            while (entry != null) {
                                val file = File(destinationPath, entry.name)

                                // Validate that the entry path doesn't escape the destination directory
                                // This prevents path traversal attacks (zip slip vulnerability)
                                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                    Log.w(
                                        "TarGzipUnzipService",
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
            Log.d("TarGzipUnzipService", "Successfully extracted tar.gz file")
            true
        } catch (e: Exception) {
            Log.e("TarGzipUnzipService", "Failed to extract tar.gz file: ${e.message}", e)
            false
        }
}
