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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
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

    @Test
    fun `the next launch is the staged bundle, then the stable one when its files are gone`() {
        val rootDir = temporaryFolder.newFolder()
        createCompleteBundle(rootDir, "stable-bundle", "stable")
        val staged = createCompleteBundle(rootDir, "staged-bundle", "staged")
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "staged-bundle",
                verificationPending = true,
            ),
        )
        val service = createService(rootDir)

        assertEquals("staged-bundle", service.peekLaunchBundleId())

        staged.deleteRecursively()

        assertEquals("stable-bundle", service.peekLaunchBundleId())
    }

    @Test
    fun `the next launch is what prepareLaunch then selects`() {
        val rootDir = temporaryFolder.newFolder()
        createCompleteBundle(rootDir, "staged-bundle", "staged")
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stagingBundleId = "staged-bundle",
                verificationPending = true,
            ),
        )
        val service = createService(rootDir)
        val next = service.peekLaunchBundleId()

        assertEquals(next, service.prepareLaunch(null).launchedBundleId)
        // Its own launch is still the next one: a restart runs it again.
        assertEquals(next, service.peekLaunchBundleId())

        service.markLaunchCompleted(next)

        assertEquals(next, service.peekLaunchBundleId())
    }

    @Test
    fun `the first content of a staged bundle logs that it applied`() {
        val rootDir = temporaryFolder.newFolder()
        val log = logOf(rootDir)
        createCompleteBundle(rootDir, "staged-bundle", "staged")
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stagingBundleId = "staged-bundle",
                stagingSelection = releaseSelection("release-one", "staged-bundle", 1, "hash-1", "context-1"),
                verificationPending = true,
                pendingTransition = PendingSelectionTransition(null, "built-in", "release-one", "staged-bundle"),
            ),
        )
        val service = createService(rootDir, updateLog = log)
        service.prepareLaunch(null)

        service.markLaunchCompleted("staged-bundle")
        // First content of the same launch again, as after an activity recreation.
        service.markLaunchCompleted("staged-bundle")

        val entry = loggedEntries(log).single()
        assertEquals("APPLY", entry.getString("type"))
        assertEquals("APPLIED", entry.getString("outcome"))
        assertEquals("staged-bundle", entry.getString("bundleId"))
        assertEquals("built-in", entry.getString("fromBundleId"))
        assertEquals("release-one", entry.getString("releaseId"))
        assertEquals("production", entry.getString("channel"))
    }

    @Test
    fun `a crash of the staged bundle logs the rollback`() {
        val rootDir = temporaryFolder.newFolder()
        val log = logOf(rootDir)
        createCompleteBundle(rootDir, "stable-bundle", "stable")
        createCompleteBundle(rootDir, "staged-bundle", "staged")
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "staged-bundle",
                verificationPending = true,
            ),
        )

        createService(rootDir, updateLog = log).prepareLaunch(PendingCrashRecovery("staged-bundle", shouldRollback = true))

        val entry = loggedEntries(log).single()
        assertEquals("CRASH_RECOVERY", entry.getString("type"))
        assertEquals("ROLLED_BACK_AFTER_CRASH", entry.getString("outcome"))
        assertEquals("stable-bundle", entry.getString("bundleId"))
        assertEquals("staged-bundle", entry.getString("fromBundleId"))
    }

    @Test
    fun `an unfinished launch and a missing bundle log their own rollbacks`() {
        val unfinishedRoot = temporaryFolder.newFolder()
        val unfinishedLog = logOf(unfinishedRoot)
        createCompleteBundle(unfinishedRoot, "hung-bundle", "hung")
        writeMetadata(
            unfinishedRoot,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stagingBundleId = "hung-bundle",
                verificationPending = true,
                launchInProgress = true,
            ),
        )
        createService(unfinishedRoot, updateLog = unfinishedLog).prepareLaunch(null)
        assertEquals("ROLLED_BACK_UNFINISHED_LAUNCH", loggedEntries(unfinishedLog).single().getString("outcome"))

        val missingRoot = temporaryFolder.newFolder()
        val missingLog = logOf(missingRoot)
        writeMetadata(
            missingRoot,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stagingBundleId = "gone-bundle",
                verificationPending = true,
            ),
        )
        createService(missingRoot, updateLog = missingLog).prepareLaunch(null)
        assertEquals("ROLLED_BACK_MISSING_BUNDLE", loggedEntries(missingLog).single().getString("outcome"))
    }

    @Test
    fun `a channel reset logs the return to the built-in bundle and leaves the log file`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder()
            val log = logOf(rootDir)
            createCompleteBundle(rootDir, "channel-bundle", "channel")
            writeMetadata(
                rootDir,
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = "channel-bundle",
                    verificationPending = false,
                ),
            )
            val service = createService(rootDir, minBundleId = "built-in", updateLog = log)

            assertTrue(service.resetChannel())

            assertNull(service.peekLaunchBundleId())
            val entry = loggedEntries(log).single()
            assertEquals("ROLLBACK", entry.getString("type"))
            assertEquals("CHANNEL_RESET", entry.getString("outcome"))
            assertEquals("built-in", entry.getString("bundleId"))
            assertEquals("channel-bundle", entry.getString("fromBundleId"))
        }

    @Test
    fun `a committed built-in selection logs the rollback and clears the next launch's bundle`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder()
            val log = logOf(rootDir)
            createCompleteBundle(rootDir, "downloaded-bundle", "downloaded")
            writeMetadata(
                rootDir,
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = "downloaded-bundle",
                    verificationPending = false,
                ),
            )
            val service = createService(rootDir, minBundleId = "built-in", updateLog = log)
            assertTrue(
                service.acceptReleaseCatalog("project-a", "scope-production", 2, "hash-2", "production", "context-2"),
            )

            assertTrue(
                service.commitReleaseSelection(
                    PersistedSelection(
                        kind = "BUILTIN",
                        releaseId = null,
                        bundleId = "built-in",
                        catalogId = "project-a",
                        scopeKey = "scope-production",
                        generation = 2,
                        catalogHash = "hash-2",
                        channel = "production",
                        selectionContextHash = "context-2",
                    ),
                ),
            )

            assertNull(service.peekLaunchBundleId())
            val entry = loggedEntries(log).single()
            assertEquals("ROLLBACK", entry.getString("type"))
            assertEquals("BUILT_IN_SELECTED", entry.getString("outcome"))
            assertEquals("built-in", entry.getString("bundleId"))
            assertEquals("downloaded-bundle", entry.getString("fromBundleId"))
        }

    @Test
    fun `settling before the launch rolls back an unfinished launch and keeps its RECOVERED report`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        listOf("stable-bundle", "hung-bundle").forEach { bundleId ->
            val directory = createBundleDir(rootDir, bundleId)
            writeFile(directory, "index.android.bundle")
            writeManifest(directory, listOf("index.android.bundle"))
        }
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "hung-bundle",
                verificationPending = true,
            ),
        )
        val firstProcess = createService(rootDir, preferences)
        firstProcess.prepareLaunch(null)
        firstProcess.markLaunchStarted("hung-bundle")

        // A native update check reads the selection before React Native starts.
        val nextProcess = createService(rootDir, preferences)
        var consumed = 0
        nextProcess.settlePreviousLaunch {
            consumed++
            null
        }
        nextProcess.settlePreviousLaunch {
            consumed++
            null
        }

        assertEquals(1, consumed)
        assertEquals("stable-bundle", nextProcess.peekLaunchBundleId())
        assertFalse(loadMetadata(rootDir)!!.launchInProgress)
        assertTrue(nextProcess.getCrashHistory().contains("hung-bundle"))
        assertEquals("stable-bundle", nextProcess.prepareLaunch(null).launchedBundleId)
        assertEquals("RECOVERED", nextProcess.notifyAppReady()["status"])
    }

    @Test
    fun `settling rolls back a pending bundle whose file is gone`() {
        val rootDir = temporaryFolder.newFolder()
        val stableDir = createBundleDir(rootDir, "stable-bundle")
        writeFile(stableDir, "index.android.bundle")
        writeManifest(stableDir, listOf("index.android.bundle"))
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "missing-bundle",
                verificationPending = true,
            ),
        )
        val service = createService(rootDir, InMemoryPreferencesService())

        service.settlePreviousLaunch { null }

        // The selection no longer names the missing bundle, so a check reads what the launch runs.
        assertEquals("stable-bundle", loadMetadata(rootDir)!!.stagingBundleId)
        assertEquals("stable-bundle", service.peekLaunchBundleId())
        assertTrue(service.getCrashHistory().contains("missing-bundle"))
    }

    @Test
    fun `metadata in another schema is not loaded`() {
        val rootDir = temporaryFolder.newFolder()
        val stableDir = createBundleDir(rootDir, "stable-bundle")
        writeFile(stableDir, "index.android.bundle")
        writeManifest(stableDir, listOf("index.android.bundle"))
        File(bundleStoreDir(rootDir), BundleMetadata.METADATA_FILENAME).writeText(
            JSONObject()
                .put("schema", "metadata-v3")
                .put("isolationKey", TEST_ISOLATION_KEY)
                .put("stableBundleId", "stable-bundle")
                .put("verificationPending", false)
                .toString(),
        )

        val preferences = InMemoryPreferencesService()
        preferences.setItem("HotUpdaterBundleURL", File(stableDir, "index.android.bundle").absolutePath)

        assertNull(loadMetadata(rootDir))
        val service = createService(rootDir, preferences)
        assertNull(service.prepareLaunch(null).launchedBundleId)
        assertNull(service.getBundleId())
        assertEquals("", service.getBaseURL())
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
    fun `peekLaunchBundleId reads the next launch without preparing it`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        assertNull(createService(rootDir, preferences).peekLaunchBundleId())
        listOf("stable-bundle", "staged-bundle").forEach { bundleId ->
            val directory = createBundleDir(rootDir, bundleId)
            writeFile(directory, "index.android.bundle")
            writeManifest(directory, listOf("index.android.bundle"))
        }
        val metadata =
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "staged-bundle",
                verificationPending = true,
            )
        writeMetadata(rootDir, metadata)
        val service = createService(rootDir, preferences)
        val saved = loadMetadata(rootDir)

        assertEquals("staged-bundle", service.peekLaunchBundleId())
        assertEquals("staged-bundle", service.peekLaunchBundleId())
        assertEquals(saved, loadMetadata(rootDir))
        val launch = service.prepareLaunch(null)
        assertEquals("staged-bundle", launch.launchedBundleId)
        assertTrue(launch.shouldRollbackOnCrash)
    }

    @Test
    fun `peekLaunchBundleId skips a staged bundle the launch would not load`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        val stableDirectory = createBundleDir(rootDir, "stable-bundle")
        writeFile(stableDirectory, "index.android.bundle")
        writeManifest(stableDirectory, listOf("index.android.bundle"))
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "missing-bundle",
                verificationPending = true,
            ),
        )
        assertEquals("stable-bundle", createService(rootDir, preferences).peekLaunchBundleId())

        val stagedDirectory = createBundleDir(rootDir, "staged-bundle")
        writeFile(stagedDirectory, "index.android.bundle")
        writeManifest(stagedDirectory, listOf("index.android.bundle"))
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stableBundleId = "stable-bundle",
                stagingBundleId = "staged-bundle",
                verificationPending = true,
                launchInProgress = true,
            ),
        )
        // Settling rolls back a pending bundle whose launch never finished.
        val nextProcess = createService(rootDir, preferences)
        nextProcess.settlePreviousLaunch { null }
        assertEquals("stable-bundle", nextProcess.peekLaunchBundleId())
        assertFalse(loadMetadata(rootDir)!!.launchInProgress)
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

        assertEquals(stagingDir.name, service.prepareLaunch(null).launchedBundleId)
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
    fun `a bundle staged after this launch leaves the launch unchanged`() {
        val rootDir = temporaryFolder.newFolder()
        val preferences = InMemoryPreferencesService()
        val service = createService(rootDir, preferences)
        assertNull(service.prepareLaunch(null).launchedBundleId)
        assertEquals(mapOf("status" to "UNCHANGED"), service.notifyAppReady())

        // A download in this session stages the next launch's bundle.
        val stagedDir = createBundleDir(rootDir, "staged-bundle")
        writeFile(stagedDir, "index.android.bundle")
        writeManifest(stagedDir, listOf("index.android.bundle"))
        writeMetadata(
            rootDir,
            BundleMetadata(
                isolationKey = TEST_ISOLATION_KEY,
                stagingBundleId = stagedDir.name,
                verificationPending = true,
            ),
        )

        // A root that mounts again after its activity is recreated reads this
        // launch again. It must not wait for the staged bundle.
        assertEquals(mapOf("status" to "UNCHANGED"), service.notifyAppReady())

        val nextProcess = createService(rootDir, preferences)
        assertEquals(stagedDir.name, nextProcess.prepareLaunch(null).launchedBundleId)
        assertEquals(mapOf("status" to "PENDING"), nextProcess.notifyAppReady())
    }

    @Test
    fun `first OTA reuses a built in asset the build re-encoded from the same source`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("first-ota-re-encoded-built-in")
            val bundleContent = "target-bundle"
            val sourceContent = "source-image"
            val packagedContent = "crunched-image"
            val assets =
                linkedMapOf(
                    "index.android.bundle" to sha256(rootDir, bundleContent),
                    "drawable-mdpi/image.png" to sha256(rootDir, sourceContent),
                    "drawable-mdpi/changed.png" to sha256(rootDir, "changed-image"),
                )
            val manifest = manifestJson("target-bundle", assets)
            val downloads =
                MappingDownloadService(
                    mapOf(
                        "https://example.com/manifest.json" to manifest,
                        "https://example.com/index.android.bundle" to bundleContent,
                        "https://example.com/drawable-mdpi/changed.png" to "changed-image",
                    ),
                )
            val service =
                createService(
                    rootDir,
                    downloadService = downloads,
                    builtInAssetResolver =
                        SourceMappingBuiltInAssetResolver(
                            mapOf(
                                "drawable-mdpi/image.png" to (sha256(rootDir, sourceContent) to packagedContent),
                                // The store build's source of this one is older.
                                "drawable-mdpi/changed.png" to (sha256(rootDir, "old-image") to "crunched-old"),
                            ),
                        ),
                )

            service.updateBundle(
                bundleId = "target-bundle",
                manifestUrl = "https://example.com/manifest.json",
                manifestFileHash = sha256(rootDir, manifest),
                assets = assets.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                progressCallback = {},
            )

            assertEquals(
                setOf(
                    "https://example.com/manifest.json",
                    "https://example.com/drawable-mdpi/changed.png",
                    "https://example.com/index.android.bundle",
                ),
                downloads.calls.toSet(),
            )
            val targetDir = File(bundleStoreDir(rootDir), "target-bundle")
            assertEquals(packagedContent, File(targetDir, "drawable-mdpi/image.png").readText())
            assertEquals("changed-image", File(targetDir, "drawable-mdpi/changed.png").readText())
            assertFalse(File(targetDir, "builtin-assets.json").exists())
            assertEquals("target-bundle", loadMetadata(rootDir)?.stagingBundleId)
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
    fun `a guarded channel reset keeps the channel for a stale selection`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("guarded-reset")
            val service = createService(rootDir)

            fun accept(
                generation: Long,
                context: String,
            ) = service.acceptReleaseCatalog(
                catalogId = "project-a",
                scopeKey = "scope-pr-2",
                generation = generation,
                catalogHash = "hash-$generation",
                channel = "pr-2",
                selectionContextHash = context,
            )

            suspend fun reset(
                generation: Long,
                context: String,
            ) = service.resetChannelIfSelectionCurrent(
                catalogId = "project-a",
                scopeKey = "scope-pr-2",
                generation = generation,
                catalogHash = "hash-$generation",
                channel = "pr-2",
                selectionContextHash = context,
            )
            assertTrue(accept(3, "context-3"))
            // A newer catalog of the channel arrives before the leave.
            assertTrue(accept(4, "context-4"))

            assertFalse(reset(3, "context-3"))
            // Nothing was reset: the newer catalog's selection still stages.
            assertTrue(
                service.isReleaseSelectionCurrent(
                    catalogId = "project-a",
                    scopeKey = "scope-pr-2",
                    generation = 4,
                    catalogHash = "hash-4",
                    channel = "pr-2",
                    selectionContextHash = "context-4",
                ),
            )

            assertTrue(reset(4, "context-4"))
            assertFalse(
                service.isReleaseSelectionCurrent(
                    catalogId = "project-a",
                    scopeKey = "scope-pr-2",
                    generation = 4,
                    catalogHash = "hash-4",
                    channel = "pr-2",
                    selectionContextHash = "context-4",
                ),
            )
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
            // A selection made before the reset no longer stages.
            assertFalse(
                service.isReleaseSelectionCurrent(
                    catalogId = "project-a",
                    scopeKey = "scope-production",
                    generation = 2,
                    catalogHash = "hash-2",
                    channel = "production",
                    selectionContextHash = "context-2",
                ),
            )
            // The same catalog, checked again, selects again.
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
                    pendingTransition =
                        PendingSelectionTransition(
                            fromReleaseId = "release-zero",
                            fromBundleId = "bundle-zero",
                            toReleaseId = "release-one",
                            toBundleId = bundleDir.name,
                        ),
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
            // The launch reports the adopted Release as the one applied.
            assertEquals(
                PendingSelectionTransition("release-zero", "bundle-zero", "release-two", bundleDir.name),
                loadMetadata(rootDir)?.pendingTransition,
            )
        }

    @Test
    fun `a selection committed while first content arrives keeps the launch verified`() {
        val rootDir = temporaryFolder.newFolder("selection-during-launch-completion")
        val race = LaunchCompletionRace(rootDir)

        // The commit read the metadata before first content and writes it after.
        val service =
            race.run(
                pausesWrite = { it.verificationPending && it.stagingSelection == race.newSelection },
                first = { runBlocking { assertTrue(it.commitReleaseSelection(race.newSelection)) } },
                duringPause = { it.markLaunchCompleted(race.bundleId) },
            )

        val metadata = loadMetadata(rootDir)
        assertFalse(metadata?.verificationPending ?: true)
        assertEquals(race.newSelection, metadata?.stagingSelection)
        assertNull(metadata?.pendingTransition)
        assertEquals(
            mapOf(
                "status" to "UPDATE_APPLIED",
                "fromReleaseId" to "release-zero",
                "fromBundleId" to "bundle-zero",
                "toReleaseId" to "release-two",
                "toBundleId" to race.bundleId,
                "updateStrategy" to "appVersion",
            ),
            service.notifyAppReady(),
        )

        // The next launch runs the bundle as verified and reports nothing new.
        val nextProcess = createService(rootDir)
        val selection = nextProcess.prepareLaunch(null)
        assertEquals(race.bundleId, selection.launchedBundleId)
        assertFalse(selection.shouldRollbackOnCrash)
        nextProcess.markLaunchCompleted(race.bundleId)
        assertEquals(mapOf("status" to "UNCHANGED"), nextProcess.notifyAppReady())
    }

    @Test
    fun `first content arriving while a selection commits keeps the selection`() {
        val rootDir = temporaryFolder.newFolder("launch-completion-during-selection")
        val race = LaunchCompletionRace(rootDir)

        // First content read the metadata before the commit and writes it after.
        val service =
            race.run(
                pausesWrite = { !it.verificationPending && it.stagingSelection == race.oldSelection },
                first = { it.markLaunchCompleted(race.bundleId) },
                duringPause = { runBlocking { assertTrue(it.commitReleaseSelection(race.newSelection)) } },
            )

        val metadata = loadMetadata(rootDir)
        assertFalse(metadata?.verificationPending ?: true)
        assertEquals(race.newSelection, metadata?.stagingSelection)
        assertNull(metadata?.pendingTransition)
        assertEquals("UPDATE_APPLIED", service.notifyAppReady()["status"])
    }

    /**
     * A staged bundle pending its first content, whose Release a newer catalog
     * selects again. [run] pauses the metadata write [pausesWrite] matches
     * until the other writer returns, or a bound when that writer waits for
     * the paused one.
     */
    private inner class LaunchCompletionRace(
        private val rootDir: File,
    ) {
        val bundleId = "bundle-one"
        val oldSelection = releaseSelection("release-one", bundleId, 1, "hash-1", "context-1")
        val newSelection = releaseSelection("release-two", bundleId, 2, "hash-2", "context-2")

        fun run(
            pausesWrite: (BundleMetadata) -> Boolean,
            first: (BundleFileStorageService) -> Unit,
            duringPause: (BundleFileStorageService) -> Unit,
        ): BundleFileStorageService {
            val bundleDir = createBundleDir(rootDir, bundleId)
            writeFile(bundleDir, "index.android.bundle")
            writeManifest(bundleDir, listOf("index.android.bundle"))
            writeMetadata(
                rootDir,
                BundleMetadata(
                    isolationKey = TEST_ISOLATION_KEY,
                    stagingBundleId = bundleId,
                    stagingSelection = oldSelection,
                    verificationPending = true,
                    pendingTransition = PendingSelectionTransition("release-zero", "bundle-zero", "release-one", bundleId),
                ),
            )
            val paused = CountDownLatch(1)
            val otherWriterReturned = CountDownLatch(1)
            val hasPaused = AtomicBoolean(false)
            val service =
                createService(
                    rootDir,
                    metadataWriter = { metadata, file ->
                        if (pausesWrite(metadata) && hasPaused.compareAndSet(false, true)) {
                            paused.countDown()
                            otherWriterReturned.await(2, TimeUnit.SECONDS)
                        }
                        metadata.saveToFile(file)
                    },
                )
            val launch = service.prepareLaunch(null)
            assertEquals(bundleId, launch.launchedBundleId)
            assertTrue(launch.shouldRollbackOnCrash)
            assertTrue(service.acceptReleaseCatalog("project-a", "scope-production", 2, "hash-2", "production", "context-2"))

            val executor = Executors.newFixedThreadPool(2)
            try {
                val firstWrite = executor.submit { first(service) }
                assertTrue(paused.await(5, TimeUnit.SECONDS))
                val otherWrite =
                    executor.submit {
                        duringPause(service)
                        otherWriterReturned.countDown()
                    }
                firstWrite.get(10, TimeUnit.SECONDS)
                otherWrite.get(10, TimeUnit.SECONDS)
            } finally {
                executor.shutdownNow()
            }
            return service
        }
    }

    @Test
    fun `a committed selection makes another scope's selection stale`() =
        runBlocking {
            val rootDir = temporaryFolder.newFolder("selection-across-scopes")
            val service = createService(rootDir)
            val bundleDir = createBundleDir(rootDir, "bundle-one")
            writeFile(bundleDir, "index.android.bundle")
            writeManifest(bundleDir, listOf("index.android.bundle"))
            writeMetadata(
                rootDir,
                BundleMetadata(isolationKey = TEST_ISOLATION_KEY, stagingBundleId = bundleDir.name),
            )
            assertTrue(service.acceptReleaseCatalog("project-a", "scope-production", 1, "hash-1", "production", "context-1"))
            assertTrue(service.acceptReleaseCatalog("project-a", "scope-beta", 1, "hash-beta", "beta", "context-beta"))
            val beta =
                PersistedSelection(
                    kind = "BUNDLE",
                    releaseId = "release-beta",
                    bundleId = bundleDir.name,
                    catalogId = "project-a",
                    scopeKey = "scope-beta",
                    generation = 1,
                    catalogHash = "hash-beta",
                    channel = "beta",
                    selectionContextHash = "context-beta",
                )

            assertTrue(service.commitReleaseSelection(beta))

            // A production check kept from before the beta commit no longer stages.
            assertFalse(service.isReleaseSelectionCurrent("project-a", "scope-production", 1, "hash-1", "production", "context-1"))
            assertTrue(service.isReleaseSelectionCurrent("project-a", "scope-beta", 1, "hash-beta", "beta", "context-beta"))
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
    fun `startup rejects a re-encoded built in file that only a stored record vouches for`() {
        val root = temporaryFolder.newFolder("forged-built-in-record")
        val final = createCompleteBundle(root, "target", "new")
        writeFile(final, "drawable-mdpi/image.png", "tampered")
        File(final, "manifest.json").writeText(
            manifestJson(
                "target",
                mapOf(
                    "index.android.bundle" to sha256(root, "new"),
                    "drawable-mdpi/image.png" to sha256(root, "source"),
                ),
            ),
        )
        // A record in app storage is no proof: anything that writes the file can write it.
        File(final, "builtin-assets.json").writeText(
            JSONObject()
                .put("assets", JSONObject().put("drawable-mdpi/image.png", sha256(root, "tampered")))
                .toString(),
        )
        createCompleteBundle(root, "target.install-backup", "old", manifestBundleId = "target")

        createService(root, builtInAssetResolver = SourceMappingBuiltInAssetResolver(emptyMap()))

        assertEquals("old", File(bundleStoreDir(root), "target/index.android.bundle").readText())
    }

    @Test
    fun `startup keeps a re-encoded built in file that the APK vouches for`() {
        val root = temporaryFolder.newFolder("apk-vouched-built-in")
        val final = createCompleteBundle(root, "target", "new")
        writeFile(final, "drawable-mdpi/image.png", "crunched")
        File(final, "manifest.json").writeText(
            manifestJson(
                "target",
                mapOf(
                    "index.android.bundle" to sha256(root, "new"),
                    "drawable-mdpi/image.png" to sha256(root, "source"),
                ),
            ),
        )
        createCompleteBundle(root, "target.install-backup", "old", manifestBundleId = "target")

        createService(
            root,
            builtInAssetResolver =
                SourceMappingBuiltInAssetResolver(
                    mapOf("drawable-mdpi/image.png" to (sha256(root, "source") to "crunched")),
                ),
        )

        assertEquals("new", File(bundleStoreDir(root), "target/index.android.bundle").readText())
        assertEquals("crunched", File(bundleStoreDir(root), "target/drawable-mdpi/image.png").readText())
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
    fun `independent downloads overlap with at most sixteen active requests`() =
        runBlocking {
            val root = temporaryFolder.newFolder("parallel-originals")
            val paths = listOf("index.android.bundle") + (0..23).map { "assets/$it.png" }
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
            assertTrue("Expected more than four concurrent requests, observed ${maximum.get()}", maximum.get() > 4)
            assertTrue("Concurrency must be bounded", maximum.get() <= 16)
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
    fun `artifact protocol v2 asks only for the files it downloads, in requests of 100`() =
        runBlocking {
            val root = temporaryFolder.newFolder("artifact-files-resolver")
            val reused = (0 until 10).associate { "drawable-mdpi/reused$it.png" to "reused$it" }
            val changed =
                mapOf("index.android.bundle" to "bundle") +
                    (0 until 149).associate { "drawable-mdpi/changed$it.png" to "changed$it" }
            val contents = reused + changed
            val hashes = contents.mapValues { sha256(root, it.value) }
            val manifest = manifestJson(bundleId = "target", assets = hashes)
            val downloads =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to manifest.toByteArray()) +
                        changed.mapKeys { "https://cdn.example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                )
            val resolver = RecordingArtifactFileResolver { path -> "https://cdn.example.com/$path" }

            createService(
                root,
                downloadService = downloads,
                builtInAssetResolver = MappingBuiltInAssetResolver(reused),
            ).updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = emptyMap(),
                fileResolver = resolver,
                progressCallback = {},
            )

            assertEquals(listOf(100, 50), resolver.requests.map { it.size })
            assertEquals(changed.keys, resolver.requests.flatten().toSet())
            assertEquals(
                setOf(MANIFEST_URL) + changed.keys.map { "https://cdn.example.com/$it" },
                downloads.calls.toSet(),
            )
            val targetDir = File(bundleStoreDir(root), "target")
            assertEquals("changed148", File(targetDir, "drawable-mdpi/changed148.png").readText())
            assertEquals("reused3", File(targetDir, "drawable-mdpi/reused3.png").readText())
        }

    @Test
    fun `artifact protocol v2 rejects a file URL that is not absolute HTTP(S)`() =
        runBlocking {
            for (fileUrl in listOf("https://", "file:///tmp/payload", "ftp://cdn.example.com/index.android.bundle")) {
                val root = temporaryFolder.newFolder()
                val hashes = mapOf("index.android.bundle" to sha256(root, "bundle"))
                val manifest = manifestJson(bundleId = "target", assets = hashes)
                val downloads = BinaryMappingDownloadService(mapOf(MANIFEST_URL to manifest.toByteArray()))

                val error =
                    runCatching {
                        createService(
                            root,
                            downloadService = downloads,
                            builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                        ).updateBundle(
                            bundleId = "target",
                            manifestUrl = MANIFEST_URL,
                            manifestFileHash = sha256(root, manifest),
                            assets = emptyMap(),
                            fileResolver = RecordingArtifactFileResolver { fileUrl },
                            progressCallback = {},
                        )
                    }.exceptionOrNull()

                assertUpdateFailure(
                    error,
                    "INVALID_FILE_URL",
                    UpdateFailure.download(UpdateFailureReason.INVALID_RESPONSE).copy(resource = UpdateFailureResource.FILE),
                )
                assertEquals(listOf(MANIFEST_URL), downloads.calls)
            }
        }

    @Test
    fun `artifact protocol v2 reports a malformed files response as an invalid response`() =
        runBlocking {
            val root = temporaryFolder.newFolder()
            val manifest = manifestJson(bundleId = "target", assets = mapOf("index.android.bundle" to sha256(root, "bundle")))
            val resolver =
                object : ArtifactFileResolver {
                    override suspend fun resolve(paths: List<String>): Map<String, ResolvedArtifactFile> =
                        throw InvalidUpdateResponseException("Artifact files response has no files")
                }

            val error =
                runCatching {
                    createService(
                        root,
                        downloadService = BinaryMappingDownloadService(mapOf(MANIFEST_URL to manifest.toByteArray())),
                        builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
                    ).updateBundle(
                        bundleId = "target",
                        manifestUrl = MANIFEST_URL,
                        manifestFileHash = sha256(root, manifest),
                        assets = emptyMap(),
                        fileResolver = resolver,
                        progressCallback = {},
                    )
                }.exceptionOrNull()

            assertEquals(
                UpdateFailure.download(UpdateFailureReason.INVALID_RESPONSE).copy(resource = UpdateFailureResource.FILE),
                (error as HotUpdaterException).failure,
            )
        }

    @Test
    fun `artifact protocol v2 asks for no file when it takes the archive`() =
        runBlocking {
            val root = temporaryFolder.newFolder("artifact-files-archive")
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
                    downloadByteSizes = contents.mapValues { 10_000L },
                    archive = archiveJson(root, archiveBytes, tarByteSize = 3072),
                )
            val downloads =
                BinaryMappingDownloadService(mapOf(MANIFEST_URL to manifest.toByteArray(), ARCHIVE_URL to archiveBytes))
            val resolver = RecordingArtifactFileResolver { path -> "https://cdn.example.com/$path" }

            createService(
                root,
                downloadService = downloads,
                builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()),
            ).updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = emptyMap(),
                archiveUrl = ARCHIVE_URL,
                fileResolver = resolver,
                progressCallback = {},
            )

            assertEquals(emptyList<List<String>>(), resolver.requests)
            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), downloads.calls)
        }

    @Test
    fun `first OTA reuses built in assets and downloads only changed files despite an archive`() =
        runBlocking {
            val root = temporaryFolder.newFolder("first-ota-built-in-over-archive")
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val unchanged = (0 until 40).associate { "drawable-mdpi/icon$it.png" to "icon$it" }
            val changed = mapOf("index.android.bundle" to "bundle", "drawable-mdpi/new.png" to "new")
            val contents = unchanged + changed
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
                    downloadByteSizes = contents.mapValues { 300L },
                    archive =
                        archiveJson(root, archiveBytes, tarByteSize = 64 * 1024)
                            .put("downloadByteSize", 300L * contents.size),
                )
            val downloads =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to manifest.toByteArray(), ARCHIVE_URL to archiveBytes) +
                        contents.mapKeys { "https://example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                )
            // Half of the unchanged icons were re-encoded by the release build.
            val reEncoded = unchanged.keys.filterIndexed { index, _ -> index % 2 == 0 }.toSet()
            val resolver =
                object : BuiltInAssetResolver {
                    override fun copyIfMatches(
                        assetPath: String,
                        expectedHash: String,
                        destination: File,
                    ): Boolean {
                        if (assetPath in reEncoded) return false
                        val content = unchanged[assetPath] ?: return false
                        destination.parentFile?.mkdirs()
                        destination.writeText(content)
                        return true
                    }

                    override fun copyIfSourceMatches(
                        assetPath: String,
                        expectedHash: String,
                        destination: File,
                    ): String? {
                        if (assetPath !in reEncoded || hashes[assetPath] != expectedHash) return null
                        destination.parentFile?.mkdirs()
                        destination.writeText("crunched-$assetPath")
                        return HashUtils.calculateSHA256(destination)
                    }

                    override fun packagedHashIfSourceMatches(
                        assetPath: String,
                        expectedHash: String,
                    ): String? {
                        if (assetPath !in reEncoded || hashes[assetPath] != expectedHash) return null
                        return sha256(root, "crunched-$assetPath")
                    }
                }

            createService(root, downloadService = downloads, builtInAssetResolver = resolver).updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = {},
            )

            assertEquals(
                setOf(MANIFEST_URL) + changed.keys.map { "https://example.com/$it" },
                downloads.calls.toSet(),
            )
            assertEquals(3, downloads.calls.size)
        }

    @Test
    fun `many small network files take the archive even when it carries more bytes`() =
        runBlocking {
            val root = temporaryFolder.newFolder("archive-many-files")
            val archiveBytes = Base64.getDecoder().decode(TarBrArchiveExtractorTest.VALID)
            val icons = (0 until 40).associate { "assets/icon$it.png" to "icon$it" }
            val contents = mapOf("assets/large.png" to "large", "index.android.bundle" to "bundle") + icons
            val hashes = contents.mapValues { sha256(root, it.value) }
            val downloadByteSizes =
                mapOf("assets/large.png" to 500_000L, "index.android.bundle" to 100_000L) + icons.mapValues { 300L }
            // The large file is reused, so the archive carries 500 kB more than
            // the 41 files left; 41 requests still cost more than one archive.
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
                    downloadByteSizes = downloadByteSizes,
                    archive =
                        archiveJson(root, archiveBytes, tarByteSize = 64 * 1024)
                            .put("downloadByteSize", downloadByteSizes.values.sum()),
                )
            val downloads =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to manifest.toByteArray(), ARCHIVE_URL to archiveBytes) +
                        contents.mapKeys { "https://example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                )
            val service =
                createService(
                    rootDir = root,
                    downloadService = downloads,
                    builtInAssetResolver = MappingBuiltInAssetResolver(mapOf("assets/large.png" to "large")),
                )

            service.updateBundle(
                bundleId = "target",
                manifestUrl = MANIFEST_URL,
                manifestFileHash = sha256(root, manifest),
                assets = hashes.mapValues { (path, hash) -> ChangedAssetDescriptor("https://example.com/$path", hash) },
                archiveUrl = ARCHIVE_URL,
                progressCallback = {},
            )

            // This archive is not the target's, so after trying it the install
            // falls back to the files: only the order shows the choice.
            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), downloads.calls.take(2))
            assertFalse(downloads.calls.contains("https://example.com/assets/large.png"))
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
                                        BsdiffPatchDescriptor("bsdiff", MIN_BUNDLE_ID, "a", "b", "https://example.com/patch")
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
                                        BsdiffPatchDescriptor("bsdiff", MIN_BUNDLE_ID, "a", "b", "https://example.com/patch", byteSize = 1)
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
                                        BsdiffPatchDescriptor("bsdiff", MIN_BUNDLE_ID, "a", "b", "https://example.com/patch", byteSize = -1)
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
                                            MIN_BUNDLE_ID,
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
                // The patches are for the built-in bundle, which runs and is
                // their base: they count.
                val service =
                    createService(
                        root,
                        downloadService = downloads,
                        builtInAssetResolver = PatchBaseBuiltInAssetResolver(baseFileHash = "a"),
                        minBundleId = MIN_BUNDLE_ID,
                    )

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
    @Suppress("DEPRECATION")
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

    @Test
    fun `with no OTA bundle, a patch for the built-in bundle applies to its packaged file`() =
        runBlocking {
            val builtInPatch = BuiltInPatchUpdate(temporaryFolder.newFolder("built-in-patch"))

            val result = builtInPatch.run(packagedContent = BASE_CONTENT)

            assertEquals(UpdateBundleResult(BundleDelivery.PATCH, patchFallback = false), result)
            assertEquals(listOf(MANIFEST_URL, PATCH_URL), builtInPatch.downloads.calls)
            assertEquals(PATCHED_CONTENT, File(bundleStoreDir(builtInPatch.root), "target/index.android.bundle").readText())
            assertFalse(File(builtInPatch.root, "bundle-manifest-temp").walk().any { it.name.endsWith(".base") })
        }

    @Test
    fun `a built-in bundle whose packaged bytes differ downloads the file instead`() =
        runBlocking {
            val builtInPatch = BuiltInPatchUpdate(temporaryFolder.newFolder("built-in-patch-mismatch"))

            // Store processing rewrote the packaged file the patch was made from.
            val result = builtInPatch.run(packagedContent = "console.log(\"store-processed\");\n")

            assertEquals(UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = true), result)
            assertEquals(listOf(MANIFEST_URL, BUNDLE_URL), builtInPatch.downloads.calls)
            assertEquals(PATCHED_CONTENT, File(bundleStoreDir(builtInPatch.root), "target/index.android.bundle").readText())
        }

    @Test
    fun `a patch for the built-in bundle is not attempted while an OTA bundle runs or in a Debug build`() =
        runBlocking {
            val otaRunning = PatchUpdate(temporaryFolder.newFolder("built-in-patch-ota-running"))
            assertEquals(
                UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = false),
                otaRunning.run(servedPatch = otaRunning.patchBytes, patchBaseBundleId = MIN_BUNDLE_ID).getOrThrow(),
            )
            assertEquals(listOf(MANIFEST_URL, BUNDLE_URL), otaRunning.downloads.calls)

            // A Debug build reports the nil UUID, and has no built-in bundle.
            val debugBuild = BuiltInPatchUpdate(temporaryFolder.newFolder("built-in-patch-debug"), minBundleId = NIL_UUID)
            assertEquals(
                UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = false),
                debugBuild.run(packagedContent = BASE_CONTENT, patchBaseBundleId = NIL_UUID),
            )
            assertEquals(listOf(MANIFEST_URL, BUNDLE_URL), debugBuild.downloads.calls)
        }

    @Test
    fun `the archive choice leaves out a patch this device cannot apply`() =
        runBlocking {
            val root = temporaryFolder.newFolder("archive-ignores-inapplicable-patch")
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
            // A tiny patch, but for a bundle this device does not run.
            val otherBasePatch =
                BsdiffPatchDescriptor(
                    algorithm = "bsdiff",
                    baseBundleId = "other-bundle",
                    baseFileHash = sha256(root, BASE_CONTENT),
                    patchFileHash = sha256(root, "patch"),
                    patchUrl = PATCH_URL,
                    byteSize = 1,
                )

            val result =
                createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
                    .updateBundle(
                        bundleId = "target",
                        manifestUrl = MANIFEST_URL,
                        manifestFileHash = sha256(root, manifest),
                        assets =
                            hashes.mapValues { (path, hash) ->
                                ChangedAssetDescriptor(
                                    "https://example.com/$path",
                                    hash,
                                    patch = otherBasePatch.takeIf { path == "index.android.bundle" },
                                )
                            },
                        archiveUrl = ARCHIVE_URL,
                        progressCallback = {},
                    )

            assertEquals(UpdateBundleResult(BundleDelivery.ARCHIVE, patchFallback = false), result)
            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), downloads.calls)
        }

    @Test
    fun `the archive choice prices a built-in patch only when the packaged file is its base`() =
        runBlocking {
            suspend fun install(packagedContent: String): Pair<UpdateBundleResult, List<String>> {
                val root = temporaryFolder.newFolder()
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
                    BinaryMappingDownloadService(
                        mapOf(MANIFEST_URL to manifest.toByteArray(), ARCHIVE_URL to archiveBytes) +
                            contents.mapKeys { "https://example.com/${it.key}" }.mapValues { it.value.toByteArray() },
                    )
                val builtInPatch =
                    BsdiffPatchDescriptor(
                        algorithm = "bsdiff",
                        baseBundleId = MIN_BUNDLE_ID,
                        baseFileHash = sha256(root, BASE_CONTENT),
                        patchFileHash = sha256(root, "patch"),
                        patchUrl = PATCH_URL,
                        byteSize = 1,
                    )
                val result =
                    createService(
                        root,
                        downloadService = downloads,
                        builtInAssetResolver = MappingBuiltInAssetResolver(mapOf("index.android.bundle" to packagedContent)),
                        minBundleId = MIN_BUNDLE_ID,
                    ).updateBundle(
                        bundleId = "target",
                        manifestUrl = MANIFEST_URL,
                        manifestFileHash = sha256(root, manifest),
                        assets =
                            hashes.mapValues { (path, hash) ->
                                ChangedAssetDescriptor(
                                    "https://example.com/$path",
                                    hash,
                                    patch = builtInPatch.takeIf { path == "index.android.bundle" },
                                )
                            },
                        archiveUrl = ARCHIVE_URL,
                        progressCallback = {},
                    )
                return result to downloads.calls
            }

            // Store processing rewrote the packaged file: the patch would
            // fall back to the whole file, so the archive is cheaper.
            val (rewritten, rewrittenCalls) = install("console.log(\"store-processed\");\n")
            assertEquals(UpdateBundleResult(BundleDelivery.ARCHIVE, patchFallback = false), rewritten)
            assertEquals(listOf(MANIFEST_URL, ARCHIVE_URL), rewrittenCalls)

            // The packaged file is the patch's base: the tiny patch wins.
            val (_, matchingCalls) = install(BASE_CONTENT)
            assertTrue(PATCH_URL in matchingCalls)
            assertFalse(ARCHIVE_URL in matchingCalls)
        }

    /**
     * Bundle "target" whose index.android.bundle can be produced by a bsdiff
     * patch against the built-in bundle, with no OTA bundle installed, or
     * downloaded whole.
     */
    private inner class BuiltInPatchUpdate(
        val root: File,
        private val minBundleId: String = MIN_BUNDLE_ID,
    ) {
        private val patchBytes: ByteArray = Base64.getDecoder().decode(BsdiffPatchTest.BSDIFF_PATCH_FIXTURE_BASE64)
        lateinit var downloads: BinaryMappingDownloadService

        suspend fun run(
            packagedContent: String,
            patchBaseBundleId: String = minBundleId,
        ): UpdateBundleResult {
            val targetHash = sha256(root, PATCHED_CONTENT)
            val manifest = manifestJson("target", mapOf("index.android.bundle" to targetHash))
            downloads =
                BinaryMappingDownloadService(
                    mapOf(
                        MANIFEST_URL to manifest.toByteArray(),
                        BUNDLE_URL to PATCHED_CONTENT.toByteArray(),
                        PATCH_URL to patchBytes,
                    ),
                )
            val service =
                createService(
                    root,
                    downloadService = downloads,
                    builtInAssetResolver = MappingBuiltInAssetResolver(mapOf("index.android.bundle" to packagedContent)),
                    minBundleId = minBundleId,
                )
            val descriptor =
                ChangedAssetDescriptor(
                    fileUrl = BUNDLE_URL,
                    fileHash = targetHash,
                    patch =
                        BsdiffPatchDescriptor(
                            algorithm = "bsdiff",
                            baseBundleId = patchBaseBundleId,
                            // The packaged file's hash, recorded when its native build was registered.
                            baseFileHash = sha256(root, BASE_CONTENT),
                            patchFileHash = sha256(root, patchBytes),
                            patchUrl = PATCH_URL,
                        ),
                )
            return service.updateBundle("target", MANIFEST_URL, sha256(root, manifest), mapOf("index.android.bundle" to descriptor)) {}
        }
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

            val staleResult =
                runCatching {
                    service.updateBundle(
                        "target",
                        MANIFEST_URL,
                        sha256(staleRoot, manifest),
                        mapOf("index.android.bundle" to ChangedAssetDescriptor(BUNDLE_URL, hash)),
                        selection = releaseSelection("release-one", "target", 1, "hash-1", "context-1"),
                    ) {}
                }.exceptionOrNull()

            assertTrue("Expected a stale selection, got $staleResult", staleResult is StaleReleaseSelectionException)
            assertNull(loadMetadata(staleRoot)?.stagingBundleId)
        }

    @Test
    fun `a selection stays with its own staging`() =
        runBlocking {
            val root = temporaryFolder.newFolder("selection-per-staging")
            val hash = sha256(root, BUNDLE_CONTENT)
            val manifest = manifestJson("target", mapOf("index.android.bundle" to hash))
            val served =
                BinaryMappingDownloadService(
                    mapOf(MANIFEST_URL to manifest.toByteArray(), BUNDLE_URL to BUNDLE_CONTENT.toByteArray()),
                )
            var failNext = true
            val downloads =
                object : DownloadService {
                    override suspend fun downloadFile(
                        fileUrl: URL,
                        destination: File,
                        fileSizeCallback: ((Long) -> Unit)?,
                        progressCallback: (DownloadProgress) -> Unit,
                    ): DownloadResult {
                        if (failNext) {
                            failNext = false
                            return DownloadResult.Error(java.io.IOException("offline"))
                        }
                        return served.downloadFile(fileUrl, destination, fileSizeCallback, progressCallback)
                    }
                }
            val service = createService(root, downloadService = downloads, builtInAssetResolver = MappingBuiltInAssetResolver(emptyMap()))
            assertTrue(service.acceptReleaseCatalog("project-a", "scope-production", 1, "hash-1", "production", "context-1"))
            val assets = mapOf("index.android.bundle" to ChangedAssetDescriptor(BUNDLE_URL, hash))

            val failed =
                runCatching {
                    service.updateBundle(
                        "target",
                        MANIFEST_URL,
                        sha256(root, manifest),
                        assets,
                        selection = releaseSelection("release-one", "target", 1, "hash-1", "context-1"),
                    ) {}
                }
            assertTrue(failed.isFailure)

            // A later staging of the same bundle without a selection stages a
            // bare bundle, not the failed staging's Release.
            service.updateBundle("target", MANIFEST_URL, sha256(root, manifest), assets) {}
            val staging = loadMetadata(root)?.stagingSelection
            assertEquals("target", staging?.bundleId)
            assertNull(staging?.releaseId)
            // A check from before that staging no longer stages over it.
            assertFalse(service.isReleaseSelectionCurrent("project-a", "scope-production", 1, "hash-1", "production", "context-1"))
        }

    @Test
    fun `an isolation key change of one instance leaves the other's bundles`() {
        val (mainRoot, widgetRoot) = stageMainAndWidget()
        createService(widgetRoot, isolationKey = "changed-isolation-key")
        assertFalse(File(bundleStoreDir(widgetRoot), "widget-bundle").exists())
        assertMainAndWidget(mainRoot, widgetRoot, widget = false)

        val (nextMainRoot, nextWidgetRoot) = stageMainAndWidget()
        createService(nextMainRoot, isolationKey = "changed-isolation-key")
        assertFalse(File(bundleStoreDir(nextMainRoot), "main-bundle").exists())
        assertMainAndWidget(nextMainRoot, nextWidgetRoot, main = false)
    }

    @Test
    @Suppress("DEPRECATION")
    fun `a store under the old fingerprint key format is discarded once`() {
        val root = temporaryFolder.newFolder()
        // What main's key was before it held the build's min bundle id: the
        // fingerprint, the app version, and the channel.
        val oldKey = "HotUpdaterPrefs_app-fp_1.0.0_production"
        HotUpdaterConfig.fingerprintHash = "app-fp"
        try {
            val newKey = HotUpdaterInstanceEnvironment.main.isolationKey(InstanceTestContext(temporaryFolder.newFolder()), MIN_BUNDLE_ID)
            assertEquals("HotUpdaterPrefs_app-fp_${MIN_BUNDLE_ID}_production", newKey)
            createCompleteBundle(root, "old-bundle", "old-bundle")
            writeMetadata(root, BundleMetadata(isolationKey = oldKey, stableBundleId = "old-bundle"))

            // The first launch under the new key starts from the built-in bundle.
            val upgraded = createService(root, isolationKey = newKey)
            assertFalse(File(bundleStoreDir(root), "old-bundle").exists())
            assertNull(upgraded.prepareLaunch(null).launchedBundleId)

            // A bundle stored under the new key survives every later launch.
            createCompleteBundle(root, "new-bundle", "new-bundle")
            writeMetadata(root, BundleMetadata(isolationKey = newKey, stableBundleId = "new-bundle"))
            repeat(2) {
                assertEquals("new-bundle", createService(root, isolationKey = newKey).prepareLaunch(null).launchedBundleId)
                assertTrue(File(bundleStoreDir(root), "new-bundle/index.android.bundle").isFile)
            }
        } finally {
            HotUpdaterConfig.clear()
        }
    }

    @Test
    fun `a channel reset of one instance leaves the other's bundles`() =
        runBlocking {
            val (mainRoot, widgetRoot) = stageMainAndWidget()
            assertTrue(createService(widgetRoot).resetChannel())
            assertFalse(File(bundleStoreDir(widgetRoot), "widget-bundle").exists())
            assertMainAndWidget(mainRoot, widgetRoot, widget = false)

            val (nextMainRoot, nextWidgetRoot) = stageMainAndWidget()
            assertTrue(createService(nextMainRoot).resetChannel())
            assertFalse(File(bundleStoreDir(nextMainRoot), "main-bundle").exists())
            assertMainAndWidget(nextMainRoot, nextWidgetRoot, main = false)
        }

    @Test
    fun `an install of one instance cleans only its own old bundles and scratch`() =
        runBlocking {
            val (mainRoot, widgetRoot) = stageMainAndWidget()
            val mainScratch = File(mainRoot, "bundle-manifest-temp/in-use").apply { parentFile!!.mkdirs() }
            mainScratch.writeText("main download")
            assertNull(runOneFileUpdate(widgetRoot))
            assertTrue(File(bundleStoreDir(widgetRoot), "target").isDirectory)
            assertFalse(File(bundleStoreDir(widgetRoot), "widget-bundle-old").exists())
            assertTrue(mainScratch.isFile)
            assertMainAndWidget(mainRoot, widgetRoot, widget = false)

            val (nextMainRoot, nextWidgetRoot) = stageMainAndWidget()
            assertNull(runOneFileUpdate(nextMainRoot))
            assertFalse(File(bundleStoreDir(nextMainRoot), "main-bundle-old").exists())
            assertMainAndWidget(nextMainRoot, nextWidgetRoot, main = false)
        }

    @Test
    fun `a named instance reads its cached bundle URL from its own root`() {
        val (_, widgetRoot) = stageMainAndWidget()
        val bundleFile = File(bundleStoreDir(widgetRoot), "widget-bundle/index.android.bundle")
        val preferences = InMemoryPreferencesService()
        preferences.setItem("HotUpdaterBundleURL", bundleFile.absolutePath)

        assertEquals(bundleFile.absolutePath, createService(widgetRoot, preferences).getCachedBundleURL())
    }

    @Test
    fun `a named instance launches its own embedded bundle and verifies with its own key`() =
        runBlocking {
            val widgetRoot = temporaryFolder.newFolder("embedded")
            val widget =
                createService(
                    widgetRoot,
                    fallbackBundleURL = "assets://widget.android.bundle",
                    publicKey = "-----BEGIN PUBLIC KEY-----\nwidget\n-----END PUBLIC KEY-----",
                    downloadService = UnusedDownloadService,
                )
            assertEquals("assets://widget.android.bundle", widget.prepareLaunch(null).bundleUrl)

            // An unsigned manifest is refused when the instance's key turns signing on.
            val manifest = manifestJson("target", mapOf("index.android.bundle" to sha256(widgetRoot, BUNDLE_CONTENT)))
            val signed =
                createService(
                    widgetRoot,
                    publicKey = "-----BEGIN PUBLIC KEY-----\nwidget\n-----END PUBLIC KEY-----",
                    downloadService = BinaryMappingDownloadService(mapOf(MANIFEST_URL to manifest.toByteArray())),
                )
            val error =
                runCatching {
                    signed.updateBundle(
                        "target",
                        MANIFEST_URL,
                        sha256(widgetRoot, manifest),
                        mapOf("index.android.bundle" to ChangedAssetDescriptor(BUNDLE_URL, sha256(widgetRoot, BUNDLE_CONTENT))),
                    ) {}
                }.exceptionOrNull()
            assertTrue(error?.cause is SignatureVerificationException.UnsignedNotAllowed)
        }

    /**
     * Main's files directory and the named instance "widget"'s root beside it,
     * each with its stable bundle, an older bundle an install cleans up, its
     * metadata, and its crash history.
     */
    private fun stageMainAndWidget(): Pair<File, File> {
        val context = InstanceTestContext(temporaryFolder.newFolder())
        val mainRoot = HotUpdaterInstanceEnvironment.main.filesRoot(context)!!
        val widgetRoot =
            HotUpdaterInstanceEnvironment
                .of(HotUpdaterOptions("https://updates.example.com", name = "widget", bundleAssetName = "widget.android.bundle"))
                .filesRoot(context)!!
        listOf(mainRoot to "main-bundle", widgetRoot to "widget-bundle").forEach { (root, bundleId) ->
            createCompleteBundle(root, bundleId, bundleId)
            createCompleteBundle(root, "$bundleId-old", "$bundleId-old")
            writeMetadata(root, BundleMetadata(isolationKey = TEST_ISOLATION_KEY, stableBundleId = bundleId))
            assertTrue(CrashedHistory().apply { addEntry("$bundleId-crashed") }.saveToFile(crashedHistoryFile(root)))
        }
        return mainRoot to widgetRoot
    }

    private fun assertMainAndWidget(
        mainRoot: File,
        widgetRoot: File,
        main: Boolean = true,
        widget: Boolean = true,
    ) {
        listOf(Triple(mainRoot, "main-bundle", main), Triple(widgetRoot, "widget-bundle", widget))
            .filter { it.third }
            .forEach { (root, bundleId) ->
                assertTrue(bundleId, File(bundleStoreDir(root), "$bundleId/index.android.bundle").isFile)
                assertTrue(bundleId, File(bundleStoreDir(root), "$bundleId-old/index.android.bundle").isFile)
                assertEquals(bundleId, loadMetadata(root)?.stableBundleId)
                assertTrue(bundleId, loadCrashedHistory(root).contains("$bundleId-crashed"))
            }
    }

    private fun crashedHistoryFile(rootDir: File): File = File(bundleStoreDir(rootDir), CrashedHistory.CRASHED_HISTORY_FILENAME)

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
        isolationKey: String = TEST_ISOLATION_KEY,
        publicKey: String? = null,
        fallbackBundleURL: String = "assets://index.android.bundle",
        minBundleId: String = HotUpdaterImpl.getMinBundleId(),
        updateLog: UpdateLogService? = null,
    ): BundleFileStorageService =
        BundleFileStorageService(
            context = ContextWrapper(null),
            fileSystem = TestFileSystemService(rootDir),
            downloadService = downloadService,
            preferences = preferences,
            isolationKey = isolationKey,
            defaultChannelProvider = { "production" },
            // Not the fingerprint the test app's build embedded.
            fingerprintHashProvider = { null },
            minBundleIdProvider = { minBundleId },
            publicKeyProvider = { publicKey ?: SignatureVerifier.getPublicKeyFromConfig(ContextWrapper(null)) },
            fallbackBundleURL = fallbackBundleURL,
            builtInAssetResolver = builtInAssetResolver,
            metadataWriter = metadataWriter,
            directoryRenamer = directoryRenamer,
            updateLog = updateLog,
        )

    private fun logOf(rootDir: File) = UpdateLogService(File(rootDir, "logs/${UpdateLogService.FILENAME}"))

    private fun loggedEntries(log: UpdateLogService): List<JSONObject> =
        org.json.JSONArray(log.read()).let { array -> (0 until array.length()).map(array::getJSONObject) }

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

    private class RecordingArtifactFileResolver(
        private val urlOf: (String) -> String,
    ) : ArtifactFileResolver {
        val requests = CopyOnWriteArrayList<List<String>>()

        override suspend fun resolve(paths: List<String>): Map<String, ResolvedArtifactFile> {
            requests += paths
            return paths.associateWith { ResolvedArtifactFile(url = urlOf(it), compression = null) }
        }
    }

    /** Packaged assets whose bytes differ from the source the build recorded. */
    private class SourceMappingBuiltInAssetResolver(
        private val sources: Map<String, Pair<String, String>>,
    ) : BuiltInAssetResolver {
        override fun copyIfMatches(
            assetPath: String,
            expectedHash: String,
            destination: File,
        ): Boolean = false

        override fun copyIfSourceMatches(
            assetPath: String,
            expectedHash: String,
            destination: File,
        ): String? {
            val (sourceHash, packaged) = sources[assetPath] ?: return null
            if (sourceHash != expectedHash) return null
            destination.parentFile?.mkdirs()
            destination.writeText(packaged)
            return HashUtils.calculateSHA256(destination)
        }

        override fun packagedHashIfSourceMatches(
            assetPath: String,
            expectedHash: String,
        ): String? {
            val (sourceHash, packaged) = sources[assetPath] ?: return null
            if (sourceHash != expectedHash) return null
            return java.security.MessageDigest
                .getInstance("SHA-256")
                .digest(packaged.toByteArray())
                .joinToString("") { "%02x".format(it) }
        }
    }

    /** Packaged files that are the base of every patch made from [baseFileHash], and of nothing else. */
    private class PatchBaseBuiltInAssetResolver(
        private val baseFileHash: String,
    ) : BuiltInAssetResolver {
        override fun copyIfMatches(
            assetPath: String,
            expectedHash: String,
            destination: File,
        ): Boolean {
            if (expectedHash != baseFileHash) return false
            destination.parentFile?.mkdirs()
            destination.writeText("packaged $assetPath")
            return true
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
        private const val MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-000000000000"
        private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"
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
