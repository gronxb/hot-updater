package com.hotupdater

import android.util.Log
import java.io.File
import java.util.zip.ZipFile

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
 * Implementation of UnzipService using standard Zip API
 */
class ZipFileUnzipService : UnzipService {
    override fun extractZipFile(
        filePath: String,
        destinationPath: String,
    ): Boolean =
        try {
            ZipFile(filePath).use { zip ->
                zip.entries().asSequence().forEach { entry ->
                    val file = File(destinationPath, entry.name)
                    if (entry.isDirectory) {
                        file.mkdirs()
                    } else {
                        file.parentFile?.mkdirs()
                        zip.getInputStream(entry).use { input ->
                            file.outputStream().use { output ->
                                input.copyTo(output)
                            }
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
