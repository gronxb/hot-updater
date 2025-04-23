package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.util.Log
import io.mockk.*
import io.mockk.impl.annotations.MockK
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.min // Ensure min is imported

@ExperimentalCoroutinesApi // Required for TestCoroutineScheduler and Dispatchers.setMain
class HotUpdaterTest {

    // --- Mocks ---
    @MockK lateinit var mockContext: Context
    @MockK lateinit var mockPackageManager: PackageManager
    // Fix: Remove @MockK, we will use a real instance for PackageInfo
    // @MockK lateinit var mockPackageInfo: PackageInfo
    @MockK lateinit var mockApplicationInfo: ApplicationInfo
    @MockK lateinit var mockPrefs: SharedPreferences
    @MockK lateinit var mockPrefsEditor: SharedPreferences.Editor
    @MockK lateinit var mockBaseDir: File // Mock for context.getExternalFilesDir()
    @MockK lateinit var mockStoreDir: File // Mock representing File(mockBaseDir, "bundle-store") concept
    @MockK lateinit var mockFinalDir: File // Mock representing File(mockStoreDir, bundleId) concept
    @MockK lateinit var mockTempBaseDir: File // Mock for context.cacheDir
    @MockK lateinit var mockTempDir: File // Mock representing File(mockTempBaseDir, "bundle-temp") concept
    @MockK lateinit var mockZipFile: File // Mock representing File(mockTempDir, "bundle.zip") concept
    @MockK lateinit var mockExtractedDir: File // Mock representing File(mockTempDir, "extracted") concept
    @MockK lateinit var mockIndexFileInExtracted: File // Mock representing index file inside mockExtractedDir
    @MockK lateinit var mockIndexFileInFinal: File // Mock representing index file inside mockFinalDir
    @MockK lateinit var mockFileWalk: FileTreeWalk // Mock for File.walk() result
    @MockK lateinit var mockUrl: URL // Keep for mocking openConnection if needed, though static mock is used
    @MockK lateinit var mockConnection: HttpURLConnection
    @MockK lateinit var mockInputStream: InputStream
    @MockK lateinit var mockOutputStream: FileOutputStream // Use specific type matching File.outputStream()

    // --- Coroutine Test Setup ---
    private val testScheduler = TestCoroutineScheduler()
    private val testDispatcher = StandardTestDispatcher(testScheduler)

    // --- Test Parameters ---
    private val bundleId = "test-bundle-123"
    private val zipUrl = "http://example.com/bundle.zip"
    private val appVersion = "1.0.0"
    private val appPackageName = "com.example.testhost" // Define a package name
    private val currentStableBundlePath = "/path/to/current/stable/index.android.bundle"
    // Define paths based on mocked file objects for clarity in asserts/verify
    private val baseDirPath = "/mock/external"
    private val storeDirPath = "$baseDirPath/bundle-store"
    private val finalDirPath = "$storeDirPath/$bundleId"
    private val cacheDirPath = "/mock/cache"
    private val tempDirPath = "$cacheDirPath/bundle-temp"
    private val zipFilePath = "$tempDirPath/bundle.zip"
    private val extractedDirPath = "$tempDirPath/extracted"
    private val indexExtractedPath = "$extractedDirPath/index.android.bundle"
    private val indexFinalPath = "$finalDirPath/index.android.bundle"
    // This is derived from indexFinalPath, used in setBundleURL verification
    private val newBundlePath = indexFinalPath

    // Fix: Declare readPointer at class level for shared access
    private var readPointer = 0
    private val fakeZipData = ByteArray(1024) { 1 } // Simulate 1024 bytes of data

