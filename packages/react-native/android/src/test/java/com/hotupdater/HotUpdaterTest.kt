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
import kotlin.math.min

@ExperimentalCoroutinesApi
class HotUpdaterTest {

    @MockK
    private lateinit var mockContext: Context

    @MockK
    private lateinit var mockPackageManager: PackageManager

    @MockK
    private lateinit var mockApplicationInfo: ApplicationInfo

    @MockK
    private lateinit var mockPrefs: SharedPreferences

    @MockK
    private lateinit var mockPrefsEditor: SharedPreferences.Editor

    @MockK
    private lateinit var mockBaseDir: File

    @MockK
    private lateinit var mockStoreDir: File

    @MockK
    private lateinit var mockFinalDir: File

    @MockK
    private lateinit var mockTempBaseDir: File

    @MockK
    private lateinit var mockTempDir: File

    @MockK
    private lateinit var mockZipFile: File

    @MockK
    private lateinit var mockExtractedDir: File

    @MockK
    private lateinit var mockIndexFileInExtracted: File

    @MockK
    private lateinit var mockIndexFileInFinal: File

    @MockK
    private lateinit var mockFileWalk: FileTreeWalk

    @MockK
    private lateinit var mockConnection: HttpURLConnection

    @MockK
    private lateinit var mockInputStream: InputStream

    @MockK
    private lateinit var mockOutputStream: FileOutputStream

    private val testScheduler = TestCoroutineScheduler()
    private val testDispatcher = StandardTestDispatcher(testScheduler)

    private val bundleId = "test-bundle-123"
    private val zipUrl = "https://example.com/bundle.zip"
    private val appVersion = "1.0.0"
    private val appPackageName = "com.example.testhost"
    private val currentStableBundlePath = "current/stable/index.android.bundle"
    private val baseDirPath = "external"
    private val storeDirPath = "$baseDirPath/bundle-store"
    private val finalDirPath = "$storeDirPath/$bundleId"
    private val cacheDirPath = "cache"
    private val tempDirPath = "$cacheDirPath/bundle-temp"
    private val zipFilePath = "$tempDirPath/bundle.zip"
    private val extractedDirPath = "$tempDirPath/extracted"
    private val indexExtractedPath = "$extractedDirPath/index.android.bundle"
    private val indexFinalPath = "$finalDirPath/index.android.bundle"
    private val newBundlePath = indexFinalPath

    private var readPointer = 0
    private val fakeZipData = ByteArray(1024) { 1 }

    @Before
    fun setUp() {
        MockKAnnotations.init(this, relaxUnitFun = true)
        
        // 기본 모킹 초기화
        mockkObject(HotUpdater.Companion)
        mockkStatic(Log::class)
        mockkStatic(File::class)
        mockkStatic(URL::class)

        // URL 관련 모킹
        every { URL(any()) } answers { mockk(relaxed = true) }
        every { any<URL>().openConnection() } returns mockConnection
        every { mockConnection.requestMethod = any() } just runs
        every { mockConnection.connectTimeout = any() } just runs
        every { mockConnection.readTimeout = any() } just runs
        every { mockConnection.instanceFollowRedirects = any() } just runs
        every { mockConnection.connect() } just runs
        every { mockConnection.disconnect() } just runs
        every { mockConnection.responseCode } returns HttpURLConnection.HTTP_OK
        every { mockConnection.responseMessage } returns "OK"
        every { mockConnection.contentLengthLong } returns 1024L
        every { mockConnection.inputStream } returns mockInputStream

        // 입력 스트림 모킹
        every { mockInputStream.read(any<ByteArray>()) } answers {
            val buffer = firstArg<ByteArray>()
            val currentReadPointer = readPointer
            val bytesToRead = min(buffer.size, fakeZipData.size - currentReadPointer)

            if (bytesToRead <= 0) {
                -1
            } else {
                System.arraycopy(fakeZipData, currentReadPointer, buffer, 0, bytesToRead)
                readPointer += bytesToRead
                bytesToRead
            }
        }

        every { mockInputStream.read(any<ByteArray>(), any<Int>(), any<Int>()) } answers {
            val buffer = firstArg<ByteArray>()
            val offset = secondArg<Int>()
            val length = thirdArg<Int>()
            val currentReadPointer = readPointer
            val bytesToRead = min(length, fakeZipData.size - currentReadPointer)

            if (bytesToRead <= 0) {
                -1
            } else {
                System.arraycopy(fakeZipData, currentReadPointer, buffer, offset, bytesToRead)
                readPointer += bytesToRead
                bytesToRead
            }
        }

        every { mockInputStream.close() } just runs

        // Context & Related Mocks
        every { mockContext.applicationContext } returns mockContext
        every { mockContext.packageManager } returns mockPackageManager
        every { mockContext.packageName } returns appPackageName

        // Create a real PackageInfo instance
        val realPackageInfo = PackageInfo().apply {
            versionName = appVersion
            packageName = appPackageName
            firstInstallTime = 0
            lastUpdateTime = 0
            versionCode = 1
        }

        // Mock packageManager
        every { mockPackageManager.getPackageInfo(appPackageName, 0) } returns realPackageInfo
        every { mockPackageManager.getPackageInfo(appPackageName, any()) } returns realPackageInfo

        every { mockContext.applicationInfo } returns mockApplicationInfo
        every { mockApplicationInfo.dataDir } returns "/data/data/com.example.app"

        // SharedPreferences setup
        val prefsName = "HotUpdaterPrefs_$appVersion"
        every { mockContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE) } returns mockPrefs
        every { mockPrefs.edit() } returns mockPrefsEditor
        every { mockPrefsEditor.putString(any(), any()) } returns mockPrefsEditor
        every { mockPrefsEditor.remove(any()) } returns mockPrefsEditor
        every { mockPrefsEditor.putBoolean(any(), any()) } returns mockPrefsEditor
        every { mockPrefsEditor.apply() } just runs

