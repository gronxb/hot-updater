package com.hotupdater

import android.content.ContextWrapper
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.URL
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class BundleFileStorageServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `resolveBundleFile uses single manifest bundle at root`() {
        val rootDir = temporaryFolder.newFolder("root-manifest-bundle")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-root")
        val expectedBundleFile = writeFile(bundleDir, "foo.android.bundle")

        writeManifest(bundleDir, listOf("foo.android.bundle"))

        assertResolvedBundlePath(service, bundleDir, expectedBundleFile)
    }

    @Test
    fun `resolveBundleFile uses single nested manifest bundle`() {
        val rootDir = temporaryFolder.newFolder("nested-manifest-bundle")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-nested")
        val expectedBundleFile = writeFile(bundleDir, "dist/foo.android.bundle")

        writeManifest(bundleDir, listOf("dist/foo.android.bundle"))

        assertResolvedBundlePath(service, bundleDir, expectedBundleFile)
    }

    @Test
    fun `resolveBundleFile falls back to root index when manifest has no android bundle candidate`() {
        val rootDir = temporaryFolder.newFolder("no-android-candidate")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-no-candidate")
        val fallbackBundleFile = writeFile(bundleDir, "index.android.bundle")

        writeManifest(bundleDir, listOf("index.ios.bundle", "assets/image.png"))

        assertResolvedBundlePath(service, bundleDir, fallbackBundleFile)
    }

    @Test
    fun `resolveBundleFile falls back to root index when manifest has multiple android bundle candidates`() {
        val rootDir = temporaryFolder.newFolder("multiple-android-candidates")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-multiple-candidates")
        val fallbackBundleFile = writeFile(bundleDir, "index.android.bundle")

        writeFile(bundleDir, "foo.android.bundle")
        writeFile(bundleDir, "dist/bar.android.bundle")
        writeManifest(bundleDir, listOf("foo.android.bundle", "dist/bar.android.bundle"))

        assertResolvedBundlePath(service, bundleDir, fallbackBundleFile)
    }

    @Test
    fun `resolveBundleFile returns null when manifest escapes root and no fallback exists`() {
        val rootDir = temporaryFolder.newFolder("escaped-manifest-path")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-escaped-path")

        writeFile(bundleStoreDir(rootDir), "outside.android.bundle")
        writeManifest(bundleDir, listOf("../outside.android.bundle"))

        assertNull(invokeResolveBundleFile(service, bundleDir))
    }

    @Test
    fun `resolveBundleFile returns null when manifest target is missing and no fallback exists`() {
        val rootDir = temporaryFolder.newFolder("missing-manifest-target")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-missing-target")

        writeManifest(bundleDir, listOf("dist/missing.android.bundle"))

        assertNull(invokeResolveBundleFile(service, bundleDir))
    }

    @Test
    fun `resolveBundleFile allows legacy root index without manifest`() {
        val rootDir = temporaryFolder.newFolder("legacy-root-index")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-legacy")
        val fallbackBundleFile = writeFile(bundleDir, "index.android.bundle")

        assertResolvedBundlePath(service, bundleDir, fallbackBundleFile)
    }

    @Test
    fun `resolveBundleFile returns null when manifest and root index are both missing`() {
        val rootDir = temporaryFolder.newFolder("missing-everything")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-invalid")

        assertNull(invokeResolveBundleFile(service, bundleDir))
    }

    @Test
    fun `prepareLaunch rolls back invalid staging and selects stable bundle`() {
        val rootDir = temporaryFolder.newFolder("rollback-to-stable")
        val preferences = InMemoryPreferencesService()
        val service = createService(rootDir, preferences)

        val stagingDir = createBundleDir(rootDir, "staging-bundle")
        writeManifest(stagingDir, listOf("dist/missing.android.bundle"))

        val stableDir = createBundleDir(rootDir, "stable-bundle")
        val stableBundleFile = writeFile(stableDir, "dist/stable.android.bundle")
        writeManifest(stableDir, listOf("dist/stable.android.bundle"))

        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = stableDir.name,
                stagingBundleId = stagingDir.name,
                verificationPending = true,
            ),
        )

        val selection = service.prepareLaunch(null)
        val report = service.notifyAppReady()

        assertEquals(stableBundleFile.canonicalFile.absolutePath, selection.bundleUrl)
        assertEquals(stableDir.name, selection.launchedBundleId)
        assertFalse(selection.shouldRollbackOnCrash)
        assertFalse(stagingDir.exists())
        assertEquals("RECOVERED", report["status"])
        assertEquals(stagingDir.name, report["crashedBundleId"])

        val metadata = loadMetadata(rootDir)
        assertNotNull(metadata)
        assertEquals(stableDir.name, metadata?.stagingBundleId)
        assertNull(metadata?.stableBundleId)
        assertFalse(metadata?.verificationPending ?: true)
        assertEquals(stableBundleFile.canonicalFile.absolutePath, preferences.getItem("HotUpdaterBundleURL"))
    }

    @Test
    fun `prepareLaunch falls back to built in bundle when staging and stable are both invalid`() {
        val rootDir = temporaryFolder.newFolder("fallback-to-built-in")
        val service = createService(rootDir)

        val stagingDir = createBundleDir(rootDir, "staging-bundle")
        writeManifest(stagingDir, listOf("dist/missing.android.bundle"))

        val stableDir = createBundleDir(rootDir, "stable-bundle")
        writeManifest(stableDir, listOf("../outside.android.bundle"))

        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = stableDir.name,
                stagingBundleId = stagingDir.name,
                verificationPending = true,
            ),
        )

        val selection = service.prepareLaunch(null)
        val report = service.notifyAppReady()

        assertEquals("assets://index.android.bundle", selection.bundleUrl)
        assertNull(selection.launchedBundleId)
        assertFalse(selection.shouldRollbackOnCrash)
        assertFalse(stagingDir.exists())
        assertEquals("RECOVERED", report["status"])
        assertEquals(stagingDir.name, report["crashedBundleId"])
    }

    @Test
    fun `getBundleId falls back to built in while staging verification is pending`() {
        val rootDir = temporaryFolder.newFolder("pending-staging-built-in")
        val service = createService(rootDir)

        val stagingDir = createBundleDir(rootDir, "staging-bundle")
        writeFile(stagingDir, "index.android.bundle")
        writeManifest(stagingDir, listOf("index.android.bundle"))

        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = null,
                stagingBundleId = stagingDir.name,
                verificationPending = true,
            ),
        )

        assertNull(service.getBundleId())
        assertEquals("", service.getBaseURL())
        assertTrue(service.getManifest().isEmpty())
    }

    @Test
    fun `getBundleId returns launched staging bundle while verification is pending`() {
        val rootDir = temporaryFolder.newFolder("pending-staging-active")
        val preferences = InMemoryPreferencesService()
        val service = createService(rootDir, preferences)

        val stagingDir = createBundleDir(rootDir, "staging-bundle")
        val stagingBundleFile = writeFile(stagingDir, "index.android.bundle")
        writeManifest(stagingDir, listOf("index.android.bundle"))

        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = null,
                stagingBundleId = stagingDir.name,
                verificationPending = true,
            ),
        )

        preferences.setItem("HotUpdaterBundleURL", stagingBundleFile.absolutePath)

        assertEquals(stagingDir.name, service.getBundleId())
    }

    @Test
    fun `manifest driven install is disabled before first OTA`() {
        val rootDir = temporaryFolder.newFolder("first-ota-manifest-disabled")
        val service = createService(rootDir)

        assertFalse(invokeCanUseManifestDrivenInstall(service))
    }

    @Test
    fun `manifest driven install is enabled for active OTA bundle with manifest`() {
        val rootDir = temporaryFolder.newFolder("active-ota-manifest-enabled")
        val preferences = InMemoryPreferencesService()
        val service = createService(rootDir, preferences)
        val activeDir = createBundleDir(rootDir, "active-bundle")
        val activeBundleFile = writeFile(activeDir, "index.android.bundle")
        writeManifest(activeDir, listOf("index.android.bundle"))

        preferences.setItem("HotUpdaterBundleURL", activeBundleFile.absolutePath)

        assertTrue(invokeCanUseManifestDrivenInstall(service))
    }

    @Test
    fun `manifest driven install rejects unsafe asset paths`() {
        val rootDir = temporaryFolder.newFolder("active-ota-unsafe-manifest")
        val preferences = InMemoryPreferencesService()
        val service = createService(rootDir, preferences)
        val activeDir = createBundleDir(rootDir, "active-bundle")
        val activeBundleFile = writeFile(activeDir, "index.android.bundle")
        writeManifest(activeDir, listOf("../active-bundle_evil/index.android.bundle"))

        preferences.setItem("HotUpdaterBundleURL", activeBundleFile.absolutePath)

        assertFalse(invokeCanUseManifestDrivenInstall(service))
    }

    @Test
    fun `zip decompression does not write sibling prefix traversal entries`() {
        val rootDir = temporaryFolder.newFolder("zip-sibling-prefix")
        val zipFile = File(rootDir, "bundle.zip")
        ZipOutputStream(zipFile.outputStream()).use { zip ->
            writeZipEntry(zip, "../bundle-temp_evil/escape.txt", "blocked")
            writeZipEntry(zip, "safe/kept.txt", "kept")
        }

        val destinationDir = File(rootDir, "bundle-temp")
        val extracted =
            ZipDecompressionStrategy().decompress(
                zipFile.absolutePath,
                destinationDir.absolutePath,
            ) {}

        assertTrue(extracted)
        assertTrue(File(destinationDir, "safe/kept.txt").isFile)
        assertFalse(File(rootDir, "bundle-temp_evil/escape.txt").exists())
    }

    private fun createService(
        rootDir: File,
        preferences: InMemoryPreferencesService = InMemoryPreferencesService(),
    ): BundleFileStorageService =
        BundleFileStorageService(
            ContextWrapper(null),
            TestFileSystemService(rootDir),
            UnusedDownloadService,
            DecompressService(),
            preferences,
            TEST_ISOLATION_KEY,
        )

    private fun createBundleDir(
        rootDir: File,
        bundleId: String,
    ): File = File(bundleStoreDir(rootDir), bundleId).apply { mkdirs() }

    private fun writeManifest(
        bundleDir: File,
        assetPaths: List<String>,
    ) {
        val assets =
            JSONObject().apply {
                assetPaths.forEach { assetPath ->
                    put(assetPath, JSONObject().put("fileHash", "$assetPath-hash"))
                }
            }

        File(bundleDir, "manifest.json").writeText(
            JSONObject()
                .put("bundleId", bundleDir.name)
                .put("assets", assets)
                .toString(),
        )
    }

    private fun writeMetadata(
        rootDir: File,
        metadata: BundleMetadata,
    ) {
        assertTrue(metadata.saveToFile(File(bundleStoreDir(rootDir), BundleMetadata.METADATA_FILENAME)))
    }

    private fun loadMetadata(rootDir: File): BundleMetadata? =
        BundleMetadata.loadFromFile(
            File(bundleStoreDir(rootDir), BundleMetadata.METADATA_FILENAME),
            TEST_ISOLATION_KEY,
        )

    private fun writeFile(
        rootDir: File,
        relativePath: String,
        content: String = "bundle-content",
    ): File =
        File(rootDir, relativePath).apply {
            parentFile?.mkdirs()
            writeText(content)
        }

    private fun writeZipEntry(
        zip: ZipOutputStream,
        path: String,
        content: String,
    ) {
        zip.putNextEntry(ZipEntry(path))
        zip.write(content.toByteArray())
        zip.closeEntry()
    }

    private fun bundleStoreDir(rootDir: File): File = File(rootDir, "bundle-store").apply { mkdirs() }

    private fun invokeResolveBundleFile(
        service: BundleFileStorageService,
        bundleDir: File,
    ): File? {
        val method =
            BundleFileStorageService::class.java.getDeclaredMethod(
                "resolveBundleFile",
                File::class.java,
            )
        method.isAccessible = true
        return method.invoke(service, bundleDir) as File?
    }

    private fun invokeCanUseManifestDrivenInstall(service: BundleFileStorageService): Boolean {
        val method = BundleFileStorageService::class.java.getDeclaredMethod("canUseManifestDrivenInstall")
        method.isAccessible = true
        return method.invoke(service) as Boolean
    }

    private fun assertResolvedBundlePath(
        service: BundleFileStorageService,
        bundleDir: File,
        expected: File,
    ) {
        val resolved = invokeResolveBundleFile(service, bundleDir)

        assertNotNull(resolved)
        assertEquals(expected.canonicalFile.absolutePath, resolved?.canonicalFile?.absolutePath)
    }

    private class TestFileSystemService(
        private val internalFilesDir: File,
    ) : FileSystemService {
        override fun fileExists(path: String): Boolean = File(path).exists()

        override fun createDirectory(path: String): Boolean = File(path).mkdirs()

        override fun removeItem(path: String): Boolean = File(path).deleteRecursively()

        override fun moveItem(
            sourcePath: String,
            destinationPath: String,
        ): Boolean = File(sourcePath).renameTo(File(destinationPath))

        override fun copyItem(
            sourcePath: String,
            destinationPath: String,
        ): Boolean =
            try {
                File(sourcePath).copyRecursively(File(destinationPath), overwrite = true)
            } catch (_: Exception) {
                false
            }

        override fun contentsOfDirectory(path: String): List<String> = File(path).list()?.toList() ?: emptyList()

        override fun getInternalFilesDir(): File = internalFilesDir
    }

    private class InMemoryPreferencesService : PreferencesService {
        private val values = mutableMapOf<String, String?>()

        override fun getItem(key: String): String? = values[key]

        override fun setItem(
            key: String,
            value: String?,
        ) {
            if (value == null) {
                values.remove(key)
            } else {
                values[key] = value
            }
        }
    }

    private object UnusedDownloadService : DownloadService {
        override suspend fun downloadFile(
            fileUrl: URL,
            destination: File,
            fileSizeCallback: ((Long) -> Unit)?,
            progressCallback: (DownloadProgress) -> Unit,
        ): DownloadResult = error("downloadFile should not be called in these tests")
    }

    companion object {
        private const val TEST_ISOLATION_KEY = "test-isolation-key"
    }
}
