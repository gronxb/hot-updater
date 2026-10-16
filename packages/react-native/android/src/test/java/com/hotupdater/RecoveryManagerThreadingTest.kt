package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Work posted for a launch never acts on a newer launch of the same instance. */
class RecoveryManagerThreadingTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    private val widget =
        HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, name = "widget", bundleAssetName = "widget.android.bundle"))

    @Test
    fun `a grace period already running leaves a newer launch monitored`() {
        val mainThread = FakeMainThread()
        val manager = HotUpdaterRecoveryManager(InstanceTestContext(temporaryFolder.root), widget, mainThread)
        val completed = mutableListOf<String?>()
        manager.start("first") { completed += it }
        HotUpdaterRecoveryManager.contentAppeared(widget.name)

        // The looper took the grace callback just as a new launch started on another thread.
        val runningGracePeriod = mainThread.take()
        manager.start("second") { completed += it }
        runningGracePeriod.forEach(Runnable::run)

        HotUpdaterRecoveryManager.contentAppeared(widget.name)
        assertEquals(listOf("first", "second"), completed)
    }

    @Test
    fun `a gate action for an earlier launch does not arm the current one`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val manager = HotUpdaterRecoveryManager(context, widget, FakeMainThread())
        val first = manager.start("first")
        manager.start("second")
        var marked = false

        manager.armLaunch(first) { marked = true }

        assertFalse(marked)
        // So a crash elsewhere in the process is not the unarmed launch's.
        HotUpdaterRecoveryManager.chargeUncaughtException(IllegalStateException("native failure"))
        assertFalse(File(widget.filesRoot(context), "bundle-store/recovery-crash-marker.json").exists())
    }

    @Test
    fun `a launch whose content was already seen is not armed afterwards`() {
        // The runtime rendered before its view could be found, then its gate fired.
        val manager = HotUpdaterRecoveryManager(InstanceTestContext(temporaryFolder.root), widget, FakeMainThread())
        val launch = manager.start("first")
        HotUpdaterRecoveryManager.contentAppeared(widget.name)
        var marked = false

        manager.armLaunch(launch) { marked = true }

        assertFalse(marked)
    }

    @Test
    fun `main's error hooks for an earlier launch stop once a newer launch starts`() {
        val mainThread = FakeMainThread()
        val manager =
            HotUpdaterRecoveryManager(InstanceTestContext(temporaryFolder.root), HotUpdaterInstanceEnvironment.main, mainThread)
        manager.start("first")

        val runningHooks = mainThread.take()
        manager.start("second")
        runningHooks.forEach(Runnable::run)

        // Only the newer launch keeps hooking main's host.
        assertEquals(1, mainThread.waiting)
    }

    private fun HotUpdaterRecoveryManager.start(
        bundleId: String,
        onContentAppeared: (String?) -> Unit = {},
    ): Long =
        startMonitoring(
            bundleId = bundleId,
            shouldRollback = true,
            onContentAppeared = onContentAppeared,
            onCrashOfAnotherInstance = {},
            onRecoveryRestartRequested = null,
        )

    companion object {
        private const val BASE_URL = "https://updates.example.com"
    }
}
