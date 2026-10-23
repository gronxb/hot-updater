package com.hotupdater

import android.app.Activity
import android.app.Application
import com.facebook.react.bridge.JSExceptionHandler
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Main records a crash for the rest of the process once its launch is
 * verified, and the next launch that shows UI checks for an update natively.
 */
class PostCrashUpdateCheckTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    private val main = HotUpdaterInstanceEnvironment.main
    private val widget =
        HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, name = "widget", bundleAssetName = "widget.android.bundle"))

    @After
    @Suppress("DEPRECATION")
    fun clearConfig() {
        HotUpdaterConfig.clear()
    }

    // The config JavaScript writes.

    @Test
    fun `the config JavaScript writes is read as a check on the current channel`() {
        val config =
            requireNotNull(
                RecoveryCheckConfig.parse(
                    JSONObject()
                        .put("version", 1)
                        .put("baseURL", "https://updates.example.com/api")
                        .put("requestHeaders", JSONObject().put("x-api-key", "secret"))
                        .put("requestTimeoutMs", 7000)
                        .put("updateStrategy", "fingerprint")
                        .toString(),
                ),
            )

        val request = config.toRequest()
        assertEquals("https://updates.example.com/api", request.baseURL)
        assertEquals(mapOf("x-api-key" to "secret"), request.requestHeaders)
        // Milliseconds, as JavaScript writes them.
        assertEquals(7000L, request.requestTimeoutMillis)
        assertEquals(HotUpdaterUpdateStrategy.FINGERPRINT, request.updateStrategy)
        assertNull(request.channel)
        assertEquals(HotUpdaterUpdateStrategy.APP_VERSION, RecoveryCheckConfig.parse(config(updateStrategy = "appVersion"))?.updateStrategy)
    }

    @Test
    fun `a record without headers or a timeout takes the defaults`() {
        val config = requireNotNull(RecoveryCheckConfig.parse("""{"version":1,"baseURL":"$BASE_URL","updateStrategy":"appVersion"}"""))

        assertTrue(config.requestHeaders.isEmpty())
        assertEquals(5_000L, config.requestTimeoutMillis)
    }

    @Test
    fun `a missing, unparsable, other-version, or invalid record is no config`() {
        listOf(
            null,
            "",
            "not json",
            "[]",
            config(version = 2),
            config(version = null),
            config(baseURL = null),
            config(baseURL = "ftp://updates.example.com"),
            config(baseURL = "https:///api"),
            config(baseURL = "updates.example.com"),
            config(updateStrategy = "nightly"),
            config(updateStrategy = null),
            config(requestHeaders = JSONObject().put("x-api-key", 1)),
            config(requestHeaders = "x-api-key"),
            config(requestTimeoutMs = 0),
            config(requestTimeoutMs = -5),
            config(requestTimeoutMs = "5000"),
        ).forEach { value -> assertNull(value, RecoveryCheckConfig.parse(value)) }
    }

    // Main's crashes after its monitoring ended.

    @Test
    fun `main's JavaScript fatal error after its monitoring ended records the running bundle without rollback`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, "main-bundle")

        val outcome = HotUpdaterRecoveryManager.handleJavaScriptError(RuntimeException("update flow failed"), MAIN_SOURCE_URL)

        // React Native's handler still ends the process.
        assertFalse(outcome.recovered)
        assertEquals(PendingCrashRecovery("main-bundle", false), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
    }

    @Test
    fun `an unclaimed JavaScript fatal error after main's monitoring ended records main's bundle`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, "main-bundle")

        assertFalse(HotUpdaterRecoveryManager.handleJavaScriptException(RuntimeException("unknown runtime"), null))

        assertEquals(PendingCrashRecovery("main-bundle", false), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
    }

    @Test
    fun `an uncaught exception after main's monitoring ended records main's bundle`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, "main-bundle")

        // The process ends through the app's previous handler.
        assertFalse(HotUpdaterRecoveryManager.chargeUncaughtException(IllegalStateException("native failure")))

        assertEquals(PendingCrashRecovery("main-bundle", false), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
    }

    @Test
    fun `a crash of the built-in bundle after main's monitoring ended records no bundle`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, bundleId = null)

        HotUpdaterRecoveryManager.chargeUncaughtException(IllegalStateException("native failure"))

        assertEquals(PendingCrashRecovery(null, false), PendingCrashRecovery.loadFromFile(crashMarker(context, main)))
    }

    @Test
    fun `main's hooked error is still forwarded after its monitoring ended`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, "main-bundle")
        val forwarded = mutableListOf<Exception>()
        val error = RuntimeException("update flow failed")

        HotUpdaterRecoveryManager
            .RecoveryJSExceptionHandler(JSExceptionHandler { forwarded += it }, { MAIN_SOURCE_URL })
            .handleException(error)

        assertEquals(1, forwarded.size)
        assertSame(error, forwarded.single())
        assertTrue(crashMarker(context, main).exists())
        // Without a previous handler the error is thrown, as React Native would.
        crashMarker(context, main).delete()
        assertThrows(RuntimeException::class.java) {
            HotUpdaterRecoveryManager.RecoveryJSExceptionHandler(null, { MAIN_SOURCE_URL }).handleException(RuntimeException("again"))
        }
        assertTrue(crashMarker(context, main).exists())
    }

    @Test
    fun `a debug build records no crash of main's after its monitoring ended`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, "main-bundle", recordsCrashesAfterContent = false)
        val forwarded = mutableListOf<Exception>()
        val error = RuntimeException("RedBox")

        HotUpdaterRecoveryManager
            .RecoveryJSExceptionHandler(JSExceptionHandler { forwarded += it }, { MAIN_SOURCE_URL })
            .handleException(error)
        HotUpdaterRecoveryManager.chargeUncaughtException(error)

        // React Native still shows its RedBox.
        assertSame(error, forwarded.single())
        assertFalse(crashMarker(context, main).exists())
    }

    @Test
    fun `a named instance's fatal error after main's monitoring ended leaves main's marker alone`() {
        val context = InstanceTestContext(temporaryFolder.root)
        verifiedMainLaunch(context, "main-bundle")
        HotUpdaterRecoveryManager(context, widget, FakeMainThread()).startMonitoring(
            bundleId = "widget-bundle",
            shouldRollback = true,
            onContentAppeared = {},
            onCrashOfAnotherInstance = {},
            onRecoveryRestartRequested = null,
        )
        val error = RuntimeException("widget failed")

        assertFalse(HotUpdaterRecoveryManager.handleJavaScriptException(error, widget.name))
        // The crash the claimed error ends in stays the widget's.
        HotUpdaterRecoveryManager.chargeUncaughtException(error)

        assertEquals(PendingCrashRecovery("widget-bundle", true), PendingCrashRecovery.loadFromFile(crashMarker(context, widget)))
        assertFalse(crashMarker(context, main).exists())
    }

    @Test
    fun `main's native slot keeps recording its verified bundle and nothing is left posted`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val slots = mutableListOf<String>()
        HotUpdaterRecoveryManager.nativeRecovery =
            object : HotUpdaterNativeRecovery {
                override fun updateSlot(
                    slot: Int,
                    crashMarkerPath: String,
                    bundleId: String?,
                    shouldRollback: Boolean,
                    writesWhenVerified: Boolean,
                ) {
                    slots += "slot $slot bundle=$bundleId rollback=$shouldRollback writes=$writesWhenVerified"
                }

                override fun attributeCrash(slot: Int) = Unit

                override fun clearCrashAttribution() = Unit
            }

        val mainThread = verifiedMainLaunch(context, "main-bundle")

        // A signal writes main's marker with its bundle, never asking to roll back.
        assertEquals("slot 0 bundle=main-bundle rollback=false writes=true", slots.last())
        assertEquals(0, mainThread.waiting)
    }

    // The gate of the check: the first launch that shows UI.

    @Test
    fun `the check's gate counts an activity started before it, without the process lifecycle`() {
        val application = GateApplication()
        val attribution = HotUpdaterRecoveryAttribution(isStarted = { true })
        // Handed over as the context, before the gate followed activities.
        attribution.noteActivity(Activity())
        var runs = 0

        HotUpdaterImpl
            .postCrashUiGate(application, attribution, processLifecycleStarted = { false }, mainThread = FakeMainThread())
            .runWhenActivityStarted { runs += 1 }

        assertEquals(1, runs)
    }

    @Test
    fun `the check's gate waits for an activity when none is started`() {
        val application = GateApplication()
        val attribution = HotUpdaterRecoveryAttribution(isStarted = { false })
        attribution.noteActivity(Activity())
        var runs = 0

        HotUpdaterImpl
            .postCrashUiGate(application, attribution, processLifecycleStarted = { false }, mainThread = FakeMainThread())
            .runWhenActivityStarted { runs += 1 }
        assertEquals(0, runs)

        application.startActivity()
        assertEquals(1, runs)
    }

    // The flag the next launch's preparation sets.

    @Test
    fun `main's launch preparation sets the check flag only for a crash marker without rollback`() {
        listOf(true, false).forEach { shouldRollback ->
            val context = InstanceTestContext(temporaryFolder.newFolder())
            writeCrashMarker(context, main, "main-bundle", shouldRollback)

            mainImpl(context).getJSBundleFile()

            assertFalse(crashMarker(context, main).exists())
            // A rollback is settled locally: the restored bundle passed its first content.
            assertEquals(
                if (shouldRollback) null else "1",
                storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY),
            )
        }
    }

    @Test
    fun `a rollback marker clears a check an earlier crash left pending`() {
        val context = InstanceTestContext(temporaryFolder.root)
        storage(context, main).setItem(PostCrashUpdateCheck.PENDING_KEY, "1")
        writeCrashMarker(context, main, "main-bundle", shouldRollback = true)

        mainImpl(context).getJSBundleFile()

        assertFalse(crashMarker(context, main).exists())
        assertNull(storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    @Test
    fun `a launch without a crash marker keeps a check left pending`() {
        val context = InstanceTestContext(temporaryFolder.root)
        storage(context, main).setItem(PostCrashUpdateCheck.PENDING_KEY, "1")
        val check = RecordingCheck()

        HotUpdaterImpl(
            context,
            main,
            postCrashUpdateCheck = { storage -> check.create(storage::getItem, storage::setItem) },
            isDevelopmentBuild = false,
        ).getJSBundleFile()

        // No config, so no request either: the flag waits for one.
        assertEquals("1", storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    @Test
    fun `main's update check before React Native starts sets the check flag when it consumes a crash marker`() {
        val context = InstanceTestContext(temporaryFolder.root)
        writeCrashMarker(context, main, "main-bundle", shouldRollback = false)

        mainImpl(context).getBundleIdForUpdateCheck()

        assertEquals("1", storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    @Test
    fun `a debug build's launch preparation sets no check flag`() {
        val context = InstanceTestContext(temporaryFolder.root)
        writeCrashMarker(context, main, "main-bundle", shouldRollback = false)
        val check = RecordingCheck()

        HotUpdaterImpl(
            context,
            main,
            postCrashUpdateCheck = { storage -> check.create(storage::getItem, storage::setItem) },
            isDevelopmentBuild = true,
        ).getJSBundleFile()

        assertFalse(crashMarker(context, main).exists())
        assertNull(storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    @Test
    fun `a launch without a crash marker sets no check flag`() {
        val context = InstanceTestContext(temporaryFolder.root)

        mainImpl(context).getJSBundleFile()

        assertNull(storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    @Test
    fun `a named instance's crash marker sets no check flag`() {
        val context = InstanceTestContext(temporaryFolder.root)
        writeCrashMarker(context, widget, "widget-bundle", shouldRollback = false)

        HotUpdaterImpl(context, widget).getJSBundleFile()

        assertFalse(crashMarker(context, widget).exists())
        assertNull(storage(context, widget).getItem(PostCrashUpdateCheck.PENDING_KEY))
        assertNull(storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    @Test
    fun `the launch after a crash checks once its UI is shown and stages what it finds`() {
        val context = InstanceTestContext(temporaryFolder.root)
        writeCrashMarker(context, main, "main-bundle", shouldRollback = false)
        storage(context, main).setItem(RecoveryCheckConfig.KEY, config())
        val check = RecordingCheck()
        check.update = check.updateOf("fix-bundle")
        val impl = mainImpl(context, check)

        impl.getJSBundleFile()

        // The check waits for UI; the flag stays until it ran.
        assertEquals(1, check.gates.size)
        assertTrue(check.requests.isEmpty())
        check.showUi()
        assertEquals(1, check.requests.size)
        assertEquals(BASE_URL, check.requests.single().baseURL)
        assertNull(check.requests.single().channel)
        assertEquals(1, check.installs)
        assertNull(storage(context, main).getItem(PostCrashUpdateCheck.PENDING_KEY))
    }

    // When the check runs.

    @Test
    fun `no flag means no check`() {
        val store = mutableMapOf(RecoveryCheckConfig.KEY to config())
        val check = recordingCheck(store)

        check.subject.startIfPending()

        assertTrue(check.gates.isEmpty())
        assertTrue(check.requests.isEmpty())
    }

    @Test
    fun `no config means no request, and the flag waits for a launch that has one`() {
        val store = mutableMapOf(PostCrashUpdateCheck.PENDING_KEY to "1")
        val check = recordingCheck(store)

        check.subject.startIfPending()

        assertTrue(check.gates.isEmpty())
        assertTrue(check.requests.isEmpty())
        assertEquals("1", store[PostCrashUpdateCheck.PENDING_KEY])

        // JavaScript saves a config later in the process.
        store[RecoveryCheckConfig.KEY] = config()
        check.subject.startIfPending()
        check.showUi()
        assertEquals(1, check.requests.size)
    }

    @Test
    fun `an invalid config means no request`() {
        val store = mutableMapOf(PostCrashUpdateCheck.PENDING_KEY to "1", RecoveryCheckConfig.KEY to config(baseURL = "file:///tmp"))
        val check = recordingCheck(store)

        check.subject.startIfPending()

        assertTrue(check.gates.isEmpty())
        assertTrue(check.requests.isEmpty())
    }

    @Test
    fun `a headless launch leaves the check for a launch that shows UI`() {
        val store = mutableMapOf(PostCrashUpdateCheck.PENDING_KEY to "1", RecoveryCheckConfig.KEY to config())
        val headless = recordingCheck(store)

        headless.subject.startIfPending()

        // The process ends without an activity.
        assertTrue(headless.requests.isEmpty())
        assertEquals("1", store[PostCrashUpdateCheck.PENDING_KEY])

        val next = recordingCheck(store)
        next.subject.startIfPending()
        next.showUi()
        assertEquals(1, next.requests.size)
        assertNull(store[PostCrashUpdateCheck.PENDING_KEY])
    }

    @Test
    fun `the check runs once per process`() {
        val store = mutableMapOf(PostCrashUpdateCheck.PENDING_KEY to "1", RecoveryCheckConfig.KEY to config())
        val check = recordingCheck(store)

        check.subject.startIfPending()
        check.subject.startIfPending()
        check.showUi()
        // A later crash marker in the same process.
        check.subject.markPending()
        check.subject.startIfPending()

        assertEquals(1, check.gates.size)
        assertEquals(1, check.requests.size)
        assertEquals("1", store[PostCrashUpdateCheck.PENDING_KEY])
    }

    @Test
    fun `the flag is cleared when the attempt finishes, whatever it found`() {
        listOf<(RecordingCheck) -> Unit>(
            { it.update = null },
            { it.update = it.updateOf("fix-bundle") },
            { it.update = it.updateOf("fix-bundle", commits = false) },
            { it.failure = IllegalStateException("Request failed with HTTP 500") },
        ).forEach { setUp ->
            val store = mutableMapOf(PostCrashUpdateCheck.PENDING_KEY to "1", RecoveryCheckConfig.KEY to config())
            val check = StoreCheck(store, recorder = RecordingCheck().also(setUp))

            check.subject.startIfPending()
            check.showUi()

            assertEquals(1, check.requests.size)
            assertEquals(if (check.recorder.update != null) 1 else 0, check.recorder.installs)
            assertNull(store[PostCrashUpdateCheck.PENDING_KEY])
        }
    }

    @Test
    fun `Hot Updater's restart process never checks`() {
        val store = mutableMapOf(PostCrashUpdateCheck.PENDING_KEY to "1", RecoveryCheckConfig.KEY to config())
        val check = recordingCheck(store, restartProcess = true)

        check.subject.startIfPending()

        assertTrue(check.gates.isEmpty())
        assertEquals("1", store[PostCrashUpdateCheck.PENDING_KEY])
    }

    /** The UI gate, checker, and staging of a check, which the test runs by hand. */
    private class RecordingCheck {
        val gates = mutableListOf<() -> Unit>()
        val requests = mutableListOf<NativeCheckRequest>()
        var update: HotUpdaterUpdate? = null
        var failure: Exception? = null
        var installs = 0

        /** A check whose background work runs on this thread. */
        fun create(
            getItem: (String) -> String?,
            setItem: (String, String?) -> Unit,
            restartProcess: Boolean = false,
        ) = PostCrashUpdateCheck(
            getItem = getItem,
            setItem = setItem,
            whenUiShown = { action -> gates += action },
            check = { request ->
                requests += request
                failure?.let { throw it }
                update
            },
            isRestartProcess = { restartProcess },
            background = Runnable::run,
        )

        fun showUi() = gates.toList().forEach { it() }

        /** An update whose staging commits, or finds its selection superseded. */
        fun updateOf(
            bundleId: String,
            commits: Boolean = true,
        ) = HotUpdaterUpdate(
            id = bundleId,
            releaseId = null,
            status = HotUpdaterUpdateStatus.UPDATE,
            shouldForceUpdate = false,
            message = null,
            rolloutCohortCount = 1000,
            targetCohorts = emptyList(),
            transitionKind = "INSTALL",
            runsCurrentBundle = false,
            targetKey = bundleId,
            install = {
                installs += 1
                commits
            },
        )
    }

    /** A check over [store], with its recorder. */
    private class StoreCheck(
        store: MutableMap<String, String>,
        restartProcess: Boolean = false,
        val recorder: RecordingCheck = RecordingCheck(),
    ) {
        val subject =
            recorder.create(
                { key -> store[key] },
                { key, value -> if (value == null) store.remove(key) else store[key] = value },
                restartProcess,
            )
        val gates get() = recorder.gates
        val requests get() = recorder.requests

        fun showUi() = recorder.showUi()
    }

    private fun recordingCheck(
        store: MutableMap<String, String>,
        restartProcess: Boolean = false,
    ) = StoreCheck(store, restartProcess)

    /** Main's impl, whose check after a crash runs on this thread through [check]. */
    private fun mainImpl(
        context: InstanceTestContext,
        check: RecordingCheck = RecordingCheck(),
    ): HotUpdaterImpl =
        HotUpdaterImpl(
            context,
            main,
            postCrashUpdateCheck = { storage -> check.create(storage::getItem, storage::setItem) },
            isDevelopmentBuild = false,
        )

    /** Main's launch of [bundleId], verified by its first content and past its grace period. */
    private fun verifiedMainLaunch(
        context: InstanceTestContext,
        bundleId: String?,
        recordsCrashesAfterContent: Boolean = true,
    ): FakeMainThread {
        val mainThread = FakeMainThread()
        HotUpdaterRecoveryManager(context, main, mainThread, recordsCrashesAfterContent).startMonitoring(
            bundleId = bundleId,
            shouldRollback = bundleId != null,
            onContentAppeared = {},
            onCrashOfAnotherInstance = {},
            onRecoveryRestartRequested = { throw AssertionError("a verified launch never restarts the app") },
        )
        HotUpdaterRecoveryManager.contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)
        // The error hooks' retry and the grace period.
        mainThread.runAll()
        return mainThread
    }

    private class GateApplication : Application() {
        private val callbacks = mutableListOf<ActivityLifecycleCallbacks>()

        override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
            callbacks += callback
        }

        fun startActivity() = callbacks.forEach { it.onActivityStarted(Activity()) }
    }

    private fun storage(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
    ) = KeyValueStorageService(environment.keyValueStorageFile(context))

    private fun crashMarker(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
    ) = File(File(environment.filesRoot(context), "bundle-store"), "recovery-crash-marker.json")

    private fun writeCrashMarker(
        context: InstanceTestContext,
        environment: HotUpdaterInstanceEnvironment,
        bundleId: String,
        shouldRollback: Boolean,
    ) {
        crashMarker(context, environment).apply {
            parentFile?.mkdirs()
            writeText("{\"bundleId\":\"$bundleId\",\"shouldRollback\":$shouldRollback}\n")
        }
    }

    private fun config(
        version: Int? = 1,
        baseURL: String? = BASE_URL,
        requestHeaders: Any? = JSONObject().put("x-api-key", "secret"),
        requestTimeoutMs: Any? = 5000,
        updateStrategy: String? = "appVersion",
    ): String =
        JSONObject()
            .apply {
                version?.let { put("version", it) }
                baseURL?.let { put("baseURL", it) }
                requestHeaders?.let { put("requestHeaders", it) }
                requestTimeoutMs?.let { put("requestTimeoutMs", it) }
                updateStrategy?.let { put("updateStrategy", it) }
            }.toString()

    companion object {
        private const val BASE_URL = "https://updates.example.com"
        private const val MAIN_SOURCE_URL = "assets://index.android.bundle"
    }
}
