package com.hotupdater

import android.util.Log
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

/**
 * Strategy for handling ZIP compressed files
 */
class ZipDecompressionStrategy : DecompressionStrategy {
    companion object {
        private const val TAG = "ZipStrategy"
        private const val MIN_ZIP_SIZE = 22L
    }

    override fun isValid(filePath: String): Boolean {
        val file = File(filePath)

        if (!file.exists() || file.length() < MIN_ZIP_SIZE) {
            Log.d(TAG, "Invalid ZIP: file doesn't exist or too small (${file.length()} bytes)")
            return false
        }

        try {
            FileInputStream(file).use { fis ->
                val header = ByteArray(4)
                if (fis.read(header) != 4) {
                    Log.d(TAG, "Invalid ZIP: cannot read header")
                    return false
                }

                // ZIP magic bytes: 0x50 0x4B 0x03 0x04 ("PK\u0003\u0004")
                val expectedMagic = byteArrayOf(0x50.toByte(), 0x4B.toByte(), 0x03.toByte(), 0x04.toByte())

                if (!header.contentEquals(expectedMagic)) {
                    val headerHex = header.joinToString(" ") { "0x%02X".format(it) }
                    Log.d(TAG, "Invalid ZIP: wrong magic bytes (expected 0x50 0x4B 0x03 0x04, got $headerHex)")
                    return false
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "Invalid ZIP: error reading file: ${e.message}")
            return false
        }

        try {
            ZipFile(file).use { zipFile ->
                val entries = zipFile.entries()
                if (!entries.hasMoreElements()) {
                    Log.d(TAG, "Invalid ZIP: no entries found")
                    return false
                }

                val firstEntry = entries.nextElement()
                zipFile.getInputStream(firstEntry).use { stream ->
                    val buffer = ByteArray(1024)
                    stream.read(buffer)
                }
            }
            return true
        } catch (e: ZipException) {
            Log.d(TAG, "Invalid ZIP: ZIP structure error: ${e.message}")
            return false
        } catch (e: Exception) {
            Log.d(TAG, "Invalid ZIP: validation error: ${e.message}")
            return false
        }
    }

    override fun decompress(
        filePath: String,
        destinationPath: String,
        progressCallback: (Double) -> Unit,
    ): Boolean {
        return try {
            val destinationDir = File(destinationPath)
            if (!destinationDir.exists()) {
                destinationDir.mkdirs()
            }

            // Calculate total bytes to extract for accurate progress reporting
            val totalBytes =
                try {
                    ZipFile(File(filePath)).use { zipFile ->
                        zipFile
                            .entries()
                            .asSequence()
                            .filter { !it.isDirectory }
                            .sumOf { it.size }
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "Failed to calculate total bytes: ${e.message}")
                    0L
                }

            if (totalBytes == 0L) {
                Log.d(TAG, "No content found in ZIP")
                return false
            }

            Log.d(TAG, "Extracting $totalBytes bytes from ZIP")

            var extractedFileCount = 0
            var extractedBytes = 0L
            var lastReportedProgress = 0.0

            FileInputStream(filePath).use { fileInputStream ->
                BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                    ZipInputStream(bufferedInputStream).use { zipInputStream ->
                        var entry: ZipEntry? = zipInputStream.nextEntry
                        while (entry != null) {
                            val file = File(destinationPath, entry.name)

                            // Zip Slip vulnerability check - verify entry path is within destination
                            try {
                                val canonicalDestPath = destinationDir.canonicalPath
                                val canonicalFilePath = file.canonicalPath

                                if (!canonicalFilePath.startsWith(canonicalDestPath)) {
                                    Log.w(TAG, "Skipping potentially malicious zip entry: ${entry.name}")
                                    entry = zipInputStream.nextEntry
                                    continue
                                }
                            } catch (e: IOException) {
                                // If we can't resolve canonical paths, treat as potentially malicious
                                Log.w(TAG, "Failed to resolve canonical path for zip entry: ${entry.name}", e)
                                entry = zipInputStream.nextEntry
                                continue
                            }

                            if (entry.isDirectory) {
                                file.mkdirs()
                            } else {
                                file.parentFile?.mkdirs()

                                val crc = CRC32()
                                FileOutputStream(file).use { output ->
                                    val buffer = ByteArray(8 * 1024)
                                    var bytesRead: Int

                                    while (zipInputStream.read(buffer).also { bytesRead = it } != -1) {
                                        output.write(buffer, 0, bytesRead)
                                        crc.update(buffer, 0, bytesRead)

                                        // Track bytes written for byte-based progress
                                        extractedBytes += bytesRead

                                        // Report progress more frequently (every 1%)
                                        val currentProgress = extractedBytes.toDouble() / totalBytes
                                        if (currentProgress - lastReportedProgress >= 0.01) {
                                            progressCallback.invoke(currentProgress)
                                            lastReportedProgress = currentProgress
                                        }
                                    }
                                }

                                if (entry.crc != -1L && crc.value != entry.crc) {
                                    Log.w(TAG, "CRC mismatch for ${entry.name}: expected ${entry.crc}, got ${crc.value}")
                                    file.delete()
                                    return false
                                }

                                extractedFileCount++
                            }

                            zipInputStream.closeEntry()
                            entry = zipInputStream.nextEntry
                        }
                    }
                }
            }

            if (extractedFileCount == 0) {
                Log.d(TAG, "No files extracted from ZIP")
                return false
            }

            Log.d(TAG, "Successfully extracted $extractedFileCount files ($extractedBytes bytes)")
            progressCallback.invoke(1.0)
            true
        } catch (e: ZipException) {
            Log.d(TAG, "ZIP extraction failed: ${e.message}")
            false
        } catch (e: Exception) {
            Log.d(TAG, "Failed to unzip file: ${e.message}")
            false
        }
    }
}