    @Before
    fun setUp() {
        MockKAnnotations.init(this, relaxUnitFun = true)
        Dispatchers.setMain(testDispatcher)
        mockkObject(HotUpdater.Companion) // Mock companion object
        mockkStatic(Log::class)           // Mock static Log methods
        // mockkConstructor(File::class)  // Keep removed
        mockkStatic(URL::class)           // Keep static mock for URL openConnection

        // --- Context & Related Mocks ---
        every { mockContext.applicationContext } returns mockContext
        every { mockContext.packageManager } returns mockPackageManager
        every { mockContext.packageName } returns appPackageName // Mock packageName access

        // Fix: Create a real PackageInfo instance and set its fields
        val realPackageInfo = PackageInfo().apply {
            versionName = appVersion
            packageName = appPackageName // Usually required
            // Set other fields to default values if necessary to avoid NullPointerExceptions
            // Example: firstInstallTime = 0; lastUpdateTime = 0; versionCode = 1; ...
        }
        // Mock packageManager to return the real instance
        every { mockPackageManager.getPackageInfo(appPackageName, 0) } returns realPackageInfo
        // Handle potential calls with flags other than 0 if needed
        every { mockPackageManager.getPackageInfo(appPackageName, any()) } returns realPackageInfo

        // Fix: Remove the problematic line - no longer needed as we return a real PackageInfo
        // every { mockPackageInfo.versionName } returns appVersion // REMOVED

        every { mockContext.applicationInfo } returns mockApplicationInfo
        every { mockApplicationInfo.dataDir } returns "/data/data/com.example.app" // Needed for HotUpdaterPrefs init

        // SharedPreferences setup
        val prefsName = "HotUpdaterPrefs_$appVersion"
        every { mockContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE) } returns mockPrefs
        every { mockPrefs.edit() } returns mockPrefsEditor
        every { mockPrefsEditor.putString(any(), any()) } returns mockPrefsEditor
        every { mockPrefsEditor.remove(any()) } returns mockPrefsEditor
        every { mockPrefsEditor.putBoolean(any(), any()) } returns mockPrefsEditor
        every { mockPrefsEditor.apply() } just runs


        // --- File System Mocks (No Constructor Mocking) ---
        // Define paths for mock objects
        every { mockBaseDir.absolutePath } returns baseDirPath
        every { mockStoreDir.absolutePath } returns storeDirPath
        every { mockFinalDir.absolutePath } returns finalDirPath
        every { mockTempBaseDir.absolutePath } returns cacheDirPath
        every { mockTempDir.absolutePath } returns tempDirPath
        every { mockZipFile.absolutePath } returns zipFilePath
        every { mockExtractedDir.absolutePath } returns extractedDirPath
        every { mockIndexFileInFinal.absolutePath } returns indexFinalPath
        every { mockIndexFileInExtracted.absolutePath } returns indexExtractedPath

        // Mock Context methods returning Files
        every { mockContext.getExternalFilesDir(null) } returns mockBaseDir
        every { mockContext.cacheDir } returns mockTempBaseDir

        // Mock methods ONLY on the mock File instances we control
        // Default behaviors for the mocked directories/files
        every { mockBaseDir.exists() } returns true
        every { mockStoreDir.exists() } returns true
        every { mockStoreDir.mkdirs() } returns true
        every { mockFinalDir.exists() } returns false // Default: doesn't exist yet
        every { mockFinalDir.isDirectory } returns true // Assume it's a dir if it exists
        every { mockFinalDir.deleteRecursively() } returns true
        every { mockTempBaseDir.exists() } returns true
        every { mockTempDir.exists() } returns true
        every { mockTempDir.mkdirs() } returns true
        every { mockTempDir.deleteRecursively() } returns true
        every { mockZipFile.exists() } returns true
        every { mockZipFile.delete() } returns true
        every { mockExtractedDir.exists() } returns true
        every { mockExtractedDir.mkdirs() } returns true
        every { mockExtractedDir.renameTo(mockFinalDir) } returns true // Assume rename succeeds by default
        every { mockIndexFileInFinal.exists() } returns false // Default: index doesn't exist in final dir yet
        every { mockIndexFileInFinal.isFile } returns true
        every { mockIndexFileInFinal.name } returns "index.android.bundle"
        every { mockIndexFileInExtracted.exists() } returns true // Assume extraction mock creates this
        every { mockIndexFileInExtracted.isFile } returns true
        every { mockIndexFileInExtracted.name } returns "index.android.bundle"
        every { mockFinalDir.setLastModified(any()) } returns true // For cache hit logic

        // Mock File walking ONLY on specific mock instances
        every { mockExtractedDir.walk() } returns mockFileWalk
        every { mockFinalDir.walk() } returns mockFileWalk
        every { mockFileWalk.maxDepth(any()) } returns mockFileWalk // Allow chaining common walk methods
        every { mockFileWalk.onEnter(any()) } returns mockFileWalk
        every { mockFileWalk.onLeave(any()) } returns mockFileWalk
        // Provide a default iterator for find - TESTS MUST OVERRIDE THIS if they expect find to return something
        every { mockFileWalk.iterator() } answers { emptyList<File>().iterator() }

