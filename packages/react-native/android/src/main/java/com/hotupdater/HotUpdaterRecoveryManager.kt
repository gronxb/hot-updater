package com.hotupdater

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import com.facebook.react.bridge.ReactMarker
import com.facebook.react.bridge.ReactMarkerConstants
import org.json.JSONObject
import java.io.File
import kotlin.system.exitProcess

internal class HotUpdaterRecoveryManager(
    context: Context,
) {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val crashMarkerFile = File(File(appContext.getExternalFilesDir(null), "bundle-store"), CRASH_MARKER_FILENAME)

    private var currentBundleId: String? = null
    private var shouldRollbackOnCrash = false
    private var isMonitoring = false
    private var contentAppearedCallback: ((String?) -> Unit)? = null

    private val stopMonitoringRunnable =
        Runnable {
            Log.d(TAG, "Stopping crash monitoring for current launch")
            isMonitoring = false
            shouldRollbackOnCrash = false
            currentBundleId = null
            contentAppearedCallback = null
            updateNativeLaunchState(null, false)
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
    ) {
        crashMarkerFile.parentFile?.mkdirs()
        contentAppearedCallback = onContentAppeared
        currentBundleId = bundleId
        shouldRollbackOnCrash = shouldRollback
        isMonitoring = true

        ensureExceptionHandlerInstalled()
        ensureNativeSignalHandlerInstalled()

        mainHandler.removeCallbacks(stopMonitoringRunnable)
        ReactMarker.removeListener(contentAppearedListener)
        ReactMarker.addListener(contentAppearedListener)
        updateNativeLaunchState(bundleId, shouldRollback)

        Log.d(TAG, "Started crash monitoring bundleId=$bundleId shouldRollback=$shouldRollback")
    }

    private fun handleContentAppeared() {
        if (!isMonitoring) {
            return
        }

        Log.d(TAG, "First content appeared for bundleId=$currentBundleId")
        contentAppearedCallback?.invoke(currentBundleId)

        shouldRollbackOnCrash = false
        updateNativeLaunchState(currentBundleId, false)
        ReactMarker.removeListener(contentAppearedListener)
        mainHandler.removeCallbacks(stopMonitoringRunnable)
        mainHandler.postDelayed(stopMonitoringRunnable, MONITORING_GRACE_PERIOD_MS)
    }

    private fun ensureExceptionHandlerInstalled() {
        if (exceptionHandlerInstalled) {
            return
        }

        previousExceptionHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            writeCrashMarker()
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

    companion object {
        private const val TAG = "HotUpdaterRecovery"
        private const val CRASH_MARKER_FILENAME = "recovery-crash-marker.json"
        private const val MONITORING_GRACE_PERIOD_MS = 10_000L

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
    }
}