        // File System Mocks
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

        // File operations
        every { mockBaseDir.exists() } returns true
        every { mockStoreDir.exists() } returns true
        every { mockStoreDir.mkdirs() } returns true
        every { mockFinalDir.exists() } returns false
        every { mockFinalDir.isDirectory } returns true
        every { mockFinalDir.deleteRecursively() } returns true
        every { mockTempBaseDir.exists() } returns true
        every { mockTempDir.exists() } returns true
        every { mockTempDir.mkdirs() } returns true
        every { mockTempDir.deleteRecursively() } returns true
        every { mockZipFile.exists() } returns true
        every { mockZipFile.delete() } returns true
        every { mockExtractedDir.exists() } returns true
        every { mockExtractedDir.mkdirs() } returns true
        every { mockExtractedDir.renameTo(mockFinalDir) } returns true
        every { mockIndexFileInFinal.exists() } returns false
        every { mockIndexFileInFinal.isFile } returns true
        every { mockIndexFileInFinal.name } returns "index.android.bundle"
        every { mockIndexFileInExtracted.exists() } returns true
        every { mockIndexFileInExtracted.isFile } returns true
        every { mockIndexFileInExtracted.name } returns "index.android.bundle"
        every { mockFinalDir.setLastModified(any()) } returns true

        // File walking
        every { mockExtractedDir.walk() } returns mockFileWalk
        every { mockFinalDir.walk() } returns mockFileWalk
        every { mockFileWalk.maxDepth(any()) } returns mockFileWalk
        every { mockFileWalk.onEnter(any()) } returns mockFileWalk
        every { mockFileWalk.onLeave(any()) } returns mockFileWalk
        every { mockFileWalk.iterator() } answers { emptyList<File>().iterator() }

        // Output Stream
        every { mockZipFile.outputStream() } returns mockOutputStream
        every { mockOutputStream.write(any<ByteArray>(), any(), any()) } just runs
        every { mockOutputStream.close() } just runs

        // HotUpdater Companion Mocks
        every { HotUpdater.extractZipFileAtPath(any(), any()) } returns true
        every { HotUpdater.setBundleURL(mockContext, any()) } just runs
        every { HotUpdater.cleanupOldBundles(mockStoreDir) } just runs

