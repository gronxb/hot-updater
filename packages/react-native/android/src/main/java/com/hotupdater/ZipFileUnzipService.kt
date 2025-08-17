package com.hotupdater

import android.util.Log
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

/**
 * Interface for unzip operations
 */
interface UnzipService {
    /**
     * Extracts a zip file to a destination directory
     * @param filePath Path to the zip file
     * @param destinationPath Directory to extract contents to
     * @return true if extraction was successful, false otherwise
     */
    fun extractZipFile(
        filePath: String,
        destinationPath: String,
    ): Boolean
}

/**
 * Implementation of UnzipService using ZipInputStream for 16KB page compatibility
 */
class ZipFileUnzipService : UnzipService {
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
                    ZipInputStream(bufferedInputStream).use { zipInputStream ->
                        var entry: ZipEntry? = zipInputStream.nextEntry
                        while (entry != null) {
                            val file = File(destinationPath, entry.name)

                            // Validate that the entry path doesn't escape the destination directory
                            if (!file.canonicalPath.startsWith(destinationDir.canonicalPath)) {
                                Log.w("UnzipService", "Skipping potentially malicious zip entry: ${entry.name}")
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
            true
        } catch (e: Exception) {
            Log.d("UnzipService", "Failed to unzip file: ${e.message}")
            false
        }
}
