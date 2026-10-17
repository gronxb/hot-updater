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
import java.io.IOException
import java.lang.ref.WeakReference
import java.lang.reflect.Field
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
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

    private val launchState = HotUpdaterRecoveryState()

    // Launches start on whichever thread prepares them, while first content,
    // views, delayed callbacks, and JavaScript errors arrive on others. Every
    // change to this launch's state happens under this lock, and work posted
    // for a launch carries its generation, so it never acts on a newer one.
    private val lock = recoveryLock
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

    // A rollback marker was written for this launch: its native slot asks
    // for rollback too, armed or not, so a signal before the process ends
    // writes it again rather than leaving it out.
    private var charged = false
    private var contentAppearedCallback: ((String?) -> Unit)? = null
    private var crashOfAnotherInstanceCallback: ((String?) -> Unit)? = null
    private var recoveryRestartCallback: (() -> Boolean)? = null
    private var runtimeActivityCallback: ((Activity) -> Unit)? = null
    private var chargedCallback: (() -> Unit)? = null
    private var stopTask: Runnable? = null
    private var hookTask: Runnable? = null

    // The bundle this launch handed to React Native, and the runtimes running
    // it whose HotUpdater module hooks their errors. A runtime of an earlier
    // launch whose module is created late runs another bundle, so it never
    // counts for this launch.
    private var launchURL: String? = null
    private val registeredRuntimes = WeakIdentitySet<Any>()

    init {
        attribution.track(appContext)
        watchdogContext = appContext
        if (!isMain) namedInstanceCreated = true
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
     * @param onCharged called when a named launch is charged with a crash
     * marker, so the instance's next start prepares a launch that reads it
     * @return the launch's generation, which [armLaunch] takes
     */
    fun startMonitoring(
        bundleId: String?,
        shouldRollback: Boolean,
        onContentAppeared: (String?) -> Unit,
        onCrashOfAnotherInstance: (String?) -> Unit,
        onRecoveryRestartRequested: (() -> Boolean)?,
        onRuntimeActivity: ((Activity) -> Unit)? = null,
        onCharged: (() -> Unit)? = null,
        launchURL: String? = null,
    ): Long {
        crashMarkerFile.parentFile?.mkdirs()
        ensureExceptionHandlerInstalled()
        ensureNativeSignalHandlerInstalled()
        ensureContentAppearedListenerInstalled()

        val generation =
            synchronized(lock) {
                // Unique in the process, so a claim names one launch of one manager.
                generation = launchGenerations.incrementAndGet()
                cancelScheduledLocked()
                contentAppearedCallback = onContentAppeared
                crashOfAnotherInstanceCallback = onCrashOfAnotherInstance
                recoveryRestartCallback = onRecoveryRestartRequested
                runtimeActivityCallback = onRuntimeActivity
                chargedCallback = onCharged
                // A new launch runs in a new runtime, which registers when its
                // module is created; until then its errors are not hooked.
                this.launchURL = launchURL
                registeredRuntimes.clear()
                launchState.start(bundleId, shouldRollback)
                armed = isMain
                launchStartedAction = null
                charged = false
                // A launch that starts while another instance's claimed error
                // may still end the process joins that claim: it is armed only
                // once the claim is released and the process lived on.
                endedByAnotherInstance = joinActiveClaim(this, generation)
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
            // The native slot asks for rollback before any file is written,
            // then the watchdog, then the launch is recorded in storage: a
            // signal during either write still rolls the launch back. An
            // instance that found every slot taken gets no marker from a
            // signal, so its launch is recorded first: from the moment it
            // counts as armed, a signal leaves it unfinished in storage.
            val recordsFirst = !armed && slots.slotOf(name) == null
            if (recordsFirst) markLaunchStarted()
            if (!armed) {
                armed = true
                updateNativeLaunchStateLocked()
                if (launchState.snapshot()?.shouldRollback == true) {
                    startRecoveryWatchdog()
                }
            }
            if (!recordsFirst) markLaunchStarted()
        }
    }

    private fun currentLaunch(): HotUpdaterRecoverySlots.Launch? =
        synchronized(lock) {
            launchState.snapshot()?.let {
                // A launch another instance's claim left alone is not armed
                // for the crash that claim may end in.
                HotUpdaterRecoverySlots.Launch(
                    name,
                    it.bundleId,
                    it.shouldRollback,
                    armed && !endedByAnotherInstance,
                    launchState.hasContentAppeared(),
                )
            }
        }

    /** First content of this instance's runtime; [expectedGeneration] limits it to that launch. */
    private fun handleContentAppeared(expectedGeneration: Long? = null) {
        synchronized(lock) {
            if (expectedGeneration != null && expectedGeneration != generation) return
            val launch = launchState.completeLaunch() ?: return
            Log.d(TAG, "First content appeared for $name bundleId=${launch.bundleId}")
            cancelScheduledLocked()
            // The slot stops asking before storage records the verification.
            updateNativeLaunchStateLocked()
            contentAppearedCallback?.invoke(launch.bundleId)
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
            chargedCallback = null
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
     * Records [runtime], which loaded [sourceURL], as one of this
     * launch's, and shows the launch gate its [activity]; false for a runtime
     * of an earlier launch, which runs another bundle.
     */
    private fun registerRuntime(
        runtime: Any,
        sourceURL: String?,
        activity: Activity?,
    ): Boolean {
        val callback =
            synchronized(lock) {
                val launchURL = launchURL
                if (launchState.snapshot() == null) return false
                if (launchURL != null && !isSameBundle(sourceURL, launchURL)) return false
                // A runtime registered for an earlier launch, whose module is
                // created again, stays that launch's.
                runtimeLaunches[runtime]?.let { (instanceName, launch) -> if (instanceName == name && launch != generation) return false }
                registeredRuntimes.add(runtime)
                runtimeLaunches[runtime] = name to generation
                runtimeActivityCallback
            }
        if (activity != null) callback?.invoke(activity)
        return true
    }

    private fun unregisterRuntime(runtime: Any) {
        synchronized(lock) { registeredRuntimes.remove(runtime) }
    }

    private fun hasRegisteredRuntime(): Boolean = synchronized(lock) { !registeredRuntimes.isEmpty() }

    /** Whether a runtime that loaded [sourceURL] runs this launch's bundle. */
    private fun runsLaunchOf(sourceURL: String?): Boolean =
        synchronized(lock) {
            val launchURL = launchURL ?: return@synchronized true
            isSameBundle(sourceURL, launchURL)
        }

    private fun currentGeneration(): Long = synchronized(lock) { generation }

    /** Whether the launch of [generation] is still the one monitored. */
    fun monitorsLaunch(generation: Long): Boolean = synchronized(lock) { generation == this.generation && launchState.snapshot() != null }

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

    // The owners, the intents, the state file, and the alarm change together
    // (see the companion's watchdog operations).
    private fun startRecoveryWatchdog() {
        synchronized(recoveryLock) { startWatchdogLocked(appContext, name) }
    }

    /**
     * Keeps the watchdog relaunching the app for this instance's claimed
     * error while its claim is active: the host may prepare a replacement
     * launch before the error ends the process, which reads the marker and
     * leaves no other trace a later process could relaunch for.
     */
    private fun keepRelaunchIntentLocked() {
        addRelaunchIntentLocked(appContext, name)
    }

    /** This instance's claimed error of the launch of [ownerGeneration] did not end the process. */
    private fun leaveWatchdogAfterSurvivedError(ownerGeneration: Long?) {
        synchronized(lock) {
            removeRelaunchIntentLocked(appContext, name)
            if (ownerGeneration != generation) return
            releaseRecoveryWatchdog()
        }
    }

    // One alarm serves the process: it stops once no instance waits for content.
    private fun releaseRecoveryWatchdog() {
        synchronized(recoveryLock) { removeWatchdogOwnerLocked(appContext, name) }
    }

    /**
     * Main's recovery: a launch waiting for its first content restarts the
     * app once and leaves its marker for the restarted process.
     */
    private fun requestAutomaticRecoveryLocked(
        exception: Exception? = null,
        onSlotAsking: (() -> Unit)? = null,
    ): Boolean {
        val request = launchState.requestRecovery()
        if (exception != null) {
            Log.e(TAG, "Caught React startup exception for bundleId=${launchState.snapshot()?.bundleId}", exception)
        }
        // The same order as a named launch's charge: the slot asks for
        // rollback (even one another claim left alone), then the claim, then
        // the marker and the restart.
        charged = true
        updateNativeLaunchStateLocked()
        onSlotAsking?.invoke()
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
     * Charges this instance for the crash that ends the process, whichever
     * path decided it: its own claimed error, an inferred or unclaimed
     * JavaScript error, or an uncaught exception. A named instance never
     * restarts the app: restarting reaches main's host, so its next launch
     * rolls the bundle back instead.
     *
     * @param onSlotAsking runs once this launch's slot asks for rollback,
     * before any file is written: a claim publishes itself there
     * @param keepRelaunchIntent keeps the watchdog relaunching for a claimed
     * error, whose marker a replacement launch may read first
     */
    private fun chargeCrash(
        exception: Exception? = null,
        onSlotAsking: (() -> Unit)? = null,
        keepRelaunchIntent: Boolean = false,
    ): Boolean =
        synchronized(lock) {
            if (isMain) return@synchronized requestAutomaticRecoveryLocked(exception, onSlotAsking)
            val launch = launchState.snapshot()?.takeIf { it.shouldRollback } ?: return@synchronized false
            if (exception != null) {
                Log.e(TAG, "Caught React startup exception of $name for bundleId=${launch.bundleId}", exception)
            }
            writeRollbackMarkerLocked(launch, onSlotAsking, keepRelaunchIntent)
            false
        }

    /**
     * The one place a named launch's rollback marker is written. The process
     * may outlive it: a fatal error's handler may return, and the host start
     * this instance's runtime again, so everything that start needs to roll
     * the bundle back happens here too.
     */
    private fun writeRollbackMarkerLocked(
        launch: HotUpdaterRecoveryState.Launch,
        onSlotAsking: (() -> Unit)? = null,
        keepRelaunchIntent: Boolean = false,
    ) {
        // The native slot asks for rollback first, with no file written: a
        // signal from here on writes the marker natively.
        charged = true
        updateNativeLaunchStateLocked()
        // An instance that found every slot taken gets no marker from a
        // signal, and a launch none of whose views was shown has no
        // launchInProgress: its marker is written first, so a signal from
        // the claim on still rolls it back, after the watchdog's alarm, so a
        // signal from the marker on relaunches the app. A receiver in a
        // process that never set the alarm relaunches for any marker, with
        // or without the watchdog's state, and clears the alarm without one.
        val slotted = slots.slotOf(name) != null
        if (!slotted) {
            setWatchdogAlarmLocked(appContext)
            writeCrashMarker(launch)
        }
        // Then a claim publishes itself, still with no file written for a
        // slotted launch: a signal from here on writes only this launch's marker.
        onSlotAsking?.invoke()
        // Then the watchdog, file and alarm: a launch none of whose views was
        // shown has none yet, and the marker must relaunch the app.
        startRecoveryWatchdog()
        if (keepRelaunchIntent) keepRelaunchIntentLocked()
        // A slotted launch's marker file last, with its alarm already set.
        if (slotted) writeCrashMarker(launch)
        // The next start prepares a new launch, which reads this marker.
        chargedCallback?.invoke()
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
            // The slot stops asking before storage forgets the launch.
            updateNativeLaunchStateLocked()
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
            updateNativeLaunchStateLocked()
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
        val slot = slots.slotOf(name) ?: return
        val launch = currentLaunch()
        nativeRecovery.updateSlot(
            slot,
            crashMarkerFile.absolutePath,
            launch?.bundleId,
            launch?.unverified == true || (charged && launch?.shouldRollback == true),
            isMain,
        )
    }

    // Each architecture's source set reaches its own React instance, so the old
    // architecture's ReactNativeHost is compiled only into old architecture builds.
    private fun installJavaScriptExceptionHooks() {
        JavaScriptExceptionHooks.install(appContext)
    }

    internal class RecoveryJSExceptionHandler(
        private val previousHandler: JSExceptionHandler?,
        private val sourceURL: () -> String?,
        /** The runtime that threw, whose registered launch tells it apart from a replacement of the same bundle. */
        private val runtime: () -> Any? = { null },
    ) : JSExceptionHandler {
        override fun handleException(e: Exception) {
            val outcome = handleJavaScriptError(e, runCatching(sourceURL).getOrNull(), runCatching(runtime).getOrNull())
            if (outcome.recovered) return
            previousHandler?.handleException(e) ?: throw e
            // The handler returned, however long it took: the error did not end the process.
            handlerReturned(outcome)
        }
    }

    /** The deadline of the recovery watchdog, and the instances that armed it. */
    internal data class WatchdogState(
        val deadlineAt: Long,
        val instances: List<String>,
        /** The process that armed the watchdog, recorded beside named owners. */
        val pid: Int? = null,
        /** Named instances whose claimed error is in flight: they relaunch without a marker. */
        val relaunching: List<String> = emptyList(),
    ) {
        // Main alone writes only its deadline, as it always has. Any other set
        // of owners is listed on an `owners:` line, which may leave main out:
        // a marker main left in an earlier process is not this launch's.
        fun serialize(): String {
            val owners = instances.distinct()
            val relaunch = relaunching.distinct()
            if (owners == listOf(HotUpdaterInstanceEnvironment.MAIN_NAME) && relaunch.isEmpty()) return deadlineAt.toString()
            val pidLine = pid?.let { "\n$PID_PREFIX$it" }.orEmpty()
            val relaunchLine = if (relaunch.isEmpty()) "" else "\n$RELAUNCH_PREFIX${relaunch.joinToString(",")}"
            return "$deadlineAt\n$OWNERS_PREFIX${owners.joinToString(",")}$pidLine$relaunchLine"
        }

        /**
         * Whether the watchdog, ticking in process [currentPid], relaunches the
         * app for a marker that asks to roll back. It relaunches after the
         * process that armed it died. A named instance's marker is written
         * before its error is forwarded, and the error's handler may return:
         * a development build shows it, and an app's handler may swallow it.
         * Then the process that armed the watchdog lives on and is not
         * restarted. Main's own file has no process, and relaunches as it
         * always has.
         */
        fun relaunchesFor(
            markerRequestsRollback: Boolean,
            currentPid: Int,
        ): Boolean = (markerRequestsRollback || relaunching.isNotEmpty()) && pid != currentPid

        companion object {
            private const val OWNERS_PREFIX = "owners:"
            private const val PID_PREFIX = "pid:"
            private const val RELAUNCH_PREFIX = "relaunch:"

            private fun names(
                lines: List<String>,
                prefix: String,
            ): List<String>? =
                lines
                    .firstOrNull { it.startsWith(prefix) }
                    ?.removePrefix(prefix)
                    ?.split(',')
                    ?.map(String::trim)
                    ?.filter(String::isNotEmpty)

            fun parse(text: String?): WatchdogState? {
                val lines = text?.lines()?.map(String::trim)?.filter(String::isNotEmpty) ?: return null
                val deadlineAt = lines.firstOrNull()?.toLongOrNull() ?: return null
                val owners = names(lines, OWNERS_PREFIX)
                val pid = lines.firstOrNull { it.startsWith(PID_PREFIX) }?.removePrefix(PID_PREFIX)?.toIntOrNull()
                // A file with only a deadline is main's.
                return WatchdogState(
                    deadlineAt,
                    owners ?: listOf(HotUpdaterInstanceEnvironment.MAIN_NAME),
                    pid,
                    names(lines, RELAUNCH_PREFIX).orEmpty(),
                )
            }
        }
    }

    companion object {
        /**
         * The one lock of crash recovery's state in this process: every
         * launch's state, the live launches, claims, the native slots and
         * claim, and the watchdog's owners change under it, so no change ever
         * sees another half done. What runs under it is short: small files,
         * JNI stores, and alarm updates. View work, posts to the main thread,
         * and a gate's handed-over activity run outside it.
         */
        internal val recoveryLock = Any()

        // Whether this process ever had a named instance; until then every
        // view is main's.
        @Volatile
        private var namedInstanceCreated = false

        /** The instance whose runtime shows the root view of a root tag, and that runtime's launch; main thread. Tests stand in for the views. */
        @Volatile
        internal var rootTagOwner: (Int) -> HotUpdaterRootOwner? = { rootTag ->
            attribution.rootOf(rootTag)?.let { HotUpdaterRootOwner(it.instanceName, launchOfRuntime(it.instanceName, it.runtime)) }
        }
        internal val defaultRootTagOwner = rootTagOwner

        private const val TAG = "HotUpdaterRecovery"
        private const val CRASH_MARKER_FILENAME = "recovery-crash-marker.json"
        private const val WATCHDOG_STATE_FILENAME = "recovery-watchdog-state.txt"
        private const val WATCHDOG_ACTION = "com.hotupdater.RECOVERY_WATCHDOG"
        private const val MONITORING_GRACE_PERIOD_MS = 10_000L
        private const val WATCHDOG_TICK_INTERVAL_MS = 1_500L
        private const val JS_EXCEPTION_HOOK_RETRY_DELAY_MS = 50L

        @Volatile
        private var signalHandlerInstalled = false

        internal fun isSignalHandlerInstalled(): Boolean = signalHandlerInstalled

        /** The native signal handler's slots and claim; tests stand in for it. */
        @Volatile
        internal var nativeRecovery: HotUpdaterNativeRecovery = HotUpdaterNativeRecovery.jni

        @Volatile
        private var exceptionHandlerInstalled = false

        @Volatile
        private var contentAppearedListenerInstalled = false

        @Volatile
        private var previousExceptionHandler: Thread.UncaughtExceptionHandler? = null

        private val slots = HotUpdaterRecoverySlots()

        // Read on use, so neither class's initialization waits on the other's.
        private val attribution: HotUpdaterRecoveryAttribution
            get() = HotUpdaterRecoveryAttribution.shared

        /** The manager of each instance whose launch is monitored. */
        private val liveManagers = ConcurrentHashMap<String, HotUpdaterRecoveryManager>()

        private val signalHandlerLock = Any()
        private const val MAX_CAUSE_DEPTH = 8

        // The launches the current claim left alone, armed again if the
        // process outlives the claim.
        private var claimGeneration = 0
        private val launchGenerations = AtomicLong()

        // The instance and the launch generation of the latest claim.
        private var claimOwner: Pair<String, Long?>? = null

        // Every claim whose handler hasn't returned yet, by generation, with
        // its owner. Fatal errors of several runtimes may be in flight at
        // once: the claim stays published until the last of them ends.
        private val activeClaims = LinkedHashMap<Int, Pair<String, Long?>>()

        // The error each active claim was made for. React Native may report
        // one error twice, through a runtime's context and its host, or wrap
        // it on the way: a report of an error already claimed reuses its
        // claim, which its handler's return or its fail-safe ends.
        private val claimErrors = HashMap<Int, WeakReference<Throwable>>()

        // The hooks still forwarding each claim's error: one report may reach
        // a runtime's context and its host at once, each with a handler that
        // returns in its own time. The claim ends when the last returns.
        private val claimHolders = HashMap<Int, Int>()

        // Whether each claim's charge started main's recovery restart. A
        // repeated report of its error gets the same answer, so its hook
        // doesn't forward the error while that restart is under way.
        private val claimRecovering = HashMap<Int, Boolean>()

        // Every owner of the claims still active, which overlap when errors
        // return: each one's watchdog is left when the latest claim ends.
        private val claimedOwners = LinkedHashSet<Pair<String, Long?>>()
        private val disarmedByClaim = LinkedHashMap<HotUpdaterRecoveryManager, Long>()
        private val watchdogOwners = linkedSetOf<String>()
        private val relaunchIntents = linkedSetOf<String>()
        private var watchdogDeadlineAt = 0L

        // The application, for watchdog changes no live launch makes.
        @Volatile
        private var watchdogContext: Context? = null

        // Whether this process ever set the watchdog's alarm. A receiver in a
        // process that never did runs after the process that set it ended,
        // which may have died before its state file was written.
        private var watchdogArmedInProcess = false

        // The watchdog's state lives in this process (owners, intents), in
        // its file, and in its alarm. Every change goes through these, under
        // the recovery lock, so the three never disagree, whichever launch,
        // claim, or fail-safe makes it, and whether its launch is still live.

        private fun startWatchdogLocked(
            context: Context,
            name: String,
        ) {
            try {
                watchdogOwners += name
                watchdogDeadlineAt = System.currentTimeMillis() + MONITORING_GRACE_PERIOD_MS
                // The alarm before the file: a process that dies in between
                // leaves an alarm whose receiver reads the crash markers.
                setWatchdogAlarmLocked(context)
                persistWatchdogLocked(context)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to schedule recovery watchdog", e)
            }
        }

        private fun removeWatchdogOwnerLocked(
            context: Context,
            name: String,
        ) {
            // Another owner's watchdog is not this one's to change.
            if (!watchdogOwners.remove(name) && watchdogOwners.isNotEmpty()) return
            persistWatchdogLocked(context)
        }

        private fun addRelaunchIntentLocked(
            context: Context,
            name: String,
        ) {
            relaunchIntents += name
            // An intent is only kept with an alarm that acts on it.
            watchdogDeadlineAt = maxOf(watchdogDeadlineAt, System.currentTimeMillis() + MONITORING_GRACE_PERIOD_MS)
            setWatchdogAlarmLocked(context)
            persistWatchdogLocked(context)
        }

        private fun setWatchdogAlarmLocked(context: Context) {
            watchdogArmedInProcess = true
            scheduleRecoveryWatchdogTick(context, WATCHDOG_TICK_INTERVAL_MS)
        }

        private fun removeRelaunchIntentLocked(
            context: Context,
            name: String,
        ) {
            if (!relaunchIntents.remove(name)) return
            persistWatchdogLocked(context)
        }

        // Writes the state, or ends the watchdog once nothing is left for it.
        private fun persistWatchdogLocked(context: Context) {
            val file = watchdogFile(context)
            if (watchdogOwners.isEmpty() && relaunchIntents.isEmpty()) {
                file.delete()
                cancelRecoveryWatchdogAlarm(context)
                return
            }
            try {
                writeWatchdogState(
                    file,
                    WatchdogState(watchdogDeadlineAt, watchdogOwners.toList(), Process.myPid(), relaunchIntents.toList()),
                )
            } catch (e: Exception) {
                Log.e(TAG, "Failed to update recovery watchdog", e)
            }
        }

        private fun watchdogFile(context: Context): File = File(getBundleStoreDir(context), WATCHDOG_STATE_FILENAME)

        // Whole or not at all: a process that dies while writing leaves the
        // previous state, or none, never a part that reads as main's alone.
        private fun writeWatchdogState(
            file: File,
            state: WatchdogState,
        ) {
            file.parentFile?.mkdirs()
            val partial = File(file.parentFile, "${file.name}.tmp")
            partial.writeText(state.serialize())
            if (!partial.renameTo(file)) {
                partial.delete()
                throw IOException("Failed to replace ${file.name}")
            }
        }

        private val patchedReactContexts = WeakIdentitySet<ReactContext>()

        private val contentAppearedListener =
            ReactMarker.MarkerListener { marker, _, rootTag ->
                if (marker == ReactMarkerConstants.CONTENT_APPEARED) {
                    handleContentAppeared(rootTag)
                }
            }

        // The flag is set only once the listener is registered, under one lock,
        // so no launch can go on to render before the listener can hear it.
        private fun ensureContentAppearedListenerInstalled() {
            if (contentAppearedListenerInstalled) return
            synchronized(this) {
                if (contentAppearedListenerInstalled) return
                ReactMarker.addListener(contentAppearedListener)
                contentAppearedListenerInstalled = true
            }
        }

        // React Native names the view by its root tag. A view no known activity
        // shows is credited to main, as every view always was.
        //
        // A view no known activity shows yet may be a named runtime's: one that
        // rendered before its module registered, or before its root view was
        // attached to an activity. While a named launch waits for its first
        // content, the content is held (HotUpdaterHeldContent) instead.
        internal fun handleContentAppeared(rootTag: Int) {
            // An app with only main: every view is main's, as it always was.
            if (!namedInstanceCreated) {
                contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME)
                return
            }
            // The launches when the content appeared: a launch that starts
            // while the view is looked up is not the one that showed it.
            val generations = launchGenerations()
            // A named runtime may outlive its launch's monitoring and render
            // again: its content is its own, never main's, monitored or not.
            // Finding the view walks views and UI managers: outside the lock.
            val owner = rootTagOwner(rootTag)
            synchronized(recoveryLock) {
                if (owner != null) {
                    contentAppeared(owner.instanceName, owner.boundTo(generations))
                    return
                }
                val waitingNamedLaunch = liveManagers.values.any { !it.isMain && it.awaitsFirstContent() }
                if (!waitingNamedLaunch) {
                    contentAppeared(HotUpdaterInstanceEnvironment.MAIN_NAME, generations)
                    return
                }
                heldContent.hold(rootTag, generations)
            }
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
                resolve = { rootTag -> rootTagOwner(rootTag) },
                credit = { instanceName, generation -> liveManagers[instanceName]?.handleContentAppeared(generation) },
            )

        /** First content of [instanceName]'s runtime appeared: it verifies only that instance's launch. */
        internal fun contentAppeared(instanceName: String) {
            liveManagers[instanceName]?.handleContentAppeared()
        }

        /** Content of [instanceName] verifies only its launch in [generations], when the content appeared. */
        private fun contentAppeared(
            instanceName: String,
            generations: Map<String, Long>,
        ) {
            val generation = generations[instanceName] ?: return
            liveManagers[instanceName]?.handleContentAppeared(generation)
        }

        // The launch each runtime registered for, by the runtime: a host may
        // start a replacement launch of the same bundle while its previous
        // runtime still renders, and that runtime's content is its own
        // launch's, not the replacement's. Kept after the runtime is torn
        // down, whose content may still arrive; weak, so it goes with it.
        private val runtimeLaunches = WeakHashMap<Any, Pair<String, Long>>()

        /** The launch of [instanceName] [runtime] registered for, or null when it didn't register for one. */
        internal fun launchOfRuntime(
            instanceName: String,
            runtime: Any?,
        ): Long? {
            runtime ?: return null
            return synchronized(recoveryLock) { runtimeLaunches[runtime]?.takeIf { it.first == instanceName }?.second }
        }

        /**
         * Whether [runtime] registered for [instanceName]'s current launch;
         * null when it registered for no launch of it, which its URL decides.
         */
        internal fun runtimeRunsCurrentLaunch(
            instanceName: String,
            runtime: Any?,
        ): Boolean? {
            runtime ?: return null
            return synchronized(recoveryLock) {
                val (name, launch) = runtimeLaunches[runtime] ?: return@synchronized null
                if (name != instanceName) return@synchronized null
                val manager = liveManagers[instanceName] ?: return@synchronized null
                manager.currentGeneration() == launch
            }
        }

        /** Each live instance's launch generation now. */
        private fun launchGenerations(): Map<String, Long> =
            synchronized(recoveryLock) { liveManagers.values.associate { it.name to it.currentGeneration() } }

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
         * The crash a claimed error ends in is that claim's, by the error
         * itself. A JavaScript error is otherwise its own runtime's, by its
         * stack, even while another runtime's claim is active; only then does
         * the active claim take it. With no claim, an unclaimed one may be
         * inferred to be one named launch's
         * ([HotUpdaterRecoverySlots.inferJavaScriptErrorOwner]).
         */
        internal fun chargeUncaughtException(throwable: Throwable): Boolean =
            synchronized(recoveryLock) {
                activeClaimOf(throwable)?.let { claimed ->
                    return@synchronized handleUncaughtCrash(claim = activeClaims[claimed])
                }
                val claim = activeClaimLocked()
                val isJavaScript = isJavaScriptError(throwable)
                val owner =
                    when {
                        !isJavaScript -> null

                        claim == null -> javaScriptErrorOwner(throwable)

                        // During another claim, a stack of main's own bundle is
                        // main's distinct error, not the claim's.
                        else -> attribution.instanceOfStack(javaScriptStacks(throwable))
                    }
                if (owner != null) {
                    claimJavaScriptError(throwable as? Exception, owner).recovered
                } else {
                    handleUncaughtCrash(claim = claim)
                }
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
            claim: Pair<String, Long?>? = activeClaim(),
        ): Boolean =
            synchronized(recoveryLock) {
                // A claim belongs to the launch that threw, not to a newer launch
                // of its instance that started while the claim was active.
                val attributedName = claim?.first
                val targets =
                    HotUpdaterRecoverySlots.markerTargets(liveLaunches(), attributedName).filter { target ->
                        target.name != attributedName || liveManagers[target.name]?.currentGeneration() == claim?.second
                    }
                // Named instances first: main's recovery restart ends the process.
                targets.filterNot { it.isMain }.forEach { liveManagers[it.name]?.chargeCrash(exception) }
                if (targets.none { it.isMain }) return@synchronized false
                liveManagers[HotUpdaterInstanceEnvironment.MAIN_NAME]?.chargeCrash(exception) == true
            }

        /**
         * Hands a JavaScript error of the runtime that loaded [sourceURL] to
         * crash recovery; false when it does not recover it.
         */
        internal fun handleJavaScriptExceptionForRecovery(
            exception: Exception,
            sourceURL: String?,
        ): Boolean = handleJavaScriptError(exception, sourceURL).recovered

        /**
         * [handleJavaScriptExceptionForRecovery], with the claim it made.
         * A hook that forwards the error and sees its handler return calls
         * [handlerReturned] with it.
         */
        internal fun handleJavaScriptError(
            exception: Exception,
            sourceURL: String?,
            runtime: Any? = null,
        ): JavaScriptErrorOutcome {
            // The launches when the error was thrown: one that starts while
            // the runtime's instance is resolved is not the one that threw.
            val generations = launchGenerations()
            val instanceName = attribution.instanceOf(sourceURL)
            return synchronized(recoveryLock) { handleJavaScriptExceptionLocked(exception, instanceName, sourceURL, runtime, generations) }
        }

        private fun handleJavaScriptExceptionLocked(
            exception: Exception,
            instanceName: String?,
            sourceURL: String?,
            runtime: Any?,
            generations: Map<String, Long>,
        ): JavaScriptErrorOutcome {
            val manager = instanceName?.let { liveManagers[it] }
            if (instanceName != null &&
                instanceName != HotUpdaterInstanceEnvironment.MAIN_NAME &&
                manager != null &&
                (
                    manager.currentGeneration() != generations[instanceName] ||
                        // The launch the runtime registered for, when it did; else its bundle's URL.
                        !(runtimeRunsCurrentLaunch(instanceName, runtime) ?: manager.runsLaunchOf(sourceURL))
                )
            ) {
                // A runtime of an earlier launch of the instance, whose context
                // still reports errors: the crash it may end in is its own, so
                // it charges no launch of this process.
                Log.w(TAG, "JavaScript error of an earlier launch's runtime of $instanceName", exception)
                return claimJavaScriptError(exception, "$instanceName$EARLIER_LAUNCH_SUFFIX")
            }
            if (instanceName == null) return handleClaimableJavaScriptException(exception, null)
            return claimJavaScriptError(exception, instanceName, generations[instanceName])
        }

        // Instance names have no "@", so no launch is ever this claim's.
        private const val EARLIER_LAUNCH_SUFFIX = "@earlier-launch"

        /**
         * Whether a runtime that loaded [sourceURL] runs [instanceName]'s
         * current launch; true while no launch of it is monitored.
         */
        internal fun runsCurrentLaunch(
            instanceName: String,
            sourceURL: String?,
        ): Boolean = liveManagers[instanceName]?.runsLaunchOf(sourceURL) ?: true

        /**
         * A JavaScript error of [instanceName]'s runtime, or of an unknown one
         * when null, which counts as a native crash does. A claimed error
         * charges only its instance, and the crash it may end in charges no
         * other instance: their launches did not fail.
         */
        internal fun handleJavaScriptException(
            exception: Exception,
            instanceName: String?,
        ): Boolean = synchronized(recoveryLock) { handleClaimableJavaScriptException(exception, instanceName).recovered }

        private fun handleClaimableJavaScriptException(
            exception: Exception,
            instanceName: String?,
        ): JavaScriptErrorOutcome {
            // An error no runtime claims is not the continuation of a claimed
            // one: it is the one named launch whose runtime never reached
            // HotUpdater, or it charges every launch it can be blamed on.
            if (instanceName == null) {
                val owner =
                    javaScriptErrorOwner(exception)
                        ?: return JavaScriptErrorOutcome(handleUncaughtCrash(exception, claim = null))
                return claimJavaScriptError(exception, owner)
            }
            return claimJavaScriptError(exception, instanceName)
        }

        /**
         * The handler a hook forwarded a JavaScript error to returned: the
         * error did not end the process, so its claim ends now. Only the
         * handler's return ends it; a handler that takes long, then ends the
         * process, keeps it for that crash.
         */
        internal fun handlerReturned(outcome: JavaScriptErrorOutcome) {
            val claim = outcome.claim ?: return
            synchronized(recoveryLock) {
                val holders = (claimHolders[claim] ?: return) - 1
                if (holders > 0) {
                    claimHolders[claim] = holders
                    return
                }
                releaseClaim(claim)
            }
        }

        /**
         * @param eventGeneration the generation of [instanceName]'s launch
         * when the error was thrown; its current one when the error is handled
         * where it was thrown
         */
        private fun claimJavaScriptError(
            exception: Exception?,
            instanceName: String,
            eventGeneration: Long? = liveManagers[instanceName]?.currentGeneration(),
        ): JavaScriptErrorOutcome =
            synchronized(recoveryLock) {
                exception?.let(::activeClaimOf)?.let { claimed ->
                    claimHolders[claimed] = (claimHolders[claimed] ?: 0) + 1
                    return@synchronized JavaScriptErrorOutcome(claimRecovering[claimed] == true, claimed)
                }
                // The claim's generation, its attribution in both claims, its
                // owner, and the launches it leaves alone change at once: no
                // launch starts, and no release runs, in between. Only the
                // launch that threw is the owner.
                val owner = liveManagers[instanceName]?.takeIf { it.currentGeneration() == eventGeneration }
                val ownerGeneration = eventGeneration
                claimGeneration += 1
                val generation = claimGeneration
                // The claim holds until this release runs. It takes the
                // recovery lock, so it never runs before this section ends,
                // and its window starts with the claim.
                scheduleClaimRelease(generation)
                slots.attribute(instanceName)
                claimOwner = instanceName to ownerGeneration
                claimedOwners += instanceName to ownerGeneration
                activeClaims[generation] = instanceName to ownerGeneration
                exception?.let { claimErrors[generation] = WeakReference(it) }
                claimHolders[generation] = 1
                // For main and named owners alike: the owner's native slot asks
                // for rollback, then the native claim, both with no file
                // written; then the watchdog and relaunch intent (file and
                // alarm), the marker file, and main's recovery restart. A
                // signal before the claim finds no slot of the owner's charge
                // yet changed but its own, and after it writes only the
                // owner's marker. A claim no launch owns, such as an earlier
                // launch's runtime's, leaves the native handler unclaimed: a
                // signal then writes every marker that may still be needed.
                var published = false
                val publishClaim = {
                    if (!published && owner != null) nativeRecovery.attributeCrash(slots.assignedSlot(instanceName) ?: -1)
                    published = true
                }
                val recovering = owner?.chargeCrash(exception, onSlotAsking = publishClaim, keepRelaunchIntent = true) == true
                // Main's own recovery, or an owner with no launch to charge.
                publishClaim()
                // Claims overlap when errors return: every launch any of them
                // left alone waits for the last one, including that claim's own
                // instance, which an earlier claim may have left alone.
                liveManagers.values
                    .filter { it.name != instanceName }
                    .forEach { manager -> manager.handleCrashOfAnotherInstance()?.let { disarmedByClaim[manager] = it } }
                claimRecovering[generation] = recovering
                JavaScriptErrorOutcome(recovering, generation)
            }

        /**
         * Adds the launch of [generation] of [manager] to the claim still
         * active; true when it joined.
         * Checked under the claim's lock, which the claim takes after it set
         * itself, so a launch that started after the claim left the live
         * launches alone joins it here.
         */
        private fun joinActiveClaim(
            manager: HotUpdaterRecoveryManager,
            generation: Long,
        ): Boolean {
            synchronized(recoveryLock) {
                // Every launch that starts during a claim joins it, a newer
                // launch of the claim's own instance too: only the launch
                // that threw is the claim's. It counts again when the last
                // active claim ends.
                activeClaimLocked() ?: return false
                disarmedByClaim[manager] = generation
                return true
            }
        }

        /**
         * Ends the claim of [generation] (every active claim when null): its
         * error did not end the process. While another claim is active, that
         * one is published instead. When the last ends, the launches left
         * alone count again if they still wait for their first content.
         */
        internal fun releaseClaim(generation: Int? = null) {
            synchronized(recoveryLock) {
                if (generation == null) {
                    activeClaims.clear()
                    claimErrors.clear()
                    claimHolders.clear()
                    claimRecovering.clear()
                } else if (activeClaims.remove(generation) == null) {
                    return
                } else {
                    claimErrors.remove(generation)
                    claimHolders.remove(generation)
                    claimRecovering.remove(generation)
                }
                // Another fatal error is still in flight: the claim stays,
                // now its, with its marker and slot already in place.
                activeClaims.values.lastOrNull()?.let { (name, ownerGeneration) ->
                    slots.attribute(name)
                    claimOwner = name to ownerGeneration
                    val owner = liveManagers[name]?.takeIf { it.currentGeneration() == ownerGeneration }
                    if (owner != null) {
                        nativeRecovery.attributeCrash(slots.assignedSlot(name) ?: -1)
                    } else {
                        nativeRecovery.clearCrashAttribution()
                    }
                    return
                }
                val survivedOwners = claimedOwners.toList()
                claimedOwners.clear()
                // The claim ends here, in Kotlin and natively at once: a
                // crash from now on charges the launches it can be blamed on.
                slots.clearAttribution()
                claimOwner = null
                nativeRecovery.clearCrashAttribution()
                val disarmed = disarmedByClaim.toList()
                disarmedByClaim.clear()
                // Each instance whose error was survived keeps its marker for its
                // next launch, but the process lives on: if it ends for another
                // reason, the watchdog must not relaunch the app for that marker.
                // A launch whose generation moved on is no longer the one that threw.
                survivedOwners.forEach { (name, ownerGeneration) ->
                    if (name != HotUpdaterInstanceEnvironment.MAIN_NAME) {
                        val manager = liveManagers[name]
                        if (manager != null) {
                            manager.leaveWatchdogAfterSurvivedError(ownerGeneration)
                        } else {
                            watchdogContext?.let { removeRelaunchIntentLocked(it, name) }
                        }
                    }
                }
                disarmed.forEach { (manager, launch) -> manager.resumeAfterAnotherInstanceSurvived(launch) }
            }
        }

        /** The active claim made for [error], or for an error it wraps or that wraps it. */
        private fun activeClaimOf(error: Throwable): Int? {
            val chain = causes(error)
            return claimErrors.entries
                .firstOrNull { (generation, claimed) ->
                    generation in activeClaims &&
                        claimed.get()?.let { claimedError -> causes(claimedError).any { cause -> chain.any { it === cause } } } == true
                }?.key
        }

        private fun causes(error: Throwable): List<Throwable> {
            val chain = ArrayList<Throwable>()
            var current: Throwable? = error
            while (current != null && chain.size < MAX_CAUSE_DEPTH && chain.none { it === current }) {
                chain += current
                current = current.cause
            }
            return chain
        }

        /** The active claim: its instance and the generation of the launch that threw. */
        private fun activeClaim(): Pair<String, Long?>? = synchronized(recoveryLock) { activeClaimLocked() }

        private fun activeClaimLocked(): Pair<String, Long?>? {
            val name = slots.attributedName() ?: return null
            return name to claimOwner?.takeIf { it.first == name }?.second
        }

        /**
         * Runs [releaseClaim] for the claim of [generation] once its window
         * ends, on a thread of its own, so it runs even while the main thread
         * is blocked: a development build shows the error, and an app's
         * handler may swallow it, and then the process lived on.
         */
        private fun scheduleClaimRelease(generation: Int) {
            claimReleaseScheduler(HotUpdaterRecoverySlots.CLAIM_FAIL_SAFE_MS, Runnable { releaseClaim(generation) })
        }

        private val claimReleaseExecutor by lazy {
            Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "HotUpdaterRecoveryClaims").apply { isDaemon = true } }
        }

        /** Schedules a claim's release after a delay; tests run it by hand. */
        internal val defaultClaimReleaseScheduler: (Long, Runnable) -> Unit = { delayMs, task ->
            claimReleaseExecutor.schedule(task, delayMs, TimeUnit.MILLISECONDS)
        }

        @Volatile
        internal var claimReleaseScheduler: (Long, Runnable) -> Unit = defaultClaimReleaseScheduler

        /**
         * Hooks the JavaScript errors of a named instance's runtime when its
         * HotUpdater module is created, since the app exposes only main's
         * host, and follows its activity for its views. Main's runtime is
         * left alone: main hooks its host only while it monitors a launch, as
         * it always has. Every runtime's root views, main's too, are found
         * through its UI managers: main may show a view in a dialog, outside
         * any activity's decor view, while a named launch waits for its
         * content. That is a weak reference, which an app with only main
         * never reads.
         */
        internal fun registerRuntime(reactContext: ReactContext): String? {
            attribution.registerRuntime(reactContext)
            val instanceName = attribution.instanceOf(runCatching { reactContext.sourceURL }.getOrNull())
            if (instanceName == null || !registersRuntime(instanceName)) {
                // Content main's runtime showed before can be told now.
                if (namedInstanceCreated) heldContent.runtimeRegistered()
                return null
            }
            try {
                JavaScriptExceptionHooks.installForRuntime(reactContext)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to hook the runtime's JavaScript errors", e)
            }
            registerRuntime(
                instanceName,
                reactContext,
                runCatching { reactContext.sourceURL }.getOrNull(),
                reactContext.currentActivity,
            )
            return instanceName
        }

        /**
         * Records that [instanceName]'s [runtime], which loaded
         * [sourceURL], hooks its errors, and shows its launch gate the
         * runtime's [activity]: the module is created while the bundle loads,
         * before its first content, and the activity may have started before
         * anything followed activities. A runtime of an earlier launch, whose
         * module may be created after the next launch started, counts for
         * nothing.
         */
        internal fun registerRuntime(
            instanceName: String,
            runtime: Any,
            sourceURL: String?,
            activity: Activity?,
        ): Boolean {
            val registered = liveManagers[instanceName]?.registerRuntime(runtime, sourceURL, activity) == true
            // Content its runtime showed before can be told now.
            if (registered) heldContent.runtimeRegistered()
            return registered
        }

        /**
         * [reactContext] was torn down, as in a reload: its root views are no
         * longer looked for, and the runtime of [instanceName], the named
         * instance it was registered for, counts for its launch no more.
         */
        internal fun unregisterRuntime(
            reactContext: ReactContext,
            instanceName: String?,
        ) {
            attribution.unregisterRuntime(reactContext)
            instanceName?.let { unregisterRuntime(it, reactContext) }
        }

        /** [instanceName]'s [runtime] was torn down, as in a reload. */
        internal fun unregisterRuntime(
            instanceName: String,
            runtime: Any,
        ) {
            liveManagers[instanceName]?.unregisterRuntime(runtime)
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
            if (!patchedReactContexts.add(reactContext)) return

            val previousHandler = reactContext.jsExceptionHandler
            if (previousHandler is RecoveryJSExceptionHandler) {
                return
            }

            reactContext.setJSExceptionHandler(RecoveryJSExceptionHandler(previousHandler, { reactContext.sourceURL }, { reactContext }))
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
            synchronized(recoveryLock) { handleRecoveryWatchdogLocked(context) }
        }

        private fun handleRecoveryWatchdogLocked(context: Context) {
            val appContext = context.applicationContext
            val watchdogStateFile = File(getBundleStoreDir(appContext), WATCHDOG_STATE_FILENAME)
            val state = WatchdogState.parse(watchdogStateFile.takeIf(File::exists)?.readText())
            // A process that never set the alarm runs after the process that
            // set it ended, which may have died before writing its state or
            // before rewriting it for a new owner: the file's owners may lag.
            // Any marker asking to roll back is then that process's, as one
            // left earlier was consumed or relaunched for then. A marker,
            // never a launch merely pending, so a relaunched process that
            // dies again relaunches no further.
            val relaunchesAfterArmingProcess = !watchdogArmedInProcess && anyCrashMarkerRequestsRollback(appContext.filesDir)
            if (state == null) {
                cancelRecoveryWatchdogAlarm(appContext)
                watchdogStateFile.delete()
                if (relaunchesAfterArmingProcess) {
                    Log.i(TAG, "Recovery watchdog detected crash marker without its state, relaunching app")
                    launchRecoveryRestart(appContext)
                }
                return
            }

            if (relaunchesAfterArmingProcess ||
                state.relaunchesFor(crashMarkerRequestsRollback(appContext.filesDir, state.instances), Process.myPid())
            ) {
                Log.i(TAG, "Recovery watchdog detected crash marker, relaunching app")
                watchdogStateFile.delete()
                cancelRecoveryWatchdogAlarm(appContext)
                launchRecoveryRestart(appContext)
                return
            }

            val now = System.currentTimeMillis()
            if (now >= state.deadlineAt) {
                // A claimed error's handler in this process may run long, then
                // end it: the watchdog stays until the claim ends, which drops
                // its relaunch intent (or the process does).
                if (state.relaunching.isNotEmpty() && state.pid == Process.myPid()) {
                    watchdogDeadlineAt = now + MONITORING_GRACE_PERIOD_MS
                    scheduleRecoveryWatchdogTick(appContext, WATCHDOG_TICK_INTERVAL_MS)
                    writeWatchdogState(watchdogStateFile, state.copy(deadlineAt = watchdogDeadlineAt))
                    return
                }
                // The watchdog ends here, in this process's state too: a
                // later owner starts a new one rather than reviving these.
                watchdogOwners.clear()
                relaunchIntents.clear()
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

        /** Whether the crash marker of main or of any named instance on disk asks to roll a launch back. */
        internal fun anyCrashMarkerRequestsRollback(filesDir: File?): Boolean {
            val named =
                filesDir
                    ?.let { File(it, HotUpdaterInstanceEnvironment.INSTANCES_DIRECTORY).listFiles() }
                    ?.filter(File::isDirectory)
                    ?.map(File::getName)
                    .orEmpty()
            return crashMarkerRequestsRollback(filesDir, listOf(HotUpdaterInstanceEnvironment.MAIN_NAME) + named)
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
        ) = watchdogAlarm(context, delayMs)

        /** Sets the watchdog's alarm; tests stand in for AlarmManager. */
        @Volatile
        internal var watchdogAlarm: (Context, Long) -> Unit = ::setRecoveryWatchdogAlarm
        internal val defaultWatchdogAlarm = watchdogAlarm

        private fun setRecoveryWatchdogAlarm(
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

/**
 * What crash recovery did with a JavaScript error: whether main's recovery
 * restart took over, and the claim it made, which ends when the error's
 * handler returns.
 */
internal data class JavaScriptErrorOutcome(
    val recovered: Boolean,
    val claim: Int? = null,
)

/** What crash recovery tells the native signal handler (HotUpdaterRecovery.cpp). */
internal interface HotUpdaterNativeRecovery {
    fun updateSlot(
        slot: Int,
        crashMarkerPath: String,
        bundleId: String?,
        shouldRollback: Boolean,
        writesWhenVerified: Boolean,
    )

    /** [slot] is -1 for an instance that has none. */
    fun attributeCrash(slot: Int)

    fun clearCrashAttribution()

    companion object {
        /** The signal handler, once installed. */
        val jni: HotUpdaterNativeRecovery =
            object : HotUpdaterNativeRecovery {
                override fun updateSlot(
                    slot: Int,
                    crashMarkerPath: String,
                    bundleId: String?,
                    shouldRollback: Boolean,
                    writesWhenVerified: Boolean,
                ) = call { HotUpdaterRecoveryNative.nativeUpdateSlot(slot, crashMarkerPath, bundleId, shouldRollback, writesWhenVerified) }

                override fun attributeCrash(slot: Int) = call { HotUpdaterRecoveryNative.nativeAttributeCrash(slot) }

                override fun clearCrashAttribution() = call { HotUpdaterRecoveryNative.nativeClearCrashAttribution() }

                private fun call(native: () -> Unit) {
                    if (!HotUpdaterRecoveryManager.isSignalHandlerInstalled()) return
                    try {
                        native()
                    } catch (e: UnsatisfiedLinkError) {
                        Log.w("HotUpdaterRecovery", "Native crash recovery is not available", e)
                    }
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

    /** Ends the claim [nativeAttributeCrash] made. */
    @JvmStatic
    external fun nativeClearCrashAttribution()
}

/**
 * The instance whose runtime shows a root view, and the launch that runtime
 * registered for, or null for a runtime that didn't register for one, such
 * as main's: its content counts for the instance's launch when it appeared.
 */
internal data class HotUpdaterRootOwner(
    val instanceName: String,
    val launchGeneration: Long? = null,
) {
    /** The launches [generations] had when the content appeared, with this view's runtime's own. */
    fun boundTo(generations: Map<String, Long>): Map<String, Long> =
        launchGeneration?.let { generations + (instanceName to it) } ?: generations
}
