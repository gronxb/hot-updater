package com.hotupdater

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.core.util.AtomicFile
import com.facebook.react.bridge.JSExceptionHandler
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactMarker
import com.facebook.react.bridge.ReactMarkerConstants
import com.facebook.react.common.JavascriptException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.lang.reflect.Field
import java.util.concurrent.ConcurrentHashMap
import kotlin.system.exitProcess

/**
 * Watches one instance's launch until its first content appears: its crash
 * marker lives in its own bundle store, and a crash charges it only when the
 * crash is its own (see [HotUpdaterRecoverySlots]). Main restarts the app to
 * recover, as it always has; a named instance leaves its marker for its next
 * launch to roll back.
 */
internal class HotUpdaterRecoveryManager(
    context: Context,
    environment: HotUpdaterInstanceEnvironment = HotUpdaterInstanceEnvironment.main,
    private val mainThread: HotUpdaterMainThread = HotUpdaterMainThread.android,
) {
    private val appContext = context.applicationContext
    private val name = environment.name
    private val isMain = environment.isMain
    private val crashMarkerFile = getCrashMarkerFile(appContext, environment)
    private val watchdogStateFile = File(getBundleStoreDir(appContext), WATCHDOG_STATE_FILENAME)

    private val launchState = HotUpdaterRecoveryState()

    // Launches start on whichever thread prepares them, while first content,
    // views, delayed callbacks, and JavaScript errors arrive on others. Every
    // change to this launch's state happens under this lock, and work posted
    // for a launch carries its generation, so it never acts on a newer one.
    private val lock = Any()
    private var generation = 0L

    // Main's launch counts from the start, as it always has. A named launch
    // counts once one of its views is shown ([armLaunch]): a runtime pre-warmed
    // without UI must not be charged for a crash elsewhere in the process.
    private var armed = isMain

    // Another instance's fatal error is ending the process, so this launch
    // must not be armed in the moments left.
    private var endedByAnotherInstance = false

    // What arms this launch for the next process, kept so a launch another
    // instance's claimed error disarmed is armed again when that error turns
    // out not to end the process.
    private var launchStartedAction: (() -> Unit)? = null
    private var contentAppearedCallback: ((String?) -> Unit)? = null
    private var crashOfAnotherInstanceCallback: ((String?) -> Unit)? = null
    private var recoveryRestartCallback: (() -> Boolean)? = null
    private var runtimeActivityCallback: ((Activity) -> Unit)? = null
    private var stopTask: Runnable? = null
    private var hookTask: Runnable? = null

    // The bundle this launch handed to React Native, and the runtimes running
    // it whose HotUpdater module hooks their errors. A runtime of an earlier
    // launch whose module is created late runs another bundle, so it never
    // counts for this launch.
    private var launchURL: String? = null
    private val registeredRuntimeIds = mutableSetOf<Int>()

    init {
        attribution.track(appContext)
    }

    fun consumePendingCrashRecovery(): PendingCrashRecovery? {
        if (!crashMarkerFile.exists()) {
            return null
        }

        return try {
            val recovery = PendingCrashRecovery.loadFromFile(crashMarkerFile) ?: return null
            Log.d(
                TAG,
                "Consumed pending crash marker of $name bundleId=${recovery.launchedBundleId} shouldRollback=${recovery.shouldRollback}",
            )
            recovery
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read crash marker", e)
            null
        } finally {
            crashMarkerFile.delete()
        }
    }

    /**
     * @param onCrashOfAnotherInstance called when another instance's
     * JavaScript fatal error is about to end the process: this launch did not
     * fail, so it must not count as unfinished at the next start
     * @param onRecoveryRestartRequested restarts the app to recover; null
     * leaves recovery to the next launch
     * @param onRuntimeActivity called with the activity of this instance's
     * runtime once its HotUpdater module is created, which may show its view
     * in an activity that started before anything followed activities
     * @param launchURL the bundle this launch hands to React Native, which
     * the runtimes of this launch load; null accepts any runtime
     * @return the launch's generation, which [armLaunch] takes
     */
    fun startMonitoring(
        bundleId: String?,
        shouldRollback: Boolean,
        onContentAppeared: (String?) -> Unit,
        onCrashOfAnotherInstance: (String?) -> Unit,
        onRecoveryRestartRequested: (() -> Boolean)?,
        onRuntimeActivity: ((Activity) -> Unit)? = null,
        launchURL: String? = null,
    ): Long {
        crashMarkerFile.parentFile?.mkdirs()
        ensureExceptionHandlerInstalled()
        ensureNativeSignalHandlerInstalled()
        ensureContentAppearedListenerInstalled()

        val generation =
            synchronized(lock) {
                generation += 1
                cancelScheduledLocked()
                contentAppearedCallback = onContentAppeared
                crashOfAnotherInstanceCallback = onCrashOfAnotherInstance
                recoveryRestartCallback = onRecoveryRestartRequested
                runtimeActivityCallback = onRuntimeActivity
                // A new launch runs in a new runtime, which registers when its
                // module is created; until then its errors are not hooked.
                this.launchURL = launchURL
                registeredRuntimeIds.clear()
                launchState.start(bundleId, shouldRollback)
                armed = isMain
                endedByAnotherInstance = false
                launchStartedAction = null
                liveManagers[name] = this
                updateNativeLaunchStateLocked()
                if (shouldRollback && armed) {
                    startRecoveryWatchdog()
                } else {
                    releaseRecoveryWatchdog()
                }
                // A named instance's runtime hooks its errors when its module
                // is created (registerRuntime); main's host is reachable from the app.
                if (isMain) installJavaScriptExceptionHooksLocked(generation)
                generation
            }

        Log.d(TAG, "Started crash monitoring of $name bundleId=$bundleId shouldRollback=$shouldRollback")
        return generation
    }

    /**
     * One of this instance's views is shown, so a crash from now on may be
     * its launch's, when [generation] is still the current launch: a gate's
     * action may run after a newer launch started. [markLaunchStarted]
     * records the launch for the next process unless another instance's
     * crash is already ending this one.
     */
    fun armLaunch(
        generation: Long,
        markLaunchStarted: () -> Unit,
    ) {
        synchronized(lock) {
            if (generation != this.generation) return
            // Content already verified the launch, as when its runtime
            // rendered before its view could be found.
            if (launchState.hasContentAppeared()) return
            launchStartedAction = markLaunchStarted
            if (endedByAnotherInstance) return
            markLaunchStarted()
            if (armed) return
            armed = true
            updateNativeLaunchStateLocked()
            if (launchState.snapshot()?.shouldRollback == true) {
                startRecoveryWatchdog()
            }
        }
    }

    private fun currentLaunch(): HotUpdaterRecoverySlots.Launch? =
        synchronized(lock) {
            launchState.snapshot()?.let {
                HotUpdaterRecoverySlots.Launch(name, it.bundleId, it.shouldRollback, armed, launchState.hasContentAppeared())
            }
        }

    /** First content of this instance's runtime; [expectedGeneration] limits it to that launch. */
    private fun handleContentAppeared(expectedGeneration: Long? = null) {
        synchronized(lock) {
            if (expectedGeneration != null && expectedGeneration != generation) return
            val launch = launchState.completeLaunch() ?: return
            Log.d(TAG, "First content appeared for $name bundleId=${launch.bundleId}")
            cancelScheduledLocked()
            contentAppearedCallback?.invoke(launch.bundleId)
            updateNativeLaunchStateLocked()
            releaseRecoveryWatchdog()
            val generation = generation
            stopTask = Runnable { stopMonitoring(generation) }.also { mainThread.postDelayed(it, MONITORING_GRACE_PERIOD_MS) }
        }
    }

    /** Ends the grace period of the launch of [generation], unless a newer launch started. */
    private fun stopMonitoring(generation: Long) {
        synchronized(lock) {
            if (generation != this.generation) return
            stopTask = null
            releaseRecoveryWatchdog()
            Log.d(TAG, "Stopping crash monitoring for current launch of $name")
            launchState.stop()
            contentAppearedCallback = null
            crashOfAnotherInstanceCallback = null
            recoveryRestartCallback = null
            runtimeActivityCallback = null
            liveManagers.remove(name, this)
            updateNativeLaunchStateLocked()
        }
    }

    private fun cancelScheduledLocked() {
        stopTask?.let(mainThread::remove)
        hookTask?.let(mainThread::remove)
        stopTask = null
        hookTask = null
    }

    // Keeps hooking main's host until the launch of [generation] ends: the
    // host creates its React instance later.
    private fun installJavaScriptExceptionHooksLocked(generation: Long) {
        hookTask =
            object : Runnable {
                override fun run() {
                    synchronized(lock) {
                        if (generation != this@HotUpdaterRecoveryManager.generation || launchState.snapshot() == null) return
                    }
                    installJavaScriptExceptionHooks()
                    synchronized(lock) {
                        if (generation == this@HotUpdaterRecoveryManager.generation && hookTask === this) {
                            mainThread.postDelayed(this, JS_EXCEPTION_HOOK_RETRY_DELAY_MS)
                        }
                    }
                }
            }.also(mainThread::post)
    }

    /**
     * Records runtime [runtimeId], which loaded [sourceURL], as one of this
     * launch's, and shows the launch gate its [activity]; false for a runtime
     * of an earlier launch, which runs another bundle.
     */
    private fun registerRuntime(
        runtimeId: Int,
        sourceURL: String?,
        activity: Activity?,
    ): Boolean {
        val callback =
            synchronized(lock) {
                val launchURL = launchURL
                if (launchState.snapshot() == null) return false
                if (launchURL != null && !isSameBundle(sourceURL, launchURL)) return false
                registeredRuntimeIds += runtimeId
                runtimeActivityCallback
            }
        if (activity != null) callback?.invoke(activity)
        return true
    }

    private fun unregisterRuntime(runtimeId: Int) {
        synchronized(lock) { registeredRuntimeIds -= runtimeId }
    }

    private fun hasRegisteredRuntime(): Boolean = synchronized(lock) { registeredRuntimeIds.isNotEmpty() }

    /** Whether a runtime that loaded [sourceURL] runs this launch's bundle. */
    private fun runsLaunchOf(sourceURL: String?): Boolean =
        synchronized(lock) {
            val launchURL = launchURL ?: return@synchronized true
            isSameBundle(sourceURL, launchURL)
        }

    private fun currentGeneration(): Long = synchronized(lock) { generation }

    /** A launch waiting for its first content, whose root view may not be found yet. */
    private fun awaitsFirstContent(): Boolean = synchronized(lock) { launchState.snapshot() != null && !launchState.hasContentAppeared() }

    private fun writeCrashMarker(launch: HotUpdaterRecoveryState.Launch) {
        val atomicFile = AtomicFile(crashMarkerFile)
        var output: FileOutputStream? = null
        try {
            val payload =
                JSONObject().apply {
                    put("bundleId", launch.bundleId ?: JSONObject.NULL)
                    put("shouldRollback", launch.shouldRollback)
                }
            crashMarkerFile.parentFile?.mkdirs()
            output = atomicFile.startWrite()
            output.write(payload.toString().toByteArray(Charsets.UTF_8))
            atomicFile.finishWrite(output)
        } catch (e: Exception) {
            output?.let(atomicFile::failWrite)
            Log.e(TAG, "Failed to write crash marker", e)
        }
    }

    // The owners, the state file, and the alarm change together, so two
    // instances never write the file in reverse order or delete it after
    // another one joined.
    private fun startRecoveryWatchdog() {
        synchronized(watchdogOwners) {
            try {
                watchdogOwners += name
                watchdogDeadlineAt = System.currentTimeMillis() + MONITORING_GRACE_PERIOD_MS
                watchdogStateFile.parentFile?.mkdirs()
                watchdogStateFile.writeText(WatchdogState(watchdogDeadlineAt, watchdogOwners.toList()).serialize())
                scheduleRecoveryWatchdogTick(appContext, WATCHDOG_TICK_INTERVAL_MS)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to schedule recovery watchdog", e)
            }
        }
    }

    // One alarm serves the process: it stops once no instance waits for content.
    private fun releaseRecoveryWatchdog() {
        synchronized(watchdogOwners) {
            if (!watchdogOwners.remove(name) && watchdogOwners.isNotEmpty()) return
            if (watchdogOwners.isNotEmpty()) {
                // The instances still waiting keep the watchdog, and a marker
                // of this one no longer relaunches the app.
                try {
                    watchdogStateFile.writeText(WatchdogState(watchdogDeadlineAt, watchdogOwners.toList()).serialize())
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to update recovery watchdog", e)
                }
                return
            }
            watchdogStateFile.delete()
            cancelRecoveryWatchdogAlarm(appContext)
        }
    }

    /**
     * Main's recovery: a launch waiting for its first content restarts the
     * app once and leaves its marker for the restarted process.
     */
    private fun requestAutomaticRecoveryLocked(exception: Exception? = null): Boolean {
        val request = launchState.requestRecovery()
        if (exception != null) {
            Log.e(TAG, "Caught React startup exception for bundleId=${launchState.snapshot()?.bundleId}", exception)
        }
        if (request == null) {
            launchState.snapshot()?.let(::writeCrashMarker)
            return false
        }
        if (!request.shouldRestart) return true
        writeCrashMarker(request.launch)
        val started = recoveryRestartCallback?.invoke() == true
        launchState.finishRecoveryRequest(request, started)
        if (!started) {
            Log.w(TAG, "Failed to schedule automatic recovery restart")
        } else {
            Log.i(TAG, "Scheduled automatic recovery restart for bundleId=${request.launch.bundleId}")
        }
        return started
    }

    /**
     * Charges this instance for the crash that ends the process. A named
     * instance never restarts the app: restarting reaches main's host, so its
     * next launch rolls the bundle back instead.
     */
    private fun chargeCrash(exception: Exception? = null): Boolean =
        synchronized(lock) {
            if (isMain) return@synchronized requestAutomaticRecoveryLocked(exception)
            val launch = launchState.snapshot()?.takeIf { it.shouldRollback } ?: return@synchronized false
            if (exception != null) {
                Log.e(TAG, "Caught React startup exception of $name for bundleId=${launch.bundleId}", exception)
            }
            writeCrashMarker(launch)
            // A launch none of whose views was shown has no watchdog yet; it
            // relaunches the app after this crash, as for an armed launch.
            startRecoveryWatchdog()
            false
        }

    /**
     * Leaves this launch alone for another instance's crash: the generation
     * of the launch it left, or null when the launch wasn't waiting for its
     * content.
     */
    private fun handleCrashOfAnotherInstance(): Long? =
        synchronized(lock) {
            val launch = launchState.snapshot()?.takeIf { it.shouldRollback } ?: return@synchronized null
            endedByAnotherInstance = true
            crashOfAnotherInstanceCallback?.invoke(launch.bundleId)
            generation
        }

    /**
     * Another instance's claimed error did not end the process: the launch of
     * [generation] counts again, unless a newer launch started since.
     */
    private fun resumeAfterAnotherInstanceSurvived(generation: Long) {
        synchronized(lock) {
            if (generation != this.generation || !endedByAnotherInstance) return
            endedByAnotherInstance = false
            val action = launchStartedAction ?: return
            if (launchState.snapshot()?.shouldRollback != true) return
            armLaunch(generation, action)
        }
    }

    // Two instances may prepare their launches at once. Installing twice
    // would record Hot Updater's own handler as the one to forward to.
    private fun ensureNativeSignalHandlerInstalled() {
        synchronized(signalHandlerLock) {
            if (signalHandlerInstalled || !HotUpdaterRecoveryNative.load()) {
                return
            }

            try {
                HotUpdaterRecoveryNative.nativeInstallSignalHandler()
                signalHandlerInstalled = true
            } catch (e: UnsatisfiedLinkError) {
                Log.w(TAG, "Signal handler not available", e)
            }
        }
    }

    // Under the manager's lock, so the native slot follows this launch's
    // transitions in order.
    private fun updateNativeLaunchStateLocked() {
        if (!signalHandlerInstalled) {
            return
        }
        val slot = slots.slotOf(name) ?: return
        val launch = currentLaunch()

        try {
            HotUpdaterRecoveryNative.nativeUpdateSlot(
                slot,
                crashMarkerFile.absolutePath,
                launch?.bundleId,
                launch?.unverified == true,
                isMain,
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.w(TAG, "Failed to update native launch state", e)
        }
    }

    // Each architecture's source set reaches its own React instance, so the old
    // architecture's ReactNativeHost is compiled only into old architecture builds.
    private fun installJavaScriptExceptionHooks() {
        JavaScriptExceptionHooks.install(appContext)
    }

    internal class RecoveryJSExceptionHandler(
        private val previousHandler: JSExceptionHandler?,
        private val sourceURL: () -> String?,
    ) : JSExceptionHandler {
        override fun handleException(e: Exception) {
            if (!handleJavaScriptExceptionForRecovery(e, runCatching(sourceURL).getOrNull())) {
                previousHandler?.handleException(e) ?: throw e
            }
        }
    }

    /** The deadline of the recovery watchdog, and the instances that armed it. */
    internal data class WatchdogState(
        val deadlineAt: Long,
        val instances: List<String>,
    ) {
        // Main alone writes only its deadline, as it always has. Any other set
        // of owners is listed on an `owners:` line, which may leave main out:
        // a marker main left in an earlier process is not this launch's.
        fun serialize(): String {
            val owners = instances.distinct()
            if (owners == listOf(HotUpdaterInstanceEnvironment.MAIN_NAME)) return deadlineAt.toString()
            return "$deadlineAt\n$OWNERS_PREFIX${owners.joinToString(",")}"
        }

        companion object {
            private const val OWNERS_PREFIX = "owners:"

            fun parse(text: String?): WatchdogState? {
                val lines = text?.lines()?.map(String::trim)?.filter(String::isNotEmpty) ?: return null
                val deadlineAt = lines.firstOrNull()?.toLongOrNull() ?: return null
                val owners =
                    lines
                        .firstOrNull { it.startsWith(OWNERS_PREFIX) }
                        ?.removePrefix(OWNERS_PREFIX)
                        ?.split(',')
                        ?.map(String::trim)
                        ?.filter(String::isNotEmpty)
                // A file with only a deadline is main's.
                return WatchdogState(deadlineAt, owners ?: listOf(HotUpdaterInstanceEnvironment.MAIN_NAME))
            }
        }
    }

    companion object {
        private const val TAG = "HotUpdaterRecovery"
        private const val CRASH_MARKER_FILENAME = "recovery-crash-marker.json"
        private const val WATCHDOG_STATE_FILENAME = "recovery-watchdog-state.txt"
        private const val WATCHDOG_ACTION = "com.hotupdater.RECOVERY_WATCHDOG"
        private const val MONITORING_GRACE_PERIOD_MS = 10_000L
        private const val WATCHDOG_TICK_INTERVAL_MS = 1_500L
        private const val JS_EXCEPTION_HOOK_RETRY_DELAY_MS = 50L

        @Volatile
        private var signalHandlerInstalled = false

        @Volatile
        private var exceptionHandlerInstalled = false

        @Volatile
        private var contentAppearedListenerInstalled = false

        @Volatile
        private var previousExceptionHandler: Thread.UncaughtExceptionHandler? = null

        private val slots = HotUpdaterRecoverySlots()
        private val attribution = HotUpdaterRecoveryAttribution.shared

        /** The manager of each instance whose launch is monitored. */
        private val liveManagers = ConcurrentHashMap<String, HotUpdaterRecoveryManager>()

        private val signalHandlerLock = Any()
        private const val MAX_CAUSE_DEPTH = 8

        // The launches the current claim left alone, armed again if the
        // process outlives the claim.
        private val claimLock = Any()
        private var claimGeneration = 0
        private val disarmedByClaim = LinkedHashMap<HotUpdaterRecoveryManager, Long>()
        private val watchdogOwners = linkedSetOf<String>()
        private var watchdogDeadlineAt = 0L

        private val patchedReactContextIds = mutableSetOf<Int>()

        private val contentAppearedListener =
            ReactMarker.MarkerListener { marker, _, rootTag ->
                if (marker == ReactMarkerConstants.CONTENT_APPEARED) {
                    handleContentAppeared(rootTag)
                }
            }

        private fun ensureContentAppearedListenerInstalled() {
            synchronized(this) {
                if (contentAppearedListenerInstalled) return
                contentAppearedListenerInstalled = true
            }
            ReactMarker.addListener(contentAppearedListener)
        }

        // React Native names the view by its root tag. A view no known activity
        // shows is credited to main, as every view always was.
        //
        // A view no known activity shows yet may be a named runtime's: one that
        // rendered before its module registered, or before its root view was
        // attached to an activity. While a named launch waits for its first
        // content, the content is held (HotUpdaterHeldContent) instead.
        internal fun handleContentAppeared(rootTag: Int) {
            if (liveManagers.keys.all { it == HotUpdaterInstanceEnvironment.MAIN_NAME }) {
                contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)
                return
            }
            attribution.instanceOfRootTag(rootTag)?.let {
                contentAppeared(it)
                return
            }
            val waitingNamedLaunch = liveManagers.values.any { !it.isMain && it.awaitsFirstContent() }
            if (!waitingNamedLaunch) {
                contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)
                return
            }
            heldContent.hold(rootTag, liveManagers.values.associate { it.name to it.currentGeneration() })
        }

        /**
         * Main thread: verifies the launches whose held content's views can
         * be found now, as when a root view was attached to an activity after
         * its first content appeared.
         */
        internal fun resolveHeldContent() {
            heldContent.resolveHeld()
        }

        private val heldContent =
            HotUpdaterHeldContent(
                mainThread = HotUpdaterMainThread.android,
                clock = { SystemClock.uptimeMillis() },
                resolve = { rootTag -> attribution.instanceOfRootTag(rootTag) },
                credit = { instanceName, generation -> liveManagers[instanceName]?.handleContentAppeared(generation) },
            )

        /** First content of [instanceName]'s runtime appeared: it verifies only that instance's launch. */
        internal fun contentAppeared(instanceName: String) {
            liveManagers[instanceName]?.handleContentAppeared()
        }

        private fun ensureExceptionHandlerInstalled() {
            synchronized(this) {
                if (exceptionHandlerInstalled) {
                    return
                }

                previousExceptionHandler = Thread.getDefaultUncaughtExceptionHandler()
                exceptionHandlerInstalled = true
                Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                    if (chargeUncaughtException(throwable)) {
                        // The separate restart activity kills this process after it starts.
                        // A second fatal error must not kill it while that request is in flight.
                        return@setDefaultUncaughtExceptionHandler
                    }

                    previousExceptionHandler?.uncaughtException(thread, throwable)
                        ?: run {
                            Process.killProcess(Process.myPid())
                            exitProcess(10)
                        }
                }
            }
        }

        /**
         * Writes the crash markers of an uncaught exception that ends the
         * process; true when main's recovery restart takes over the process.
         * A JavaScript error that reaches it unclaimed may be inferred to be
         * one named launch's ([HotUpdaterRecoverySlots.inferJavaScriptErrorOwner]).
         */
        internal fun chargeUncaughtException(throwable: Throwable): Boolean {
            val owner =
                if (slots.attributedName() == null && isJavaScriptError(throwable)) javaScriptErrorOwner(throwable) else null
            return if (owner != null) claimJavaScriptError(null, owner) else handleUncaughtCrash()
        }

        /**
         * The instance an unclaimed JavaScript error belongs to: the one its
         * stack runs from, or the one inferred from the launches that haven't
         * finished loading; null when neither tells.
         */
        private fun javaScriptErrorOwner(throwable: Throwable): String? =
            attribution.namedInstanceOfStack(javaScriptStacks(throwable)) ?: inferJavaScriptErrorOwner()

        // React Native formats a fatal error's frames without their files,
        // but keeps the engine's own stack, with each frame's bundle, in its
        // extra data.
        private fun javaScriptStacks(throwable: Throwable): List<String> =
            generateSequence(throwable) { it.cause }
                .take(MAX_CAUSE_DEPTH)
                .filterIsInstance<JavascriptException>()
                .flatMap { error -> listOfNotNull(error.message, error.extraDataAsJson?.let(::rawStackOf)) }
                .toList()

        private fun rawStackOf(extraDataAsJson: String): String =
            runCatching { JSONObject(extraDataAsJson).optString("rawStack") }.getOrNull()?.takeIf { it.isNotEmpty() } ?: extraDataAsJson

        private fun isJavaScriptError(throwable: Throwable): Boolean =
            generateSequence(throwable) { it.cause }.take(MAX_CAUSE_DEPTH).any { it is JavascriptException }

        private fun inferJavaScriptErrorOwner(): String? =
            HotUpdaterRecoverySlots.inferJavaScriptErrorOwner(
                liveLaunches(),
                liveManagers.values
                    .filter { it.hasRegisteredRuntime() }
                    .map { it.name }
                    .toSet(),
            )

        private fun liveLaunches(): List<HotUpdaterRecoverySlots.Launch> = liveManagers.values.mapNotNull { it.currentLaunch() }

        /**
         * Writes the crash markers of the crash that ends the process: the
         * claimed instance's, or every launch it can be blamed on. True when
         * main's recovery restart takes over the process.
         */
        private fun handleUncaughtCrash(
            exception: Exception? = null,
            attributedName: String? = slots.attributedName(),
        ): Boolean {
            val targets = HotUpdaterRecoverySlots.markerTargets(liveLaunches(), attributedName)
            // Named instances first: main's recovery restart ends the process.
            targets.filterNot { it.isMain }.forEach { liveManagers[it.name]?.chargeCrash(exception) }
            if (targets.none { it.isMain }) return false
            return liveManagers[HotUpdaterInstanceEnvironment.MAIN_NAME]?.chargeCrash(exception) == true
        }

        /**
         * Hands a JavaScript error of the runtime that loaded [sourceURL] to
         * crash recovery; false when it does not recover it.
         */
        internal fun handleJavaScriptExceptionForRecovery(
            exception: Exception,
            sourceURL: String?,
        ): Boolean {
            val instanceName = attribution.instanceOf(sourceURL)
            if (instanceName != null &&
                instanceName != HotUpdaterInstanceEnvironment.MAIN_NAME &&
                liveManagers[instanceName]?.runsLaunchOf(sourceURL) == false
            ) {
                // A runtime of an earlier launch of the instance, whose context
                // still reports errors: the crash it may end in is its own, so
                // it charges no launch of this process.
                Log.w(TAG, "JavaScript error of an earlier launch's runtime of $instanceName", exception)
                return claimJavaScriptError(exception, "$instanceName$EARLIER_LAUNCH_SUFFIX")
            }
            return handleJavaScriptException(exception, instanceName)
        }

        // Instance names have no "@", so no launch is ever this claim's.
        private const val EARLIER_LAUNCH_SUFFIX = "@earlier-launch"

        /**
         * A JavaScript error of [instanceName]'s runtime, or of an unknown one
         * when null, which counts as a native crash does. A claimed error
         * charges only its instance, and the crash it may end in charges no
         * other instance: their launches did not fail.
         */
        internal fun handleJavaScriptException(
            exception: Exception,
            instanceName: String?,
        ): Boolean {
            // An error no runtime claims is not the continuation of a claimed
            // one: it is the one named launch whose runtime never reached
            // HotUpdater, or it charges every launch it can be blamed on.
            if (instanceName == null) {
                val owner = javaScriptErrorOwner(exception) ?: return handleUncaughtCrash(exception, attributedName = null)
                return claimJavaScriptError(exception, owner)
            }
            return claimJavaScriptError(exception, instanceName)
        }

        private fun claimJavaScriptError(
            exception: Exception?,
            instanceName: String,
        ): Boolean {
            slots.attribute(instanceName)
            if (signalHandlerInstalled) {
                try {
                    HotUpdaterRecoveryNative.nativeAttributeCrash(slots.assignedSlot(instanceName) ?: -1)
                } catch (e: UnsatisfiedLinkError) {
                    Log.w(TAG, "Failed to attribute the crash natively", e)
                }
            }
            val disarmed =
                liveManagers.values
                    .filter { it.name != instanceName }
                    .mapNotNull { manager -> manager.handleCrashOfAnotherInstance()?.let { manager to it } }
            // Claims overlap when errors return: every launch any of them
            // left alone waits for the last one, including that claim's own
            // instance, which an earlier claim may have left alone.
            val (generation, waiting) =
                synchronized(claimLock) {
                    claimGeneration += 1
                    disarmed.forEach { (manager, launch) -> disarmedByClaim[manager] = launch }
                    claimGeneration to disarmedByClaim.isNotEmpty()
                }
            // A development build shows the error, and an app's handler may
            // swallow it: once the claim expires, the process lived on.
            if (waiting) {
                HotUpdaterMainThread.android.postDelayed({ releaseClaim(generation) }, HotUpdaterRecoverySlots.ATTRIBUTION_WINDOW_MS)
            }
            return liveManagers[instanceName]?.chargeCrash(exception) == true
        }

        /**
         * Arms again the launches the claim of [generation] (the latest by
         * default) left alone, when they still wait for their first content:
         * the claimed error did not end the process.
         */
        internal fun releaseClaim(generation: Int? = null) {
            val disarmed =
                synchronized(claimLock) {
                    if (generation != null && generation != claimGeneration) return
                    disarmedByClaim.toList().also { disarmedByClaim.clear() }
                }
            disarmed.forEach { (manager, launch) -> manager.resumeAfterAnotherInstanceSurvived(launch) }
        }

        /**
         * Hooks the JavaScript errors of a named instance's runtime when its
         * HotUpdater module is created, since the app exposes only main's
         * host, and follows its activity for its views. Main's runtime is
         * left alone: main hooks its host only while it monitors a launch, as
         * it always has.
         */
        internal fun registerRuntime(reactContext: ReactContext): String? {
            val instanceName = attribution.instanceOf(runCatching { reactContext.sourceURL }.getOrNull())
            if (instanceName == null || !registersRuntime(instanceName)) return null
            attribution.registerRuntime(reactContext)
            try {
                JavaScriptExceptionHooks.installForRuntime(reactContext)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to hook the runtime's JavaScript errors", e)
            }
            registerRuntime(
                instanceName,
                System.identityHashCode(reactContext),
                runCatching { reactContext.sourceURL }.getOrNull(),
                reactContext.currentActivity,
            )
            return instanceName
        }

        /**
         * Records that [instanceName]'s runtime [runtimeId], which loaded
         * [sourceURL], hooks its errors, and shows its launch gate the
         * runtime's [activity]: the module is created while the bundle loads,
         * before its first content, and the activity may have started before
         * anything followed activities. A runtime of an earlier launch, whose
         * module may be created after the next launch started, counts for
         * nothing.
         */
        internal fun registerRuntime(
            instanceName: String,
            runtimeId: Int,
            sourceURL: String?,
            activity: Activity?,
        ): Boolean {
            val registered = liveManagers[instanceName]?.registerRuntime(runtimeId, sourceURL, activity) == true
            // Content its runtime showed before can be told now.
            if (registered) heldContent.runtimeRegistered()
            return registered
        }

        /** [instanceName]'s runtime [runtimeId] was torn down, as in a reload. */
        internal fun unregisterRuntime(
            instanceName: String,
            runtimeId: Int,
        ) {
            liveManagers[instanceName]?.unregisterRuntime(runtimeId)
        }

        // React Native may hold `/data/data/...` where the launch handed out
        // `/data/user/0/...`, a symlink to the same file.
        private fun isSameBundle(
            sourceURL: String?,
            launchURL: String,
        ): Boolean {
            val source = sourceURL?.takeIf { it.isNotEmpty() } ?: return false
            return source == launchURL || canonicalBundlePath(source) == canonicalBundlePath(launchURL)
        }

        private fun canonicalBundlePath(url: String): String {
            val path = url.removePrefix("file://")
            return if (path.startsWith("/")) runCatching { File(path).canonicalPath }.getOrDefault(path) else url
        }

        /**
         * Whether a runtime of [instanceName] is hooked when its module is
         * created: only a named instance's. A runtime whose bundle isn't known
         * yet is main's, as every runtime is in an app with only main.
         */
        internal fun registersRuntime(instanceName: String?): Boolean =
            instanceName != null && instanceName != HotUpdaterInstanceEnvironment.MAIN_NAME

        internal fun patchReactContextExceptionHandler(reactContext: ReactContext) {
            val contextIdentity = System.identityHashCode(reactContext)
            synchronized(patchedReactContextIds) {
                if (!patchedReactContextIds.add(contextIdentity)) {
                    return
                }
            }

            val previousHandler = reactContext.jsExceptionHandler
            if (previousHandler is RecoveryJSExceptionHandler) {
                return
            }

            reactContext.setJSExceptionHandler(RecoveryJSExceptionHandler(previousHandler) { reactContext.sourceURL })
        }

        internal fun findField(
            clazz: Class<*>,
            name: String,
        ): Field? {
            var current: Class<*>? = clazz
            while (true) {
                val currentClass = current ?: break
                runCatching { currentClass.getDeclaredField(name) }
                    .getOrNull()
                    ?.let { return it }
                current = currentClass.superclass
            }
            return null
        }

        // The receiver runs on the main thread of a live process too, beside
        // launches that change the watchdog on other threads.
        @JvmStatic
        fun handleRecoveryWatchdog(context: Context) {
            synchronized(watchdogOwners) { handleRecoveryWatchdogLocked(context) }
        }

        private fun handleRecoveryWatchdogLocked(context: Context) {
            val appContext = context.applicationContext
            val watchdogStateFile = File(getBundleStoreDir(appContext), WATCHDOG_STATE_FILENAME)
            val state = WatchdogState.parse(watchdogStateFile.takeIf(File::exists)?.readText())
            if (state == null) {
                cancelRecoveryWatchdogAlarm(appContext)
                watchdogStateFile.delete()
                return
            }

            if (crashMarkerRequestsRollback(appContext.filesDir, state.instances)) {
                Log.i(TAG, "Recovery watchdog detected crash marker, relaunching app")
                watchdogStateFile.delete()
                cancelRecoveryWatchdogAlarm(appContext)
                launchRecoveryRestart(appContext)
                return
            }

            if (System.currentTimeMillis() >= state.deadlineAt) {
                watchdogStateFile.delete()
                cancelRecoveryWatchdogAlarm(appContext)
                return
            }

            scheduleRecoveryWatchdogTick(appContext, WATCHDOG_TICK_INTERVAL_MS)
        }

        /**
         * Whether a crash marker of [instances], the ones that armed the
         * watchdog, asks to roll a launch back. Only those: a marker another
         * instance left in an earlier process waits for that instance's next
         * launch, and must not relaunch this one.
         */
        internal fun crashMarkerRequestsRollback(
            filesDir: File?,
            instances: List<String>,
        ): Boolean =
            instances.distinct().any { name ->
                val root =
                    if (name == HotUpdaterInstanceEnvironment.MAIN_NAME) {
                        filesDir
                    } else {
                        filesDir?.let { File(File(it, HotUpdaterInstanceEnvironment.INSTANCES_DIRECTORY), name) }
                    }
                val recovery = PendingCrashRecovery.loadFromFile(File(File(root, BUNDLE_STORE_DIRECTORY), CRASH_MARKER_FILENAME))
                recovery?.shouldRollback == true && recovery.launchedBundleId != null
            }

        private const val BUNDLE_STORE_DIRECTORY = "bundle-store"

        private fun getBundleStoreDir(context: Context): File = File(context.filesDir, BUNDLE_STORE_DIRECTORY)

        // Main's path is the one it always had: filesRoot is the files directory.
        private fun getCrashMarkerFile(
            context: Context,
            environment: HotUpdaterInstanceEnvironment,
        ): File = File(File(environment.filesRoot(context), BUNDLE_STORE_DIRECTORY), CRASH_MARKER_FILENAME)

        private fun getRecoveryWatchdogIntent(context: Context): Intent =
            Intent(context, HotUpdaterRecoveryReceiver::class.java).setAction(WATCHDOG_ACTION)

        private fun getRecoveryWatchdogPendingIntent(context: Context): PendingIntent =
            PendingIntent.getBroadcast(
                context,
                0,
                getRecoveryWatchdogIntent(context),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        private fun scheduleRecoveryWatchdogTick(
            context: Context,
            delayMs: Long,
        ) {
            val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
            val triggerAt = SystemClock.elapsedRealtime() + delayMs
            alarmManager.set(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                getRecoveryWatchdogPendingIntent(context),
            )
        }

        private fun cancelRecoveryWatchdogAlarm(context: Context) {
            val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
            alarmManager.cancel(getRecoveryWatchdogPendingIntent(context))
        }

        private fun launchRecoveryRestart(context: Context) {
            val restartIntent =
                Intent(context, HotUpdaterRestartActivity::class.java).apply {
                    putExtra(HotUpdaterRestartActivity.EXTRA_PACKAGE_NAME, context.packageName)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
                }

            try {
                context.startActivity(restartIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to launch recovery restart", e)
            }
        }
    }
}

/** The signal handler of HotUpdaterRecovery.cpp, which writes each slot's crash marker. */
internal object HotUpdaterRecoveryNative {
    @Volatile
    private var loadAttempted = false

    @Volatile
    private var loaded = false

    fun load(): Boolean {
        synchronized(this) {
            if (loadAttempted) return loaded
            loadAttempted = true
            loaded =
                try {
                    System.loadLibrary("hotupdater_recovery")
                    true
                } catch (e: UnsatisfiedLinkError) {
                    Log.w("HotUpdaterRecovery", "Failed to load recovery native library", e)
                    false
                }
            return loaded
        }
    }

    @JvmStatic
    external fun nativeInstallSignalHandler()

    @JvmStatic
    external fun nativeUpdateSlot(
        slot: Int,
        crashMarkerPath: String,
        bundleId: String?,
        shouldRollback: Boolean,
        writesWhenVerified: Boolean,
    )

    /** [slot] is -1 for an instance that has none. */
    @JvmStatic
    external fun nativeAttributeCrash(slot: Int)
}
