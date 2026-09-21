package com.hotupdater

import android.content.ContextWrapper
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
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
import java.util.concurrent.atomic.AtomicInteger

class BundleFileStorageServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `unfinished staging launch rolls back to stable on cold start`() {
        assertStagingLaunchAcrossColdStart(hasStableBundle = true)
    }

    @Test
    fun `unfinished staging launch rolls back to built in on cold start`() {
        assertStagingLaunchAcrossColdStart(hasStableBundle = false)
    }

    @Test
    fun `completed staging launch remains trusted on cold start`() {
        assertStagingLaunchAcrossColdStart(hasStableBundle = true, completesLaunch = true)
    }

    @Test
    fun `completed first OTA launch remains trusted on cold start`() {
        assertStagingLaunchAcrossColdStart(hasStableBundle = false, completesLaunch = true)
    }

    private fun assertStagingLaunchAcrossColdStart(
        hasStableBundle: Boolean,
        completesLaunch: Boolean = false,
    ) {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        val stableBundleId = if (hasStableBundle) "stable-bundle" else null
        listOfNotNull(stableBundleId, "hung-bundle").forEach { bundleId ->
            val directory = createBundleDir(rootDir, bundleId)
            writeFile(directory, "index.android.bundle")
            writeManifest(directory, listOf("index.android.bundle"))
        }
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = stableBundleId,
                stagingBundleId = "hung-bundle",
                verificationPending = true,
            ),
        )
        val firstProcess = createService(rootDir, preferences)
        val firstLaunch = firstProcess.prepareLaunch(null)
        assertEquals("hung-bundle", firstLaunch.launchedBundleId)
        assertTrue(firstLaunch.shouldRollbackOnCrash)

        assertEquals("hung-bundle", firstProcess.prepareLaunch(null).launchedBundleId)
        assertFalse(firstProcess.getCrashHistory().contains("hung-bundle"))
        if (completesLaunch) {
            firstProcess.markLaunchCompleted("hung-bundle")
        }

        // Issue #1321: simulate process termination without a crash marker.
        val secondProcess = createService(rootDir, preferences)
        val nextLaunch = secondProcess.prepareLaunch(null)
        assertEquals(if (completesLaunch) "hung-bundle" else stableBundleId, nextLaunch.launchedBundleId)
        assertFalse(nextLaunch.shouldRollbackOnCrash)
        assertEquals(!completesLaunch, secondProcess.getCrashHistory().contains("hung-bundle"))
        if (!completesLaunch) {
            assertEquals("RECOVERED", secondProcess.notifyAppReady()["status"])
        }
        val thirdProcess = createService(rootDir, preferences)
        assertEquals(nextLaunch.launchedBundleId, thirdProcess.prepareLaunch(null).launchedBundleId)
    }

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
    fun `manifest driven install reuses matching built in asset before first OTA`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("first-ota-manifest-install")
            val bundleContent = "target-bundle"
            val imageContent = "target-image"
            val assets =
                linkedMapOf(
                    "index.android.bundle" to sha256(rootDir, bundleContent),
                    "assets/image.png" to sha256(rootDir, imageContent),
                )
            val manifest = manifestJson("target-bundle", assets)
            val downloads =
                MappingDownloadService(
                    mapOf(
                        "https://example.com/manifest.json" to manifest,
                        "https://example.com/index.android.bundle" to bundleContent,
                    ),
                )
            val service =
                createService(
                    rootDir,
                    downloadService = downloads,
                    builtInAssetResolver =
                        MappingBuiltInAssetResolver(
                            mapOf("assets/image.png" to imageContent),
                        ),
                )

            val progress = CopyOnWriteArrayList<UpdateProgressPayload>()
            service.updateBundle(
                bundleId = "target-bundle",
                manifestUrl = "https://example.com/manifest.json",
                manifestFileHash = sha256(rootDir, manifest),
                assets =
                    assets.mapValues { (path, hash) ->
                        ChangedAssetDescriptor(
                            fileUrl = "https://example.com/$path",
                            fileHash = hash,
                        )
                    },
                progressCallback = { progress.add(it) },
            )

            assertEquals(1, progress.last().details?.totalFilesCount)
            assertEquals(
                listOf("index.android.bundle"),
                progress
                    .last()
                    .details
                    ?.files
                    ?.map { it.path },
            )
            assertTrue(progress.any { it.progress in 0.15..0.2 && it.details?.totalFilesCount == 0 })
            val targetDir = File(bundleStoreDir(rootDir), "target-bundle")
            assertEquals(bundleContent, File(targetDir, "index.android.bundle").readText())
            assertEquals(imageContent, File(targetDir, "assets/image.png").readText())
            assertEquals("target-bundle", loadMetadata(rootDir)?.stagingBundleId)
            assertEquals(
                listOf(
                    "https://example.com/manifest.json",
                    "https://example.com/index.android.bundle",
                ),
                downloads.calls,
            )
        }

    @Test
    fun `manifest driven install downloads original when matching current asset is corrupt`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("corrupt-current-asset")
            val preferences = InMemoryPreferencesService()
            val targetContent = "verified-target-bundle"
            val targetHash = sha256(rootDir, targetContent)
            val activeDir = createBundleDir(rootDir, "active-bundle")
            val activeBundleFile = writeFile(activeDir, "index.android.bundle", "corrupt")
            File(activeDir, "manifest.json").writeText(
                manifestJson("active-bundle", mapOf("index.android.bundle" to targetHash)),
            )
            preferences.setItem("HotUpdaterBundleURL", activeBundleFile.absolutePath)

            val targetManifest =
                manifestJson("target-bundle", mapOf("index.android.bundle" to targetHash))
            val downloads =
                MappingDownloadService(
                    mapOf(
                        "https://example.com/manifest.json" to targetManifest,
                        "https://example.com/index.android.bundle" to targetContent,
                    ),
                )
            val service = createService(rootDir, preferences, downloads)

            service.updateBundle(
                bundleId = "target-bundle",
                manifestUrl = "https://example.com/manifest.json",
                manifestFileHash = sha256(rootDir, targetManifest),
                assets =
                    mapOf(
                        "index.android.bundle" to
                            ChangedAssetDescriptor(
                                fileUrl = "https://example.com/index.android.bundle",
                                fileHash = targetHash,
                            ),
                    ),
                progressCallback = {},
            )

            assertEquals(
                targetContent,
                File(bundleStoreDir(rootDir), "target-bundle/index.android.bundle").readText(),
            )
            assertTrue(downloads.calls.contains("https://example.com/index.android.bundle"))
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
                                manifestUrl = "https://example.com/manifest.json",
                                manifestFileHash = "manifest-hash",
                                assets = emptyMap(),
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
    fun `reused bytes cannot bypass mismatched descriptor contracts`() =
        runBlocking {
            for (kind in listOf("missing", "mismatch", "extra", "missing-original")) {
                val root = temporaryFolder.newFolder(kind)
                val hash = sha256(root, "target")
                val manifest = manifestJson("target", mapOf("index.android.bundle" to hash))
                val downloads = MappingDownloadService(mapOf("https://example.com/manifest.json" to manifest))
                val service =
                    createService(
                        root,
                        downloadService = downloads,
                        builtInAssetResolver = MappingBuiltInAssetResolver(mapOf("index.android.bundle" to "target")),
                    )
                val descriptors = mutableMapOf("index.android.bundle" to ChangedAssetDescriptor("https://example.com/bundle", hash))
                when (kind) {
                    "missing" -> {
                        descriptors.clear()
                    }

                    "mismatch" -> {
                        descriptors["index.android.bundle"] = ChangedAssetDescriptor("https://example.com/bundle", "wrong")
                    }

                    "extra" -> {
                        descriptors["extra.png"] = ChangedAssetDescriptor("https://example.com/extra", hash)
                    }

                    "missing-original" -> {
                        descriptors["index.android.bundle"] = ChangedAssetDescriptor(null, hash)
                    }
                }
                val result =
                    runCatching {
                        service.updateBundle(
                            "target",
                            "https://example.com/manifest.json",
                            sha256(root, manifest),
                            descriptors,
                        ) {}
                    }
                assertTrue("Contract $kind must fail closed", result.isFailure)
                assertNull(loadMetadata(root)?.stagingBundleId)
            }
        }

    @Test
    fun `cached target is repaired before activation`() =
        runBlocking {
            val root = temporaryFolder.newFolder("corrupt-cached-target")
            val hash = sha256(root, "correct")
            val manifest = manifestJson("target", mapOf("index.android.bundle" to hash))
            val cached = createBundleDir(root, "target")
            writeFile(cached, "manifest.json", manifest)
            writeFile(cached, "index.android.bundle", "CORRUPT")
            val downloads =
                MappingDownloadService(
                    mapOf(
                        "https://example.com/manifest.json" to manifest,
                        "https://example.com/bundle" to "correct",
                    ),
                )
            val service = createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            service.updateBundle(
                "target",
                "https://example.com/manifest.json",
                sha256(root, manifest),
                mapOf("index.android.bundle" to ChangedAssetDescriptor("https://example.com/bundle", hash)),
            ) {}
            assertEquals("correct", File(cached, "index.android.bundle").readText())
            assertEquals("target", loadMetadata(root)?.stagingBundleId)
            assertTrue(downloads.calls.contains("https://example.com/bundle"))
        }

    @Test
    fun `retry reuses completed staging files and replaces partial files without stale assets`() =
        runBlocking {
            val root = temporaryFolder.newFolder("interrupted-retry")
            val hashes = mapOf("index.android.bundle" to sha256(root, "correct"), "assets/image.png" to sha256(root, "image"))
            val manifest = manifestJson("target", hashes)
            val staging = createBundleDir(root, "target.tmp")
            writeFile(staging, "index.android.bundle", "partial")
            writeFile(staging, "assets/image.png", "image")
            writeFile(staging, "assets/obsolete.png", "obsolete")
            val downloads =
                MappingDownloadService(
                    mapOf(
                        "https://example.com/manifest.json" to manifest,
                        "https://example.com/index.android.bundle" to "correct",
                    ),
                )
            val service = createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            service.updateBundle(
                "target",
                "https://example.com/manifest.json",
                sha256(root, manifest),
                hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
            ) {}
            assertEquals(listOf("https://example.com/manifest.json", "https://example.com/index.android.bundle"), downloads.calls)
            val target = File(bundleStoreDir(root), "target")
            assertEquals("image", File(target, "assets/image.png").readText())
            assertEquals("correct", File(target, "index.android.bundle").readText())
            assertFalse(File(target, "assets/obsolete.png").exists())
        }

    @Test
    fun `independent downloads overlap with at most four active requests`() =
        runBlocking {
            val root = temporaryFolder.newFolder("parallel-originals")
            val paths = listOf("index.android.bundle") + (0..8).map { "assets/$it.png" }
            val hash = sha256(root, "content")
            val manifest = manifestJson("target", paths.associateWith { hash })
            val mapping =
                MappingDownloadService(
                    mapOf("https://example.com/manifest.json" to manifest) + paths.associate { "https://example.com/$it" to "content" },
                )
            val active = AtomicInteger()
            val maximum = AtomicInteger()
            val downloader =
                object : DownloadService {
                    override suspend fun downloadFile(
                        fileUrl: URL,
                        destination: File,
                        fileSizeCallback: ((Long) -> Unit)?,
                        progressCallback: (DownloadProgress) -> Unit,
                    ): DownloadResult {
                        val isAsset = fileUrl.path != "/manifest.json"
                        if (isAsset) {
                            val count = active.incrementAndGet()
                            maximum.updateAndGet { maxOf(it, count) }
                        }
                        try {
                            delay(25)
                            return mapping.downloadFile(fileUrl, destination, fileSizeCallback, progressCallback)
                        } finally {
                            if (isAsset) active.decrementAndGet()
                        }
                    }
                }
            val service = createService(root, downloadService = downloader, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            val progress = CopyOnWriteArrayList<UpdateProgressPayload>()
            service.updateBundle(
                "target",
                "https://example.com/manifest.json",
                sha256(root, manifest),
                paths.associateWith { ChangedAssetDescriptor("https://example.com/$it", hash) },
                progress::add,
            )
            assertTrue("Expected concurrent requests, observed ${maximum.get()}", maximum.get() > 1)
            assertTrue("Concurrency must be bounded", maximum.get() <= 4)
            assertEquals(paths.size, progress.last().details?.completedFilesCount)
        }

    private fun createService(
        rootDir: File,
        preferences: InMemoryPreferencesService = InMemoryPreferencesService(),
        downloadService: DownloadService = UnusedDownloadService,
        builtInAssetResolver: BuiltInAssetResolver? = null,
    ): BundleFileStorageService =
        BundleFileStorageService(
            context = ContextWrapper(null),
            fileSystem = TestFileSystemService(rootDir),
            downloadService = downloadService,
            preferences = preferences,
            isolationKey = TEST_ISOLATION_KEY,
            defaultChannelProvider = { "production" },
            builtInAssetResolver = builtInAssetResolver,
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

    private class MappingDownloadService(
        private val contents: Map<String, String>,
    ) : DownloadService {
        val calls = CopyOnWriteArrayList<String>()

        override suspend fun downloadFile(
            fileUrl: URL,
            destination: File,
            fileSizeCallback: ((Long) -> Unit)?,
            progressCallback: (DownloadProgress) -> Unit,
        ): DownloadResult {
            calls += fileUrl.toString()
            val content =
                contents[fileUrl.toString()]
                    ?: return DownloadResult.Error(IllegalArgumentException("Unexpected URL: $fileUrl"))
            destination.parentFile?.mkdirs()
            destination.writeText(content)
            fileSizeCallback?.invoke(destination.length())
            progressCallback(DownloadProgress(1.0, destination.length(), destination.length()))
            return DownloadResult.Success(destination)
        }
    }

    private class MappingBuiltInAssetResolver(
        private val contents: Map<String, String>,
    ) : BuiltInAssetResolver {
        override fun copyIfMatches(
            assetPath: String,
            expectedHash: String,
            destination: File,
        ): Boolean {
            val content = contents[assetPath] ?: return false
            destination.parentFile?.mkdirs()
            destination.writeText(content)
            if (!HashUtils.verifyHash(destination, expectedHash)) {
                destination.delete()
                return false
            }
            return true
        }
    }

    private fun manifestJson(
        bundleId: String,
        assets: Map<String, String>,
    ): String =
        JSONObject()
            .put("bundleId", bundleId)
            .put(
                "assets",
                JSONObject().apply {
                    assets.forEach { (path, hash) ->
                        put(path, JSONObject().put("fileHash", hash))
                    }
                },
            ).toString()

    private fun sha256(
        rootDir: File,
        content: String,
    ): String {
        val file = File.createTempFile("hash-", null, rootDir)
        return try {
            file.writeText(content)
            HashUtils.calculateSHA256(file)
        } finally {
            file.delete()
        }
    }

    companion object {
        private const val TEST_ISOLATION_KEY = "test-isolation-key"
    }
}
