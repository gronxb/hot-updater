package com.hotupdater

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import kotlin.coroutines.EmptyCoroutineContext

/**
 * The start under the screen over the SDK's real bundle store and crash recovery:
 * a real [HotUpdaterImpl] over test directories, the sandbox's real live host and
 * preferences, and a crash marker in the format the crash handler writes. Each
 * "process" is a new SDK and coordinator over the same directories. There is no
 * server config, as on a fresh install: the link waits for one.
 */
@Suppress("DEPRECATION")
class HotUpdaterSandboxLiveStorageTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    private val main = HotUpdaterInstanceEnvironment.main
    private val builtIn = HotUpdaterImpl.getMinBundleId()
    private val link = "hu-sandbox-app://hot-updater/preview?channel=pr-1&fingerprint=$FINGERPRINT"

    @After
    fun clearConfig() {
        HotUpdaterConfig.clear()
    }

    /** One process of the sandbox build: its SDK, its live host, and its coordinator with Home up. */
    private inner class Process(
        val context: InstanceTestContext,
    ) {
        // Read before the SDK settles it, as the sandbox's provider does.
        val crashMarkerAtStart = PendingCrashRecovery.loadFromFile(crashMarker(context))
        val impl = HotUpdaterImpl(context, main)
        var starts = 0
        val store = HotUpdaterSandboxPreferences(context)
        val coordinator =
            HotUpdaterSandboxCoordinator(
                host =
                    HotUpdaterSandboxLiveHost(
                        context,
                        mainImpl = { impl },
                        crashMarkerAtStart = { crashMarkerAtStart },
                        appRunning = { starts > 0 },
                        canStartUnderScreen = { true },
                        startUnderScreen = { starts += 1 },
                    ),
                store = store,
                shelf = testShelf(),
                scope = CoroutineScope(Dispatchers.Unconfined),
                openApp = { _, _ -> },
                lock = HotUpdaterSandboxLock(),
                shelfContext = EmptyCoroutineContext,
                serverPoll = { awaitCancellation() },
            )

        init {
            coordinator.observe {}
        }

        val phase get() = coordinator.state.phase

        /** Reads what storage holds, on the SDK's own threads, and waits for it. */
        fun refresh() {
            coordinator.refresh()
            val until = System.currentTimeMillis() + 5_000
            while (coordinator.state.selection == null ||
                coordinator.state.phase is HotUpdaterSandboxPhase.Working ||
                (store.pendingLinks.isNotEmpty() && coordinator.state.phase is HotUpdaterSandboxPhase.Idle)
            ) {
                check(System.currentTimeMillis() < until) { "the screen's read never landed" }
                Thread.sleep(10)
            }
        }
    }

    private fun context(): InstanceTestContext {
        HotUpdaterConfig.configure(fingerprintHash = FINGERPRINT)
        return InstanceTestContext(temporaryFolder.root)
    }

    private fun bundleStore(context: InstanceTestContext) = File(main.filesRoot(context), "bundle-store")

    private fun crashMarker(context: InstanceTestContext) = File(bundleStore(context), "recovery-crash-marker.json")

    /** What the crash handler writes when a launch crashes: the bundle it ran, and whether to roll back. */
    private fun crash(
        context: InstanceTestContext,
        bundleId: String?,
        shouldRollback: Boolean,
    ) {
        crashMarker(context).apply { parentFile?.mkdirs() }.writeText(
            JSONObject().put("bundleId", bundleId ?: JSONObject.NULL).put("shouldRollback", shouldRollback).toString(),
        )
    }

    private fun stage(
        context: InstanceTestContext,
        bundleId: String,
        verified: Boolean,
    ) {
        val store = bundleStore(context)
        val directory = File(store, bundleId).apply { mkdirs() }
        File(directory, "index.android.bundle").writeText("bundle")
        File(directory, "manifest.json").writeText(
            JSONObject()
                .put("bundleId", bundleId)
                .put("assets", JSONObject().put("index.android.bundle", JSONObject().put("fileHash", "hash")))
                .toString(),
        )
        assertTrue(
            BundleMetadata(isolationKey = main.isolationKey(context), stagingBundleId = bundleId, verificationPending = !verified)
                .saveToFile(File(store, BundleMetadata.METADATA_FILENAME)),
        )
    }

    /** The first process: a fresh install's link starts the app under the screen, whose launch reads its bundle. */
    private fun startUnderTheScreen(context: InstanceTestContext): Process {
        val first = Process(context)
        first.refresh()
        first.coordinator.receiveLink(link)
        assertEquals(1, first.starts)
        assertEquals(true, (first.phase as HotUpdaterSandboxPhase.WaitingForServer).checking)
        // React Native's start under the screen reads the bundle the launch selects.
        first.impl.getJSBundleFile()
        return first
    }

    /** The next process: what the screen tells, and that the link still waits and starts nothing. */
    private fun nextProcessKeepsTheLinkAndTells(context: InstanceTestContext): Process {
        val next = Process(context)
        next.refresh()
        assertEquals(listOf(link), next.store.pendingLinks)
        val waiting = next.phase as HotUpdaterSandboxPhase.WaitingForServer
        assertEquals(false, waiting.checking)
        assertEquals("a crash still to tell starts nothing", 0, next.starts)
        assertNotNull(next.store.lastLaunch)
        return next
    }

    @Test
    fun `a pending bundle that crashes before first content under the screen rolls back, and the next screen tells it`() {
        val context = context()
        stage(context, "ota", verified = false)
        startUnderTheScreen(context)
        crash(context, "ota", shouldRollback = true)

        val next = nextProcessKeepsTheLinkAndTells(context)
        // The normal launch's outcome: rolled back to the built-in bundle, the crash recorded.
        assertEquals(
            builtIn,
            next.coordinator.state.selection
                ?.bundleId,
        )
        assertTrue(next.impl.getCrashHistory().contains("ota"))
        val told = next.store.lastLaunch!!
        assertEquals(HotUpdaterSandboxLastLaunch.Kind.CRASHED_BEFORE_CONTENT, told.kind)
        assertEquals("ota", told.bundleId)
        assertEquals(builtIn, told.rolledBackToBundleId)
    }

    @Test
    fun `a pending bundle that rendered under the screen, then crashed, stays selected, and the next screen tells it`() {
        val context = context()
        // Its first content under the screen verified it, as it would in front.
        stage(context, "ota", verified = true)
        startUnderTheScreen(context)
        crash(context, "ota", shouldRollback = false)

        val next = nextProcessKeepsTheLinkAndTells(context)
        assertEquals(
            "ota",
            next.coordinator.state.selection
                ?.bundleId,
        )
        val told = next.store.lastLaunch!!
        assertEquals(HotUpdaterSandboxLastLaunch.Kind.CRASHED, told.kind)
        assertEquals("ota", told.bundleId)
    }

    @Test
    fun `the built-in bundle crashing under the screen is told, and the link waits`() {
        val context = context()
        startUnderTheScreen(context)
        crash(context, null, shouldRollback = false)

        val next = nextProcessKeepsTheLinkAndTells(context)
        assertEquals(
            builtIn,
            next.coordinator.state.selection
                ?.bundleId,
        )
        val told = next.store.lastLaunch!!
        assertEquals(HotUpdaterSandboxLastLaunch.Kind.CRASHED, told.kind)
        assertEquals(builtIn, told.bundleId)
    }

    @Test
    fun `a launch under the screen that ended before first content with no crash rolls back, and the next screen tells it`() {
        val context = context()
        stage(context, "ota", verified = false)
        // The process ended under the screen, killed or hung, with no crash marker.
        startUnderTheScreen(context)

        val next = nextProcessKeepsTheLinkAndTells(context)
        assertEquals(
            builtIn,
            next.coordinator.state.selection
                ?.bundleId,
        )
        val told = next.store.lastLaunch!!
        assertEquals(HotUpdaterSandboxLastLaunch.Kind.ENDED_BEFORE_CONTENT, told.kind)
        assertEquals("ota", told.bundleId)
    }

    @Test
    fun `once a person moves on from what the last launch left, the next link starts the app again`() {
        val context = context()
        startUnderTheScreen(context)
        crash(context, null, shouldRollback = false)
        val next = nextProcessKeepsTheLinkAndTells(context)

        next.coordinator.acknowledgeLastLaunch()
        val after = Process(context)
        after.refresh()
        assertEquals(1, after.starts)
        assertEquals(listOf(link), after.store.pendingLinks)
    }

    @Test
    fun `the app's own answered check, saved through the SDK, asks the link with nothing else`() {
        val context = context()
        val first = startUnderTheScreen(context)
        // What JavaScript's answered check saves, through the SDK's storage.
        first.impl.setStorageItem(
            RecoveryCheckConfig.KEY,
            JSONObject()
                .put("version", 1)
                .put("baseURL", "https://updates.example.com")
                .put("requestHeaders", JSONObject())
                .put("requestTimeoutMs", 5_000)
                .put("updateStrategy", "fingerprint")
                .toString(),
        )
        first.coordinator.refresh()
        val until = System.currentTimeMillis() + 5_000
        while (first.phase !is HotUpdaterSandboxPhase.Confirming && System.currentTimeMillis() < until) Thread.sleep(10)
        assertTrue(first.phase is HotUpdaterSandboxPhase.Confirming)
        assertEquals(1, first.starts)
    }

    private companion object {
        const val FINGERPRINT = "abc"
    }
}
