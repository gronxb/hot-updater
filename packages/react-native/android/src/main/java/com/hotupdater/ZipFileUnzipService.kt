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
 * Interface for unzip operations
 */
interface UnzipService {
    /**
     * Validates if a file is a valid ZIP file
     * @param filePath Path to the zip file
     * @return true if the file is a valid ZIP, false otherwise
     */
    fun isValidZipFile(filePath: String): Boolean

    /**
     * Extracts a zip file to a destination directory
     * @param filePath Path to the zip file
     * @param destinationPath Directory to extract contents to
     * @param progressCallback Callback for extraction progress updates (0.0 to 1.0)
     * @return true if extraction was successful, false otherwise
     */
    fun extractZipFile(
        filePath: String,
        destinationPath: String,
        progressCallback: (Double) -> Unit,
    ): Boolean
}

/**
 * Implementation of UnzipService using ZipInputStream for 16KB page compatibility
 */
class ZipFileUnzipService : UnzipService {
    companion object {
        private const val TAG = "UnzipService"
        private const val ZIP_MAGIC_NUMBER = 0x504B0304
        private const val MIN_ZIP_SIZE = 22L // Minimum size for a valid ZIP file
    }

    override fun isValidZipFile(filePath: String): Boolean {
        val file = File(filePath)

        // Check if file exists and has minimum size
        if (!file.exists() || file.length() < MIN_ZIP_SIZE) {
            Log.d(TAG, "Invalid ZIP: file doesn't exist or too small (${file.length()} bytes)")
            return false
        }

        // Check ZIP magic number
        try {
            FileInputStream(file).use { fis ->
                val header = ByteArray(4)
                if (fis.read(header) != 4) {
                    Log.d(TAG, "Invalid ZIP: cannot read header")
                    return false
                }

                val magic =
                    ((header[0].toInt() and 0xFF)) or
                        ((header[1].toInt() and 0xFF) shl 8) or
                        ((header[2].toInt() and 0xFF) shl 16) or
                        ((header[3].toInt() and 0xFF) shl 24)

                if (magic != ZIP_MAGIC_NUMBER) {
                    Log.d(TAG, "Invalid ZIP: wrong magic number (0x${magic.toString(16)})")
                    return false
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "Invalid ZIP: error reading file: ${e.message}")
            return false
        }

        // Validate ZIP structure using ZipFile
        try {
            ZipFile(file).use { zipFile ->
                val entries = zipFile.entries()
                if (!entries.hasMoreElements()) {
                    Log.d(TAG, "Invalid ZIP: no entries found")
                    return false
                }

                // Try to read the first entry to verify integrity
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

            // First, count total entries for progress tracking
            val totalEntries =
                try {
                    ZipFile(File(filePath)).use { zipFile ->
                        zipFile.entries().asSequence().count()
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "Failed to count entries: ${e.message}")
                    0
                }

            if (totalEntries == 0) {
                Log.d(TAG, "No entries found in ZIP")
                return false
            }

            Log.d(TAG, "Extracting $totalEntries entries from ZIP")

            var extractedFileCount = 0
            var processedEntries = 0

            FileInputStream(filePath).use { fileInputStream ->
                BufferedInputStream(fileInputStream).use { bufferedInputStream ->
                    ZipInputStream(bufferedInputStream).use { zipInputStream ->
                        var entry: ZipEntry? = zipInputStream.nextEntry
                        while (entry != null) {
                            val file = File(destinationPath, entry.name)

                            // Validate that the entry path doesn't escape the destination directory
                            if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                Log.w(TAG, "Skipping potentially malicious zip entry: ${entry.name}")
                                entry = zipInputStream.nextEntry
                                processedEntries++
                                continue
                            }

                            if (entry.isDirectory) {
                                file.mkdirs()
                            } else {
                                file.parentFile?.mkdirs()

                                // Extract with CRC verification
                                val crc = CRC32()
                                FileOutputStream(file).use { output ->
                                    val buffer = ByteArray(8 * 1024)
                                    var bytesRead: Int

                                    while (zipInputStream.read(buffer).also { bytesRead = it } != -1) {
                                        output.write(buffer, 0, bytesRead)
                                        crc.update(buffer, 0, bytesRead)
                                    }
                                }

                                // Verify CRC if entry has CRC value
                                if (entry.crc != -1L && crc.value != entry.crc) {
                                    Log.w(TAG, "CRC mismatch for ${entry.name}: expected ${entry.crc}, got ${crc.value}")
                                    file.delete()
                                    return false
                                }

                                extractedFileCount++
                            }

                            zipInputStream.closeEntry()
                            processedEntries++

                            // Update progress
                            val progress = processedEntries.toDouble() / totalEntries
                            progressCallback.invoke(progress)

                            entry = zipInputStream.nextEntry
                        }
                    }
                }
            }

            if (extractedFileCount == 0) {
                Log.d(TAG, "No files extracted from ZIP")
                return false
            }

            Log.d(TAG, "Successfully extracted $extractedFileCount files")
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
