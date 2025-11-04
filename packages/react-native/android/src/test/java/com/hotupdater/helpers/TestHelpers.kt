package com.hotupdater.helpers

import android.content.Context
import android.content.SharedPreferences
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

// Collection of test helper utilities for Hot Updater Android tests.
//
// This file provides common utilities for:
// - Creating mock Android Context instances
// - Managing temporary test directories
// - Creating mock ZIP bundles
// - Calculating file hashes for verification
// - Mock SharedPreferences implementations
// - Coroutine testing utilities

/**
 * Creates a mock Android Context suitable for testing.
 *
 * This context includes basic functionality like:
 * - File directory access
 * - SharedPreferences access
 * - Package name
 *
 * @param filesDir Optional custom files directory (default: creates a temp directory)
 * @return A mocked Context instance
 *
 * @example
 * ```kotlin
 * val context = createMockContext()
 * val file = File(context.filesDir, "test.txt")
 * ```
 */
fun createMockContext(filesDir: File? = null): Context {
    val context = mockk<Context>(relaxed = true)
    val actualFilesDir = filesDir ?: createTempDirectory("test-files")

    every { context.filesDir } returns actualFilesDir
    every { context.cacheDir } returns File(actualFilesDir.parent, "cache").apply { mkdirs() }
    every { context.packageName } returns "com.test.hotupdater"

    // Mock application info
    val applicationInfo = android.content.pm.ApplicationInfo()
    applicationInfo.dataDir = actualFilesDir.parent
    every { context.applicationInfo } returns applicationInfo

    return context
}

/**
 * Creates a temporary directory for testing.
 *
 * The directory will be created with a unique name and should be cleaned up
 * after the test completes.
 *
 * @param prefix The prefix for the directory name (default: "test-")
 * @return The created directory
 *
 * @example
 * ```kotlin
 * val tempDir = createTempDirectory("my-test")
 * // Use tempDir...
 * cleanupTestDirectory(tempDir)
 * ```
 */
fun createTempDirectory(prefix: String = "test-"): File {
    val tempDir = File.createTempFile(prefix, "")
    tempDir.delete()
    tempDir.mkdirs()
    return tempDir
}

/**
 * Recursively deletes a directory and all its contents.
 *
 * Safe to use even if the directory doesn't exist or has already been deleted.
 *
 * @param directory The directory to delete
 * @return true if successful, false otherwise
 */
fun cleanupTestDirectory(directory: File): Boolean =
    try {
        if (directory.exists()) {
            directory.deleteRecursively()
        }
        true
    } catch (e: Exception) {
        false
    }

/**
 * Creates a mock ZIP bundle containing the specified files.
 *
 * This is useful for testing bundle download and extraction logic.
 *
 * @param files A map of file paths to their text contents
 * @return A byte array containing the ZIP file data
 *
 * @example
 * ```kotlin
 * val zipData = createMockZipBundle(mapOf(
 *     "index.android.bundle" to "var x = 1;",
 *     "assets/logo.png" to "fake png data"
 * ))
 * ```
 */
fun createMockZipBundle(files: Map<String, String>): ByteArray {
    val byteArrayOutputStream = ByteArrayOutputStream()
    ZipOutputStream(byteArrayOutputStream).use { zipOut ->
        files.forEach { (path, content) ->
            val entry = ZipEntry(path)
            zipOut.putNextEntry(entry)
            zipOut.write(content.toByteArray(Charsets.UTF_8))
            zipOut.closeEntry()
        }
    }
    return byteArrayOutputStream.toByteArray()
}

/**
 * Creates a mock ZIP bundle containing binary file data.
 *
 * @param files A map of file paths to their binary contents
 * @return A byte array containing the ZIP file data
 */
fun createMockZipBundleWithBinaryFiles(files: Map<String, ByteArray>): ByteArray {
    val byteArrayOutputStream = ByteArrayOutputStream()
    ZipOutputStream(byteArrayOutputStream).use { zipOut ->
        files.forEach { (path, content) ->
            val entry = ZipEntry(path)
            zipOut.putNextEntry(entry)
            zipOut.write(content)
            zipOut.closeEntry()
        }
    }
    return byteArrayOutputStream.toByteArray()
}

/**
 * Calculates the SHA256 hash of a byte array.
 *
 * Useful for verifying downloaded bundle integrity in tests.
 *
 * @param data The data to hash
 * @return Hex string of the hash (lowercase)
 *
 * @example
 * ```kotlin
 * val zipData = createMockZipBundle(mapOf("index.js" to "test"))
 * val hash = calculateSHA256(zipData)
 * assertEquals(expectedHash, hash)
 * ```
 */
