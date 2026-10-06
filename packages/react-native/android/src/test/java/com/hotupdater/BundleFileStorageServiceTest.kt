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
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLHandshakeException

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
        firstProcess.markLaunchStarted("hung-bundle")

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
    fun `headless staging launch stays pending on the next cold start`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        listOf("stable-bundle", "staged-bundle").forEach { bundleId ->
            val directory = createBundleDir(rootDir, bundleId)
            writeFile(directory, "index.android.bundle")
            writeManifest(directory, listOf("index.android.bundle"))
        }
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "staged-bundle",
                verificationPending = true,
            ),
        )
        // Issue #1468: a headless JS task (a background FCM message) prepares the
        // launch without an activity, so first content never appears.
        val headlessLaunch = createService(rootDir, preferences).prepareLaunch(null)
        assertEquals("staged-bundle", headlessLaunch.launchedBundleId)
        assertTrue(headlessLaunch.shouldRollbackOnCrash)

        // The OS reclaims the cached process, then the user opens the app.
        val nextProcess = createService(rootDir, preferences)
        val nextLaunch = nextProcess.prepareLaunch(null)
        assertEquals("staged-bundle", nextLaunch.launchedBundleId)
        assertTrue(nextLaunch.shouldRollbackOnCrash)
        assertFalse(nextProcess.getCrashHistory().contains("staged-bundle"))
        assertEquals("PENDING", nextProcess.notifyAppReady()["status"])
    }

    @Test
    fun `launch start records only the pending staged bundle`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        listOf("stable-bundle", "staged-bundle").forEach { bundleId ->
            val directory = createBundleDir(rootDir, bundleId)
            writeFile(directory, "index.android.bundle")
            writeManifest(directory, listOf("index.android.bundle"))
        }
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "staged-bundle",
                verificationPending = true,
            ),
        )
        val process = createService(rootDir, preferences)
        process.prepareLaunch(null)

        // The activity can start after JS staged another bundle, or after first
        // content already verified this one.
        process.markLaunchStarted("stable-bundle")
        assertFalse(loadMetadata(rootDir)!!.launchInProgress)
        process.markLaunchCompleted("staged-bundle")
        process.markLaunchStarted("staged-bundle")
        assertFalse(loadMetadata(rootDir)!!.launchInProgress)

        val nextLaunch = createService(rootDir, preferences).prepareLaunch(null)
        assertEquals("staged-bundle", nextLaunch.launchedBundleId)
        assertFalse(nextLaunch.shouldRollbackOnCrash)
    }

    // Issue #1469: a launch that ends before first content without a crash marker
    // may be a user leaving early rather than a hang.
    @Test
    fun `unfinished launch retries the bundle once before crash history`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder()
            val preferences = InMemoryPreferencesService()
            leaveUnfinishedLaunch(rootDir, preferences)

            // The next process still rolls back at once and reports RECOVERED.
            val recovered = createRetryService(rootDir, preferences)
            assertEquals("stable-bundle", recovered.prepareLaunch(null).launchedBundleId)
            assertEquals("RECOVERED", recovered.notifyAppReady()["status"])
            assertFalse(loadCrashedHistory(rootDir).contains("retried-bundle"))
            assertEquals(InterruptedLaunch("retried-bundle"), loadCrashedHistory(rootDir).interruptedLaunch)
            // The session that recovered refuses the bundle, even after first content.
            recovered.markLaunchCompleted("stable-bundle")
            assertTrue(recovered.getCrashHistory().contains("retried-bundle"))
            assertUpdateFailure(installRetriedBundle(recovered, rootDir), "BUNDLE_IN_CRASHED_HISTORY", null)

            // A later process installs it again.
            val retrying = createRetryService(rootDir, preferences)
            assertEquals("stable-bundle", retrying.prepareLaunch(null).launchedBundleId)
            assertFalse(retrying.getCrashHistory().contains("retried-bundle"))
            assertNull(installRetriedBundle(retrying, rootDir))

            // The retry ends before first content too: now crash history keeps it.
            val retryLaunch = createRetryService(rootDir, preferences)
            assertEquals("retried-bundle", retryLaunch.prepareLaunch(null).launchedBundleId)
            retryLaunch.markLaunchStarted("retried-bundle")
            val next = createRetryService(rootDir, preferences)
            assertEquals("stable-bundle", next.prepareLaunch(null).launchedBundleId)
            assertEquals("RECOVERED", next.notifyAppReady()["status"])
            assertTrue(loadCrashedHistory(rootDir).contains("retried-bundle"))
            assertNull(loadCrashedHistory(rootDir).interruptedLaunch)
            next.markLaunchCompleted("stable-bundle")
            val later = createRetryService(rootDir, preferences)
            later.prepareLaunch(null)
            assertUpdateFailure(installRetriedBundle(later, rootDir), "BUNDLE_IN_CRASHED_HISTORY", null)
        }

    @Test
    fun `retried bundle that reaches first content is verified`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder()
            val preferences = InMemoryPreferencesService()
            leaveUnfinishedLaunch(rootDir, preferences)
            val recovered = createRetryService(rootDir, preferences)
            recovered.prepareLaunch(null)
            recovered.markLaunchCompleted("stable-bundle")
            val retrying = createRetryService(rootDir, preferences)
            retrying.prepareLaunch(null)
            assertNull(installRetriedBundle(retrying, rootDir))

            val retryLaunch = createRetryService(rootDir, preferences)
            assertEquals("retried-bundle", retryLaunch.prepareLaunch(null).launchedBundleId)
            retryLaunch.markLaunchStarted("retried-bundle")
            retryLaunch.markLaunchCompleted("retried-bundle")

            assertEquals("UPDATE_APPLIED", retryLaunch.notifyAppReady()["status"])
            assertTrue(loadCrashedHistory(rootDir).bundles.isEmpty())
            assertNull(loadCrashedHistory(rootDir).interruptedLaunch)
            val next = createRetryService(rootDir, preferences).prepareLaunch(null)
            assertEquals("retried-bundle", next.launchedBundleId)
            assertFalse(next.shouldRollbackOnCrash)
        }

    @Test
    fun `retry waits for a session that showed content`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        leaveUnfinishedLaunch(rootDir, preferences)

        // A headless process consumes the unfinished launch and never renders.
        val headless = createRetryService(rootDir, preferences)
        assertEquals("stable-bundle", headless.prepareLaunch(null).launchedBundleId)
        assertTrue(headless.getCrashHistory().contains("retried-bundle"))

        // The user's next open is the first session that recovered.
        val opened = createRetryService(rootDir, preferences)
        opened.prepareLaunch(null)
        assertTrue(opened.getCrashHistory().contains("retried-bundle"))
        opened.markLaunchCompleted("stable-bundle")
        assertTrue(opened.getCrashHistory().contains("retried-bundle"))

        val later = createRetryService(rootDir, preferences)
        later.prepareLaunch(null)
        assertFalse(later.getCrashHistory().contains("retried-bundle"))
    }

    @Test
    fun `retry readies after content from the built-in bundle`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        leaveUnfinishedLaunch(rootDir, preferences, stableBundleId = null)
        val recovered = createRetryService(rootDir, preferences)
        assertNull(recovered.prepareLaunch(null).launchedBundleId)

        // First content of the built-in bundle reports no bundle ID.
        recovered.markLaunchCompleted(null)

        val later = createRetryService(rootDir, preferences)
        later.prepareLaunch(null)
        assertFalse(later.getCrashHistory().contains("retried-bundle"))
    }

    @Test
    fun `crash of a retried bundle adds it to crash history`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder()
            val preferences = InMemoryPreferencesService()
            leaveUnfinishedLaunch(rootDir, preferences)
            val recovered = createRetryService(rootDir, preferences)
            recovered.prepareLaunch(null)
            recovered.markLaunchCompleted("stable-bundle")
            val retrying = createRetryService(rootDir, preferences)
            retrying.prepareLaunch(null)
            assertNull(installRetriedBundle(retrying, rootDir))
            assertEquals("retried-bundle", createRetryService(rootDir, preferences).prepareLaunch(null).launchedBundleId)

            // That launch crashed before first content and left a crash marker.
            val next =
                createRetryService(rootDir, preferences)
                    .prepareLaunch(PendingCrashRecovery(launchedBundleId = "retried-bundle", shouldRollback = true))

            assertEquals("stable-bundle", next.launchedBundleId)
            assertTrue(loadCrashedHistory(rootDir).contains("retried-bundle"))
            assertNull(loadCrashedHistory(rootDir).interruptedLaunch)
        }

    @Test
    fun `clearing crash history drops a waiting retry`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        leaveUnfinishedLaunch(rootDir, preferences)
        val recovered = createRetryService(rootDir, preferences)
        recovered.prepareLaunch(null)

        assertTrue(recovered.clearCrashHistory())

        assertFalse(recovered.getCrashHistory().contains("retried-bundle"))
        assertNull(loadCrashedHistory(rootDir).interruptedLaunch)
    }

    @Test
    fun `malformed retry record keeps crash history`() {
        val rootDir = temporaryFolder.newFolder()
        File(bundleStoreDir(rootDir), CrashedHistory.CRASHED_HISTORY_FILENAME).writeText(
            """{"bundles":[{"bundleId":"crashed-bundle","crashedAt":1}],"maxHistorySize":10,"interruptedLaunch":{}}""",
        )

        val history = createService(rootDir).getCrashHistory()

        assertEquals(listOf("crashed-bundle"), history.bundles.map { it.bundleId })
        assertNull(history.interruptedLaunch)
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
    fun `resolveBundleFile rejects root index without manifest`() {
        val rootDir = temporaryFolder.newFolder("legacy-root-index")
        val service = createService(rootDir)
        val bundleDir = createBundleDir(rootDir, "bundle-legacy")
        writeFile(bundleDir, "index.android.bundle")

        assertNull(invokeResolveBundleFile(service, bundleDir))
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
    fun `failed final rename restores existing bundle`() =
        runBlocking {
            val root = temporaryFolder.newFolder("failed-final-rename")
            val preferences = InMemoryPreferencesService()
            val target = createCompleteBundle(root, "target", "old")
            val oldBundleFile = File(target, "index.android.bundle")
            preferences.setItem("HotUpdaterBundleURL", oldBundleFile.absolutePath)
            writeMetadata(
                root,
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = "target",
                ),
            )
            val manifest = manifestJson("target", mapOf("index.android.bundle" to sha256(root, "new")))
            val downloads =
                MappingDownloadService(
                    mapOf(
                        "https://example.com/manifest.json" to manifest,
                        "https://example.com/bundle" to "new",
                    ),
                )
            val service =
                createService(
                    root,
                    preferences = preferences,
                    downloadService = downloads,
                    builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                    directoryRenamer = { source, destination ->
                        if (source.name == "target.tmp" && destination.name == "target") {
                            false
                        } else {
                            source.renameTo(destination)
                        }
                    },
                )

            val result =
                runCatching {
                    service.updateBundle(
                        "target",
                        "https://example.com/manifest.json",
                        sha256(root, manifest),
                        mapOf(
                            "index.android.bundle" to
                                ChangedAssetDescriptor("https://example.com/bundle", sha256(root, "new")),
                        ),
                    ) {}
                }

            assertUpdateFailure(
                result.exceptionOrNull(),
                "MOVE_OPERATION_FAILED",
                UpdateFailure.install(UpdateFailureReason.STORAGE),
            )
            assertEquals("old", oldBundleFile.readText())
            assertFalse(File(bundleStoreDir(root), "target.install-backup").exists())
            assertEquals(oldBundleFile.absolutePath, preferences.getItem("HotUpdaterBundleURL"))
            assertEquals("target", loadMetadata(root)?.stagingBundleId)
        }

    @Test
    fun `metadata write failure restores preference and existing bundle`() =
        runBlocking {
            val root = temporaryFolder.newFolder("failed-metadata-write")
            val preferences = InMemoryPreferencesService()
            val target = createCompleteBundle(root, "target", "old")
            val oldBundleFile = File(target, "index.android.bundle")
            preferences.setItem("HotUpdaterBundleURL", oldBundleFile.absolutePath)
            val previousMetadata =
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = "target",
                )
            writeMetadata(root, previousMetadata)
            val newHash = sha256(root, "new")
            val manifest = manifestJson("target", mapOf("index.android.bundle" to newHash))
            val service =
                createService(
                    root,
                    preferences = preferences,
                    downloadService =
                        MappingDownloadService(
                            mapOf(
                                "https://example.com/manifest.json" to manifest,
                                "https://example.com/bundle" to "new",
                            ),
                        ),
                    builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                    metadataWriter = { _, _ -> false },
                )

            val result =
                runCatching {
                    service.updateBundle(
                        "target",
                        "https://example.com/manifest.json",
                        sha256(root, manifest),
                        mapOf(
                            "index.android.bundle" to ChangedAssetDescriptor("https://example.com/bundle", newHash),
                        ),
                    ) {}
                }

            assertUpdateFailure(
                result.exceptionOrNull(),
                "UNKNOWN_ERROR",
                UpdateFailure.install(UpdateFailureReason.STORAGE),
            )
            assertEquals("old", oldBundleFile.readText())
            assertFalse(File(bundleStoreDir(root), "target.install-backup").exists())
            assertEquals(oldBundleFile.absolutePath, preferences.getItem("HotUpdaterBundleURL"))
            assertEquals(previousMetadata.stagingBundleId, loadMetadata(root)?.stagingBundleId)
        }

    @Test
    fun `preference write failure aborts before metadata commit and restores existing bundle`() =
        runBlocking {
            val root = temporaryFolder.newFolder("failed-preference-write")
            val target = createCompleteBundle(root, "target", "old")
            val oldBundleFile = File(target, "index.android.bundle")
            var preferenceWrites = 0
            val preferences =
                InMemoryPreferencesService { key, _ ->
                    if (key == "HotUpdaterBundleURL") preferenceWrites++
                    preferenceWrites == 2
                }
            preferences.setItem("HotUpdaterBundleURL", oldBundleFile.absolutePath)
            writeMetadata(
                root,
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = "target",
                ),
            )
            val newHash = sha256(root, "new")
            val manifest = manifestJson("target", mapOf("index.android.bundle" to newHash))
            var metadataWrites = 0
            val service =
                createService(
                    root,
                    preferences = preferences,
                    downloadService =
                        MappingDownloadService(
                            mapOf(
                                "https://example.com/manifest.json" to manifest,
                                "https://example.com/bundle" to "new",
                            ),
                        ),
                    builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                    metadataWriter = { metadata, file ->
                        metadataWrites++
                        metadata.saveToFile(file)
                    },
                )

            val result =
                runCatching {
                    service.updateBundle(
                        "target",
                        "https://example.com/manifest.json",
                        sha256(root, manifest),
                        mapOf(
                            "index.android.bundle" to ChangedAssetDescriptor("https://example.com/bundle", newHash),
                        ),
                    ) {}
                }

            assertUpdateFailure(
                result.exceptionOrNull(),
                "UNKNOWN_ERROR",
                UpdateFailure.install(UpdateFailureReason.STORAGE),
            )
            assertEquals(0, metadataWrites)
            assertEquals("old", oldBundleFile.readText())
            assertEquals(oldBundleFile.absolutePath, preferences.getItem("HotUpdaterBundleURL"))
        }

    @Test
    fun `startup restores interrupted promotion backup when final is absent`() {
        val root = temporaryFolder.newFolder("missing-final-recovery")
        val backup = createCompleteBundle(root, "target.install-backup", "old", manifestBundleId = "target")

        createService(root)

        val restored = File(bundleStoreDir(root), "target")
        assertEquals("old", File(restored, "index.android.bundle").readText())
        assertFalse(backup.exists())
    }

    @Test
    fun `startup keeps complete final when install backup also exists`() {
        val root = temporaryFolder.newFolder("complete-final-recovery")
        val final = createCompleteBundle(root, "target", "new")
        val backup = createCompleteBundle(root, "target.install-backup", "old", manifestBundleId = "target")

        createService(root)

        assertEquals("new", File(final, "index.android.bundle").readText())
        assertFalse(backup.exists())
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
                progressCallback = progress::add,
            )
            assertTrue("Expected concurrent requests, observed ${maximum.get()}", maximum.get() > 1)
            assertTrue("Concurrency must be bounded", maximum.get() <= 4)
            assertEquals(paths.size, progress.last().details?.completedFilesCount)
        }

    @Test
    fun `archive installs as one actual network file at equal planned bytes`() =
        runBlocking {
            val root = temporaryFolder.newFolder("archive-selected")
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val contents = mapOf("assets/image.png" to "image", "index.android.bundle" to "bundle")
            val hashes = contents.mapValues { sha256(root, it.value) }
            val manifest =
                manifestJson(
                    bundleId = "target",
                    assets = hashes,
                    byteSizes =
                        contents.mapValues {
                            it.value
                                .toByteArray()
                                .size
                                .toLong()
                        },
                    downloadByteSizes = mapOf("assets/image.png" to 50, "index.android.bundle" to 55),
                    archive = archiveJson(root, archiveBytes, tarByteSize = 3072),
                )
            val downloads =
                BinaryMappingDownloadService(
                    mapOf(
                        MANIFEST_URL to manifest.toByteArray(),
                        ARCHIVE_URL to archiveBytes,
                    ),
                )
            val service = createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            val progress = CopyOnWriteArrayList<UpdateProgressPayload>()

            service.updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = progress::add,
            )

            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), downloads.calls)
            assertEquals(
                listOf("bundle.tar.br"),
                progress
                    .last()
                    .details
                    ?.files
                    ?.map { it.path },
            )
            assertEquals(
                archiveBytes.size.toLong(),
                progress
                    .last()
                    .details
                    ?.files
                    ?.single()
                    ?.downloadedBytes,
            )
            val installed = File(bundleStoreDir(root), "target")
            assertEquals("bundle", File(installed, "index.android.bundle").readText())
            assertEquals("image", File(installed, "assets/image.png").readText())
            val installedManifest = JSONObject(File(installed, "manifest.json").readText())
            assertEquals(archiveBytes.size.toLong(), installedManifest.getJSONObject("archive").getLong("downloadByteSize"))
            assertEquals(6, installedManifest.getJSONObject("assets").getJSONObject("index.android.bundle").getLong("byteSize"))
        }

    @Test
    fun `full network plan accepts only bounded TAR framing overhead`() =
        runBlocking {
            val contents = mapOf("assets/image.png" to "image", "index.android.bundle" to "bundle")
            val logicalBytes = contents.values.sumOf { it.toByteArray().size.toLong() }
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val individualBytes = archiveBytes.size.toLong() - 1
            val downloadByteSizes =
                mapOf(
                    "assets/image.png" to individualBytes / 2,
                    "index.android.bundle" to individualBytes - individualBytes / 2,
                )

            val selectedRoot = temporaryFolder.newFolder("archive-framing-selected")
            val selectedHashes = contents.mapValues { sha256(selectedRoot, it.value) }
            val selectedManifest =
                manifestJson(
                    bundleId = "target",
                    assets = selectedHashes,
                    byteSizes =
                        contents.mapValues {
                            it.value
                                .toByteArray()
                                .size
                                .toLong()
                        },
                    downloadByteSizes = downloadByteSizes,
                    archive = archiveJson(selectedRoot, archiveBytes, tarByteSize = 3072),
                )
            val selectedDownloads =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to selectedManifest.toByteArray(), ARCHIVE_URL to archiveBytes),
                )
            createService(
                selectedRoot,
                downloadService = selectedDownloads,
                builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
            ).updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(selectedRoot, selectedManifest),
                assets = selectedHashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = {},
            )
            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), selectedDownloads.calls)

            val declinedRoot = temporaryFolder.newFolder("archive-framing-declined")
            val declinedHashes = contents.mapValues { sha256(declinedRoot, it.value) }
            val minimumTarBytes = 1024L
            val firstByteOutsideBound = individualBytes + (minimumTarBytes - logicalBytes) + 1
            val declinedManifest =
                manifestJson(
                    bundleId = "target",
                    assets = declinedHashes,
                    byteSizes =
                        contents.mapValues {
                            it.value
                                .toByteArray()
                                .size
                                .toLong()
                        },
                    downloadByteSizes = downloadByteSizes,
                    archive =
                        archiveJson(declinedRoot, archiveBytes, tarByteSize = minimumTarBytes)
                            .put("downloadByteSize", firstByteOutsideBound),
                )
            val declinedDownloads =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to declinedManifest.toByteArray()) +
                        contents.mapKeys { "https://example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                )
            createService(
                declinedRoot,
                downloadService = declinedDownloads,
                builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
            ).updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(declinedRoot, declinedManifest),
                assets = declinedHashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = {},
            )
            assertFalse(declinedDownloads.calls.contains(ARCHIVE_URL))
        }

    @Test
    fun `corrupt archive is discarded before exactly one ordinary file pass`() =
        runBlocking {
            val root = temporaryFolder.newFolder("archive-fallback")
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val corruptArchive = archiveBytes.clone().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() }
            val contents = mapOf("assets/image.png" to "image", "index.android.bundle" to "bundle")
            val hashes = contents.mapValues { sha256(root, it.value) }
            val manifest =
                manifestJson(
                    bundleId = "target",
                    assets = hashes,
                    byteSizes =
                        contents.mapValues {
                            it.value
                                .toByteArray()
                                .size
                                .toLong()
                        },
                    downloadByteSizes = contents.mapValues { 100L },
                    archive = archiveJson(root, archiveBytes, tarByteSize = 3072),
                )
            val downloads =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to manifest.toByteArray(), ARCHIVE_URL to corruptArchive) +
                        contents.mapKeys { "https://example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                )
            val service = createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            val progress = CopyOnWriteArrayList<UpdateProgressPayload>()

            service.updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = progress::add,
            )

            assertEquals(1, downloads.calls.count { it == ARCHIVE_URL })
            assertEquals(1, downloads.calls.count { it == "https://example.com/index.android.bundle" })
            assertEquals(1, downloads.calls.count { it == "https://example.com/assets/image.png" })
            assertEquals(
                hashes.keys.sorted(),
                progress
                    .last()
                    .details
                    ?.files
                    ?.map { it.path },
            )
            assertFalse(File(bundleStoreDir(root), "target.archive.tmp").exists())
            assertFalse(File(bundleStoreDir(root), "target.local.tmp").exists())
        }

    @Test
    fun `partial local reuse keeps strict cost comparison with two network files`() =
        runBlocking {
            val root = temporaryFolder.newFolder("archive-one-remaining")
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val contents =
                mapOf(
                    "assets/image.png" to "image",
                    "assets/other.png" to "other",
                    "index.android.bundle" to "bundle",
                )
            val hashes = contents.mapValues { sha256(root, it.value) }
            val manifest =
                manifestJson(
                    bundleId = "target",
                    assets = hashes,
                    byteSizes =
                        contents.mapValues {
                            it.value
                                .toByteArray()
                                .size
                                .toLong()
                        },
                    downloadByteSizes = contents.mapValues { 1L },
                    archive = archiveJson(root, archiveBytes, tarByteSize = 3072),
                )
            val bundleUrl = "https://example.com/index.android.bundle"
            val otherUrl = "https://example.com/assets/other.png"
            val downloads =
                BinaryMappingDownloadService(
                    mapOf(
                        MANIFEST_URL to manifest.toByteArray(),
                        bundleUrl to "bundle".toByteArray(),
                        otherUrl to "other".toByteArray(),
                    ),
                )
            val service =
                createService(
                    rootDir = root,
                    downloadService = downloads,
                    builtInAssetResolver = MappingBuiltInAssetResolver(mapOf("assets/image.png" to "image")),
                )

            service.updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = {},
            )

            assertFalse(downloads.calls.contains(ARCHIVE_URL))
            assertEquals(1, downloads.calls.count { it == bundleUrl })
            assertEquals(1, downloads.calls.count { it == otherUrl })
        }

    @Test
    fun `archive selection declines incomplete expensive and overflowing cost plans`() =
        runBlocking {
            data class CostCase(
                val name: String,
                val downloadSizes: Map<String, Long>,
                val archiveSize: Long,
                val tarSize: Long = 3072,
                val logicalSizes: (Map<String, String>) -> Map<String, Long> = { contents ->
                    contents.mapValues {
                        it.value
                            .toByteArray()
                            .size
                            .toLong()
                    }
                },
                val descriptors: (Map<String, String>) -> Map<String, ChangedAssetDescriptor>,
            )

            val cases =
                listOf(
                    CostCase("missing", mapOf("index.android.bundle" to 100), 1) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase("larger", mapOf("index.android.bundle" to 50, "assets/image.png" to 50), 4000) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase("zero-archive", mapOf("index.android.bundle" to 100, "assets/image.png" to 100), 0) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase("short-tar", mapOf("index.android.bundle" to 100, "assets/image.png" to 100), 1, tarSize = 1023) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase(
                        "negative-framing",
                        mapOf("index.android.bundle" to 100, "assets/image.png" to 100),
                        1,
                        tarSize = 1024,
                        logicalSizes = { contents -> contents.mapValues { 600L } },
                    ) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase(
                        "logical-overflow",
                        mapOf("index.android.bundle" to 100, "assets/image.png" to 100),
                        1,
                        tarSize = 9_007_199_254_740_991,
                        logicalSizes = {
                            mapOf(
                                "index.android.bundle" to 9_007_199_254_740_991,
                                "assets/image.png" to 1,
                            )
                        },
                    ) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase(
                        "framed-limit-overflow",
                        mapOf("index.android.bundle" to 9_007_199_254_740_991, "assets/image.png" to 0),
                        1,
                    ) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                    CostCase("unknown-patch", mapOf("index.android.bundle" to 100, "assets/image.png" to 100), 1) { hashes ->
                        hashes.mapValues { (path, hash) ->
                            ChangedAssetDescriptor(
                                fileUrl = "https://example.com/$path",
                                fileHash = hash,
                                patch =
                                    if (path == "index.android.bundle") {
                                        BsdiffPatchDescriptor("bsdiff", "base", "a", "b", "https://example.com/patch")
                                    } else {
                                        null
                                    },
                            )
                        }
                    },
                    CostCase("known-patch", mapOf("index.android.bundle" to 100, "assets/image.png" to 1), 3) { hashes ->
                        hashes.mapValues { (path, hash) ->
                            ChangedAssetDescriptor(
                                fileUrl = "https://example.com/$path",
                                fileHash = hash,
                                patch =
                                    if (path == "index.android.bundle") {
                                        BsdiffPatchDescriptor("bsdiff", "base", "a", "b", "https://example.com/patch", byteSize = 1)
                                    } else {
                                        null
                                    },
                            )
                        }
                    },
                    CostCase("negative-patch", mapOf("index.android.bundle" to 100, "assets/image.png" to 100), 1) { hashes ->
                        hashes.mapValues { (path, hash) ->
                            ChangedAssetDescriptor(
                                fileUrl = "https://example.com/$path",
                                fileHash = hash,
                                patch =
                                    if (path == "index.android.bundle") {
                                        BsdiffPatchDescriptor("bsdiff", "base", "a", "b", "https://example.com/patch", byteSize = -1)
                                    } else {
                                        null
                                    },
                            )
                        }
                    },
                    CostCase("overflowing-patch", mapOf("index.android.bundle" to 100, "assets/image.png" to 100), 1) { hashes ->
                        hashes.mapValues { (path, hash) ->
                            ChangedAssetDescriptor(
                                fileUrl = "https://example.com/$path",
                                fileHash = hash,
                                patch =
                                    if (path == "index.android.bundle") {
                                        BsdiffPatchDescriptor(
                                            "bsdiff",
                                            "base",
                                            "a",
                                            "b",
                                            "https://example.com/patch",
                                            byteSize = Long.MAX_VALUE,
                                        )
                                    } else {
                                        null
                                    },
                            )
                        }
                    },
                    CostCase(
                        "overflow",
                        mapOf("index.android.bundle" to 9_007_199_254_740_991, "assets/image.png" to 1),
                        1,
                    ) { hashes ->
                        hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) }
                    },
                )

            for (case in cases) {
                val root = temporaryFolder.newFolder("archive-decline-${case.name}")
                val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
                val contents = mapOf("assets/image.png" to "image", "index.android.bundle" to "bundle")
                val hashes = contents.mapValues { sha256(root, it.value) }
                val manifest =
                    manifestJson(
                        bundleId = "target",
                        assets = hashes,
                        byteSizes = case.logicalSizes(contents),
                        downloadByteSizes = case.downloadSizes,
                        archive = archiveJson(root, archiveBytes, tarByteSize = case.tarSize).put("downloadByteSize", case.archiveSize),
                    )
                val downloads =
                    BinaryMappingDownloadService(
                        mapOf(MANIFEST_URL to manifest.toByteArray()) +
                            contents.mapKeys { "https://example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                    )
                val service =
                    createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))

                service.updateBundle(
                    bundleId = "target",
                    manifestUrl = MANIFEST_URL,
                    manifestFileHash = sha256(root, manifest),
                    assets = case.descriptors(hashes),
                    archiveUrl = ARCHIVE_URL,
                    progressCallback = {},
                )

                assertFalse("${case.name} must decline archive", downloads.calls.contains(ARCHIVE_URL))
            }
        }

    @Test
    fun `download failures of the manifest or a file report network http or storage`() =
        runBlocking {
            val network = UpdateFailure.download(UpdateFailureReason.NETWORK)
            val cases =
                listOf(
                    Triple(HttpStatusException(404, "Not Found"), "DOWNLOAD_FAILED", UpdateFailure.http(404)),
                    Triple(
                        HttpStatusException(403, "Forbidden", originCode = "AccessDenied"),
                        "DOWNLOAD_FAILED",
                        UpdateFailure.http(403, originCode = "AccessDenied"),
                    ),
                    Triple(
                        UnknownHostException("example.com"),
                        "DOWNLOAD_FAILED",
                        network.copy(transport = UpdateFailureTransport.DNS),
                    ),
                    Triple(
                        SocketTimeoutException("timeout"),
                        "DOWNLOAD_FAILED",
                        network.copy(transport = UpdateFailureTransport.TIMEOUT),
                    ),
                    Triple(
                        ConnectException("Connection refused"),
                        "DOWNLOAD_FAILED",
                        network.copy(transport = UpdateFailureTransport.CONNECTION),
                    ),
                    Triple(
                        SSLHandshakeException("Chain validation failed"),
                        "DOWNLOAD_FAILED",
                        network.copy(transport = UpdateFailureTransport.TLS),
                    ),
                    Triple(IncompleteDownloadException(expectedSize = 10, actualSize = 4), "INCOMPLETE_DOWNLOAD", network),
                    Triple(
                        LocalStorageException(IOException("No space left on device")),
                        "DOWNLOAD_FAILED",
                        UpdateFailure.install(UpdateFailureReason.STORAGE),
                    ),
                )
            val resources = mapOf(MANIFEST_URL to UpdateFailureResource.MANIFEST, BUNDLE_URL to UpdateFailureResource.FILE)

            cases.forEachIndexed { index, (error, code, failure) ->
                resources.forEach { (failingUrl, resource) ->
                    val root = temporaryFolder.newFolder("download-failure-$index-${resource.value}")
                    val result = runOneFileUpdate(root, failures = mapOf(failingUrl to error))

                    assertUpdateFailure(result, code, failure.copy(resource = resource))
                    assertNull(loadMetadata(root)?.stagingBundleId)
                }
            }
        }

    @Test
    fun `verification failures report hash mismatch signature or invalid response`() =
        runBlocking {
            val hashMismatch = UpdateFailure.download(UpdateFailureReason.HASH_MISMATCH)
            val hashMismatchRoot = temporaryFolder.newFolder("manifest-hash-mismatch")
            assertUpdateFailure(
                runOneFileUpdate(hashMismatchRoot, manifestFileHash = sha256(hashMismatchRoot, "another manifest")),
                "SIGNATURE_VERIFICATION_FAILED",
                hashMismatch.copy(resource = UpdateFailureResource.MANIFEST),
            )

            assertUpdateFailure(
                runOneFileUpdate(temporaryFolder.newFolder("file-hash-mismatch"), servedFile = "tampered".toByteArray()),
                "SIGNATURE_VERIFICATION_FAILED",
                hashMismatch.copy(resource = UpdateFailureResource.FILE),
            )

            HotUpdaterConfig.publicKey = "configured-public-key"
            try {
                assertUpdateFailure(
                    runOneFileUpdate(temporaryFolder.newFolder("unsigned-with-public-key")),
                    "SIGNATURE_VERIFICATION_FAILED",
                    UpdateFailure.download(UpdateFailureReason.SIGNATURE).copy(resource = UpdateFailureResource.MANIFEST),
                )
            } finally {
                HotUpdaterConfig.publicKey = null
            }

            val invalidManifest =
                UpdateFailure.download(UpdateFailureReason.INVALID_RESPONSE).copy(resource = UpdateFailureResource.MANIFEST)
            val otherBundleRoot = temporaryFolder.newFolder("manifest-for-other-bundle")
            assertUpdateFailure(
                runOneFileUpdate(
                    otherBundleRoot,
                    manifest = manifestJson("other-bundle", mapOf("index.android.bundle" to sha256(otherBundleRoot, BUNDLE_CONTENT))),
                ),
                "INVALID_BUNDLE",
                invalidManifest,
            )
            assertUpdateFailure(
                runOneFileUpdate(temporaryFolder.newFolder("unparsable-manifest"), manifest = "not json"),
                "INVALID_BUNDLE",
                invalidManifest,
            )
            assertUpdateFailure(
                runOneFileUpdate(temporaryFolder.newFolder("missing-platform-bundle"), assetPath = "assets/image.png"),
                "INVALID_BUNDLE",
                invalidManifest,
            )
            val malformedUrlRoot = temporaryFolder.newFolder("malformed-file-url")
            assertUpdateFailure(
                runOneFileUpdate(
                    malformedUrlRoot,
                    descriptor = ChangedAssetDescriptor("not a url", sha256(malformedUrlRoot, BUNDLE_CONTENT)),
                ),
                "UNKNOWN_ERROR",
                invalidManifest.copy(resource = UpdateFailureResource.FILE),
            )
        }

    @Test
    fun `install failures report extract or storage`() =
        runBlocking {
            val brotliRoot = temporaryFolder.newFolder("corrupt-brotli-file")
            val truncatedBrotli = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID).let { it.copyOf(it.size / 2) }
            assertUpdateFailure(
                runOneFileUpdate(
                    brotliRoot,
                    descriptor = ChangedAssetDescriptor(BUNDLE_URL, sha256(brotliRoot, BUNDLE_CONTENT), fileCompression = "br"),
                    servedFile = truncatedBrotli,
                ),
                "DOWNLOAD_FAILED",
                UpdateFailure.install(UpdateFailureReason.EXTRACT).copy(resource = UpdateFailureResource.FILE),
            )

            val stagingRoot = temporaryFolder.newFolder("staging-directory-blocked")
            File(bundleStoreDir(stagingRoot), "target.tmp").writeText("a file where the staging directory belongs")
            assertUpdateFailure(
                runOneFileUpdate(stagingRoot),
                "DIRECTORY_CREATION_FAILED",
                UpdateFailure.install(UpdateFailureReason.STORAGE),
            )
        }

    @Test
    fun `unanticipated failures report unknown in the stage they happened in`() =
        runBlocking {
            val downloadRoot = temporaryFolder.newFolder("unknown-download-failure")
            val downloadResult =
                runCatching {
                    createService(downloadRoot).updateBundle("target", MANIFEST_URL, "hash", emptyMap()) {}
                }.exceptionOrNull()
            assertUpdateFailure(
                downloadResult,
                "UNKNOWN_ERROR",
                UpdateFailure.download(UpdateFailureReason.UNKNOWN).copy(resource = UpdateFailureResource.MANIFEST),
            )
            assertEquals("downloadFile should not be called in these tests", downloadResult?.message)

            val installResult =
                runOneFileUpdate(
                    temporaryFolder.newFolder("unknown-install-failure"),
                    directoryRenamer = { source, destination ->
                        if (source.name == "target.tmp") throw SecurityException("Promotion denied")
                        source.renameTo(destination)
                    },
                )
            assertUpdateFailure(installResult, "UNKNOWN_ERROR", UpdateFailure.install(UpdateFailureReason.UNKNOWN))
            assertEquals("Promotion denied", installResult?.message)
        }

    @Test
    fun `a bundle built from changed files reports manifest delivery`() =
        runBlocking {
            val root = temporaryFolder.newFolder("manifest-delivery")
            val hash = sha256(root, BUNDLE_CONTENT)
            val manifest = manifestJson("target", mapOf("index.android.bundle" to hash))
            val downloads =
                BinaryMappingDownloadService(mapOf(MANIFEST_URL to manifest.toByteArray(), BUNDLE_URL to BUNDLE_CONTENT.toByteArray()))
            val service = createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            val assets = mapOf("index.android.bundle" to ChangedAssetDescriptor(BUNDLE_URL, hash))

            val downloaded = service.updateBundle("target", MANIFEST_URL, sha256(root, manifest), assets) {}
            // Installing it again reuses the staged file, so nothing is downloaded.
            val reused = service.updateBundle("target", MANIFEST_URL, sha256(root, manifest), assets) {}

            assertEquals(UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = false), downloaded)
            assertEquals(UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = false), reused)
            assertEquals(1, downloads.calls.count { it == BUNDLE_URL })
        }

    @Test
    fun `a bundle installed from the archive reports archive delivery`() =
        runBlocking {
            val root = temporaryFolder.newFolder("archive-delivery")
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val contents = mapOf("assets/image.png" to "image", "index.android.bundle" to "bundle")
            val hashes = contents.mapValues { sha256(root, it.value) }
            val manifest =
                manifestJson(
                    bundleId = "target",
                    assets = hashes,
                    byteSizes = contents.mapValues { it.value.length.toLong() },
                    downloadByteSizes = mapOf("assets/image.png" to 50, "index.android.bundle" to 55),
                    archive = archiveJson(root, archiveBytes, tarByteSize = 3072),
                )
            val downloads =
                BinaryMappingDownloadService(mapOf(MANIFEST_URL to manifest.toByteArray(), ARCHIVE_URL to archiveBytes))

            val result =
                createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
                    .updateBundle(
                        bundleId = "target",
                        manifestUrl = MANIFEST_URL,
                        manifestFileHash = sha256(root, manifest),
                        assets = hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                        archiveUrl = ARCHIVE_URL,
                        progressCallback = {},
                    )

            assertEquals(UpdateBundleResult(BundleDelivery.ARCHIVE, patchFallback = false), result)
            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), downloads.calls)
        }

    @Test
    fun `a file produced by a patch reports patch delivery`() =
        runBlocking {
            val patchUpdate = PatchUpdate(temporaryFolder.newFolder("patch-delivery"))

            val result = patchUpdate.run(servedPatch = patchUpdate.patchBytes)

            assertEquals(UpdateBundleResult(BundleDelivery.PATCH, patchFallback = false), result.getOrThrow())
            assertEquals(listOf(MANIFEST_URL, PATCH_URL), patchUpdate.downloads.calls)
            assertEquals(PATCHED_CONTENT, File(bundleStoreDir(patchUpdate.root), "target/index.android.bundle").readText())
        }

    @Test
    fun `a patch that cannot produce its file falls back to the file`() =
        runBlocking {
            val corruptPatch = PatchUpdate(temporaryFolder.newFolder("patch-fallback-corrupt"))
            assertEquals(
                UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = true),
                corruptPatch.run(servedPatch = "not a bsdiff patch".toByteArray()).getOrThrow(),
            )
            assertEquals(listOf(MANIFEST_URL, PATCH_URL, BUNDLE_URL), corruptPatch.downloads.calls)

            val unreachablePatch = PatchUpdate(temporaryFolder.newFolder("patch-fallback-http"))
            assertEquals(
                UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = true),
                unreachablePatch.run(servedPatch = null).getOrThrow(),
            )

            val corruptBase = PatchUpdate(temporaryFolder.newFolder("patch-fallback-base"))
            File(bundleStoreDir(corruptBase.root), "base-bundle/index.android.bundle").writeText("corrupt base")
            assertEquals(
                UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = true),
                corruptBase.run(servedPatch = corruptBase.patchBytes).getOrThrow(),
            )
            assertFalse(corruptBase.downloads.calls.contains(PATCH_URL))

            // A patch for a bundle other than the running one is never attempted.
            val otherBase = PatchUpdate(temporaryFolder.newFolder("patch-for-other-base"))
            assertEquals(
                UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = false),
                otherBase.run(servedPatch = otherBase.patchBytes, patchBaseBundleId = "other-bundle").getOrThrow(),
            )
            assertEquals(listOf(MANIFEST_URL, BUNDLE_URL), otherBase.downloads.calls)
        }

    /**
     * Bundle "target" whose index.android.bundle can be produced by a bsdiff
     * patch against the running bundle "base-bundle", or downloaded whole.
     */
    private inner class PatchUpdate(
        val root: File,
    ) {
        val patchBytes: ByteArray = Base64.getDecoder().decode(BsdiffPatchTest.BSDIFF_PATCH_FIXTURE_BASE64)
        private val preferences = InMemoryPreferencesService()
        lateinit var downloads: BinaryMappingDownloadService

        init {
            val base = createBundleDir(root, "base-bundle")
            val baseFile = writeFile(base, "index.android.bundle", BASE_CONTENT)
            File(base, "manifest.json").writeText(
                manifestJson("base-bundle", mapOf("index.android.bundle" to sha256(root, BASE_CONTENT))),
            )
            writeMetadata(root, BundleMetadata(isolationKey = TEST_ISOLATION_KEY, stagingBundleId = "base-bundle"))
            preferences.setItem("HotUpdaterBundleURL", baseFile.absolutePath)
        }

        /** Serves [servedPatch] with its hash, or a 404 for the patch when it is null. */
        suspend fun run(
            servedPatch: ByteArray?,
            patchBaseBundleId: String = "base-bundle",
        ): Result<UpdateBundleResult> {
            val targetHash = sha256(root, PATCHED_CONTENT)
            val manifest = manifestJson("target", mapOf("index.android.bundle" to targetHash))
            downloads =
                BinaryMappingDownloadService(
                    buildMap {
                        put(MANIFEST_URL, manifest.toByteArray())
                        put(BUNDLE_URL, PATCHED_CONTENT.toByteArray())
                        servedPatch?.let { put(PATCH_URL, it) }
                    },
                    failures = if (servedPatch == null) mapOf(PATCH_URL to HttpStatusException(404, "Not Found")) else emptyMap(),
                )
            val service =
                createService(
                    root,
                    preferences = preferences,
                    downloadService = downloads,
                    builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                )
            val descriptor =
                ChangedAssetDescriptor(
                    fileUrl = BUNDLE_URL,
                    fileHash = targetHash,
                    patch =
                        BsdiffPatchDescriptor(
                            algorithm = "bsdiff",
                            baseBundleId = patchBaseBundleId,
                            baseFileHash = sha256(root, BASE_CONTENT),
                            patchFileHash = sha256(root, servedPatch ?: ByteArray(0)),
                            patchUrl = PATCH_URL,
                        ),
                )
            return runCatching {
                service.updateBundle("target", MANIFEST_URL, sha256(root, manifest), mapOf("index.android.bundle" to descriptor)) {}
            }
        }
    }

    @Test
    fun `rejections that are not update failures carry no classification`() =
        runBlocking {
            val crashedRoot = temporaryFolder.newFolder("crashed-bundle")
            assertTrue(
                CrashedHistory(mutableListOf(CrashedBundleEntry(bundleId = "target", crashedAt = 1)))
                    .saveToFile(File(bundleStoreDir(crashedRoot), CrashedHistory.CRASHED_HISTORY_FILENAME)),
            )
            assertUpdateFailure(
                runOneFileUpdate(crashedRoot),
                "BUNDLE_IN_CRASHED_HISTORY",
                null,
            )

            val staleRoot = temporaryFolder.newFolder("stale-selection")
            val hash = sha256(staleRoot, BUNDLE_CONTENT)
            val manifest = manifestJson("target", mapOf("index.android.bundle" to hash))
            val served =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to manifest.toByteArray(), BUNDLE_URL to BUNDLE_CONTENT.toByteArray()),
                )
            lateinit var service: BundleFileStorageService
            val downloads =
                object : DownloadService {
                    override suspend fun downloadFile(
                        fileUrl: URL,
                        destination: File,
                        fileSizeCallback: ((Long) -> Unit)?,
                        progressCallback: (DownloadProgress) -> Unit,
                    ): DownloadResult {
                        if (fileUrl.toString() == BUNDLE_URL) {
                            // A newer catalog is accepted while the selected bundle downloads.
                            service.acceptReleaseCatalog("project-a", "scope-production", 2, "hash-2", "production", "context-2")
                        }
                        return served.downloadFile(fileUrl, destination, fileSizeCallback, progressCallback)
                    }
                }
            service = createService(staleRoot, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            assertTrue(service.acceptReleaseCatalog("project-a", "scope-production", 1, "hash-1", "production", "context-1"))
            assertTrue(service.stageReleaseSelection(releaseSelection("release-one", "target", 1, "hash-1", "context-1")))

            val staleResult =
                runCatching {
                    service.updateBundle(
                        "target",
                        MANIFEST_URL,
                        sha256(staleRoot, manifest),
                        mapOf("index.android.bundle" to ChangedAssetDescriptor(BUNDLE_URL, hash)),
                    ) {}
                }.exceptionOrNull()

            assertTrue("Expected a stale selection, got $staleResult", staleResult is StaleReleaseSelectionException)
            assertNull(loadMetadata(staleRoot)?.stagingBundleId)
        }

    /** Installs bundle "target" with one file, returning the failure, if any. */
    private suspend fun runOneFileUpdate(
        root: File,
        assetPath: String = "index.android.bundle",
        manifest: String = manifestJson("target", mapOf(assetPath to sha256(root, BUNDLE_CONTENT))),
        manifestFileHash: String = sha256(root, manifest),
        descriptor: ChangedAssetDescriptor = ChangedAssetDescriptor(BUNDLE_URL, sha256(root, BUNDLE_CONTENT)),
        servedFile: ByteArray = BUNDLE_CONTENT.toByteArray(),
        failures: Map<String, Exception> = emptyMap(),
        directoryRenamer: (File, File) -> Boolean = { source, destination -> source.renameTo(destination) },
    ): Throwable? {
        val service =
            createService(
                root,
                downloadService =
                    BinaryMappingDownloadService(
                        mapOf(MANIFEST_URL to manifest.toByteArray(), BUNDLE_URL to servedFile),
                        failures,
                    ),
                builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                directoryRenamer = directoryRenamer,
            )
        return runCatching {
            service.updateBundle("target", MANIFEST_URL, manifestFileHash, mapOf(assetPath to descriptor)) {}
        }.exceptionOrNull()
    }

    private fun assertUpdateFailure(
        error: Throwable?,
        code: String,
        failure: UpdateFailure?,
    ) {
        assertTrue("Expected HotUpdaterException, got $error", error is HotUpdaterException)
        val updateError = error as HotUpdaterException
        assertEquals(code, updateError.code)
        assertEquals(failure, updateError.failure)
    }

    private fun createService(
        rootDir: File,
        preferences: InMemoryPreferencesService = InMemoryPreferencesService(),
        downloadService: DownloadService = UnusedDownloadService,
        builtInAssetResolver: BuiltInAssetResolver? = null,
        metadataWriter: (BundleMetadata, File) -> Boolean = { metadata, file -> metadata.saveToFile(file) },
        directoryRenamer: (File, File) -> Boolean = { source, destination -> source.renameTo(destination) },
    ): BundleFileStorageService =
        BundleFileStorageService(
            context = ContextWrapper(null),
            fileSystem = TestFileSystemService(rootDir),
            downloadService = downloadService,
            preferences = preferences,
            isolationKey = TEST_ISOLATION_KEY,
            defaultChannelProvider = { "production" },
            builtInAssetResolver = builtInAssetResolver,
            metadataWriter = metadataWriter,
            directoryRenamer = directoryRenamer,
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

    private fun createCompleteBundle(
        rootDir: File,
        directoryName: String,
        content: String,
        manifestBundleId: String = directoryName,
    ): File {
        val directory = createBundleDir(rootDir, directoryName)
        writeFile(directory, "index.android.bundle", content)
        File(directory, "manifest.json").writeText(
            manifestJson(
                manifestBundleId,
                mapOf("index.android.bundle" to sha256(rootDir, content)),
            ),
        )
        return directory
    }

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

    private fun loadCrashedHistory(rootDir: File): CrashedHistory =
        CrashedHistory.loadFromFile(File(bundleStoreDir(rootDir), CrashedHistory.CRASHED_HISTORY_FILENAME))

    // Stages retried-bundle over stable-bundle, or over the built-in bundle, and
    // leaves a launch of it that could show UI but ended before first content.
    private fun leaveUnfinishedLaunch(
        rootDir: File,
        preferences: InMemoryPreferencesService,
        stableBundleId: String? = "stable-bundle",
    ) {
        listOfNotNull(stableBundleId, "retried-bundle").forEach { bundleId ->
            val directory = createBundleDir(rootDir, bundleId)
            writeFile(directory, "index.android.bundle")
            writeManifest(directory, listOf("index.android.bundle"))
        }
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = stableBundleId,
                stagingBundleId = "retried-bundle",
                verificationPending = true,
            ),
        )
        val launch = createService(rootDir, preferences)
        assertEquals("retried-bundle", launch.prepareLaunch(null).launchedBundleId)
        launch.markLaunchStarted("retried-bundle")
    }

    // A process whose update check can download retried-bundle again.
    private fun createRetryService(
        rootDir: File,
        preferences: InMemoryPreferencesService,
    ): BundleFileStorageService =
        createService(
            rootDir,
            preferences,
            downloadService =
                MappingDownloadService(
                    mapOf(
                        MANIFEST_URL to retriedBundleManifest(rootDir),
                        BUNDLE_URL to RETRIED_BUNDLE_CONTENT,
                    ),
                ),
            builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
        )

    private fun retriedBundleManifest(rootDir: File): String =
        manifestJson(
            "retried-bundle",
            mapOf("index.android.bundle" to sha256(rootDir, RETRIED_BUNDLE_CONTENT)),
        )

    private suspend fun installRetriedBundle(
        service: BundleFileStorageService,
        rootDir: File,
    ): Throwable? =
        runCatching {
            service.updateBundle(
                bundleId = "retried-bundle",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(rootDir, retriedBundleManifest(rootDir)),
                assets =
                    mapOf(
                        "index.android.bundle" to
                            ChangedAssetDescriptor(
                                fileUrl = BUNDLE_URL,
                                fileHash = sha256(rootDir, RETRIED_BUNDLE_CONTENT),
                            ),
                    ),
                progressCallback = {},
            )
        }.exceptionOrNull()

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

    private class InMemoryPreferencesService(
        private val shouldFailWrite: (String, String?) -> Boolean = { _, _ -> false },
    ) : PreferencesService {
        private val values = mutableMapOf<String, String?>()

        override fun getItem(key: String): String? = values[key]

        override fun setItem(
            key: String,
            value: String?,
        ) {
            if (shouldFailWrite(key, value)) {
                throw IllegalStateException("Injected preference write failure")
            }
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

    private class BinaryMappingDownloadService(
        private val contents: Map<String, ByteArray>,
        private val failures: Map<String, Exception> = emptyMap(),
    ) : DownloadService {
        val calls = CopyOnWriteArrayList<String>()

        override suspend fun downloadFile(
            fileUrl: URL,
            destination: File,
            fileSizeCallback: ((Long) -> Unit)?,
            progressCallback: (DownloadProgress) -> Unit,
        ): DownloadResult = download(fileUrl, destination, fileSizeCallback, progressCallback)

        override suspend fun downloadFileOnce(
            fileUrl: URL,
            destination: File,
            fileSizeCallback: ((Long) -> Unit)?,
            progressCallback: (DownloadProgress) -> Unit,
        ): DownloadResult = download(fileUrl, destination, fileSizeCallback, progressCallback)

        private fun download(
            fileUrl: URL,
            destination: File,
            fileSizeCallback: ((Long) -> Unit)?,
            progressCallback: (DownloadProgress) -> Unit,
        ): DownloadResult {
            calls += fileUrl.toString()
            failures[fileUrl.toString()]?.let { return DownloadResult.Error(it) }
            val bytes = contents[fileUrl.toString()] ?: return DownloadResult.Error(IllegalArgumentException("Unexpected URL: $fileUrl"))
            destination.parentFile?.mkdirs()
            destination.writeBytes(bytes)
            fileSizeCallback?.invoke(bytes.size.toLong())
            progressCallback(DownloadProgress(1.0, bytes.size.toLong(), bytes.size.toLong()))
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
        byteSizes: Map<String, Long> = emptyMap(),
        downloadByteSizes: Map<String, Long> = emptyMap(),
        archive: JSONObject? = null,
    ): String =
        JSONObject()
            .put("bundleId", bundleId)
            .put(
                "assets",
                JSONObject().apply {
                    assets.forEach { (path, hash) ->
                        put(
                            path,
                            JSONObject()
                                .put("fileHash", hash)
                                .apply {
                                    byteSizes[path]?.let { put("byteSize", it) }
                                    downloadByteSizes[path]?.let { put("downloadByteSize", it) }
                                },
                        )
                    }
                },
            ).apply {
                archive?.let { put("archive", it) }
            }.toString()

    private fun archiveJson(
        rootDir: File,
        bytes: ByteArray,
        tarByteSize: Long,
    ): JSONObject =
        JSONObject()
            .put("downloadFileHash", sha256(rootDir, bytes))
            .put("downloadByteSize", bytes.size)
            .put("tarByteSize", tarByteSize)

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

    private fun sha256(
        rootDir: File,
        bytes: ByteArray,
    ): String {
        val file = File.createTempFile("hash-", null, rootDir)
        return try {
            file.writeBytes(bytes)
            HashUtils.calculateSHA256(file)
        } finally {
            file.delete()
        }
    }

    companion object {
        private const val TEST_ISOLATION_KEY = "test-isolation-key"
        private const val MANIFEST_URL = "https://example.com/manifest.json"
        private const val ARCHIVE_URL = "https://example.com/bundle.tar.br"
        private const val BUNDLE_URL = "https://example.com/index.android.bundle"
        private const val BUNDLE_CONTENT = "bundle"
        private const val RETRIED_BUNDLE_CONTENT = "retried-bundle"
        private const val PATCH_URL = "https://example.com/index.android.bundle.bsdiff"

        // The base and output of BsdiffPatchTest.BSDIFF_PATCH_FIXTURE_BASE64.
        private const val BASE_CONTENT = "console.log(\"base bundle\");\n"
        private const val PATCHED_CONTENT = "console.log(\"patched bundle\");\n"
    }
}
