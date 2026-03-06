package com.hotupdater

import android.content.Context
import java.io.File
import java.nio.file.Files

/**
 * Interface for file system operations
 */
interface FileSystemService {
    /**
     * Checks if a file exists at the given path
     */
    fun fileExists(path: String): Boolean

    /**
     * Creates directory at the given path, including any necessary parent directories
     */
    fun createDirectory(path: String): Boolean

    /**
     * Removes a file or directory at the given path
     */
    fun removeItem(path: String): Boolean

    /**
     * Moves a file or directory from source path to destination path
     */
    fun moveItem(
        sourcePath: String,
        destinationPath: String,
    ): Boolean

    /**
     * Copies a file or directory from source path to destination path
     */
    fun copyItem(
        sourcePath: String,
        destinationPath: String,
    ): Boolean

    /**
     * Creates a hard link from source file to destination file
     */
    fun linkItem(
        sourcePath: String,
        destinationPath: String,
    ): Boolean

    /**
     * Lists the contents of a directory
     */
    fun contentsOfDirectory(path: String): List<String>

    /**
     * Gets the external files directory for the application
     */
    fun getExternalFilesDir(): File?
}

/**
 * Implementation of FileSystemService using standard File API
 */
class FileManagerService(
    private val context: Context,
) : FileSystemService {
    override fun fileExists(path: String): Boolean = File(path).exists()

    override fun createDirectory(path: String): Boolean {
        val directory = File(path)
        return (directory.exists() && directory.isDirectory) || directory.mkdirs()
    }

    override fun removeItem(path: String): Boolean {
        val target = File(path)
        if (!target.exists()) {
            return true
        }
        return target.deleteRecursively()
    }

    override fun moveItem(
        sourcePath: String,
        destinationPath: String,
    ): Boolean {
        val source = File(sourcePath)
        val destination = File(destinationPath)

        return try {
            if (!source.exists()) {
                return false
            }

            destination.parentFile?.mkdirs()
            if (destination.exists() && !destination.deleteRecursively()) {
                return false
            }

            if (source.renameTo(destination)) {
                return true
            }

            source.copyRecursively(target = destination, overwrite = true)
            source.deleteRecursively()
        } catch (e: Exception) {
            false
        }
    }

    override fun copyItem(
        sourcePath: String,
        destinationPath: String,
    ): Boolean {
        val source = File(sourcePath)
        val destination = File(destinationPath)

        return try {
            if (!source.exists()) {
                return false
            }

            destination.parentFile?.mkdirs()
            if (destination.exists() && !destination.deleteRecursively()) {
                return false
            }
            source.copyRecursively(target = destination, overwrite = true)
        } catch (e: Exception) {
            false
        }
    }

    override fun linkItem(
        sourcePath: String,
        destinationPath: String,
    ): Boolean {
        val source = File(sourcePath)
        val destination = File(destinationPath)

        return try {
            if (!source.exists() || !source.isFile) {
                return false
            }

            destination.parentFile?.mkdirs()
            if (destination.exists()) {
                destination.delete()
            }

            Files.createLink(destination.toPath(), source.toPath())
            true
        } catch (_: Exception) {
            false
        }
    }

    override fun contentsOfDirectory(path: String): List<String> {
        val directory = File(path)
        return directory.listFiles()?.map { it.name } ?: listOf()
    }

    override fun getExternalFilesDir(): File? = context.getExternalFilesDir(null)
}
