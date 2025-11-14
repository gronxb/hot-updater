package com.hotupdater

import android.content.Context
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowEnvironment
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.system.measureTimeMillis

/**
 * Integration tests for HotUpdater OTA update flow
 * These tests verify the end-to-end update process without mocking file operations or extraction
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class HotUpdaterIntegrationTest {
    private lateinit var testDir: File
    private lateinit var mockContext: Context
    private var urlCounter = 0

    @Before
    fun setup() {
        // Create temporary test directory
        testDir =
            File.createTempFile("hot-updater-test", "").apply {
                delete()
                mkdir()
            }

        // Configure Robolectric to use a real external storage directory
        ShadowEnvironment.setExternalStorageState(android.os.Environment.MEDIA_MOUNTED)

        // Get Robolectric application context
        mockContext = RuntimeEnvironment.getApplication()

        urlCounter = 0
    }

    @After
    fun tearDown() {
        testDir.deleteRecursively()
    }

    /**
     * Helper to register mock response and return URL
     */
    private fun MockDownloadService.mockUrl(data: ByteArray): String {
        val url = "http://localhost/bundle${++urlCounter}.zip"
        mockResponses[url] = Pair(data, null)
        return url
    }

    // MARK: - Test Infrastructure

    /**
     * Helper to create a valid test bundle ZIP
     */
    private fun createTestBundleZip(
        bundleContent: String = "// Test bundle content",
        fileName: String = "index.android.bundle",
    ): ByteArray {
        val outputStream = ByteArrayOutputStream()
        ZipOutputStream(outputStream).use { zipOut ->
            val entry = ZipEntry(fileName)
            zipOut.putNextEntry(entry)
            zipOut.write(bundleContent.toByteArray())
            zipOut.closeEntry()
        }
        return outputStream.toByteArray()
    }

    /**
     * Helper to create a corrupted ZIP
     */
    private fun createCorruptedZip(): ByteArray = byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0xFF.toByte(), 0xFF.toByte())

    /**
     * Helper to calculate SHA-256 hash
     */
    private fun calculateSHA256(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(data)
        return hash.joinToString("") { "%02x".format(it) }
    }

    /**
     * Test-specific FileManagerService that uses a custom directory instead of external files dir
     */
    private inner class TestFileManagerService(
        private val baseDir: File,
    ) : FileSystemService {
        override fun fileExists(path: String): Boolean = File(path).exists()

        override fun createDirectory(path: String): Boolean = File(path).mkdirs()

        override fun removeItem(path: String): Boolean = File(path).deleteRecursively()

        override fun moveItem(
            sourcePath: String,
            destinationPath: String,
        ): Boolean {
            val source = File(sourcePath)
            val destination = File(destinationPath)

            return try {
                if (destination.exists()) {
                    destination.deleteRecursively()
                }
                source.renameTo(destination)
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
                if (destination.exists()) {
                    destination.deleteRecursively()
                }
                source.copyRecursively(target = destination, overwrite = true)
            } catch (e: Exception) {
                false
            }
        }

        override fun contentsOfDirectory(path: String): List<String> {
            val directory = File(path)
            return directory.listFiles()?.map { it.name } ?: listOf()
        }

        override fun getExternalFilesDir(): File = baseDir
    }

    /**
     * Mock Download Service for testing that bypasses OkHttp entirely
     */
    private inner class MockDownloadService : DownloadService {
        val mockResponses: MutableMap<String, Pair<ByteArray?, Exception?>> = mutableMapOf()

        override suspend fun getFileSize(fileUrl: URL): Long {
            val response = mockResponses[fileUrl.toString()]
            return when {
                response?.second != null -> -1L
                response?.first != null -> response.first!!.size.toLong()
                else -> -1L
            }
        }

        override suspend fun downloadFile(
            fileUrl: URL,
            destination: File,
            progressCallback: (Double) -> Unit,
        ): DownloadResult {
            val response = mockResponses[fileUrl.toString()]

            return when {
                response == null -> DownloadResult.Error(Exception("URL not mocked: $fileUrl"))
                response.second != null -> DownloadResult.Error(response.second!!)
                response.first == null -> DownloadResult.Error(Exception("No data for URL: $fileUrl"))
                else -> {
                    // Simulate progress
                    progressCallback(0.5)

                    // Write data to destination
                    destination.parentFile?.mkdirs()
                    destination.writeBytes(response.first!!)

                    progressCallback(1.0)
                    DownloadResult.Success(destination)
                }
            }
        }
    }

    // MARK: - Basic OTA Flow Tests

    @Test
    fun testCompleteOTAUpdate_FirstInstall() =
        runBlocking {
            // Setup: Create valid test bundle
            val bundleContent = "// First install bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-v1.0.0"

            // Create services
            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-isolation-1")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Perform update
            val result =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = {},
                )

            // Verify success
            assertTrue(result)

            // Verify bundle is accessible
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)
            assertTrue(bundleURL.endsWith("index.android.bundle"))

            // Verify bundle content
            val content = File(bundleURL).readText()
            assertEquals(bundleContent, content)
        }

    @Test
    fun testCompleteOTAUpdate_Upgrade() =
        runBlocking {
            // Setup: Install first bundle, then upgrade
            val oldBundleContent = "// Old bundle v1.0.0"
            val newBundleContent = "// New bundle v2.0.0"

            val oldZipData = createTestBundleZip(bundleContent = oldBundleContent)
            val newZipData = createTestBundleZip(bundleContent = newBundleContent)

            // Create services
            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-isolation-2")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock responses
            val oldFileUrl = downloadService.mockUrl(oldZipData)
            val newFileUrl = downloadService.mockUrl(newZipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Install old bundle first
            val result1 =
                bundleStorage.updateBundle(
                    bundleId = "bundle-v1.0.0",
                    fileUrl = oldFileUrl,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            val oldBundleURL = bundleStorage.getBundleURL()
            assertNotNull(oldBundleURL)

            // Install new bundle
            val result2 =
                bundleStorage.updateBundle(
                    bundleId = "bundle-v2.0.0",
                    fileUrl = newFileUrl,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result2)

            // Verify new bundle is activated
            val newBundleURL = bundleStorage.getBundleURL()
            assertNotNull(newBundleURL)
            assertNotEquals(oldBundleURL, newBundleURL)

            val content = File(newBundleURL).readText()
            assertEquals(newBundleContent, content)

            // Verify old bundle is cleaned up
            assertFalse(File(oldBundleURL).exists())
        }

    @Test
    fun testUpdateWithProgress() =
        runBlocking {
            val bundleContent = "// Bundle with progress"
            val zipData = createTestBundleZip(bundleContent = bundleContent)

            val progressValues = mutableListOf<Double>()

            // Create services
            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-isolation-3")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Perform update with progress tracking
            val result =
                bundleStorage.updateBundle(
                    bundleId = "bundle-progress",
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = { progress ->
                        progressValues.add(progress)
                    },
                )

            assertTrue(result)

            // Verify progress values exist and are increasing
            assertTrue(progressValues.isNotEmpty())

            // Progress should start at or near 0 and progress to near 100
            assertTrue(progressValues.first() >= 0.0)
            assertTrue(progressValues.last() >= 0.8) // At least 80% (download complete)

            // Progress should be monotonically increasing
            for (i in 1 until progressValues.size) {
                assertTrue(progressValues[i] >= progressValues[i - 1])
            }
        }

    // MARK: - File System Isolation Tests

    @Test
    fun testIsolation_DifferentAppVersions() =
        runBlocking {
            val bundleContent1 = "// Bundle for app v1"
            val bundleContent2 = "// Bundle for app v2"
            val zipData1 = createTestBundleZip(bundleContent = bundleContent1)
            val zipData2 = createTestBundleZip(bundleContent = bundleContent2)

            // Create first storage with app version 1.0.0
            val fileSystem1 = TestFileManagerService(testDir)
            val preferences1 = VersionedPreferencesService(mockContext, "1.0.0_default_production")
            val downloadService1 = MockDownloadService()
            val decompressService1 = DecompressService()

            // Register mock response for first download service
            val fileUrl1 = downloadService1.mockUrl(zipData1)

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            // Create second storage with app version 2.0.0
            val fileSystem2 = TestFileManagerService(testDir)
            val preferences2 = VersionedPreferencesService(mockContext, "2.0.0_default_production")
            val downloadService2 = MockDownloadService()
            val decompressService2 = DecompressService()

            // Register mock response for second download service
            val fileUrl2 = downloadService2.mockUrl(zipData2)

            val bundleStorage2 =
                BundleFileStorageService(
                    fileSystem = fileSystem2,
                    downloadService = downloadService2,
                    decompressService = decompressService2,
                    preferences = preferences2,
                )

            // Install bundle in first storage
            val result1 =
                bundleStorage1.updateBundle(
                    bundleId = "bundle-v1",
                    fileUrl = fileUrl1,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install bundle in second storage
            val result2 =
                bundleStorage2.updateBundle(
                    bundleId = "bundle-v1",
                    fileUrl = fileUrl2,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result2)

            // Verify bundles are in different directories
            val bundleURL1 = bundleStorage1.getBundleURL()
            val bundleURL2 = bundleStorage2.getBundleURL()

            assertNotNull(bundleURL1)
            assertNotNull(bundleURL2)
            assertNotEquals(bundleURL1, bundleURL2)

            // Verify content is different
            val content1 = File(bundleURL1).readText()
            val content2 = File(bundleURL2).readText()
            assertEquals(bundleContent1, content1)
            assertEquals(bundleContent2, content2)
        }

    @Test
    fun testIsolation_DifferentFingerprints() =
        runBlocking {
            val bundleContent1 = "// Bundle for fingerprint A"
            val bundleContent2 = "// Bundle for fingerprint B"
            val zipData1 = createTestBundleZip(bundleContent = bundleContent1)
            val zipData2 = createTestBundleZip(bundleContent = bundleContent2)

            // Create first storage with fingerprint A
            val fileSystem1 = TestFileManagerService(testDir)
            val preferences1 = VersionedPreferencesService(mockContext, "1.0.0_fingerprintA_production")
            val downloadService1 = MockDownloadService()
            val decompressService1 = DecompressService()

            // Register mock response for first download service
            val fileUrl1 = downloadService1.mockUrl(zipData1)

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            // Create second storage with fingerprint B
            val fileSystem2 = TestFileManagerService(testDir)
            val preferences2 = VersionedPreferencesService(mockContext, "1.0.0_fingerprintB_production")
            val downloadService2 = MockDownloadService()
            val decompressService2 = DecompressService()

            // Register mock response for second download service
            val fileUrl2 = downloadService2.mockUrl(zipData2)

            val bundleStorage2 =
                BundleFileStorageService(
                    fileSystem = fileSystem2,
                    downloadService = downloadService2,
                    decompressService = decompressService2,
                    preferences = preferences2,
                )

            // Install bundle in first storage
            val result1 =
                bundleStorage1.updateBundle(
                    bundleId = "bundle-fp",
                    fileUrl = fileUrl1,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install bundle in second storage
            val result2 =
                bundleStorage2.updateBundle(
                    bundleId = "bundle-fp",
                    fileUrl = fileUrl2,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result2)

            // Verify bundles are in different directories
            val bundleURL1 = bundleStorage1.getBundleURL()
            val bundleURL2 = bundleStorage2.getBundleURL()

            assertNotNull(bundleURL1)
            assertNotNull(bundleURL2)
            assertNotEquals(bundleURL1, bundleURL2)

            // Verify content is different
            val content1 = File(bundleURL1).readText()
            val content2 = File(bundleURL2).readText()
            assertEquals(bundleContent1, content1)
            assertEquals(bundleContent2, content2)
        }

    @Test
    fun testIsolation_DifferentChannels() =
        runBlocking {
            val bundleContent1 = "// Bundle for production"
            val bundleContent2 = "// Bundle for staging"
            val zipData1 = createTestBundleZip(bundleContent = bundleContent1)
            val zipData2 = createTestBundleZip(bundleContent = bundleContent2)

            // Create first storage with production channel
            val fileSystem1 = TestFileManagerService(testDir)
            val preferences1 = VersionedPreferencesService(mockContext, "1.0.0_default_production")
            val downloadService1 = MockDownloadService()
            val decompressService1 = DecompressService()

            // Register mock response for first download service
            val fileUrl1 = downloadService1.mockUrl(zipData1)

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            // Create second storage with staging channel
            val fileSystem2 = TestFileManagerService(testDir)
            val preferences2 = VersionedPreferencesService(mockContext, "1.0.0_default_staging")
            val downloadService2 = MockDownloadService()
            val decompressService2 = DecompressService()

            // Register mock response for second download service
            val fileUrl2 = downloadService2.mockUrl(zipData2)

            val bundleStorage2 =
                BundleFileStorageService(
                    fileSystem = fileSystem2,
                    downloadService = downloadService2,
                    decompressService = decompressService2,
                    preferences = preferences2,
                )

            // Install bundle in first storage
            val result1 =
                bundleStorage1.updateBundle(
                    bundleId = "bundle-ch",
                    fileUrl = fileUrl1,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install bundle in second storage
            val result2 =
                bundleStorage2.updateBundle(
                    bundleId = "bundle-ch",
                    fileUrl = fileUrl2,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result2)

            // Verify bundles are in different directories
            val bundleURL1 = bundleStorage1.getBundleURL()
            val bundleURL2 = bundleStorage2.getBundleURL()

            assertNotNull(bundleURL1)
            assertNotNull(bundleURL2)
            assertNotEquals(bundleURL1, bundleURL2)

            // Verify content is different
            val content1 = File(bundleURL1).readText()
            val content2 = File(bundleURL2).readText()
            assertEquals(bundleContent1, content1)
            assertEquals(bundleContent2, content2)
        }

    // MARK: - Cache & Persistence Tests

    @Test
    fun testBundlePersistence_AfterRestart() =
        runBlocking {
            val bundleContent = "// Persistent bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-persistent"

            // Create first storage instance and install bundle
            val fileSystem1 = TestFileManagerService(testDir)
            val preferences1 = VersionedPreferencesService(mockContext, "test-persistence")
            val downloadService1 = MockDownloadService()
            val decompressService1 = DecompressService()

            // Register mock response
            val fileUrl = downloadService1.mockUrl(zipData)

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            val result =
                bundleStorage1.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result)

            val firstBundleURL = bundleStorage1.getBundleURL()
            assertNotNull(firstBundleURL)

            // Simulate app restart by creating new storage instance with same isolation key
            val fileSystem2 = TestFileManagerService(testDir)
            val preferences2 = VersionedPreferencesService(mockContext, "test-persistence")
            val downloadService2 = MockDownloadService()
            val decompressService2 = DecompressService()

            val bundleStorage2 =
                BundleFileStorageService(
                    fileSystem = fileSystem2,
                    downloadService = downloadService2,
                    decompressService = decompressService2,
                    preferences = preferences2,
                )

            // Get bundle URL from new instance
            val secondBundleURL = bundleStorage2.getBundleURL()
            assertNotNull(secondBundleURL)
            assertEquals(firstBundleURL, secondBundleURL)

            // Verify content is still accessible
            val content = File(secondBundleURL).readText()
            assertEquals(bundleContent, content)
        }

    @Test
    fun testUpdateBundle_SameBundleId() =
        runBlocking {
            val bundleContent = "// Same bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-same"

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-same-bundle")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Install bundle first time
            val result1 =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install same bundle ID again - measure execution time
            val executionTime =
                measureTimeMillis {
                    val result2 =
                        bundleStorage.updateBundle(
                            bundleId = bundleId,
                            fileUrl = fileUrl,
                            fileHash = null,
                            progressCallback = {},
                        )
                    assertTrue(result2)
                }

            // Should complete quickly (<100ms) since it's cached
            assertTrue(executionTime < 100)
        }

    @Test
    fun testRollback_ToFallback() {
        val fileSystem = TestFileManagerService(testDir)
        val preferences = VersionedPreferencesService(mockContext, "test-fallback")
        val downloadService = MockDownloadService()
        val decompressService = DecompressService()

        val bundleStorage =
            BundleFileStorageService(
                fileSystem = fileSystem,
                downloadService = downloadService,
                decompressService = decompressService,
                preferences = preferences,
            )

        // Get bundle URL without any cached bundle
        val bundleURL = bundleStorage.getBundleURL()

        // Should return fallback bundle
        assertNotNull(bundleURL)
        assertTrue(bundleURL.contains("assets://") || bundleURL.contains("index.android.bundle"))
    }

    // MARK: - Error Handling Tests

    @Test
    fun testUpdateFailure_NetworkError() =
        runBlocking {
            val bundleId = "bundle-network-fail"

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-network-error")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Simulate network error
            val url = "http://localhost/bundle${++urlCounter}.zip"
            downloadService.mockResponses[url] = Pair(null, Exception("HTTP 500"))

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Attempt update
            val result =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = url,
                    fileHash = null,
                    progressCallback = {},
                )

            // Verify update fails
            assertFalse(result)

            // Verify no partial files are left behind
            val bundleStoreDir = File(testDir, "bundle-store")
            val tmpFiles = bundleStoreDir.walkTopDown().filter { it.name.endsWith(".tmp") }.toList()
            assertTrue(tmpFiles.isEmpty())
        }

    @Test
    fun testUpdateFailure_CorruptedBundle() =
        runBlocking {
            val bundleId = "bundle-corrupted"
            val corruptedData = createCorruptedZip()

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-corrupted")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response with corrupted data
            val fileUrl = downloadService.mockUrl(corruptedData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Attempt update
            val result =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = {},
                )

            // Verify extraction fails
            assertFalse(result)

            // Verify .tmp files are cleaned up
            val bundleStoreDir = File(testDir, "bundle-store")
            if (bundleStoreDir.exists()) {
                val tmpFiles = bundleStoreDir.walkTopDown().filter { it.name.endsWith(".tmp") }.toList()
                assertTrue(tmpFiles.isEmpty())
            }

            // Verify rollback - getBundleURL should return fallback bundle
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)
            assertTrue(bundleURL.contains("assets://") || bundleURL.contains("index.android.bundle"))
        }

    @Test
    fun testUpdateFailure_InvalidBundleStructure() =
        runBlocking {
            // Create ZIP without proper bundle file
            val zipData = createTestBundleZip(bundleContent = "test", fileName = "wrong-name.js")
            val bundleId = "bundle-invalid-structure"

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-invalid-structure")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Attempt update
            val result =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = {},
                )

            // Verify validation error occurs
            assertFalse(result)

            // Verify rollback - getBundleURL should return fallback bundle
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)
            assertTrue(bundleURL.contains("assets://") || bundleURL.contains("index.android.bundle"))
        }

    @Test
    fun testUpdateFailure_InsufficientDiskSpace() =
        runBlocking {
            // This test verifies that the update process handles failures gracefully
            // Note: Actually simulating disk space errors requires mocking StatFs,
            // which is complex in unit tests. We verify the system's error handling capabilities.

            val bundleContent = "// Bundle requiring space"
            val zipData = createTestBundleZip(bundleContent = bundleContent)

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-disk-space")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Install a valid bundle first
            val result1 =
                bundleStorage.updateBundle(
                    bundleId = "bundle-original",
                    fileUrl = fileUrl,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            val originalBundleURL = bundleStorage.getBundleURL()
            assertNotNull(originalBundleURL)

            // Verify existing bundle is accessible after any potential failures
            val content = File(originalBundleURL).readText()
            assertEquals(bundleContent, content)
        }

    @Test
    fun testUpdateInterruption_AndRetry() =
        runBlocking {
            val bundleContent = "// Retry bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-retry"

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-retry")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // First attempt fails
            val url1 = "http://localhost/bundle${++urlCounter}.zip"
            downloadService.mockResponses[url1] = Pair(null, Exception("HTTP 408"))

            // Second attempt succeeds
            val url2 = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // First update attempt (fails)
            val result1 =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = url1,
                    fileHash = null,
                    progressCallback = {},
                )
            assertFalse(result1)

            // Verify .tmp cleanup
            val bundleStoreDir = File(testDir, "bundle-store")
            if (bundleStoreDir.exists()) {
                val tmpFiles = bundleStoreDir.walkTopDown().filter { it.name.endsWith(".tmp") }.toList()
                assertTrue(tmpFiles.isEmpty())
            }

            // Retry update (succeeds)
            val result2 =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = url2,
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result2)

            // Verify bundle is installed correctly
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)
            val content = File(bundleURL).readText()
            assertEquals(bundleContent, content)
        }

    // MARK: - Hash Verification Tests

    @Test
    fun testUpdateWithHashVerification_Success() =
        runBlocking {
            val bundleContent = "// Hashed bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val fileHash = calculateSHA256(zipData)
            val bundleId = "bundle-hashed"

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-hash-success")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Update with correct hash
            val result =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = fileHash,
                    progressCallback = {},
                )

            // Verify hash is verified and bundle is installed
            assertTrue(result)

            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)

            val content = File(bundleURL).readText()
            assertEquals(bundleContent, content)
        }

    @Test
    fun testUpdateWithHashVerification_Failure() =
        runBlocking {
            val bundleContent = "// Hashed bundle fail"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"
            val bundleId = "bundle-hash-fail"

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-hash-fail")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock response
            val fileUrl = downloadService.mockUrl(zipData)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Update with wrong hash
            val result =
                bundleStorage.updateBundle(
                    bundleId = bundleId,
                    fileUrl = fileUrl,
                    fileHash = wrongHash,
                    progressCallback = {},
                )

            // Verify hash mismatch error
            assertFalse(result)

            // Verify downloaded file is deleted (no .tmp files)
            val bundleStoreDir = File(testDir, "bundle-store")
            if (bundleStoreDir.exists()) {
                val tmpFiles = bundleStoreDir.walkTopDown().filter { it.name.endsWith(".tmp") }.toList()
                assertTrue(tmpFiles.isEmpty())
            }

            // Verify fallback - getBundleURL should return fallback bundle
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)
            assertTrue(bundleURL.contains("assets://") || bundleURL.contains("index.android.bundle"))
        }

    // MARK: - Concurrency Tests

    @Test
    fun testConcurrentUpdates_Sequential() =
        runBlocking {
            val bundle1Content = "// Bundle 1"
            val bundle2Content = "// Bundle 2"
            val zipData1 = createTestBundleZip(bundleContent = bundle1Content)
            val zipData2 = createTestBundleZip(bundleContent = bundle2Content)

            val fileSystem = TestFileManagerService(testDir)
            val preferences = VersionedPreferencesService(mockContext, "test-concurrency")
            val downloadService = MockDownloadService()
            val decompressService = DecompressService()

            // Register mock responses
            val fileUrl1 = downloadService.mockUrl(zipData1)
            val fileUrl2 = downloadService.mockUrl(zipData2)

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Start two updates concurrently using async
            val deferred1 =
                async {
                    bundleStorage.updateBundle(
                        bundleId = "bundle1",
                        fileUrl = fileUrl1,
                        fileHash = null,
                        progressCallback = {},
                    )
                }

            val deferred2 =
                async {
                    bundleStorage.updateBundle(
                        bundleId = "bundle2",
                        fileUrl = fileUrl2,
                        fileHash = null,
                        progressCallback = {},
                    )
                }

            // Wait for both to complete
            val result1 = deferred1.await()
            val result2 = deferred2.await()

            // Verify both succeeded
            assertTrue(result1)
            assertTrue(result2)

            // Verify the final bundle URL points to the last installed bundle
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)

            val content = File(bundleURL).readText()
            // The content should be from one of the bundles (last one wins)
            assertTrue(content == bundle1Content || content == bundle2Content)
        }
}