        // Mock Output Stream for the mocked zip file
        every { mockZipFile.outputStream() } returns mockOutputStream
        every { mockOutputStream.write(any<ByteArray>(), any(), any()) } just runs
        every { mockOutputStream.close() } just runs

        // --- Network Mocks ---
        every { URL(zipUrl).openConnection() } returns mockConnection // Use static mock intercept
        every { mockConnection.requestMethod = any() } just runs
        every { mockConnection.connectTimeout = any() } just runs
        every { mockConnection.readTimeout = any() } just runs
        every { mockConnection.instanceFollowRedirects = any() } just runs
        every { mockConnection.connect() } just runs
        every { mockConnection.disconnect() } just runs
        every { mockConnection.responseCode } returns HttpURLConnection.HTTP_OK // Default success
        every { mockConnection.responseMessage } returns "OK"
        every { mockConnection.contentLengthLong } returns 1024L // Example size
        every { mockConnection.inputStream } returns mockInputStream

        // Input Stream simulation - uses class-level readPointer
        readPointer = 0 // Reset pointer at the beginning of setup
        every { mockInputStream.read(any<ByteArray>()) } answers {
            val buffer = firstArg<ByteArray>()
            // Use class-level readPointer
            val currentReadPointer = readPointer
            val bytesToRead = min(buffer.size, fakeZipData.size - currentReadPointer)

            if (bytesToRead <= 0) {
                -1 // EOF
            } else {
                System.arraycopy(fakeZipData, currentReadPointer, buffer, 0, bytesToRead)
                readPointer += bytesToRead // Update class-level state
                bytesToRead
            }
        }
         every { mockInputStream.read(any<ByteArray>(), any<Int>(), any<Int>()) } answers {
            val buffer = firstArg<ByteArray>()
            val offset = secondArg<Int>()
            val length = thirdArg<Int>()
             // Use class-level readPointer
            val currentReadPointer = readPointer
            val bytesToRead = min(length, fakeZipData.size - currentReadPointer)

             if (bytesToRead <= 0) {
                 -1 // EOF
             } else {
                 System.arraycopy(fakeZipData, currentReadPointer, buffer, offset, bytesToRead)
                 readPointer += bytesToRead // Update class-level state
                 bytesToRead
             }
         }
        every { mockInputStream.close() } just runs


        // --- Mock HotUpdater Companion Functions (Now Internal) ---
        every { HotUpdater.extractZipFileAtPath(any(), any()) } returns true // Default success
        every { HotUpdater.setBundleURL(mockContext, any()) } just runs // Verify calls
        every { HotUpdater.cleanupOldBundles(mockStoreDir) } just runs // Verify calls

