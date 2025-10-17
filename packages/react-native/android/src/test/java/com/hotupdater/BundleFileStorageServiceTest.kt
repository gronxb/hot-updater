package com.hotupdater

import android.content.Context
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.mock
import org.mockito.kotlin.never
import org.mockito.kotlin.times
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class BundleFileStorageServiceTest {
    private lateinit var context: Context
    private lateinit var mockFileSystem: FileSystemService
    private lateinit var mockDownloadService: DownloadService
    private lateinit var mockUnzipService: UnzipService
    private lateinit var mockPreferences: PreferencesService
    private lateinit var service: BundleFileStorageService

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        mockFileSystem = mock()
        mockDownloadService = mock()
        mockUnzipService = mock()
        mockPreferences = mock()

        service =
            BundleFileStorageService(
                mockFileSystem,
                mockDownloadService,
                mockUnzipService,
                mockPreferences,
            )
    }

    // MARK: - Bundle URL Tests

    @Test
    fun `getCachedBundleURL returns URL when file exists`() {
        val bundlePath = "/data/app/bundle-store/test-bundle/index.android.bundle"
        whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(bundlePath)
        whenever(mockFileSystem.fileExists(bundlePath)).thenReturn(true)

        val url = service.getCachedBundleURL()

        assertEquals(bundlePath, url)
        verify(mockPreferences).getItem("HotUpdaterBundleURL")
        verify(mockFileSystem).fileExists(bundlePath)
    }

    @Test
    fun `getCachedBundleURL returns null when file does not exist`() {
        val bundlePath = "/data/app/bundle-store/test-bundle/index.android.bundle"
        whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(bundlePath)
        whenever(mockFileSystem.fileExists(bundlePath)).thenReturn(false)

        val url = service.getCachedBundleURL()

        assertNull(url)
        verify(mockPreferences).setItem("HotUpdaterBundleURL", null)
    }

    @Test
    fun `getCachedBundleURL returns null when preferences is empty`() {
        whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

        val url = service.getCachedBundleURL()

        assertNull(url)
    }

    @Test
    fun `getFallbackBundleURL returns assets path`() {
        val fallbackUrl = service.getFallbackBundleURL()

        assertEquals("assets://index.android.bundle", fallbackUrl)
    }

    @Test
    fun `getBundleURL returns cached URL when available`() {
        val bundlePath = "/data/app/bundle-store/test-bundle/index.android.bundle"
        whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(bundlePath)
        whenever(mockFileSystem.fileExists(bundlePath)).thenReturn(true)

        val url = service.getBundleURL()

        assertEquals(bundlePath, url)
    }

    @Test
    fun `getBundleURL returns fallback URL when cached not available`() {
        whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

        val url = service.getBundleURL()

        assertEquals("assets://index.android.bundle", url)
    }

    // MARK: - Set Bundle URL Tests

    @Test
    fun `setBundleURL saves path to preferences`() {
        val bundlePath = "/data/app/bundle-store/test-bundle/index.android.bundle"

        val result = service.setBundleURL(bundlePath)

        assertTrue(result)
        verify(mockPreferences).setItem("HotUpdaterBundleURL", bundlePath)
    }

    @Test
    fun `setBundleURL with null clears preferences`() {
        val result = service.setBundleURL(null)

        assertTrue(result)
        verify(mockPreferences).setItem("HotUpdaterBundleURL", null)
    }

    // MARK: - Update Bundle Tests

    @Test
    fun `updateBundle with null fileUrl resets bundle`() =
        runTest {
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            val result = service.updateBundle("test-bundle", null) { }

            assertTrue(result)
            verify(mockPreferences).setItem("HotUpdaterBundleURL", null)
        }

    @Test
    fun `updateBundle uses cached bundle when it exists`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")
            val finalBundleDir = File(bundleStoreDir, "test-bundle-123")
            val bundleFile = File(finalBundleDir, "index.android.bundle")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.fileExists(bundleStoreDir.absolutePath)).thenReturn(true)
            whenever(mockFileSystem.fileExists(finalBundleDir.absolutePath)).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            // Mock the walk() method behavior by directly checking if the bundle exists
            val mockWalk = mock<FileTreeWalk>()
            whenever(mockWalk.find(any())).thenReturn(bundleFile)

            val result = service.updateBundle("test-bundle-123", "https://example.com/bundle.zip") { }

            assertTrue(result)
            verify(mockPreferences).setItem("HotUpdaterBundleURL", bundleFile.absolutePath)
        }

    @Test
    fun `updateBundle downloads and extracts new bundle successfully`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")
            val finalBundleDir = File(bundleStoreDir, "test-bundle-123")
            val tempDir = File(baseDir, "bundle-temp")
            val tempZipFile = File(tempDir, "bundle.zip")
            val tmpDir = File(bundleStoreDir, "test-bundle-123.tmp")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.fileExists(bundleStoreDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(finalBundleDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(tempDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.createDirectory(any())).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            // Mock successful download
            whenever(mockDownloadService.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(tempZipFile))

            // Mock successful unzip
            whenever(mockUnzipService.extractZipFile(any(), any())).thenReturn(true)

            // Mock that the bundle file exists after extraction
            val extractedBundleFile = File(tmpDir, "index.android.bundle")
            whenever(mockFileSystem.fileExists(extractedBundleFile.absolutePath)).thenReturn(true)
            whenever(mockFileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)).thenReturn(true)

            val result = service.updateBundle("test-bundle-123", "https://example.com/bundle.zip") { }

            assertTrue(result)
            verify(mockDownloadService).downloadFile(any(), any(), any())
            verify(mockUnzipService).extractZipFile(tempZipFile.absolutePath, tmpDir.absolutePath)
        }

    @Test
    fun `updateBundle fails when download fails`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")
            val finalBundleDir = File(bundleStoreDir, "test-bundle-123")
            val tempDir = File(baseDir, "bundle-temp")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.fileExists(bundleStoreDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(finalBundleDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(tempDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.createDirectory(any())).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            // Mock failed download
            whenever(mockDownloadService.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Error(Exception("Network error")))

            val result = service.updateBundle("test-bundle-123", "https://example.com/bundle.zip") { }

            assertFalse(result)
            verify(mockDownloadService).downloadFile(any(), any(), any())
            verify(mockUnzipService, never()).extractZipFile(any(), any())
        }

    @Test
    fun `updateBundle fails when unzip fails`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")
            val finalBundleDir = File(bundleStoreDir, "test-bundle-123")
            val tempDir = File(baseDir, "bundle-temp")
            val tempZipFile = File(tempDir, "bundle.zip")
            val tmpDir = File(bundleStoreDir, "test-bundle-123.tmp")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.fileExists(bundleStoreDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(finalBundleDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(tempDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.createDirectory(any())).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            // Mock successful download
            whenever(mockDownloadService.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(tempZipFile))

            // Mock failed unzip
            whenever(mockUnzipService.extractZipFile(any(), any())).thenReturn(false)

            val result = service.updateBundle("test-bundle-123", "https://example.com/bundle.zip") { }

            assertFalse(result)
            verify(mockDownloadService).downloadFile(any(), any(), any())
            verify(mockUnzipService).extractZipFile(tempZipFile.absolutePath, tmpDir.absolutePath)
        }

    @Test
    fun `updateBundle fails when bundle file not found after extraction`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")
            val finalBundleDir = File(bundleStoreDir, "test-bundle-123")
            val tempDir = File(baseDir, "bundle-temp")
            val tempZipFile = File(tempDir, "bundle.zip")
            val tmpDir = File(bundleStoreDir, "test-bundle-123.tmp")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.fileExists(bundleStoreDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(finalBundleDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(tempDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.createDirectory(any())).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            // Mock successful download
            whenever(mockDownloadService.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(tempZipFile))

            // Mock successful unzip but no bundle file found
            whenever(mockUnzipService.extractZipFile(any(), any())).thenReturn(true)

            val result = service.updateBundle("test-bundle-123", "https://example.com/bundle.zip") { }

            assertFalse(result)
            verify(mockDownloadService).downloadFile(any(), any(), any())
            verify(mockUnzipService).extractZipFile(tempZipFile.absolutePath, tmpDir.absolutePath)
        }

    // MARK: - File System Isolation Tests

    @Test
    fun `different bundle IDs use different directories`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.createDirectory(any())).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            // Update first bundle
            val bundle1Dir = File(bundleStoreDir, "bundle-v1-fingerprint1")
            whenever(mockFileSystem.fileExists(bundle1Dir.absolutePath)).thenReturn(false)
            whenever(mockDownloadService.downloadFile(any(), any(), any()))
                .thenReturn(DownloadResult.Success(java.io.File("/temp/bundle.zip")))
            whenever(mockUnzipService.extractZipFile(any(), any())).thenReturn(true)

            service.updateBundle("bundle-v1-fingerprint1", "https://example.com/bundle1.zip") { }

            // Update second bundle with different ID
            val bundle2Dir = File(bundleStoreDir, "bundle-v2-fingerprint2")
            whenever(mockFileSystem.fileExists(bundle2Dir.absolutePath)).thenReturn(false)

            service.updateBundle("bundle-v2-fingerprint2", "https://example.com/bundle2.zip") { }

            // Verify both bundles were processed independently
            verify(mockDownloadService, times(2)).downloadFile(any(), any(), any())
        }

    @Test
    fun `updateBundle progress callback is invoked during download`() =
        runTest {
            val baseDir = File("/data/app")
            val bundleStoreDir = File(baseDir, "bundle-store")
            val finalBundleDir = File(bundleStoreDir, "test-bundle-123")
            val tempDir = File(baseDir, "bundle-temp")
            val tempZipFile = File(tempDir, "bundle.zip")

            whenever(mockFileSystem.getExternalFilesDir()).thenReturn(baseDir)
            whenever(mockFileSystem.fileExists(bundleStoreDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.fileExists(finalBundleDir.absolutePath)).thenReturn(false)
            whenever(mockFileSystem.createDirectory(any())).thenReturn(true)
            whenever(mockPreferences.getItem("HotUpdaterBundleURL")).thenReturn(null)

            var progressReceived = false
            var lastProgress = 0.0

            whenever(mockDownloadService.downloadFile(any(), any(), any())).thenAnswer { invocation ->
                val progressCallback = invocation.getArgument<(Double) -> Unit>(2)
                progressCallback(0.5)
                progressCallback(1.0)
                DownloadResult.Success(tempZipFile)
            }

            whenever(mockUnzipService.extractZipFile(any(), any())).thenReturn(true)

            service.updateBundle("test-bundle-123", "https://example.com/bundle.zip") { progress ->
                progressReceived = true
                lastProgress = progress
            }

            assertTrue(progressReceived)
            assertEquals(1.0, lastProgress, 0.01)
        }
}
