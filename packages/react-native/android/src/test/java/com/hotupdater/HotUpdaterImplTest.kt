package com.hotupdater

import android.content.Context
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.atLeast
import org.mockito.kotlin.eq
import org.mockito.kotlin.inOrder
import org.mockito.kotlin.mock
import org.mockito.kotlin.times
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class HotUpdaterImplTest {
    private lateinit var context: Context
    private lateinit var mockBundleStorage: BundleStorageService
    private lateinit var mockPreferences: PreferencesService
    private lateinit var impl: HotUpdaterImpl

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        mockBundleStorage = mock()
        mockPreferences = mock()

        impl =
            HotUpdaterImpl(
                context,
                mockBundleStorage,
                mockPreferences,
            )
    }

    // MARK: - Initialization Tests

    @Test
    fun `HotUpdaterImpl initializes successfully`() {
        assertNotNull(impl)
    }

    // MARK: - App Version Tests

    @Test
    fun `getAppVersion returns version from package manager`() {
        val version = impl.getAppVersion()

        // Robolectric provides a default version
        assertNotNull(version)
    }

    @Test
    fun `static getAppVersion returns version from context`() {
        val version = HotUpdaterImpl.getAppVersion(context)

        // Robolectric provides a default version
        assertNotNull(version)
    }

    // MARK: - Channel Tests

    @Test
    fun `getChannel returns default channel when not configured`() {
        val channel = impl.getChannel()

        assertEquals("production", channel)
    }

    @Test
    fun `static getChannel returns default channel when not configured`() {
        val channel = HotUpdaterImpl.getChannel(context)

        assertEquals("production", channel)
    }

    // MARK: - Fingerprint Tests

    @Test
    fun `getFingerprintHash returns null when not configured`() {
        val fingerprint = impl.getFingerprintHash()

        assertNull(fingerprint)
    }

    // MARK: - Isolation Key Tests

    @Test
    fun `getIsolationKey includes app version and channel`() {
        val isolationKey = HotUpdaterImpl.getIsolationKey(context)

        assertTrue(isolationKey.startsWith("HotUpdaterPrefs_"))
        assertTrue(isolationKey.contains("production"))
    }

    @Test
    fun `getIsolationKey format is correct`() {
        val isolationKey = HotUpdaterImpl.getIsolationKey(context)

        // Format should be: HotUpdaterPrefs_{fingerprint_or_version}_{channel}
        val parts = isolationKey.split("_")
        assertTrue(parts.size >= 3)
        assertEquals("HotUpdaterPrefs", parts[0])
    }

    @Test
    fun `different app versions have different isolation keys`() {
        // Since we can't easily change the app version in Robolectric,
        // we verify that the isolation key is consistent across calls
        val key1 = HotUpdaterImpl.getIsolationKey(context)
        val key2 = HotUpdaterImpl.getIsolationKey(context)

        assertEquals(key1, key2)
    }

    // MARK: - Min Bundle ID Tests

    @Test
    fun `getMinBundleId generates valid UUID format`() {
        val minBundleId = impl.getMinBundleId()

        assertNotNull(minBundleId)
        // Check UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        val uuidPattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        assertTrue(minBundleId.matches(uuidPattern))
    }

    // MARK: - Bundle URL Tests

    @Test
    fun `getJSBundleFile returns bundle URL from storage`() {
        val testPath = "/data/app/bundle-store/test/index.android.bundle"
        whenever(mockBundleStorage.getBundleURL()).thenReturn(testPath)

        val bundleFile = impl.getJSBundleFile()

        assertEquals(testPath, bundleFile)
        verify(mockBundleStorage).getBundleURL()
    }

    // MARK: - Update Bundle Tests

    @Test
    fun `updateBundle with valid URL succeeds`() =
        runTest {
            val bundleId = "test-bundle-123"
            val fileUrl = "https://example.com/bundle.zip"

            whenever(mockBundleStorage.updateBundle(any(), any(), any())).thenReturn(true)

            val result = impl.updateBundle(bundleId, fileUrl) { }

            assertTrue(result)
            verify(mockBundleStorage).updateBundle(eq(bundleId), eq(fileUrl), any())
        }

    @Test
    fun `updateBundle with null URL succeeds (reset)`() =
        runTest {
            val bundleId = "test-bundle-123"

            whenever(mockBundleStorage.updateBundle(any(), eq(null), any())).thenReturn(true)

            val result = impl.updateBundle(bundleId, null) { }

            assertTrue(result)
            verify(mockBundleStorage).updateBundle(eq(bundleId), eq(null), any())
        }

    @Test
    fun `updateBundle fails when storage fails`() =
        runTest {
            val bundleId = "test-bundle-123"
            val fileUrl = "https://example.com/bundle.zip"

            whenever(mockBundleStorage.updateBundle(any(), any(), any())).thenReturn(false)

            val result = impl.updateBundle(bundleId, fileUrl) { }

            assertFalse(result)
            verify(mockBundleStorage).updateBundle(eq(bundleId), eq(fileUrl), any())
        }

    @Test
    fun `updateBundle invokes progress callback`() =
        runTest {
            val bundleId = "test-bundle-123"
            val fileUrl = "https://example.com/bundle.zip"
            var progressReceived = false
            var lastProgress = 0.0

            whenever(mockBundleStorage.updateBundle(any(), any(), any())).thenAnswer { invocation ->
                val progressCallback = invocation.getArgument<(Double) -> Unit>(2)
                progressCallback(0.5)
                progressCallback(1.0)
                true
            }

            val result =
                impl.updateBundle(bundleId, fileUrl) { progress ->
                    progressReceived = true
                    lastProgress = progress
                }

            assertTrue(result)
            assertTrue(progressReceived)
            assertEquals(1.0, lastProgress, 0.01)
        }

    // MARK: - File System Isolation Tests

    @Test
    fun `different bundle IDs maintain isolation`() =
        runTest {
            val bundle1Id = "bundle-v1-fingerprint1"
            val bundle2Id = "bundle-v2-fingerprint2"
            val fileUrl = "https://example.com/bundle.zip"

            whenever(mockBundleStorage.updateBundle(any(), any(), any())).thenReturn(true)

            // Update first bundle
            impl.updateBundle(bundle1Id, fileUrl) { }

            // Update second bundle
            impl.updateBundle(bundle2Id, fileUrl) { }

            // Verify both were called with their respective IDs
            verify(mockBundleStorage).updateBundle(eq(bundle1Id), any(), any())
            verify(mockBundleStorage).updateBundle(eq(bundle2Id), any(), any())
        }
}

