package com.hotupdater.mocks

import com.hotupdater.FileSystemService
import java.io.File

/**
 * Mock implementation of FileSystemService for testing.
 *
 * This implementation operates on an in-memory file system representation
 * or can work with actual temporary files, depending on the test requirements.
 * It tracks all operations for verification in tests.
 *
 * @param useRealFileSystem If true, uses actual file operations on disk.
 *                          If false, simulates operations in memory only.
 *
 * @example
 * ```kotlin
 * @Test
 * fun testFileOperations() {
 *     val fs = MockFileSystemService(useRealFileSystem = false)
 *     fs.createDirectory("/test")
 *     assertTrue(fs.fileExists("/test"))
 * }
 * ```
 */
class MockFileSystemService(
  private val useRealFileSystem: Boolean = false,
  private val baseDir: File? = null,
) : FileSystemService {
  private val virtualFiles = mutableSetOf<String>()
  private val virtualDirectories = mutableSetOf<String>()
  private val operations = mutableListOf<String>()

  /**
   * Checks if a file exists at the given path.
   */
  override fun fileExists(path: String): Boolean {
    operations.add("fileExists($path)")
    return if (useRealFileSystem) {
      File(path).exists()
    } else {
      virtualFiles.contains(path) || virtualDirectories.contains(path)
    }
  }

  /**
   * Creates directory at the given path, including any necessary parent directories.
   */
  override fun createDirectory(path: String): Boolean {
    operations.add("createDirectory($path)")
    return if (useRealFileSystem) {
      try {
        File(path).mkdirs()
      } catch (e: Exception) {
        false
      }
    } else {
      virtualDirectories.add(path)
      true
    }
  }

  /**
   * Removes a file or directory at the given path.
   */
  override fun removeItem(path: String): Boolean {
    operations.add("removeItem($path)")
    return if (useRealFileSystem) {
      try {
        File(path).deleteRecursively()
      } catch (e: Exception) {
        false
      }
    } else {
      virtualFiles.remove(path) || virtualDirectories.remove(path)
    }
  }

  /**
   * Moves a file or directory from source path to destination path.
   */
  override fun moveItem(
    sourcePath: String,
    destinationPath: String,
  ): Boolean {
    operations.add("moveItem($sourcePath, $destinationPath)")
    return if (useRealFileSystem) {
      try {
        val source = File(sourcePath)
        val destination = File(destinationPath)
        if (destination.exists()) {
          destination.deleteRecursively()
        }
        source.renameTo(destination)
      } catch (e: Exception) {
        false
      }
    } else {
      if (virtualFiles.contains(sourcePath)) {
        virtualFiles.remove(sourcePath)
        virtualFiles.add(destinationPath)
        true
      } else if (virtualDirectories.contains(sourcePath)) {
        virtualDirectories.remove(sourcePath)
        virtualDirectories.add(destinationPath)
        true
      } else {
        false
      }
    }
  }

  /**
   * Copies a file or directory from source path to destination path.
   */
  override fun copyItem(
    sourcePath: String,
    destinationPath: String,
  ): Boolean {
    operations.add("copyItem($sourcePath, $destinationPath)")
    return if (useRealFileSystem) {
      try {
        val source = File(sourcePath)
        val destination = File(destinationPath)
        if (destination.exists()) {
          destination.deleteRecursively()
        }
        source.copyRecursively(target = destination, overwrite = true)
      } catch (e: Exception) {
        false
      }
    } else {
      if (virtualFiles.contains(sourcePath)) {
        virtualFiles.add(destinationPath)
        true
      } else if (virtualDirectories.contains(sourcePath)) {
        virtualDirectories.add(destinationPath)
        true
      } else {
        false
      }
    }
  }

  /**
   * Lists the contents of a directory.
   */
  override fun contentsOfDirectory(path: String): List<String> {
    operations.add("contentsOfDirectory($path)")
    return if (useRealFileSystem) {
      val directory = File(path)
      directory.listFiles()?.map { it.name } ?: listOf()
    } else {
      val prefix = if (path.endsWith("/")) path else "$path/"
      val contents = mutableSetOf<String>()

      virtualFiles.forEach { file ->
        if (file.startsWith(prefix)) {
          val relativePath = file.removePrefix(prefix)
          val firstSegment = relativePath.split("/").firstOrNull()
          if (firstSegment != null && firstSegment.isNotEmpty()) {
            contents.add(firstSegment)
          }
        }
      }

      virtualDirectories.forEach { dir ->
        if (dir.startsWith(prefix) && dir != path) {
          val relativePath = dir.removePrefix(prefix)
          val firstSegment = relativePath.split("/").firstOrNull()
          if (firstSegment != null && firstSegment.isNotEmpty()) {
            contents.add(firstSegment)
          }
        }
      }

      contents.toList()
    }
  }

  /**
   * Gets the external files directory for the application.
   */
  override fun getExternalFilesDir(): File? {
    operations.add("getExternalFilesDir()")
    return if (useRealFileSystem) {
      baseDir ?: File.createTempFile("test", "").parentFile
    } else {
      baseDir
    }
  }

  /**
   * Test utility: Gets the list of operations performed.
   *
   * @return List of operation strings
   */
  fun getOperations(): List<String> {
    return operations.toList()
  }

  /**
   * Test utility: Clears the operation history.
   */
  fun clearOperations() {
    operations.clear()
  }

  /**
   * Test utility: Resets the mock to initial state.
   */
  fun reset() {
    virtualFiles.clear()
    virtualDirectories.clear()
    operations.clear()
  }

  /**
   * Test utility: Adds a virtual file to the mock file system.
   * Only works when useRealFileSystem = false.
   *
   * @param path The path of the virtual file
   */
  fun addVirtualFile(path: String) {
    if (!useRealFileSystem) {
      virtualFiles.add(path)
    }
  }

  /**
   * Test utility: Adds a virtual directory to the mock file system.
   * Only works when useRealFileSystem = false.
   *
   * @param path The path of the virtual directory
   */
  fun addVirtualDirectory(path: String) {
    if (!useRealFileSystem) {
      virtualDirectories.add(path)
    }
  }

  /**
   * Test utility: Gets all virtual files.
   * Only meaningful when useRealFileSystem = false.
   *
   * @return Set of virtual file paths
   */
  fun getVirtualFiles(): Set<String> {
    return virtualFiles.toSet()
  }

  /**
   * Test utility: Gets all virtual directories.
   * Only meaningful when useRealFileSystem = false.
   *
   * @return Set of virtual directory paths
   */
  fun getVirtualDirectories(): Set<String> {
    return virtualDirectories.toSet()
  }
}
