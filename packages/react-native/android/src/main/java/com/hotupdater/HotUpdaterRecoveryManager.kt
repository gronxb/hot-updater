package com.hotupdater

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSExceptionHandler
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactMarker
import com.facebook.react.bridge.ReactMarkerConstants
import org.json.JSONObject
import java.io.File
import java.lang.reflect.Field
import kotlin.system.exitProcess

internal class HotUpdaterRecoveryManager(
    context: Context,
) {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val bundleStoreDir = getBundleStoreDir(appContext)
    private val crashMarkerFile = File(bundleStoreDir, CRASH_MARKER_FILENAME)
    private val watchdogStateFile = File(bundleStoreDir, WATCHDOG_STATE_FILENAME)

    private var currentBundleId: String? = null
    private var shouldRollbackOnCrash = false
    private var isMonitoring = false
    private var recoveryRequested = false
    private var contentAppearedCallback: ((String?) -> Unit)? = null
    private var recoveryRestartCallback: (() -> Boolean)? = null

    private val stopMonitoringRunnable =
        Runnable {
            if (isMonitoring) {
                contentAppearedCallback?.invoke(currentBundleId)
                shouldRollbackOnCrash = false
                updateNativeLaunchState(currentBundleId, false)
            }
            cancelRecoveryWatchdog()
            Log.d(TAG, "Stopping crash monitoring for current launch")
            isMonitoring = false
            recoveryRequested = false
            shouldRollbackOnCrash = false
            currentBundleId = null
            contentAppearedCallback = null
            recoveryRestartCallback = null
            activeManager = null
            updateNativeLaunchState(null, false)
        }

    private val installJsExceptionHooksRunnable =
        object : Runnable {
            override fun run() {
                if (!isMonitoring) {
                    return
                }

                installJavaScriptExceptionHooks()
                mainHandler.postDelayed(this, JS_EXCEPTION_HOOK_RETRY_DELAY_MS)
            }
        }

    private val contentAppearedListener =
        ReactMarker.MarkerListener { name, _, _ ->
            if (name == ReactMarkerConstants.CONTENT_APPEARED) {
                handleContentAppeared()
            }
        }

    fun consumePendingCrashRecovery(): PendingCrashRecovery? {
        if (!crashMarkerFile.exists()) {
            return null
        }

        return try {
            val recovery = PendingCrashRecovery.fromJson(JSONObject(crashMarkerFile.readText()))
            Log.d(
                TAG,
                "Consumed pending crash marker bundleId=${recovery.launchedBundleId} shouldRollback=${recovery.shouldRollback}",
            )
            recovery
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read crash marker", e)
            null
        } finally {
            crashMarkerFile.delete()
        }
    }

    fun startMonitoring(
        bundleId: String?,
        shouldRollback: Boolean,
        onContentAppeared: (String?) -> Unit,
        onRecoveryRestartRequested: () -> Boolean,
    ) {
        crashMarkerFile.parentFile?.mkdirs()
        contentAppearedCallback = onContentAppeared
        currentBundleId = bundleId
        shouldRollbackOnCrash = shouldRollback
        isMonitoring = true
        recoveryRequested = false
        recoveryRestartCallback = onRecoveryRestartRequested
        activeManager = this

        ensureExceptionHandlerInstalled()
        ensureNativeSignalHandlerInstalled()

        mainHandler.removeCallbacks(installJsExceptionHooksRunnable)
        mainHandler.removeCallbacks(stopMonitoringRunnable)
        ReactMarker.removeListener(contentAppearedListener)
        ReactMarker.addListener(contentAppearedListener)
        updateNativeLaunchState(bundleId, shouldRollback)
        if (shouldRollback) {
            startRecoveryWatchdog()
        } else {
            cancelRecoveryWatchdog()
        }
        mainHandler.post(installJsExceptionHooksRunnable)

        Log.d(TAG, "Started crash monitoring bundleId=$bundleId shouldRollback=$shouldRollback")
    }

    private fun handleContentAppeared() {
        if (!isMonitoring) {
            return
        }

        Log.d(TAG, "First content appeared for bundleId=$currentBundleId")
        ReactMarker.removeListener(contentAppearedListener)
        mainHandler.removeCallbacks(installJsExceptionHooksRunnable)
        mainHandler.removeCallbacks(stopMonitoringRunnable)
        mainHandler.postDelayed(stopMonitoringRunnable, MONITORING_GRACE_PERIOD_MS)
    }

    private fun ensureExceptionHandlerInstalled() {
        if (exceptionHandlerInstalled) {
            return
        }

        previousExceptionHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            val manager = activeManager
            manager?.writeCrashMarker()

            if (manager?.requestAutomaticRecovery() == true) {
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }

            previousExceptionHandler?.uncaughtException(thread, throwable)
                ?: run {
                    Process.killProcess(Process.myPid())
                    exitProcess(10)
                }
        }
        exceptionHandlerInstalled = true
    }

    private fun writeCrashMarker() {
        if (!isMonitoring) {
            return
        }

        try {
            val payload =
                JSONObject().apply {
                    put("bundleId", currentBundleId ?: JSONObject.NULL)
                    put("shouldRollback", shouldRollbackOnCrash)
                }
            crashMarkerFile.parentFile?.mkdirs()
            crashMarkerFile.writeText(payload.toString())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write crash marker", e)
        }
    }

    private fun startRecoveryWatchdog() {
        try {
            watchdogStateFile.parentFile?.mkdirs()
            watchdogStateFile.writeText((System.currentTimeMillis() + MONITORING_GRACE_PERIOD_MS).toString())
            scheduleRecoveryWatchdogTick(appContext, WATCHDOG_TICK_INTERVAL_MS)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule recovery watchdog", e)
        }
    }

    private fun cancelRecoveryWatchdog() {
        watchdogStateFile.delete()
        cancelRecoveryWatchdogAlarm(appContext)
    }

    private fun requestAutomaticRecovery(): Boolean {
        if (!isMonitoring || !shouldRollbackOnCrash) {
            return false
        }

        synchronized(this) {
            if (recoveryRequested) {
                return true
            }
            recoveryRequested = true
        }

        val started = recoveryRestartCallback?.invoke() == true
        if (!started) {
            synchronized(this) {
                recoveryRequested = false
            }
            Log.w(TAG, "Failed to schedule automatic recovery restart")
        } else {
            Log.i(TAG, "Scheduled automatic recovery restart for bundleId=$currentBundleId")
        }
        return started
    }

    private fun handleJavaScriptException(exception: Exception): Boolean {
        Log.e(TAG, "Caught React startup exception for bundleId=$currentBundleId", exception)
        writeCrashMarker()
        return requestAutomaticRecovery()
    }

    private fun ensureNativeSignalHandlerInstalled() {
        if (signalHandlerInstalled || !loadNativeLibrary()) {
            return
        }

        try {
            nativeInstallSignalHandler(crashMarkerFile.absolutePath)
            signalHandlerInstalled = true
        } catch (e: UnsatisfiedLinkError) {
            Log.w(TAG, "Signal handler not available", e)
        }
    }

    private fun updateNativeLaunchState(
        bundleId: String?,
        shouldRollback: Boolean,
    ) {
        if (!signalHandlerInstalled || !nativeLibraryLoaded) {
            return
        }

        try {
            nativeUpdateLaunchState(bundleId, shouldRollback)
        } catch (e: UnsatisfiedLinkError) {
            Log.w(TAG, "Failed to update native launch state", e)
        }
    }

    private fun installJavaScriptExceptionHooks() {
        val application = appContext as? ReactApplication ?: return

        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            installReactHostExceptionHook(application)
        } else {
            installLegacyExceptionHook(application)
        }
    }

    private fun installReactHostExceptionHook(application: ReactApplication) {
        val reactHost = getReactHost(application) ?: return
        val reactHostDelegate =
            findField(reactHost.javaClass, "mReactHostDelegate")?.let { field ->
                field.isAccessible = true
                field.get(reactHost)
            }
                ?: findField(reactHost.javaClass, "reactHostDelegate")?.let { field ->
                    field.isAccessible = true
                    field.get(reactHost)
                }
                ?: return

        val delegateIdentity = System.identityHashCode(reactHostDelegate)
        if (patchedReactHostDelegateIds.add(delegateIdentity)) {
            val exceptionHandlerField = findField(reactHostDelegate.javaClass, "exceptionHandler")
            if (exceptionHandlerField == null) {
                patchedReactHostDelegateIds.remove(delegateIdentity)
                return
            }

            exceptionHandlerField.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val previousHandler =
                exceptionHandlerField.get(reactHostDelegate) as? (Exception) -> Unit

            exceptionHandlerField.set(reactHostDelegate) { exception: Exception ->
                if (activeManager?.handleJavaScriptException(exception) != true) {
                    previousHandler?.invoke(exception) ?: throw exception
                }
            }
        }

        val reactContext =
            findMethod(reactHost.javaClass, "getCurrentReactContext")?.invoke(reactHost) as? ReactContext
        reactContext?.let { patchReactContextExceptionHandler(it) }
    }

    private fun installLegacyExceptionHook(application: ReactApplication) {
        val instanceManager = application.reactNativeHost.reactInstanceManager
        val managerIdentity = System.identityHashCode(instanceManager)
        if (patchedInstanceManagerIds.add(managerIdentity)) {
            val exceptionHandlerField = findField(instanceManager.javaClass, "mJSExceptionHandler")
            if (exceptionHandlerField == null) {
                patchedInstanceManagerIds.remove(managerIdentity)
                return
            }

            exceptionHandlerField.isAccessible = true
            val previousHandler = exceptionHandlerField.get(instanceManager) as? JSExceptionHandler
            exceptionHandlerField.set(instanceManager, RecoveryJSExceptionHandler(previousHandler))
        }

        instanceManager.currentReactContext?.let { reactContext ->
            patchReactContextExceptionHandler(reactContext)
            patchCatalystInstanceExceptionHandler(reactContext)
        }
    }

    private fun patchReactContextExceptionHandler(reactContext: ReactContext) {
        val contextIdentity = System.identityHashCode(reactContext)
        if (!patchedReactContextIds.add(contextIdentity)) {
            return
        }

        val previousHandler = reactContext.jsExceptionHandler
        if (previousHandler is RecoveryJSExceptionHandler) {
            return
        }

        reactContext.setJSExceptionHandler(RecoveryJSExceptionHandler(previousHandler))
    }

    private fun patchCatalystInstanceExceptionHandler(reactContext: ReactContext) {
        val catalystInstance =
            try {
                reactContext.catalystInstance
            } catch (_: Exception) {
                null
            } ?: return

        val catalystIdentity = System.identityHashCode(catalystInstance)
        if (!patchedCatalystInstanceIds.add(catalystIdentity)) {
            return
        }

        val exceptionHandlerField = findField(catalystInstance.javaClass, "mJSExceptionHandler")
        if (exceptionHandlerField == null) {
            patchedCatalystInstanceIds.remove(catalystIdentity)
            return
        }

        exceptionHandlerField.isAccessible = true
        val previousHandler = exceptionHandlerField.get(catalystInstance) as? JSExceptionHandler
        if (previousHandler is RecoveryJSExceptionHandler) {
            return
        }
        exceptionHandlerField.set(catalystInstance, RecoveryJSExceptionHandler(previousHandler))
    }

    private fun getReactHost(application: ReactApplication): Any? =
        try {
            findMethod(application.javaClass, "getReactHost")?.invoke(application)
        } catch (_: Exception) {
            null
        }

    private fun findMethod(
        clazz: Class<*>,
        name: String,
    ) = runCatching { clazz.getMethod(name) }.getOrNull()

    private fun findField(
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

    private fun loadNativeLibrary(): Boolean {
        if (nativeLibraryLoadAttempted) {
            return nativeLibraryLoaded
        }

        nativeLibraryLoadAttempted = true
        nativeLibraryLoaded =
            try {
                System.loadLibrary("hotupdater_recovery")
                true
            } catch (e: UnsatisfiedLinkError) {
                Log.w(TAG, "Failed to load recovery native library", e)
                false
            }
        return nativeLibraryLoaded
    }

    private external fun nativeInstallSignalHandler(crashMarkerPath: String)

    private external fun nativeUpdateLaunchState(
        bundleId: String?,
        shouldRollback: Boolean,
    )

    private class RecoveryJSExceptionHandler(
        private val previousHandler: JSExceptionHandler?,
    ) : JSExceptionHandler {
        override fun handleException(e: Exception) {
            if (activeManager?.handleJavaScriptException(e) != true) {
                previousHandler?.handleException(e) ?: throw e
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
        private var nativeLibraryLoadAttempted = false

        @Volatile
        private var nativeLibraryLoaded = false

        @Volatile
        private var signalHandlerInstalled = false

        @Volatile
        private var exceptionHandlerInstalled = false

        @Volatile
        private var previousExceptionHandler: Thread.UncaughtExceptionHandler? = null

        @Volatile
        private var activeManager: HotUpdaterRecoveryManager? = null

        private val patchedInstanceManagerIds = mutableSetOf<Int>()
        private val patchedCatalystInstanceIds = mutableSetOf<Int>()
        private val patchedReactContextIds = mutableSetOf<Int>()
        private val patchedReactHostDelegateIds = mutableSetOf<Int>()

        @JvmStatic
        fun handleRecoveryWatchdog(context: Context) {
            val appContext = context.applicationContext
            val watchdogStateFile = File(getBundleStoreDir(appContext), WATCHDOG_STATE_FILENAME)
            val deadlineAt = watchdogStateFile.takeIf(File::exists)?.readText()?.toLongOrNull()
            if (deadlineAt == null) {
                cancelRecoveryWatchdogAlarm(appContext)
                watchdogStateFile.delete()
                return
            }

            val crashMarkerFile = File(getBundleStoreDir(appContext), CRASH_MARKER_FILENAME)
            if (crashMarkerFile.exists()) {
                Log.i(TAG, "Recovery watchdog detected crash marker, relaunching app")
                watchdogStateFile.delete()
                cancelRecoveryWatchdogAlarm(appContext)
                launchRecoveryRestart(appContext)
                return
            }

            if (System.currentTimeMillis() >= deadlineAt) {
                watchdogStateFile.delete()
                cancelRecoveryWatchdogAlarm(appContext)
                return
            }

            scheduleRecoveryWatchdogTick(appContext, WATCHDOG_TICK_INTERVAL_MS)
        }

        private fun getBundleStoreDir(context: Context): File = File(context.getExternalFilesDir(null) ?: context.filesDir, "bundle-store")

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