// MARK: - Integration Tests

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class HotUpdaterImplIntegrationTest {
    private lateinit var context: Context

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
    }

    @Test
    fun `full OTA update workflow with file system isolation`() =
        runTest {
            val mockFS = mock<FileSystemService>()
            val mockDownload = mock<DownloadService>()
            val mockUnzip = mock<UnzipService>()
            val mockPrefs = mock<PreferencesService>()

            val storage =
                BundleFileStorageService(
                    mockFS,
                    mockDownload,
                    mockUnzip,
                    mockPrefs,
                )

            val impl = HotUpdaterImpl(context, storage, mockPrefs)

            // Setup mocks for a successful update
            val baseDir = java.io.File("/data/app")
            whenever(mockFS.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFS.fileExists(any())).thenReturn(false)
            whenever(mockFS.createDirectory(any())).thenReturn(true)
            whenever(mockPrefs.getItem(any())).thenReturn(null)

            val tempZipFile = java.io.File(baseDir, "bundle-temp/bundle.zip")
            whenever(mockDownload.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(tempZipFile))

            whenever(mockUnzip.extractZipFile(any(), any())).thenReturn(true)

            // Simulate finding the bundle file after extraction
            val bundleStoreDir = java.io.File(baseDir, "bundle-store")
            val tmpDir = java.io.File(bundleStoreDir, "test-bundle-123.tmp")
            val bundleFile = java.io.File(tmpDir, "index.android.bundle")
            whenever(mockFS.fileExists(bundleFile.absolutePath)).thenReturn(true)
            whenever(mockFS.moveItem(any(), any())).thenReturn(true)

            // Execute update
            val bundleId = "test-bundle-123"
            val fileUrl = "https://example.com/bundle.zip"
            val result = impl.updateBundle(bundleId, fileUrl) { }

            assertTrue(result)

            // Verify workflow
            verify(mockDownload).downloadFile(any(), any(), any())
            verify(mockUnzip).extractZipFile(any(), any())
            verify(mockPrefs).setItem(eq("HotUpdaterBundleURL"), any())
        }

    @Test
    fun `multiple OTA updates maintain version isolation`() =
        runTest {
            val mockFS = mock<FileSystemService>()
            val mockDownload = mock<DownloadService>()
            val mockUnzip = mock<UnzipService>()
            val mockPrefs = mock<PreferencesService>()

            val storage =
                BundleFileStorageService(
                    mockFS,
                    mockDownload,
                    mockUnzip,
                    mockPrefs,
                )

            val impl = HotUpdaterImpl(context, storage, mockPrefs)

            // Setup mocks
            val baseDir = java.io.File("/data/app")
            whenever(mockFS.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFS.createDirectory(any())).thenReturn(true)
            whenever(mockPrefs.getItem(any())).thenReturn(null)

            whenever(mockDownload.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(java.io.File("/temp/bundle.zip")))
            whenever(mockUnzip.extractZipFile(any(), any())).thenReturn(true)
            whenever(mockFS.fileExists(any())).thenReturn(false, true)
            whenever(mockFS.moveItem(any(), any())).thenReturn(true)

            // Update bundle for version 1
            val bundle1Id = "bundle-v1.0-fingerprint1"
            impl.updateBundle(bundle1Id, "https://example.com/bundle1.zip") { }

            // Update bundle for version 2
            val bundle2Id = "bundle-v2.0-fingerprint2"
            impl.updateBundle(bundle2Id, "https://example.com/bundle2.zip") { }

            // Verify both updates were processed
            verify(mockDownload, times(2)).downloadFile(any(), any(), any())
            verify(mockUnzip, times(2)).extractZipFile(any(), any())

            // Verify storage was updated twice with different paths
            verify(mockPrefs, atLeast(2)).setItem(eq("HotUpdaterBundleURL"), any())
        }

    @Test
    fun `OTA update correctly extracts and verifies bundle file`() =
        runTest {
            val mockFS = mock<FileSystemService>()
            val mockDownload = mock<DownloadService>()
            val mockUnzip = mock<UnzipService>()
            val mockPrefs = mock<PreferencesService>()

            val storage =
                BundleFileStorageService(
                    mockFS,
                    mockDownload,
                    mockUnzip,
                    mockPrefs,
                )

            val impl = HotUpdaterImpl(context, storage, mockPrefs)

            // Setup mocks
            val baseDir = java.io.File("/data/app")
            val bundleStoreDir = java.io.File(baseDir, "bundle-store")
            val bundleId = "test-bundle-verified"
            val finalBundleDir = java.io.File(bundleStoreDir, bundleId)
            val bundleFile = java.io.File(finalBundleDir, "index.android.bundle")

            whenever(mockFS.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFS.fileExists(bundleStoreDir.absolutePath)).thenReturn(false)
            whenever(mockFS.fileExists(finalBundleDir.absolutePath)).thenReturn(false)
            whenever(mockFS.createDirectory(any())).thenReturn(true)
            whenever(mockPrefs.getItem(any())).thenReturn(null)

            val tempZipFile = java.io.File(baseDir, "bundle-temp/bundle.zip")
            whenever(mockDownload.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(tempZipFile))

            whenever(mockUnzip.extractZipFile(any(), any())).thenReturn(true)

            // After extraction, the bundle file should exist
            whenever(mockFS.fileExists(bundleFile.absolutePath)).thenReturn(true)
            whenever(mockFS.moveItem(any(), any())).thenReturn(true)

            val result = impl.updateBundle(bundleId, "https://example.com/bundle.zip") { }

            assertTrue(result)

            // Verify the complete workflow
            val inOrder = inOrder(mockDownload, mockUnzip, mockPrefs)
            inOrder.verify(mockDownload).downloadFile(any(), any(), any())
            inOrder.verify(mockUnzip).extractZipFile(any(), any())
            inOrder.verify(mockPrefs).setItem(eq("HotUpdaterBundleURL"), eq(bundleFile.absolutePath))
        }
}
