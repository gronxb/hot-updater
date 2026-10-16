package com.hotupdater

import android.app.Activity
import android.app.Application
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.facebook.react.common.JavascriptException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Each instance recovers from its own crashes only. */
class InstanceRecoveryTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

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

        // The error did not end the process after all: once the claim is
        // released, the shown view arms the widget's launch.
        HotUpdaterRecoveryManager.releaseClaim()
        assertTrue(metadata(context, widget).launchInProgress)
    }

    @Test
    fun `a launch left alone by a claimed error that did not end the process counts again`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()

        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)
        assertFalse(metadata(context, main).launchInProgress)

        // A development build showed the error, and the process lived on.
        HotUpdaterRecoveryManager.releaseClaim()
        assertTrue(metadata(context, main).launchInProgress)
        assertTrue(metadata(context, main).verificationPending)
    }

    @Test
    fun `a claimed error of a launch no view armed yet schedules the recovery watchdog`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val gate =
            ActivityStartGate(
                RecordingApplication(),
                processHasStartedActivity = { false },
                showsReactView = { false },
                watchLayout = { _, _ -> {} },
            )
        HotUpdaterImpl(context, widget, gate).getJSBundleFile()
        val watchdogState = File(bundleStore(context, main), "recovery-watchdog-state.txt")
        assertFalse(watchdogState.exists())

        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)

        val state = HotUpdaterRecoveryManager.WatchdogState.parse(watchdogState.readText())!!
        assertEquals(listOf(widget.name), state.instances)
        assertTrue(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(context.filesDir, state.instances))
    }

    @Test
    fun `only a named instance's runtime is hooked when its module is created`() {
        // Main hooks its host only while it monitors a launch, as it always has.
        assertFalse(HotUpdaterRecoveryManager.registersRuntime(HotUpdaterInstanceEnvironment.MAIN_NAME))
        assertFalse(HotUpdaterRecoveryManager.registersRuntime(null))
        assertTrue(HotUpdaterRecoveryManager.registersRuntime(widget.name))
    }

    @Test
    fun `only a named instance's gate checks the activities already started for its view`() {
        // Main counts any started activity at once, as it always has.
        assertNull(HotUpdaterImpl.activitiesStartedBefore(main))
        val attribution = HotUpdaterRecoveryAttribution(resolveName = { _, _ -> HotUpdaterInstanceEnvironment.MAIN_NAME })
        assertEquals(emptyList<Activity>(), HotUpdaterImpl.activitiesStartedBefore(widget, attribution)?.invoke())
    }

    @Test
    fun `a monitored launch leaves no process-wide crash handling behind`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val rule = RecoveryMonitoringRule()
        val handler = Thread.getDefaultUncaughtExceptionHandler()
        rule.before()

        HotUpdaterImpl(context, widget).getJSBundleFile()
        assertNotSame(handler, Thread.getDefaultUncaughtExceptionHandler())
        rule.after()

        assertSame(handler, Thread.getDefaultUncaughtExceptionHandler())
        // Nothing monitors the launch any more, so its first content changes nothing.
        HotUpdaterRecoveryManager.contentAppeared(widget.name)
        assertTrue(metadata(context, widget).verificationPending)
    }

    @Test
    fun `a JavaScript error of a named runtime that never reached HotUpdater is charged to it`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        HotUpdaterRecoveryManager.contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)

        // Its bundle threw while loading, so no module hooked the error.
        assertFalse(HotUpdaterRecoveryManager.chargeUncaughtException(JavascriptException("widget failed")))

        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
        assertFalse(crashMarker(context, main).exists())
        val state =
            HotUpdaterRecoveryManager.WatchdogState.parse(
                File(bundleStore(context, main), "recovery-watchdog-state.txt").readText(),
            )!!
        assertEquals(listOf(widget.name), state.instances)
    }

    @Test
    fun `a native error is not inferred to be a named launch's`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()

        HotUpdaterRecoveryManager.chargeUncaughtException(IllegalStateException("native failure"))

        // A crash elsewhere in the process is not the pre-warmed launch's.
        assertFalse(crashMarker(context, widget).exists())
    }

    @Test
    fun `an unclaimed JavaScript fatal error is inferred the same way`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()

        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("unknown runtime"), null)

        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    private fun unshownGate() =
        ActivityStartGate(
            RecordingApplication(),
            processHasStartedActivity = { false },
            showsReactView = { false },
            watchLayout = { _, _ -> {} },
        )

    @Test
    fun `a named runtime hands its activity to its launch gate when its module is created`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        var showsWidgetView = false
        val gate = handOverGate(showsReactView = { showsWidgetView }, isStarted = { true })
        val launchURL = HotUpdaterImpl(context, widget, gate).getJSBundleFile()
        assertFalse(metadata(context, widget).launchInProgress)

        showsWidgetView = true
        HotUpdaterRecoveryManager.registerRuntime(widget.name, runtimeId = 1, sourceURL = launchURL, activity = Activity())

        assertTrue(metadata(context, widget).launchInProgress)
    }

    @Test
    fun `a runtime's activity that stopped while its bundle loaded does not arm its launch`() {
        // The app went to the background; the runtime still holds the activity
        // and its view.
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val gate = handOverGate(showsReactView = { true }, isStarted = { false })
        val launchURL = HotUpdaterImpl(context, widget, gate).getJSBundleFile()

        HotUpdaterRecoveryManager.registerRuntime(widget.name, runtimeId = 1, sourceURL = launchURL, activity = Activity())

        assertFalse(metadata(context, widget).launchInProgress)
    }

    @Test
    fun `an activity handed over as a context counts while it is started`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val implActivity = ContextActivity(context)
        val initActivity = ContextActivity(context)

        // Handed over from onCreate, before either started.
        HotUpdaterImpl(implActivity, widget)
        HotUpdater.init(initActivity, HotUpdaterOptions(BASE_URL, name = "seeded", bundleAssetName = "seeded.android.bundle"))
        assertTrue(HotUpdaterRecoveryAttribution.shared.startedActivities().isEmpty())

        implActivity.lifecycleState = Lifecycle.State.STARTED
        initActivity.lifecycleState = Lifecycle.State.RESUMED
        assertEquals(setOf(implActivity, initActivity), HotUpdaterRecoveryAttribution.shared.startedActivities().toSet())

        // Stopped, as when the app goes to the background.
        implActivity.lifecycleState = Lifecycle.State.CREATED
        assertEquals(listOf(initActivity), HotUpdaterRecoveryAttribution.shared.startedActivities())
    }

    private fun handOverGate(
        showsReactView: (Activity) -> Boolean,
        isStarted: (Activity) -> Boolean,
    ) = ActivityStartGate(
        RecordingApplication(),
        processHasStartedActivity = { true },
        showsReactView = showsReactView,
        watchLayout = { _, _ -> {} },
        activitiesStartedBefore = { emptyList() },
        isStarted = isStarted,
    )

    @Test
    fun `a torn-down runtime no longer hooks its instance's errors`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val launchURL = HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        HotUpdaterRecoveryManager.registerRuntime(widget.name, runtimeId = 1, sourceURL = launchURL, activity = null)

        // Its module hooks its errors, so an unclaimed one is not its.
        HotUpdaterRecoveryManager.chargeUncaughtException(JavascriptException("unknown runtime"))
        assertFalse(crashMarker(context, widget).exists())

        // Torn down, as in a reload: the next runtime's error may be its.
        HotUpdaterRecoveryManager.unregisterRuntime(widget.name, runtimeId = 1)
        HotUpdaterRecoveryManager.chargeUncaughtException(JavascriptException("widget failed"))
        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    @Test
    fun `a new launch runs in a runtime that has not reached HotUpdater yet`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "widget-bundle")
        val launchURL = HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        HotUpdaterRecoveryManager.registerRuntime(widget.name, runtimeId = 1, sourceURL = launchURL, activity = null)

        HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        HotUpdaterRecoveryManager.chargeUncaughtException(JavascriptException("widget failed"))

        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    @Test
    fun `a runtime of an earlier launch whose module is created late does not count for the next launch`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "first-bundle")
        val firstURL = HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        // The next launch selects another bundle.
        stagePending(context, widget, "second-bundle")
        val secondURL = HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        assertNotEquals(firstURL, secondURL)

        // The earlier runtime's module is created only now.
        assertFalse(HotUpdaterRecoveryManager.registerRuntime(widget.name, runtimeId = 1, sourceURL = firstURL, activity = null))
        HotUpdaterRecoveryManager.chargeUncaughtException(JavascriptException("widget failed"))

        // The next launch's runtime never reached HotUpdater, so the error is its.
        assertEquals(PendingCrashRecovery("second-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    @Test
    fun `the watchdog lists only the launches still waiting for their content`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        val watchdogState = File(bundleStore(context, main), "recovery-watchdog-state.txt")
        assertEquals(
            listOf(HotUpdaterInstanceEnvironment.MAIN_NAME, widget.name),
            HotUpdaterRecoveryManager.WatchdogState.parse(watchdogState.readText())!!.instances,
        )

        HotUpdaterRecoveryManager.contentAppeared(widget.name)

        // Main alone writes only its deadline, as it always has.
        assertEquals(1, watchdogState.readText().lines().size)
        assertEquals(
            listOf(HotUpdaterInstanceEnvironment.MAIN_NAME),
            HotUpdaterRecoveryManager.WatchdogState.parse(watchdogState.readText())!!.instances,
        )
    }

    @Test
    fun `an unclaimed JavaScript error belongs to the named instance its stack runs from`() {
        // Two named runtimes load at once; one throws before either reaches HotUpdater.
        val context = InstanceTestContext(temporaryFolder.root)
        val stackWidget = namedEnvironment("stack-widget")
        val stackChat = namedEnvironment("stack-chat")
        val widgetBundle = stagePending(context, stackWidget, "widget-bundle")
        stagePending(context, stackChat, "chat-bundle")
        val registry = HotUpdaterInstanceRegistry.shared
        try {
            registry.impl(context, stackWidget).getJSBundleFile()
            registry.impl(context, stackChat).getJSBundleFile()
            val error =
                JavascriptException("Error: widget failed, stack:\nanonymous@1:20480\n").apply {
                    extraDataAsJson =
                        JSONObject()
                            .put("rawStack", "Error: widget failed\n    at anonymous (address at ${widgetBundle.absolutePath}:1:20480)")
                            .put("jsEngine", "hermes")
                            .toString()
                }

            HotUpdaterRecoveryManager.chargeUncaughtException(error)

            assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, stackWidget)))
            assertFalse(crashMarker(context, stackChat).exists())
            assertFalse(metadata(context, stackChat).launchInProgress)
        } finally {
            forget(registry, stackWidget.name, stackChat.name)
        }
    }

    @Test
    fun `a late error of an earlier launch's runtime charges no launch of the instance`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val staleWidget = namedEnvironment("stale-widget")
        stagePending(context, staleWidget, "first-bundle")
        val registry = HotUpdaterInstanceRegistry.shared
        try {
            val firstURL = registry.impl(context, staleWidget).getJSBundleFile()
            // The next launch selects another bundle.
            stagePending(context, staleWidget, "second-bundle")
            HotUpdaterImpl(context, staleWidget).getJSBundleFile()
            assertTrue(metadata(context, staleWidget).launchInProgress)

            // The earlier runtime's context still reports its errors.
            HotUpdaterRecoveryManager.handleJavaScriptExceptionForRecovery(RuntimeException("first failed"), firstURL)
            HotUpdaterRecoveryManager.chargeUncaughtException(RuntimeException("first failed"))

            assertFalse(crashMarker(context, staleWidget).exists())
            // Nor does the crash it ends in count the new launch as unfinished.
            assertFalse(metadata(context, staleWidget).launchInProgress)
            assertEquals("second-bundle", metadata(context, staleWidget).stagingBundleId)
        } finally {
            forget(registry, staleWidget.name)
        }
    }

    @Test
    fun `a launch that starts during another instance's claimed error joins the claim`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)

        // Main starts after the claim left the live launches alone, before the
        // error ends the process; its view is already shown.
        HotUpdaterImpl(context, main).getJSBundleFile()
        assertFalse(metadata(context, main).launchInProgress)

        // The error did not end the process after all.
        HotUpdaterRecoveryManager.releaseClaim()
        assertTrue(metadata(context, main).launchInProgress)
    }

    @Test
    fun `a newer launch of the instance whose error is claimed joins the claim and is not charged`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, widget, "first-bundle")
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("first failed"), widget.name)

        // The host starts a replacement launch before the error ends the process.
        stagePending(context, widget, "second-bundle")
        HotUpdaterImpl(context, widget).getJSBundleFile()
        assertFalse(metadata(context, widget).launchInProgress)

        // The crash the claimed error ends in is the earlier launch's.
        HotUpdaterRecoveryManager.chargeUncaughtException(RuntimeException("first failed"))
        assertFalse(crashMarker(context, widget).exists())
        assertEquals("second-bundle", metadata(context, widget).stagingBundleId)

        // The error did not end the process after all.
        HotUpdaterRecoveryManager.releaseClaim()
        assertTrue(metadata(context, widget).launchInProgress)
    }

    @Test
    fun `a crash after a released claim charges the launches it can be blamed on`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)
        assertTrue(crashMarker(context, widget).delete())

        // The error did not end the process; then something else crashes it.
        HotUpdaterRecoveryManager.releaseClaim()
        HotUpdaterRecoveryManager.chargeUncaughtException(IllegalStateException("native failure"))

        assertEquals(PendingCrashRecovery("main-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    @Test
    fun `a claim is released on time while the main thread is blocked`() {
        val releases = mutableListOf<Runnable>()
        HotUpdaterRecoveryManager.claimReleaseScheduler = { delayMs, task ->
            assertEquals(5_000L, delayMs)
            releases += task
        }
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)
        assertFalse(metadata(context, main).launchInProgress)

        // The main looper never runs; the claim's own timer does.
        releases.forEach(Runnable::run)

        assertTrue(metadata(context, main).launchInProgress)
    }

    @Test
    fun `an instance whose error was survived leaves the watchdog and keeps its marker`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)
        val watchdogState = File(bundleStore(context, main), "recovery-watchdog-state.txt")
        assertTrue(widget.name in HotUpdaterRecoveryManager.WatchdogState.parse(watchdogState.readText())!!.instances)

        HotUpdaterRecoveryManager.releaseClaim()

        // A later exit for another reason relaunches nothing for the widget's marker.
        assertEquals(
            listOf(HotUpdaterInstanceEnvironment.MAIN_NAME),
            HotUpdaterRecoveryManager.WatchdogState.parse(watchdogState.readText())!!.instances,
        )
        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
    }

    @Test
    fun `every instance whose overlapping error was survived leaves the watchdog`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val chat = namedEnvironment("chat")
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        stagePending(context, chat, "chat-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterImpl(context, chat).getJSBundleFile()

        // Both errors returned; the first claim's release is stale once the second claims.
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("chat failed"), chat.name)
        HotUpdaterRecoveryManager.releaseClaim()

        val watchdogState = File(bundleStore(context, main), "recovery-watchdog-state.txt")
        assertEquals(
            listOf(HotUpdaterInstanceEnvironment.MAIN_NAME),
            HotUpdaterRecoveryManager.WatchdogState.parse(watchdogState.readText())!!.instances,
        )
        assertTrue(crashMarker(context, widget).exists())
        assertTrue(crashMarker(context, chat).exists())
    }

    @Test
    fun `launches left alone by overlapping claims all count again when the last claim is released`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val chat = namedEnvironment("chat")
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        stagePending(context, chat, "chat-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget).getJSBundleFile()
        HotUpdaterImpl(context, chat).getJSBundleFile()

        // Both errors returned instead of ending the process.
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("widget failed"), widget.name)
        HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("chat failed"), chat.name)
        HotUpdaterRecoveryManager.releaseClaim()

        assertTrue(metadata(context, main).launchInProgress)
        assertTrue(metadata(context, widget).launchInProgress)
        // The second error's instance, which the first claim left alone.
        assertTrue(metadata(context, chat).launchInProgress)
    }

    private fun namedEnvironment(name: String) =
        HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, name = name, bundleAssetName = "$name.android.bundle"))

    // The shared registry outlives the test.
    private fun forget(
        registry: HotUpdaterInstanceRegistry,
        vararg names: String,
    ) {
        listOf("environments", "impls", "launchURLs").forEach { field ->
            val map =
                HotUpdaterInstanceRegistry::class.java
                    .getDeclaredField(
                        field,
                    ).apply { isAccessible = true }
                    .get(registry) as MutableMap<*, *>
            synchronized(registry) { names.forEach { map.remove(it) } }
        }
    }

    @Test
    fun `content no view can be found for waits while a named runtime hasn't registered`() {
        // The widget rendered before its module handed over its activity.
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()

        HotUpdaterRecoveryManager.handleContentAppeared(rootTag = 41)

        // Neither launch is verified by content that may be the widget's.
        assertTrue(metadata(context, main).verificationPending)
        assertTrue(metadata(context, widget).verificationPending)
    }

    @Test
    fun `content no view can be found for waits while a registered named launch waits too`() {
        // The widget's module registered, but its root view rendered before it
        // was attached to an activity.
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        val widgetURL = HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        HotUpdaterRecoveryManager.registerRuntime(widget.name, runtimeId = 1, sourceURL = widgetURL, activity = null)

        HotUpdaterRecoveryManager.handleContentAppeared(rootTag = 41)

        assertTrue(metadata(context, main).verificationPending)
        assertTrue(metadata(context, widget).verificationPending)
    }

    @Test
    fun `content no view can be found for verifies main once no named launch waits`() {
        val context = InstanceTestContext(temporaryFolder.root)
        stagePending(context, main, "main-bundle")
        stagePending(context, widget, "widget-bundle")
        HotUpdaterImpl(context, main).getJSBundleFile()
        HotUpdaterImpl(context, widget, unshownGate()).getJSBundleFile()
        HotUpdaterRecoveryManager.contentAppeared(widget.name)

        HotUpdaterRecoveryManager.handleContentAppeared(rootTag = 41)

        assertFalse(metadata(context, main).verificationPending)
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
    fun `a watchdog only a named instance armed ignores a marker main left earlier`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val filesDir = context.filesDir
        writeCrashMarker(context, main, "main-bundle")

        val parsed =
            HotUpdaterRecoveryManager.WatchdogState.parse(
                HotUpdaterRecoveryManager.WatchdogState(1_000L, listOf(widget.name)).serialize(),
            )!!

        assertEquals(listOf(widget.name), parsed.instances)
        assertFalse(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(filesDir, parsed.instances))
        writeCrashMarker(context, widget, "widget-bundle")
        assertTrue(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(filesDir, parsed.instances))
    }

    @Test
    fun `the watchdog relaunches only after the process that armed it died`() {
        val named = HotUpdaterRecoveryManager.WatchdogState(1_000L, listOf(widget.name), pid = 4321)
        val parsed = HotUpdaterRecoveryManager.WatchdogState.parse(named.serialize())!!
        assertEquals(named, parsed)

        // A named instance's error was handled and the process lives on.
        assertFalse(parsed.relaunchesFor(markerRequestsRollback = true, currentPid = 4321))
        // The alarm fires in a new process after the crash.
        assertTrue(parsed.relaunchesFor(markerRequestsRollback = true, currentPid = 5678))
        assertFalse(parsed.relaunchesFor(markerRequestsRollback = false, currentPid = 5678))

        // Main's own file names no process and relaunches as it always has.
        val main = HotUpdaterRecoveryManager.WatchdogState.parse("1234")!!
        assertNull(main.pid)
        assertTrue(main.relaunchesFor(markerRequestsRollback = true, currentPid = 4321))
        assertEquals("1234", HotUpdaterRecoveryManager.WatchdogState(1_234L, listOf(main.instances.single()), pid = 4321).serialize())
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

    /** An activity the app hands over as a context, which reports its lifecycle as ComponentActivity does. */
    private class ContextActivity(
        private val application: android.content.Context,
    ) : Activity(),
        LifecycleOwner {
        private val registry = LifecycleRegistry.createUnsafe(this)

        var lifecycleState: Lifecycle.State
            get() = registry.currentState
            set(value) {
                registry.currentState = value
            }

        init {
            registry.currentState = Lifecycle.State.CREATED
        }

        override val lifecycle: Lifecycle
            get() = registry

        override fun getApplicationContext(): android.content.Context = application
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