fun calculateSHA256(data: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update(data)
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/**
 * Calculates the SHA256 hash of a file.
 *
 * @param file The file to hash
 * @return Hex string of the hash (lowercase)
 */
fun calculateFileSHA256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(8192)
        var bytesRead: Int
        while (input.read(buffer).also { bytesRead = it } != -1) {
            digest.update(buffer, 0, bytesRead)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/**
 * Creates a mock SharedPreferences instance.
 *
 * This implementation stores data in memory and can be used for testing
 * preferences-related functionality without requiring a real Android Context.
 *
 * @return A mocked SharedPreferences instance with a working Editor
 *
 * @example
 * ```kotlin
 * val prefs = createMockSharedPreferences()
 * prefs.edit().putString("key", "value").apply()
 * assertEquals("value", prefs.getString("key", null))
 * ```
 */
fun createMockSharedPreferences(): SharedPreferences {
    val data = mutableMapOf<String, Any?>()
    val prefs = mockk<SharedPreferences>(relaxed = true)

    // Mock getString
    every { prefs.getString(any(), any()) } answers {
        val key = firstArg<String>()
        val default = secondArg<String?>()
        data[key] as? String ?: default
    }

    // Mock getInt
    every { prefs.getInt(any(), any()) } answers {
        val key = firstArg<String>()
        val default = secondArg<Int>()
        data[key] as? Int ?: default
    }

    // Mock getBoolean
    every { prefs.getBoolean(any(), any()) } answers {
        val key = firstArg<String>()
        val default = secondArg<Boolean>()
        data[key] as? Boolean ?: default
    }

    // Mock getLong
    every { prefs.getLong(any(), any()) } answers {
        val key = firstArg<String>()
        val default = secondArg<Long>()
        data[key] as? Long ?: default
    }

    // Mock contains
    every { prefs.contains(any()) } answers {
        data.containsKey(firstArg())
    }

    // Mock getAll
    every { prefs.all } returns data.toMap()

    // Mock edit()
    val editor = mockk<SharedPreferences.Editor>(relaxed = true)

    every { editor.putString(any(), any()) } answers {
        data[firstArg()] = secondArg<String?>()
        editor
    }

    every { editor.putInt(any(), any()) } answers {
        data[firstArg()] = secondArg<Int>()
        editor
    }

    every { editor.putBoolean(any(), any()) } answers {
        data[firstArg()] = secondArg<Boolean>()
        editor
    }

    every { editor.putLong(any(), any()) } answers {
        data[firstArg()] = secondArg<Long>()
        editor
    }

    every { editor.remove(any()) } answers {
        data.remove(firstArg())
        editor
    }

    every { editor.clear() } answers {
        data.clear()
        editor
    }

    every { editor.apply() } returns Unit
    every { editor.commit() } returns true

    every { prefs.edit() } returns editor

    return prefs
}

/**
 * Creates a mock Context with a working mock SharedPreferences.
 *
 * @param filesDir Optional custom files directory
 * @return A mocked Context with SharedPreferences support
 */
fun createMockContextWithPreferences(filesDir: File? = null): Context {
    val context = createMockContext(filesDir)
    val mockPrefs = createMockSharedPreferences()

    every { context.getSharedPreferences(any(), any()) } returns mockPrefs

    return context
}

// Coroutine testing utilities

/**
 * Creates a test CoroutineScope with an UnconfinedTestDispatcher.
 *
 * Use this for testing coroutines in a synchronous manner.
 *
 * @param dispatcher Optional custom TestDispatcher (default: UnconfinedTestDispatcher)
 * @return A CoroutineScope configured for testing
 *
 * @example
 * ```kotlin
 * @Test
 * fun testCoroutine() = runTest {
 *     val scope = createTestScope()
 *     // Test coroutine code...
 * }
 * ```
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun createTestScope(dispatcher: TestDispatcher = UnconfinedTestDispatcher()): CoroutineScope = CoroutineScope(dispatcher)

/**
 * Writes data to a file, creating parent directories if needed.
 *
 * @param file The file to write to
 * @param data The data to write
 */
fun writeTestFile(
    file: File,
    data: ByteArray,
) {
    file.parentFile?.mkdirs()
    file.writeBytes(data)
}

/**
 * Writes text to a file, creating parent directories if needed.
 *
 * @param file The file to write to
 * @param text The text to write
 */
fun writeTestFile(
    file: File,
    text: String,
) {
    file.parentFile?.mkdirs()
    file.writeText(text)
}

/**
 * Creates a mock bundle ZIP file in the specified directory.
 *
 * @param directory The directory to create the ZIP in
 * @param filename The name of the ZIP file
 * @param files The files to include in the ZIP
 * @return The created ZIP file
 */
fun createMockBundleFile(
    directory: File,
    filename: String,
    files: Map<String, String>,
): File {
    directory.mkdirs()
    val zipFile = File(directory, filename)
    val zipData = createMockZipBundle(files)
    writeTestFile(zipFile, zipData)
    return zipFile
}

/**
 * Asserts that a file exists and is not empty.
 *
 * @param file The file to check
 * @throws AssertionError if the file doesn't exist or is empty
 */
fun assertFileExistsAndNotEmpty(file: File) {
    if (!file.exists()) {
        throw AssertionError("File does not exist: ${file.absolutePath}")
    }
    if (file.length() == 0L) {
        throw AssertionError("File is empty: ${file.absolutePath}")
    }
}

/**
 * Asserts that a directory exists and contains files.
 *
 * @param directory The directory to check
 * @throws AssertionError if the directory doesn't exist or is empty
 */
fun assertDirectoryExistsAndNotEmpty(directory: File) {
    if (!directory.exists()) {
        throw AssertionError("Directory does not exist: ${directory.absolutePath}")
    }
    if (!directory.isDirectory) {
        throw AssertionError("Not a directory: ${directory.absolutePath}")
    }
    val files = directory.listFiles()
    if (files == null || files.isEmpty()) {
        throw AssertionError("Directory is empty: ${directory.absolutePath}")
    }
}
