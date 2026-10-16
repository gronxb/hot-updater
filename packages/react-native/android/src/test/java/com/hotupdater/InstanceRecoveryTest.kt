package com.hotupdater

import android.app.Activity
import android.app.Application
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Each instance recovers from its own crashes only. */
class InstanceRecoveryTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val main = HotUpdaterInstanceEnvironment.main
    private val widget =
        HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, name = "widget", bundleAssetName = "widget.android.bundle"))

    @After
    fun clearConfig() {
        HotUpdaterConfig.clear()
    }

    @Test
    fun `a named instance's crash marker rolls back only that instance`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val mainBundle = stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        writeCrashMarker(context, widget, "widget-bundle")

        val widgetImpl = HotUpdaterImpl(context, widget)
        val mainImpl = HotUpdaterImpl(context, main)

        assertEquals("assets://widget.android.bundle", widgetImpl.getJSBundleFile())
        assertEquals(listOf("widget-bundle"), widgetImpl.getCrashHistory())
        assertFalse(crashMarker(context, widget).exists())

        assertEquals(mainBundle.absolutePath, mainImpl.getJSBundleFile())
        assertTrue(mainImpl.getCrashHistory().isEmpty())
        assertTrue(metadata(context, main).verificationPending)
        assertEquals("main-bundle", metadata(context, main).stagingBundleId)
    }

    @Test
    fun `main's crash marker never touches a named instance`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        val widgetBundle = stagePending(context, widget, "widget-bundle")
        writeCrashMarker(context, main, "main-bundle")

        val widgetImpl = HotUpdaterImpl(context, widget)
        val mainImpl = HotUpdaterImpl(context, main)

        assertEquals(widgetBundle.absolutePath, widgetImpl.getJSBundleFile())
        assertTrue(widgetImpl.getCrashHistory().isEmpty())
        assertTrue(metadata(context, widget).verificationPending)
        assertEquals("widget-bundle", metadata(context, widget).stagingBundleId)

        assertEquals("assets://index.android.bundle", mainImpl.getJSBundleFile())
        assertEquals(listOf("main-bundle"), mainImpl.getCrashHistory())
        assertFalse(crashMarker(context, main).exists())
    }

    @Test
    fun `a named launch arms only when its own view is shown and only its own content verifies it`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val application = RecordingApplication()
        var showsWidgetView = false
        val gate =
            ActivityStartGate(
                application,
                processHasStartedActivity = { false },
                showsReactView = { showsWidgetView },
                watchLayout = { _, _ -> {} },
            )
        val widgetImpl = HotUpdaterImpl(context, widget, gate)

        widgetImpl.getJSBundleFile()
        // A runtime pre-warmed without UI must not leave an unfinished launch.
        assertFalse(metadata(context, widget).launchInProgress)
        application.startActivity()
        assertFalse(metadata(context, widget).launchInProgress)

        application.stopActivity()
        showsWidgetView = true
        application.startActivity()
        assertTrue(metadata(context, widget).launchInProgress)

        HotUpdaterRecoveryManager.contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)
        assertTrue(metadata(context, widget).verificationPending)
        assertEquals("PENDING", widgetImpl.notifyAppReady()["status"])

        HotUpdaterRecoveryManager.contentAppeared(widget.name)
        assertFalse(metadata(context, widget).verificationPending)
        assertEquals("UPDATE_APPLIED", widgetImpl.notifyAppReady()["status"])
    }

    @Test
    fun `a launch is not armed while another instance's fatal error ends the process`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        val application = RecordingApplication()
        var showsWidgetView = false
        val gate =
            ActivityStartGate(
                application,
                processHasStartedActivity = { false },
                showsReactView = { showsWidgetView },
                watchLayout = { _, _ -> {} },
            )
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget, gate).getJSBundleFile()

        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("main failed"), HotUpdaterInstanceEnvironment.MAIN_NAME)
        // The widget's view shows in the moments before the process ends.
        showsWidgetView = true
        application.startActivity()

        assertFalse(metadata(context, widget).launchInProgress)
        assertTrue(metadata(context, widget).verificationPending)
    }

    @Test
    fun `first content of one instance never verifies another's launch`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()

        HotUpdaterRecoveryManager.contentAppeared(widget.name)
        assertFalse(metadata(context, widget).verificationPending)
        assertTrue(metadata(context, main).verificationPending)

        HotUpdaterRecoveryManager.contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)
        assertFalse(metadata(context, main).verificationPending)
    }

    @Test
    fun `a named runtime's fatal error charges only that instance and leaves the others' launches to run again`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val mainBundle = stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        // Both launches are armed: an activity without an application to observe counts at once.
        assertTrue(metadata(context, main).launchInProgress)
        assertTrue(metadata(context, widget).launchInProgress)

        // React Native's default handling then crashes the process.
        assertFalse(HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name))

        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
        assertFalse(crashMarker(context, main).exists())
        assertFalse(metadata(context, main).launchInProgress)
        assertTrue(metadata(context, main).verificationPending)

        // The next process.
        val nextMain = HotUpdaterImpl(context, main)
        val nextWidget = HotUpdaterImpl(context, widget)
        assertEquals(mainBundle.absolutePath, nextMain.getJSBundleFile())
        assertTrue(nextMain.getCrashHistory().isEmpty())
        assertNull(interruptedLaunch(context, main))
        assertTrue(metadata(context, main).verificationPending)

        assertEquals("assets://widget.android.bundle", nextWidget.getJSBundleFile())
        assertEquals(listOf("widget-bundle"), nextWidget.getCrashHistory())
    }

    @Test
    fun `main's fatal error charges only main`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        val widgetBundle = stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()

        // Main restarts the app to recover, as it always has, after writing its marker.
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("main failed"), HotUpdaterInstanceEnvironment.MAIN_NAME)

        assertEquals(PendingCrashRecovery("main-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
        assertFalse(crashMarker(context, widget).exists())
        assertFalse(metadata(context, widget).launchInProgress)

        val nextWidget = HotUpdaterImpl(context, widget)
        assertEquals(widgetBundle.absolutePath, nextWidget.getJSBundleFile())
        assertTrue(nextWidget.getCrashHistory().isEmpty())
        assertNull(interruptedLaunch(context, widget))
    }

    @Test
    fun `a fatal error no runtime claims charges every launch still waiting for its content`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()

        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("unknown runtime"), null)

        assertEquals(PendingCrashRecovery("main-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    @Test
    fun `the recovery watchdog relaunches for a crash marker of an instance that armed it`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val filesDir = context.filesDir
        writeCrashMarker(context, widget, "widget-bundle")
        val state = HotUpdaterRecoveryManager.WatchdogState(1_000L, listOf(HotUpdaterInstanceEnvironment.MAIN_NAME, widget.name))

        val parsed = HotUpdaterRecoveryManager.WatchdogState.parse(state.serialize())!!
        assertEquals(state, parsed)
        assertTrue(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(filesDir, parsed.instances))
        // A marker another instance left in an earlier process waits for its
        // next launch; it doesn't relaunch the app for main's launch.
        assertFalse(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(filesDir, listOf(HotUpdaterInstanceEnvironment.MAIN_NAME)))

        writeCrashMarker(context, main, "main-bundle")
        assertTrue(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(filesDir, listOf(HotUpdaterInstanceEnvironment.MAIN_NAME)))
    }

    @Test
    fun `main's watchdog state keeps its format`() {
        val state = HotUpdaterRecoveryManager.WatchdogState(1_234L, listOf(HotUpdaterInstanceEnvironment.MAIN_NAME))

        assertEquals("1234", state.serialize())
        assertEquals(state, HotUpdaterRecoveryManager.WatchdogState.parse("1234"))
        assertNull(HotUpdaterRecoveryManager.WatchdogState.parse(""))
    }

    @Test
    fun `crash markers and the watchdog state survive bundle-store sweeps`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val marker = writeCrashMarker(context, widget, "widget-bundle")
        val watchdogState = File(marker.parentFile, "recovery-watchdog-state.txt").apply { writeText("1234") }

        assertTrue(runBlocking { HotUpdaterImpl(context, widget).resetChannel() })
        assertTrue(marker.exists())
        assertTrue(watchdogState.exists())

        // A new isolation key discards the stored bundles.
        BundleMetadata(isolationKey = "stale", stagingBundleId = "widget-bundle", verificationPending = true)
            .saveToFile(File(marker.parentFile, BundleMetadata.METADATA_FILENAME))
        File(marker.parentFile, "stale-bundle").mkdirs()
        HotUpdaterImpl(context, widget)
        assertFalse(File(marker.parentFile, "stale-bundle").exists())
        assertTrue(marker.exists())
        assertTrue(watchdogState.exists())
    }

    private fun bundleStore(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
    ) = File(environment.filesRoot(context), "bundle-store")

    private fun crashMarker(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
    ) = File(bundleStore(context, environment), "recovery-crash-marker.json")

    private fun writeCrashMarker(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
        bundleId: String,
    ): File =
        crashMarker(context, environment).apply {
            parentFile?.mkdirs()
            writeText("{\"bundleId\":\"$bundleId\",\"shouldRollback\":true}\n")
        }

    private fun metadata(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
    ): BundleMetadata =
        BundleMetadata.loadFromFile(
            File(bundleStore(context, environment), BundleMetadata.METADATA_FILENAME),
            environment.isolationKey(context),
        )!!

    private fun interruptedLaunch(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
    ): JSONObject? {
        val file = File(bundleStore(context, environment), CrashedHistory.CRASHED_HISTORY_FILENAME)
        if (!file.exists()) return null
        return JSONObject(file.readText()).optJSONObject("interruptedLaunch")
    }

    /** A bundle staged and waiting for its first launch to verify it; returns its bundle file. */
    private fun stagePending(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
        bundleId: String,
    ): File {
        val store = bundleStore(context, environment)
        val bundleDir = File(store, bundleId).apply { mkdirs() }
        val bundleFile = File(bundleDir, "index.android.bundle").apply { writeText("bundle") }
        File(bundleDir, "manifest.json").writeText(
            JSONObject()
                .put("bundleId", bundleId)
                .put("assets", JSONObject().put("index.android.bundle", JSONObject().put("fileHash", "hash")))
                .toString(),
        )
        assertTrue(
            BundleMetadata(isolationKey = environment.isolationKey(context), stagingBundleId = bundleId, verificationPending = true)
                .saveToFile(File(store, BundleMetadata.METADATA_FILENAME)),
        )
        return bundleFile
    }

    private class RecordingApplication : Application() {
        private val callbacks = mutableListOf<ActivityLifecycleCallbacks>()
        private val activity = Activity()

        override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
            callbacks += callback
        }

        fun startActivity() = callbacks.forEach { it.onActivityStarted(activity) }

        fun stopActivity() = callbacks.forEach { it.onActivityStopped(activity) }
    }

    companion object {
        private const val BASE_URL = "https://updates.example.com"
    }
}
