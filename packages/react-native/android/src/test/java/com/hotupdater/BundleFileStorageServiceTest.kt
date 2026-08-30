package com.hotupdater

import android.content.ContextWrapper
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
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
    fun `resolveBundleFile rejects a manifest with missing assets even when root index exists`() {
        val rootDir = temporaryFolder.newFolder("no-android-candidate")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-no-candidate")
        writeFile(bundleDir, "index.android.bundle")

        writeManifest(bundleDir, listOf("index.ios.bundle", "assets/image.png"))

        assertNull(invokeResolveBundleFile(service, bundleDir))
    }

    @Test
    fun `resolveBundleFile rejects a manifest with multiple android bundle candidates`() {
        val rootDir = temporaryFolder.newFolder("multiple-android-candidates")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-multiple-candidates")
        writeFile(bundleDir, "index.android.bundle")

        writeFile(bundleDir, "foo.android.bundle")
        writeFile(bundleDir, "dist/bar.android.bundle")
        writeManifest(bundleDir, listOf("foo.android.bundle", "dist/bar.android.bundle"))

        assertNull(invokeResolveBundleFile(service, bundleDir))
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
        writeFile(stagingDir, "dist/staging.android.bundle")
        writeManifest(
            stagingDir,
            listOf(
                "dist/staging.android.bundle",
                "assets/missing.png",
            ),
        )

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

        assertEquals(stableBundleFile.absolutePath, selection.bundleUrl)
        assertEquals(stableDir.name, selection.launchedBundleId)
        assertFalse(selection.shouldRollbackOnCrash)
        assertFalse(stagingDir.exists())
        assertEquals("RECOVERED", report["status"])
        assertEquals(stagingDir.name, report["fromBundleId"])
        assertEquals(stableDir.name, report["toBundleId"])
        assertEquals("appVersion", report["updateStrategy"])

        val metadata = loadMetadata(rootDir)
        assertNotNull(metadata)
        assertEquals(stableDir.name, metadata?.stagingBundleId)
        assertNull(metadata?.stableBundleId)
        assertFalse(metadata?.verificationPending ?: true)
        assertEquals(stableBundleFile.absolutePath, preferences.getItem("HotUpdaterBundleURL"))
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
        assertEquals(stagingDir.name, report["fromBundleId"])
        assertEquals(HotUpdaterImpl.getMinBundleId(), report["toBundleId"])
        assertEquals("appVersion", report["updateStrategy"])
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
    fun `markLaunchCompleted records update applied transition`() {
        val rootDir = temporaryFolder.newFolder("update-applied-transition")
        val service = createService(rootDir)

        val stableDir = createBundleDir(rootDir, "stable-bundle")
        writeFile(stableDir, "index.android.bundle")
        writeManifest(stableDir, listOf("index.android.bundle"))

        val stagingDir = createBundleDir(rootDir, "staging-bundle")
        writeFile(stagingDir, "index.android.bundle")
        writeManifest(stagingDir, listOf("index.android.bundle"))

        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = stableDir.name,
                stagingBundleId = stagingDir.name,
                verificationPending = true,
            ),
        )

        assertEquals(mapOf("status" to "PENDING"), service.notifyAppReady())

        service.markLaunchCompleted(stagingDir.name)

        assertEquals(
            mapOf(
                "status" to "UPDATE_APPLIED",
                "fromBundleId" to stableDir.name,
                "toBundleId" to stagingDir.name,
                "updateStrategy" to "appVersion",
            ),
            service.notifyAppReady(),
        )
    }

    @Test
    fun `install identity persists across service instances and user clear keeps install id`() {
        val rootDir = temporaryFolder.newFolder("install-identity")
        val firstService = createService(rootDir)

        val firstInstallId = firstService.getInstallId()
        assertTrue(firstInstallId.isNotBlank())

        firstService.setUser("user-123", "alice")
        assertEquals(
            InstallationIdentity(
                installId = firstInstallId,
                userId = "user-123",
                username = "alice",
            ),
            loadInstallationIdentity(rootDir),
        )

        val restartedService = createService(rootDir)
        assertEquals(firstInstallId, restartedService.getInstallId())

        restartedService.setUser(null, null)
        assertEquals(
            InstallationIdentity(
                installId = firstInstallId,
                userId = null,
                username = null,
            ),
            loadInstallationIdentity(rootDir),
        )
    }

    @Test
    fun `user update keeps cached install id when persisted identity becomes unreadable`() {
        val rootDir = temporaryFolder.newFolder("install-identity-corruption")
        val service = createService(rootDir)
        val installId = service.getInstallId()
        val identityFile = File(bundleStoreDir(rootDir), InstallationIdentity.IDENTITY_FILENAME)
        identityFile.writeText("{")

        service.setUser("user-123", "alice")

        assertEquals(installId, service.getInstallId())
        assertEquals(
            InstallationIdentity(
                installId = installId,
                userId = "user-123",
                username = "alice",
            ),
            loadInstallationIdentity(rootDir),
        )
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
    fun `catalog high water rejects replay and survives channel reset`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("release-high-water")
            val service = createService(rootDir)

            assertTrue(
                service.acceptReleaseCatalog(
                    catalogId = "project-a",
                    scopeKey = "scope-production",
                    generation = 2,
                    catalogHash = "hash-2",
                    channel = "production",
                    selectionContextHash = "context-2",
                ),
            )
            assertFalse(
                service.acceptReleaseCatalog(
                    catalogId = "project-a",
                    scopeKey = "scope-production",
                    generation = 1,
                    catalogHash = "hash-1",
                    channel = "production",
                    selectionContextHash = "context-1",
                ),
            )
            assertFalse(
                service.acceptReleaseCatalog(
                    catalogId = "project-a",
                    scopeKey = "scope-production",
                    generation = 2,
                    catalogHash = "different-hash",
                    channel = "production",
                    selectionContextHash = "context-2",
                ),
            )

            assertTrue(service.resetChannel())
            val metadata = loadMetadata(rootDir)
            assertEquals(
                CatalogHighWater(generation = 2, catalogHash = "hash-2"),
                metadata?.highestSeenCatalogs?.get("project-a|scope-production"),
            )
        }

    @Test
    fun `same bundle adoption refreshes its receipt without changing bytes`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("same-bundle-adoption")
            val service = createService(rootDir)
            val bundleDir = createBundleDir(rootDir, "bundle-one")
            writeFile(bundleDir, "index.android.bundle")
            writeManifest(bundleDir, listOf("index.android.bundle"))
            val oldSelection =
                releaseSelection(
                    releaseId = "release-one",
                    bundleId = bundleDir.name,
                    generation = 1,
                    catalogHash = "hash-1",
                    selectionContextHash = "context-1",
                )
            writeMetadata(
                rootDir,
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = bundleDir.name,
                    stagingSelection = oldSelection,
                ),
            )
            assertTrue(
                service.acceptReleaseCatalog(
                    catalogId = "project-a",
                    scopeKey = "scope-production",
                    generation = 2,
                    catalogHash = "hash-2",
                    channel = "production",
                    selectionContextHash = "context-2",
                ),
            )
            val newSelection =
                releaseSelection(
                    releaseId = "release-two",
                    bundleId = bundleDir.name,
                    generation = 2,
                    catalogHash = "hash-2",
                    selectionContextHash = "context-2",
                )

            assertTrue(service.commitReleaseSelection(newSelection))

            assertTrue(bundleDir.isDirectory)
            assertEquals(newSelection, loadMetadata(rootDir)?.stagingSelection)
            assertFalse(loadMetadata(rootDir)?.verificationPending ?: true)
        }

    @Test
    fun `crash restores the complete stable receipt but retains newer high water`() {
        val rootDir = temporaryFolder.newFolder("release-crash-ledger")
        val service = createService(rootDir)
        val stableDir = createBundleDir(rootDir, "bundle-one")
        writeFile(stableDir, "index.android.bundle")
        writeManifest(stableDir, listOf("index.android.bundle"))
        val stagingDir = createBundleDir(rootDir, "bundle-two")
        writeFile(stagingDir, "index.android.bundle")
        writeManifest(stagingDir, listOf("index.android.bundle"))
        val stableSelection =
            releaseSelection("release-one", stableDir.name, 1, "hash-1", "context-1")
        val stagingSelection =
            releaseSelection("release-two", stagingDir.name, 2, "hash-2", "context-2")
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = stableDir.name,
                stagingBundleId = stagingDir.name,
                stableSelection = stableSelection,
                stagingSelection = stagingSelection,
                pendingUpdateStrategy = "appVersion",
                pendingTransition =
                    PendingSelectionTransition(
                        fromReleaseId = stableSelection.releaseId,
                        fromBundleId = stableSelection.bundleId,
                        toReleaseId = stagingSelection.releaseId,
                        toBundleId = stagingSelection.bundleId,
                    ),
                verificationPending = true,
                highestSeenCatalogs =
                    mapOf(
                        "project-a|scope-production" to
                            CatalogHighWater(generation = 2, catalogHash = "hash-2"),
                    ),
                currentSelectionContexts =
                    mapOf("project-a|scope-production" to "production\ncontext-2"),
            ),
        )

        val launch =
            service.prepareLaunch(
                PendingCrashRecovery(
                    launchedBundleId = stagingDir.name,
                    shouldRollback = true,
                ),
            )
        val report = service.notifyAppReady()
        val metadata = loadMetadata(rootDir)

        assertEquals(stableDir.name, launch.launchedBundleId)
        assertEquals("RECOVERED", report["status"])
        assertEquals("release-two", report["fromReleaseId"])
        assertEquals("release-one", report["toReleaseId"])
        assertEquals(stableSelection, metadata?.stagingSelection)
        assertEquals(
            CatalogHighWater(generation = 2, catalogHash = "hash-2"),
            metadata?.highestSeenCatalogs?.get("project-a|scope-production"),
        )
        assertTrue(service.getCrashHistory().contains(stagingDir.name))
    }

    @Test
    fun `manifest driven install moves blocking work off caller dispatcher`() {
        val rootDir = temporaryFolder.newFolder("manifest-install-dispatcher")
        val preferences = InMemoryPreferencesService()
        val downloadService = RecordingFailedDownloadService()
        val service = createService(rootDir, preferences, downloadService)
        val activeDir = createBundleDir(rootDir, "active-bundle")
        val activeBundleFile = writeFile(activeDir, "index.android.bundle")
        writeManifest(activeDir, listOf("index.android.bundle"))

        preferences.setItem("HotUpdaterBundleURL", activeBundleFile.absolutePath)

        Executors
            .newSingleThreadExecutor { runnable -> Thread(runnable, "manifest-caller") }
            .asCoroutineDispatcher()
            .use { callerDispatcher ->
                runBlocking(callerDispatcher) {
                    val result =
                        runCatching {
                            service.updateBundle(
                                bundleId = "target-bundle",
                                fileUrl = "https://example.com/bundle.zip",
                                fileHash = null,
                                manifestUrl = "https://example.com/manifest.json",
                                manifestFileHash = "manifest-hash",
                                changedAssets = emptyMap(),
                                progressCallback = {},
                            )
                        }
                    assertTrue(result.exceptionOrNull() is HotUpdaterException)
                }
            }

        val manifestCall = downloadService.calls.first()
        assertEquals("https://example.com/manifest.json", manifestCall.first)
        assertFalse(
            "Manifest install ran on the caller dispatcher: ${manifestCall.second}",
            manifestCall.second.contains("manifest-caller"),
        )
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
        downloadService: DownloadService = UnusedDownloadService,
    ): BundleFileStorageService =
        BundleFileStorageService(
            ContextWrapper(null),
            TestFileSystemService(rootDir),
            downloadService,
            DecompressService(),
            preferences,
            TEST_ISOLATION_KEY,
            { "production" },
        )

    private fun releaseSelection(
        releaseId: String,
        bundleId: String,
        generation: Long,
        catalogHash: String,
        selectionContextHash: String,
    ): PersistedSelection =
        PersistedSelection(
            kind = "BUNDLE",
            releaseId = releaseId,
            bundleId = bundleId,
            catalogId = "project-a",
            scopeKey = "scope-production",
            generation = generation,
            catalogHash = catalogHash,
            channel = "production",
            selectionContextHash = selectionContextHash,
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

    private fun loadInstallationIdentity(rootDir: File): InstallationIdentity? =
        InstallationIdentity.loadFromFile(
            File(bundleStoreDir(rootDir), InstallationIdentity.IDENTITY_FILENAME),
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
                String::class.java,
            )
        method.isAccessible = true
        return method.invoke(service, bundleDir, bundleDir.name) as File?
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

    private class RecordingFailedDownloadService : DownloadService {
        val calls = CopyOnWriteArrayList<Pair<String, String>>()

        override suspend fun downloadFile(
            fileUrl: URL,
            destination: File,
            fileSizeCallback: ((Long) -> Unit)?,
            progressCallback: (DownloadProgress) -> Unit,
        ): DownloadResult {
            calls += fileUrl.toString() to Thread.currentThread().name
            return DownloadResult.Error(IllegalStateException("expected download failure"))
        }
    }

    companion object {
        private const val TEST_ISOLATION_KEY = "test-isolation-key"
    }
}
