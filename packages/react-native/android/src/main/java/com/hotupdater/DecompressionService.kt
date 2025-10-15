package com.hotupdater

import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.brotli.BrotliCompressorInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

/**
 * Interface for decompression operations
 */
interface DecompressionService {
    /**
     * Extracts an archive file to a destination directory
     * @param filePath Path to the archive file
     * @param destinationPath Directory to extract contents to
     * @param contentEncoding Content-Encoding header value (e.g., "br", "gzip", "identity")
     * @return true if extraction was successful, false otherwise
     */
    fun extractArchive(
        filePath: String,
        destinationPath: String,
        contentEncoding: String?,
    ): Boolean
}

/**
 * Implementation of DecompressionService that supports multiple compression formats
 */
class UniversalDecompressionService : DecompressionService {
    override fun extractArchive(
        filePath: String,
        destinationPath: String,
        contentEncoding: String?,
    ): Boolean =
        try {
            val destinationDir = File(destinationPath)
            if (!destinationDir.exists()) {
                destinationDir.mkdirs()
            }

            when (contentEncoding?.lowercase()) {
                "br", "brotli" -> extractTarBrotli(filePath, destinationPath, destinationDir)
                "gzip" -> extractTarGzip(filePath, destinationPath, destinationDir)
                else -> extractZip(filePath, destinationPath, destinationDir)
            }
            true
        } catch (e: Exception) {
            Log.d("DecompressionService", "Failed to extract archive: ${e.message}")
            false
        }

    /**
     * Extract a ZIP file
     */
    private fun extractZip(
        filePath: String,
        destinationPath: String,
        destinationDir: File,
    ) {
        FileInputStream(filePath).use { fileInputStream ->
            BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                ZipInputStream(bufferedInputStream).use { zipInputStream ->
                    var entry: ZipEntry? = zipInputStream.nextEntry
                    while (entry != null) {
                        val file = File(destinationPath, entry.name)

                        // Validate that the entry path doesn't escape the destination directory
                        if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                            Log.w("DecompressionService", "Skipping potentially malicious zip entry: ${entry.name}")
                            entry = zipInputStream.nextEntry
                            continue
                        }

                        if (entry.isDirectory) {
                            file.mkdirs()
                        } else {
                            file.parentFile?.mkdirs()
                            FileOutputStream(file).use { output ->
                                zipInputStream.copyTo(output)
                            }
                        }
                        zipInputStream.closeEntry()
                        entry = zipInputStream.nextEntry
                    }
                }
            }
        }
    }

    /**
     * Extract a TAR archive compressed with Brotli
     */
    private fun extractTarBrotli(
        filePath: String,
        destinationPath: String,
        destinationDir: File,
    ) {
        FileInputStream(filePath).use { fileInputStream ->
            BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                BrotliCompressorInputStream(bufferedInputStream).use { brotliInputStream ->
                    extractTar(brotliInputStream, destinationPath, destinationDir)
                }
            }
        }
    }

    /**
     * Extract a TAR archive compressed with Gzip
     */
    private fun extractTarGzip(
        filePath: String,
        destinationPath: String,
        destinationDir: File,
    ) {
        FileInputStream(filePath).use { fileInputStream ->
            BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                GzipCompressorInputStream(bufferedInputStream).use { gzipInputStream ->
                    extractTar(gzipInputStream, destinationPath, destinationDir)
                }
            }
        }
    }

    /**
     * Extract a TAR archive from an input stream
     */
    private fun extractTar(
        inputStream: java.io.InputStream,
        destinationPath: String,
        destinationDir: File,
    ) {
        TarArchiveInputStream(inputStream).use { tarInputStream ->
            var entry = tarInputStream.nextTarEntry
            while (entry != null) {
                val file = File(destinationPath, entry.name)

                // Validate that the entry path doesn't escape the destination directory
                if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                    Log.w("DecompressionService", "Skipping potentially malicious tar entry: ${entry.name}")
                    entry = tarInputStream.nextTarEntry
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
                entry = tarInputStream.nextTarEntry
            }
        }
    }
}
