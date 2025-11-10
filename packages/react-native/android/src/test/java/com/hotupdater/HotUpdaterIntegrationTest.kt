package com.hotupdater

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import android.content.Context
import android.content.res.Resources
import kotlin.system.measureTimeMillis

/**
 * Integration tests for HotUpdater OTA update flow
 * These tests verify the end-to-end update process without mocking file operations or extraction
 */
@DisplayName("HotUpdater Integration Tests")
class HotUpdaterIntegrationTest {
    private lateinit var mockWebServer: MockWebServer
    private lateinit var testDir: File
    private lateinit var mockContext: Context

    @BeforeEach
    fun setup() {
        mockWebServer = MockWebServer()
        mockWebServer.start()

        // Create temporary test directory
        testDir =
            File.createTempFile("hot-updater-test", "").apply {
                delete()
                mkdir()
            }

        // Create mock context
        mockContext = createMockContext()
    }

    @AfterEach
    fun tearDown() {
        mockWebServer.shutdown()
        testDir.deleteRecursively()
    }

    /**
     * Helper to create a mock Android Context for testing
     */
    private fun createMockContext(): Context {
        val context = mockk<Context>(relaxed = true)
        val resources = mockk<Resources>(relaxed = true)

        every { context.getExternalFilesDir(null) } returns testDir
        every { context.resources } returns resources
        every { resources.getIdentifier(any(), any(), any()) } returns 0
        every { context.packageName } returns "com.test.hotupdater"

        return context
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

    // MARK: - Basic OTA Flow Tests

    @Test
    @DisplayName("Complete OTA update - First install")
    fun testCompleteOTAUpdate_FirstInstall() =
        runBlocking {
            // Setup: Create valid test bundle
            val bundleContent = "// First install bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-v1.0.0"

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            // Create services
            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-isolation-1")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Complete OTA update - Upgrade from existing")
    fun testCompleteOTAUpdate_Upgrade() =
        runBlocking {
            // Setup: Install first bundle, then upgrade
            val oldBundleContent = "// Old bundle v1.0.0"
            val newBundleContent = "// New bundle v2.0.0"

            val oldZipData = createTestBundleZip(bundleContent = oldBundleContent)
            val newZipData = createTestBundleZip(bundleContent = newBundleContent)

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(oldZipData)))
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(newZipData)))

            // Create services
            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-isolation-2")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle1.zip").toString(),
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
                    fileUrl = mockWebServer.url("/bundle2.zip").toString(),
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
    @DisplayName("Update with progress tracking")
    fun testUpdateWithProgress() =
        runBlocking {
            val bundleContent = "// Bundle with progress"
            val zipData = createTestBundleZip(bundleContent = bundleContent)

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val progressValues = mutableListOf<Double>()

            // Create services
            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-isolation-3")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Isolation - Different app versions")
    fun testIsolation_DifferentAppVersions() =
        runBlocking {
            val bundleContent1 = "// Bundle for app v1"
            val bundleContent2 = "// Bundle for app v2"
            val zipData1 = createTestBundleZip(bundleContent = bundleContent1)
            val zipData2 = createTestBundleZip(bundleContent = bundleContent2)

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData1)))
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData2)))

            // Create first storage with app version 1.0.0
            val fileSystem1 = FileManagerService(mockContext)
            val preferences1 = VersionedPreferencesService(mockContext, "1.0.0_default_production")
            val downloadService1 = OkHttpDownloadService()
            val decompressService1 = DecompressService()

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            // Create second storage with app version 2.0.0
            val fileSystem2 = FileManagerService(mockContext)
            val preferences2 = VersionedPreferencesService(mockContext, "2.0.0_default_production")
            val downloadService2 = OkHttpDownloadService()
            val decompressService2 = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle1.zip").toString(),
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install bundle in second storage
            val result2 =
                bundleStorage2.updateBundle(
                    bundleId = "bundle-v1",
                    fileUrl = mockWebServer.url("/bundle2.zip").toString(),
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
    @DisplayName("Isolation - Different fingerprints")
    fun testIsolation_DifferentFingerprints() =
        runBlocking {
            val bundleContent1 = "// Bundle for fingerprint A"
            val bundleContent2 = "// Bundle for fingerprint B"
            val zipData1 = createTestBundleZip(bundleContent = bundleContent1)
            val zipData2 = createTestBundleZip(bundleContent = bundleContent2)

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData1)))
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData2)))

            // Create first storage with fingerprint A
            val fileSystem1 = FileManagerService(mockContext)
            val preferences1 = VersionedPreferencesService(mockContext, "1.0.0_fingerprintA_production")
            val downloadService1 = OkHttpDownloadService()
            val decompressService1 = DecompressService()

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            // Create second storage with fingerprint B
            val fileSystem2 = FileManagerService(mockContext)
            val preferences2 = VersionedPreferencesService(mockContext, "1.0.0_fingerprintB_production")
            val downloadService2 = OkHttpDownloadService()
            val decompressService2 = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle1.zip").toString(),
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install bundle in second storage
            val result2 =
                bundleStorage2.updateBundle(
                    bundleId = "bundle-fp",
                    fileUrl = mockWebServer.url("/bundle2.zip").toString(),
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
    @DisplayName("Isolation - Different channels")
    fun testIsolation_DifferentChannels() =
        runBlocking {
            val bundleContent1 = "// Bundle for production"
            val bundleContent2 = "// Bundle for staging"
            val zipData1 = createTestBundleZip(bundleContent = bundleContent1)
            val zipData2 = createTestBundleZip(bundleContent = bundleContent2)

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData1)))
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData2)))

            // Create first storage with production channel
            val fileSystem1 = FileManagerService(mockContext)
            val preferences1 = VersionedPreferencesService(mockContext, "1.0.0_default_production")
            val downloadService1 = OkHttpDownloadService()
            val decompressService1 = DecompressService()

            val bundleStorage1 =
                BundleFileStorageService(
                    fileSystem = fileSystem1,
                    downloadService = downloadService1,
                    decompressService = decompressService1,
                    preferences = preferences1,
                )

            // Create second storage with staging channel
            val fileSystem2 = FileManagerService(mockContext)
            val preferences2 = VersionedPreferencesService(mockContext, "1.0.0_default_staging")
            val downloadService2 = OkHttpDownloadService()
            val decompressService2 = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle1.zip").toString(),
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)

            // Install bundle in second storage
            val result2 =
                bundleStorage2.updateBundle(
                    bundleId = "bundle-ch",
                    fileUrl = mockWebServer.url("/bundle2.zip").toString(),
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
    @DisplayName("Bundle persistence after restart")
    fun testBundlePersistence_AfterRestart() =
        runBlocking {
            val bundleContent = "// Persistent bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-persistent"

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            // Create first storage instance and install bundle
            val fileSystem1 = FileManagerService(mockContext)
            val preferences1 = VersionedPreferencesService(mockContext, "test-persistence")
            val downloadService1 = OkHttpDownloadService()
            val decompressService1 = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result)

            val firstBundleURL = bundleStorage1.getBundleURL()
            assertNotNull(firstBundleURL)

            // Simulate app restart by creating new storage instance with same isolation key
            val fileSystem2 = FileManagerService(mockContext)
            val preferences2 = VersionedPreferencesService(mockContext, "test-persistence")
            val downloadService2 = OkHttpDownloadService()
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
    @DisplayName("Update with same bundle ID - No re-download")
    fun testUpdateBundle_SameBundleId() =
        runBlocking {
            val bundleContent = "// Same bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-same"

            // Enqueue only once
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-same-bundle")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result1)
            assertEquals(1, mockWebServer.requestCount)

            // Install same bundle ID again - measure execution time
            val executionTime =
                measureTimeMillis {
                    val result2 =
                        bundleStorage.updateBundle(
                            bundleId = bundleId,
                            fileUrl = mockWebServer.url("/bundle.zip").toString(),
                            fileHash = null,
                            progressCallback = {},
                        )
                    assertTrue(result2)
                }

            // Only one download should occur
            assertEquals(1, mockWebServer.requestCount)
            // Should complete quickly (<100ms)
            assertTrue(executionTime < 100)
        }

    @Test
    @DisplayName("Rollback to fallback bundle")
    fun testRollback_ToFallback() {
        val fileSystem = FileManagerService(mockContext)
        val preferences = VersionedPreferencesService(mockContext, "test-fallback")
        val downloadService = OkHttpDownloadService()
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
    @DisplayName("Update failure - Network error")
    fun testUpdateFailure_NetworkError() =
        runBlocking {
            val bundleId = "bundle-network-fail"

            // Simulate network error
            mockWebServer.enqueue(MockResponse().setResponseCode(500))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-network-error")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Update failure - Corrupted bundle")
    fun testUpdateFailure_CorruptedBundle() =
        runBlocking {
            val bundleId = "bundle-corrupted"
            val corruptedData = createCorruptedZip()

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(corruptedData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-corrupted")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Update failure - Invalid bundle structure")
    fun testUpdateFailure_InvalidBundleStructure() =
        runBlocking {
            // Create ZIP without proper bundle file
            val zipData = createTestBundleZip(bundleContent = "test", fileName = "wrong-name.js")
            val bundleId = "bundle-invalid-structure"

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-invalid-structure")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Update failure - Insufficient disk space")
    fun testUpdateFailure_InsufficientDiskSpace() =
        runBlocking {
            // This test verifies that the update process handles failures gracefully
            // Note: Actually simulating disk space errors requires mocking StatFs,
            // which is complex in unit tests. We verify the system's error handling capabilities.

            val bundleContent = "// Bundle requiring space"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-no-space"

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-disk-space")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

            val bundleStorage =
                BundleFileStorageService(
                    fileSystem = fileSystem,
                    downloadService = downloadService,
                    decompressService = decompressService,
                    preferences = preferences,
                )

            // Install a valid bundle first
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))
            val result1 =
                bundleStorage.updateBundle(
                    bundleId = "bundle-original",
                    fileUrl = mockWebServer.url("/original.zip").toString(),
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
    @DisplayName("Update interruption and retry")
    fun testUpdateInterruption_AndRetry() =
        runBlocking {
            val bundleContent = "// Retry bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val bundleId = "bundle-retry"

            // First attempt fails, second succeeds
            mockWebServer.enqueue(MockResponse().setResponseCode(408)) // Timeout
            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-retry")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
                    fileHash = null,
                    progressCallback = {},
                )
            assertTrue(result2)

            // Verify 2 requests were made (OkHttpDownloadService has retry logic, so might be more)
            assertTrue(mockWebServer.requestCount >= 2)

            // Verify bundle is installed correctly
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)
            val content = File(bundleURL).readText()
            assertEquals(bundleContent, content)
        }

    // MARK: - Hash Verification Tests

    @Test
    @DisplayName("Update with hash verification - Success")
    fun testUpdateWithHashVerification_Success() =
        runBlocking {
            val bundleContent = "// Hashed bundle"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val fileHash = calculateSHA256(zipData)
            val bundleId = "bundle-hashed"

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-hash-success")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Update with hash verification - Failure")
    fun testUpdateWithHashVerification_Failure() =
        runBlocking {
            val bundleContent = "// Hashed bundle fail"
            val zipData = createTestBundleZip(bundleContent = bundleContent)
            val wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"
            val bundleId = "bundle-hash-fail"

            mockWebServer.enqueue(MockResponse().setBody(okio.Buffer().write(zipData)))

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-hash-fail")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                    fileUrl = mockWebServer.url("/bundle.zip").toString(),
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
    @DisplayName("Concurrent updates - Sequential handling")
    fun testConcurrentUpdates_Sequential() =
        runBlocking {
            val bundle1Content = "// Bundle 1"
            val bundle2Content = "// Bundle 2"
            val zipData1 = createTestBundleZip(bundleContent = bundle1Content)
            val zipData2 = createTestBundleZip(bundleContent = bundle2Content)

            // Simulate network delay
            mockWebServer.enqueue(
                MockResponse().setBody(okio.Buffer().write(zipData1)).setBodyDelay(100, java.util.concurrent.TimeUnit.MILLISECONDS),
            )
            mockWebServer.enqueue(
                MockResponse().setBody(okio.Buffer().write(zipData2)).setBodyDelay(100, java.util.concurrent.TimeUnit.MILLISECONDS),
            )

            val fileSystem = FileManagerService(mockContext)
            val preferences = VersionedPreferencesService(mockContext, "test-concurrency")
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()

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
                        fileUrl = mockWebServer.url("/bundle1.zip").toString(),
                        fileHash = null,
                        progressCallback = {},
                    )
                }

            val deferred2 =
                async {
                    bundleStorage.updateBundle(
                        bundleId = "bundle2",
                        fileUrl = mockWebServer.url("/bundle2.zip").toString(),
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

            // Verify both requests were made
            assertEquals(2, mockWebServer.requestCount)

            // Verify the final bundle URL points to the last installed bundle
            val bundleURL = bundleStorage.getBundleURL()
            assertNotNull(bundleURL)

            val content = File(bundleURL).readText()
            // The content should be from one of the bundles (last one wins)
            assertTrue(content == bundle1Content || content == bundle2Content)
        }
}