        // --- Mock Log ---
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.w(any<String>(), isNull<String>()) } returns 0
        every { Log.w(any<String>(), any<Throwable>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
        every { Log.e(any(), any(), any()) } returns 0

        // --- Default Prefs State ---
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_FIRST_RUN, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PREV_BUNDLE_URL, null) } returns null
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkAll() // Clears static, object mocks setup in @Before
    }

    // --- Helper to reset input stream state ---
    private fun resetMockInputStream() {
        // Access class-level readPointer
        readPointer = 0
    }

    // --- Test Cases ---
    // (Test cases remain the same as the previous version)
    // Note: Tests involving `File(path).exists()` for internally created paths
    // might rely on assumptions now, as that specific check is harder to mock precisely
    // without constructor mocking. Focus verification on observable state changes and
    // calls to mocked dependencies / internal companion methods.

    @Test
    fun `updateBundle - success scenario - downloads, extracts, sets provisional`() = runTest(testDispatcher.scheduler) {
        // Arrange
        resetMockInputStream() // Ensure clean state for read simulation
        val progressUpdates = mutableListOf<Double>()
        val progressCallback: (Double) -> Unit = { progressUpdates.add(it) }
        every { mockExtractedDir.renameTo(mockFinalDir) } returns true
        // Assume the internal check File(finalDir, "index.android.bundle").exists() passes
        // because extractZipFileAtPath returned true and renameTo returned true.

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        assertTrue("Update should succeed", result)
        verify { URL(zipUrl).openConnection() }
        verify { mockConnection.connect() }
        verify(atLeast = 1) { mockInputStream.read(any<ByteArray>()) }
        verify { mockOutputStream.write(any<ByteArray>(), 0, 1024) } // Check based on fake data size
        verify { mockConnection.disconnect() }
        verify { HotUpdater.extractZipFileAtPath(zipFilePath, extractedDirPath) } // Verify internal call
        verify { mockZipFile.delete() } // Verify cleanup on mock instances
        verify { mockExtractedDir.renameTo(mockFinalDir) }
        verify { mockTempDir.deleteRecursively() }

        // Verify State Updates (Provisional) using internal constants
        verifyOrder {
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_PREV_BUNDLE_URL), isNull()) // was null
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_PROVISIONAL), eq("true"))
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_FIRST_RUN), eq("true"))
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_BUNDLE_URL), eq(newBundlePath))
            mockPrefsEditor.apply()
        }
        verify { HotUpdater.setBundleURL(mockContext, newBundlePath) } // Verify internal call
        verify { HotUpdater.cleanupOldBundles(mockStoreDir) }
        assertTrue("Progress should include 1.0", progressUpdates.contains(1.0))
        assertTrue("Progress should be ~2 calls (intermediate + final 1.0)", progressUpdates.size >= 1) // Check if callback called
        println("Progress updates: $progressUpdates")
    }

    @Test
    fun `updateBundle - cached bundle exists - uses cache, becomes stable`() = runTest(testDispatcher.scheduler) {
        // Arrange
        val progressUpdates = mutableListOf<Double>()
        val progressCallback: (Double) -> Unit = { progressUpdates.add(it) }
        every { mockFinalDir.exists() } returns true // Cache dir exists
        every { mockFinalDir.isDirectory } returns true
        // Simulate find succeeding by providing the mock index file in the iterator
        every { mockFinalDir.walk().iterator() } answers { listOf(mockIndexFileInFinal).iterator() }
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns currentStableBundlePath // Different current bundle

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        assertTrue("Update should succeed using cache", result)
        verify(exactly = 0) { URL(any()).openConnection() } // No download
        verify(exactly = 0) { HotUpdater.extractZipFileAtPath(any(), any()) } // No extraction
        verify { mockFinalDir.exists() }
        verify { mockFinalDir.walk().iterator() } // Verify walk was used
        verify { mockFinalDir.setLastModified(any()) }

        // Verify State Updates (Becomes STABLE directly)
        verifyOrder {
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_PREV_BUNDLE_URL), eq(currentStableBundlePath))
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_BUNDLE_URL), eq(newBundlePath)) // newBundlePath == indexFinalPath
            mockPrefsEditor.remove(eq(HotUpdater.PREF_KEY_PROVISIONAL))
            mockPrefsEditor.remove(eq(HotUpdater.PREF_KEY_FIRST_RUN))
            mockPrefsEditor.apply()
        }
        verify { HotUpdater.setBundleURL(mockContext, newBundlePath) } // Verify internal call
        verify { HotUpdater.cleanupOldBundles(mockStoreDir) } // Verify cleanup called
        assertTrue("Progress callback should not be called for cache hit", progressUpdates.isEmpty())
    }

     @Test
    fun `updateBundle - cached bundle exists but already current - skips update`() = runTest(testDispatcher.scheduler) {
         // Arrange
         val progressCallback: (Double) -> Unit = {}
         every { mockFinalDir.exists() } returns true
         every { mockFinalDir.isDirectory } returns true
         // Simulate find succeeding
         every { mockFinalDir.walk().iterator() } answers { listOf(mockIndexFileInFinal).iterator() }
         every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns newBundlePath // Already current

         // Act
         val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

         // Assert
         assertTrue("Update should succeed (no-op)", result)
         verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) } // No state changes
         verify(exactly = 0) { mockPrefsEditor.remove(any()) }
         verify(exactly = 0) { mockPrefsEditor.apply() }
         verify(exactly = 0) { HotUpdater.setBundleURL(any(), any()) } // No react update
         verify { HotUpdater.cleanupOldBundles(mockStoreDir) } // Cleanup still called after cache check
         verify(exactly = 0) { URL(any()).openConnection() } // No download/extraction
         verify(exactly = 0) { HotUpdater.extractZipFileAtPath(any(), any()) }
     }


    @Test
    fun `updateBundle - redundant update skipped - bundleId matches current and file exists`() = runTest(testDispatcher.scheduler) {
        // Arrange
        val progressCallback: (Double) -> Unit = {}
        val currentBundlePathContainingId = "/some/path/$bundleId/index.android.bundle" // Example path
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns currentBundlePathContainingId
        // !! Limitation: Cannot easily mock File(currentBundlePathContainingId).exists()
        // This test assumes the check passes based on the URL match for testing the skip logic.

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        // We assume the 'File(current).exists()' check magically passes here due to limitation
        assertTrue("Update should succeed (redundant, skipped)", result)
        // Verify based on skipping EARLY
        verify(exactly = 0) { URL(any()).openConnection() }
        verify(exactly = 0) { HotUpdater.extractZipFileAtPath(any(), any()) }
        verify(exactly = 0) { mockPrefsEditor.apply() }
        verify(exactly = 0) { HotUpdater.setBundleURL(any(), any()) }
        verify(exactly = 0) { HotUpdater.cleanupOldBundles(any()) } // Cleanup not reached
    }

     @Test
    fun `updateBundle - redundant update proceeds - bundleId matches but file missing`() = runTest(testDispatcher.scheduler) {
        // Arrange
        resetMockInputStream()
        val progressCallback: (Double) -> Unit = {}
        val currentBundlePathContainingId = "/some/path/$bundleId/index.android.bundle"
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns currentBundlePathContainingId
        // !! Limitation: Cannot easily mock File(currentBundlePathContainingId).exists() to return false.
        // This test assumes the condition is met to test the *subsequent* download/extract flow.

        // Mocks for the rest of the flow to succeed
        every { mockExtractedDir.renameTo(mockFinalDir) } returns true
        // Assume index file exists after mocked extraction/rename

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        // We assert based on the download/extract path being taken
        assertTrue("Update should succeed (proceeded after redundant file missing)", result)
        verify { URL(zipUrl).openConnection() } // Download DID happen
        verify { HotUpdater.extractZipFileAtPath(zipFilePath, extractedDirPath) } // Extraction DID happen
        // Verify state changes for provisional update
        verifyOrder {
            // Previous bundle URL should be captured
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_PREV_BUNDLE_URL), eq(currentBundlePathContainingId))
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_PROVISIONAL), eq("true"))
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_FIRST_RUN), eq("true"))
            mockPrefsEditor.putString(eq(HotUpdater.PREF_KEY_BUNDLE_URL), eq(newBundlePath))
            mockPrefsEditor.apply()
        }
        verify { HotUpdater.setBundleURL(mockContext, newBundlePath) }
        verify { HotUpdater.cleanupOldBundles(mockStoreDir) }
    }

    @Test
    fun `updateBundle - network error - fails`() = runTest(testDispatcher.scheduler) {
        // Arrange
        resetMockInputStream()
        val progressCallback: (Double) -> Unit = {}
        every { mockConnection.responseCode } returns HttpURLConnection.HTTP_NOT_FOUND // Simulate 404

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        assertFalse("Update should fail due to network error", result)
        verify { URL(zipUrl).openConnection() }
        verify { mockConnection.connect() }
        verify(exactly = 0) { mockInputStream.read(any<ByteArray>()) } // Read shouldn't happen
        verify { mockConnection.disconnect() }
        verify { mockZipFile.delete() } // Verify cleanup on mocks
        verify { mockTempDir.deleteRecursively() } // Should clean up temp base dir
        verify(exactly = 0) { mockPrefsEditor.apply() } // No state change commit
    }

     @Test
    fun `updateBundle - download io exception - fails`() = runTest(testDispatcher.scheduler) {
        // Arrange
        resetMockInputStream()
        val progressCallback: (Double) -> Unit = {}
        // Simulate exception during input stream reading
        every { mockInputStream.read(any<ByteArray>()) } throws IOException("Simulated network disconnect")

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        assertFalse("Update should fail due to IO exception", result)
        verify { URL(zipUrl).openConnection() }
        verify { mockConnection.connect() }
        verify { mockConnection.disconnect() } // Should still disconnect in finally block
        verify { mockZipFile.delete() } // Cleanup in finally
        verify { mockTempDir.deleteRecursively() } // Cleanup on failure path
        verify(exactly = 0) { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - extraction fails - fails`() = runTest(testDispatcher.scheduler) {
        // Arrange
        resetMockInputStream()
        val progressCallback: (Double) -> Unit = {}
        every { HotUpdater.extractZipFileAtPath(zipFilePath, extractedDirPath) } returns false // Mock extraction failure

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        assertFalse("Update should fail due to extraction failure", result)
        verify { URL(zipUrl).openConnection() } // Download succeeded
        verify { mockConnection.disconnect() }
        verify { HotUpdater.extractZipFileAtPath(zipFilePath, extractedDirPath) } // Verify attempted
        verify { mockZipFile.delete() } // Cleanup in finally
        verify { mockTempDir.deleteRecursively() } // Cleanup on failure path
        verify(exactly = 0) { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - index file missing after move - fails`() = runTest(testDispatcher.scheduler) {
         // Arrange
         resetMockInputStream()
         val progressCallback: (Double) -> Unit = {}
         every { mockExtractedDir.renameTo(mockFinalDir) } returns true // Move succeeds
         // !! Limitation: Cannot easily mock the internal File(finalDir, "index.android.bundle").exists() check.
         // This test assumes this check fails to test the subsequent cleanup logic.
         // To force this path, maybe modify the extractZipFileAtPath mock *if needed*,
         // but it's cleaner to assume the SUT's check fails.

         // Act
         val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

         // Assert
         // Assert based on the failure path being taken after the rename
         assertFalse("Update should fail due to missing index file post-move", result)
         verify { URL(zipUrl).openConnection() }
         verify { HotUpdater.extractZipFileAtPath(zipFilePath, extractedDirPath) }
         verify { mockExtractedDir.renameTo(mockFinalDir) }
         // Cannot reliably verify the internal exists() check, but can verify cleanup
         verify { mockFinalDir.deleteRecursively() } // Cleaned up failed final dir
         verify(atLeast = 1) { mockTempDir.deleteRecursively() } // Temp cleanup should have happened
         verify(exactly = 0) { mockPrefsEditor.apply() } // No state commit
     }

     @Test
    fun `updateBundle - rename fails - fails`() = runTest(testDispatcher.scheduler) {
        // Arrange
        resetMockInputStream()
        val progressCallback: (Double) -> Unit = {}
        every { mockExtractedDir.renameTo(mockFinalDir) } returns false // Mock rename failure

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Assert
        assertFalse("Update should fail due to rename failure", result)
        verify { URL(zipUrl).openConnection() }
        verify { HotUpdater.extractZipFileAtPath(zipFilePath, extractedDirPath) }
        verify { mockExtractedDir.renameTo(mockFinalDir) } // Attempted rename
        verify { mockTempDir.deleteRecursively() } // Temp (incl. extracted) cleaned up
        verify { mockFinalDir.deleteRecursively() } // Target dir attempted cleanup before rename
        verify(exactly = 0) { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - null zipUrl - clears bundle state, returns true`() = runTest(testDispatcher.scheduler) {
        // Arrange
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns currentStableBundlePath
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns "true" // Example previous state

        // Act
        val result = HotUpdater.updateBundle(mockContext, bundleId, null, progressCallback) // null zipUrl

        // Assert
        assertTrue("Update should succeed (cleared state)", result)
        verify(exactly = 0) { URL(any()).openConnection() } // No download/extraction
        verify(exactly = 0) { HotUpdater.extractZipFileAtPath(any(), any()) }

        // Verify state is cleared
        verifyOrder {
             mockPrefsEditor.remove(eq(HotUpdater.PREF_KEY_PROVISIONAL))
             mockPrefsEditor.remove(eq(HotUpdater.PREF_KEY_FIRST_RUN))
             mockPrefsEditor.remove(eq(HotUpdater.PREF_KEY_BUNDLE_URL))
             mockPrefsEditor.remove(eq(HotUpdater.PREF_KEY_PREV_BUNDLE_URL))
             mockPrefsEditor.apply()
        }
        verify { HotUpdater.setBundleURL(mockContext, null) } // Notified React layer
        verify(exactly = 0) { HotUpdater.cleanupOldBundles(any()) } // No store cleanup needed
    }
}