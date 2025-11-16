package com.hotupdater

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertTrue

// MARK: - Test Constants

object TestConstants {
    const val validBundleHash = "9a885c0ebee4f7a9dce994f626b1fb4cebfde6e3608fb01f714061d7c4e70e3f"
    const val corruptedBundleHash = "38893dade3c03e3521f5750c4a8ee90cd6d7b1eeb30b410a0cce483ea6ede84b"
    const val invalidBundleHash = "accc5fb6b024d45a87a6013f3aff7ddd94de4463bfd7d3814d37e090d4fd594f"
    const val appVersion = "1.0.0"
    const val fingerprint = "test-fingerprint"
    const val channel = "production"
    const val bundleId = "test-bundle-1"
}

// MARK: - Temporary Directory Management

class TempDirectoryManager {
    private val tempDirectories = mutableListOf<File>()

    fun createTempDirectory(prefix: String = "HotUpdaterTest"): File {
        val tempDir = File.createTempFile(prefix, "").apply {
            delete()
            mkdirs()
        }
        tempDirectories.add(tempDir)
        return tempDir
    }

    fun cleanupAll() {
        tempDirectories.forEach { dir ->
            dir.deleteRecursively()
        }
        tempDirectories.clear()
    }
}

// MARK: - Mock Web Server Helper

class MockWebServerHelper {
    private val server = MockWebServer()
    private var started = false

    fun start() {
        if (!started) {
            server.start()
            started = true
        }
    }

    fun shutdown() {
        if (started) {
            server.shutdown()
            started = false
        }
    }

    fun url(path: String = "/"): String = server.url(path).toString()

    fun enqueueFile(file: File, statusCode: Int = 200) {
        val buffer = Buffer()
        buffer.write(file.readBytes())
        val response = MockResponse()
            .setResponseCode(statusCode)
            .setBody(buffer)
            .addHeader("Content-Length", file.length().toString())
        server.enqueue(response)
    }

    fun enqueueNetworkError() {
        server.enqueue(MockResponse().setResponseCode(500))
    }

    fun enqueueData(data: ByteArray, statusCode: Int = 200, contentLength: Long? = null) {
        val buffer = Buffer()
        buffer.write(data)
        val response = MockResponse()
            .setResponseCode(statusCode)
            .setBody(buffer)

        contentLength?.let {
            response.addHeader("Content-Length", it.toString())
        } ?: run {
            response.addHeader("Content-Length", data.size.toString())
        }

        server.enqueue(response)
    }
}

// MARK: - Test Preferences Service

class TestPreferencesService : PreferencesService {
    private val storage = mutableMapOf<String, String>()
    private var isolationKey: String = ""

    fun configure(isolationKey: String) {
        this.isolationKey = isolationKey
    }

    private fun prefixedKey(key: String): String {
        require(isolationKey.isNotEmpty()) { "PreferencesService not configured" }
        return "$isolationKey$key"
    }

    override fun setItem(key: String, value: String?) {
        val fullKey = prefixedKey(key)
        if (value != null) {
            storage[fullKey] = value
        } else {
            storage.remove(fullKey)
        }
    }

    override fun getItem(key: String): String? {
        val fullKey = prefixedKey(key)
        return storage[fullKey]
    }
}

// MARK: - Test File System Service

class TestFileSystemService(private val documentsDir: File) : FileSystemService {
    override fun documentsPath(): String = documentsDir.absolutePath

    override fun fileExists(path: String): Boolean = File(path).exists()

    override fun createDirectory(path: String): Boolean {
        return try {
            File(path).mkdirs()
            true
        } catch (e: Exception) {
            false
        }
    }

    override fun removeItem(path: String) {
        File(path).deleteRecursively()
    }

    override fun moveItem(srcPath: String, dstPath: String) {
        val src = File(srcPath)
        val dst = File(dstPath)
        if (!src.renameTo(dst)) {
            throw Exception("Failed to move $srcPath to $dstPath")
        }
    }

    override fun copyItem(srcPath: String, dstPath: String) {
        val src = File(srcPath)
        val dst = File(dstPath)
        src.copyRecursively(dst, overwrite = true)
    }

    override fun contentsOfDirectory(path: String): List<String> {
        return File(path).list()?.toList() ?: emptyList()
    }

    override fun attributesOfItem(path: String): Map<String, Any> {
        val file = File(path)
        return mapOf(
            "size" to file.length(),
            "lastModified" to file.lastModified()
        )
    }
}

// MARK: - Progress Tracker

class ProgressTracker {
    private val progressValues = mutableListOf<Double>()

    @Synchronized
    fun track(progress: Double) {
        progressValues.add(progress)
    }

    @Synchronized
    fun reset() {
        progressValues.clear()
    }

    @Synchronized
    fun getValues(): List<Double> = progressValues.toList()

    val lastProgress: Double?
        @Synchronized get() = progressValues.lastOrNull()

    val minProgress: Double?
        @Synchronized get() = progressValues.minOrNull()

    val maxProgress: Double?
        @Synchronized get() = progressValues.maxOrNull()

    val count: Int
        @Synchronized get() = progressValues.size
}

// MARK: - File Assertions

object FileAssertions {
    fun assertFileExists(path: String, message: String = "Expected file to exist at: $path") {
        assertTrue(File(path).exists(), message)
    }

    fun assertFileNotExists(path: String, message: String = "Expected file to not exist at: $path") {
        assertTrue(!File(path).exists(), message)
    }

    fun assertDirectoryExists(path: String, message: String = "Expected directory to exist at: $path") {
        val file = File(path)
        assertTrue(file.exists() && file.isDirectory, message)
    }

    fun assertFileContains(path: String, expectedContent: String, message: String = "Expected file to contain content") {
        val content = File(path).readText()
        assertTrue(content.contains(expectedContent), message)
    }

    fun assertBundleStructure(bundlePath: String, platform: String = "android") {
        assertDirectoryExists(bundlePath)
        val indexBundle = File(bundlePath, "index.$platform.bundle")
        assertFileExists(indexBundle.absolutePath)
    }
}

// MARK: - Async Test Utilities

suspend fun <T> awaitResult(
    timeoutMs: Long = 10000,
    block: (complete: (T) -> Unit) -> Unit
): T {
    val latch = CountDownLatch(1)
    var result: T? = null
    var error: Throwable? = null

    block { value ->
        result = value
        latch.countDown()
    }

    val completed = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    if (!completed) {
        throw AssertionError("Timeout waiting for result after ${timeoutMs}ms")
    }

    error?.let { throw it }
    return result ?: throw AssertionError("Result was null")
}

// MARK: - Test Resources

object TestResources {
    fun getResourceFile(name: String): File {
        val classLoader = TestResources::class.java.classLoader
            ?: throw IllegalStateException("ClassLoader not found")

        val resource = classLoader.getResource(name)
            ?: throw IllegalArgumentException("Resource not found: $name")

        return File(resource.file)
    }

    fun getResourcePath(name: String): String {
        return getResourceFile(name).absolutePath
    }
}