        // Log Mocks
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.w(any<String>(), isNull<String>()) } returns 0
        every { Log.w(any<String>(), any<Throwable>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
        every { Log.e(any(), any(), any()) } returns 0

        // Default Prefs State
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_FIRST_RUN, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PREV_BUNDLE_URL, null) } returns null

        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkAll()
    }

    private fun resetMockInputStream() {
        readPointer = 0
    }

    // --- Test Cases ---
    // (Test cases remain the same as the previous version)
    // Note: Tests involving `File(path).exists()` for internally created paths
    // might rely on assumptions now, as that specific check is harder to mock precisely
    // without constructor mocking. Focus verification on observable state changes and
    // calls to mocked dependencies / internal companion methods.

    @Test
    fun `updateBundle - success scenario - downloads, extracts, sets provisional`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockZipFile.exists() } returns false
        every { mockFinalDir.exists() } returns false
        every { mockIndexFileInFinal.exists() } returns false
        every { mockIndexFileInExtracted.exists() } returns true

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertTrue(result)
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_PROVISIONAL, "true") }
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_FIRST_RUN, "true") }
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_BUNDLE_URL, indexFinalPath) }
        verify { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - cached bundle exists - uses cache, becomes stable`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns zipUrl
        every { mockZipFile.exists() } returns true
        every { mockFinalDir.exists() } returns false
        every { mockIndexFileInFinal.exists() } returns false
        every { mockIndexFileInExtracted.exists() } returns true

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertTrue(result)
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_PROVISIONAL, "true") }
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_FIRST_RUN, "true") }
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_BUNDLE_URL, indexFinalPath) }
        verify { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - network error - fails`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockZipFile.exists() } returns false
        every { mockConnection.responseCode } returns HttpURLConnection.HTTP_NOT_FOUND

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertFalse(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }

    @Test
    fun `updateBundle - download io exception - fails`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockZipFile.exists() } returns false
        every { mockInputStream.read(any<ByteArray>()) } throws IOException("Network error")

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertFalse(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }

    @Test
    fun `updateBundle - extraction fails - fails`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockZipFile.exists() } returns false
        every { HotUpdater.extractZipFileAtPath(any(), any()) } returns false

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertFalse(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }

    @Test
    fun `updateBundle - index file missing after move - fails`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockZipFile.exists() } returns false
        every { mockIndexFileInExtracted.exists() } returns false

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertFalse(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }

    @Test
    fun `updateBundle - rename fails - fails`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns null
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns null
        every { mockZipFile.exists() } returns false
        every { mockExtractedDir.renameTo(mockFinalDir) } returns false

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertFalse(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }

    @Test
    fun `updateBundle - redundant update skipped - bundleId matches current and file exists`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns bundleId
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns indexFinalPath
        every { mockIndexFileInFinal.exists() } returns true

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertTrue(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }

    @Test
    fun `updateBundle - redundant update proceeds - bundleId matches but file missing`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns bundleId
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns indexFinalPath
        every { mockIndexFileInFinal.exists() } returns false
        every { mockZipFile.exists() } returns true
        every { mockIndexFileInExtracted.exists() } returns true

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertTrue(result)
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_PROVISIONAL, "true") }
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_FIRST_RUN, "true") }
        verify { mockPrefsEditor.putString(HotUpdater.PREF_KEY_BUNDLE_URL, indexFinalPath) }
        verify { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - null zipUrl - clears bundle state, returns true`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns bundleId
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns indexFinalPath

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, null, progressCallback)

        // Then
        assertTrue(result)
        verify { mockPrefsEditor.remove(HotUpdater.PREF_KEY_PROVISIONAL) }
        verify { mockPrefsEditor.remove(HotUpdater.PREF_KEY_FIRST_RUN) }
        verify { mockPrefsEditor.remove(HotUpdater.PREF_KEY_BUNDLE_URL) }
        verify { mockPrefsEditor.remove(HotUpdater.PREF_KEY_PREV_BUNDLE_URL) }
        verify { mockPrefsEditor.apply() }
    }

    @Test
    fun `updateBundle - cached bundle exists but already current - skips update`() = runTest {
        // Given
        val progressCallback: (Double) -> Unit = {}
        every { mockPrefs.getString(HotUpdater.PREF_KEY_PROVISIONAL, null) } returns bundleId
        every { mockPrefs.getString(HotUpdater.PREF_KEY_BUNDLE_URL, null) } returns indexFinalPath
        every { mockZipFile.exists() } returns true
        every { mockIndexFileInFinal.exists() } returns true

        // When
        val result = HotUpdater.updateBundle(mockContext, bundleId, zipUrl, progressCallback)

        // Then
        assertTrue(result)
        verify(exactly = 0) { mockPrefsEditor.putString(any(), any()) }
    }
}