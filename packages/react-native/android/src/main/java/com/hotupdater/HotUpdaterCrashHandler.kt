package com.hotupdater

import android.content.Context
import android.os.Process
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.system.exitProcess

internal object HotUpdaterCrashHandler {
    private const val TAG = "HotUpdaterCrash"
    private const val CRASH_MARKER_FILENAME = "hotupdater_crash.marker"

    private val initialized = AtomicBoolean(false)
    private val crashMarkerWritten = AtomicBoolean(false)

    private var previousHandler: Thread.UncaughtExceptionHandler? = null

    fun initialize(context: Context) {
        if (!initialized.compareAndSet(false, true)) {
            return
        }

        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                writeCrashMarker(context, Log.getStackTraceString(throwable))
            } catch (e: Exception) {
                Log.w(TAG, "Failed to persist crash marker", e)
            } finally {
                if (previousHandler != null) {
                    previousHandler?.uncaughtException(thread, throwable)
                } else {
                    Process.killProcess(Process.myPid())
                    exitProcess(10)
                }
            }
        }

        try {
            System.loadLibrary("hotupdater-crash")
            initNativeSignalHandler(getCrashMarkerFile(context).absolutePath)
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to initialize native signal handler", t)
        }
    }

    fun readCrashMarker(context: Context): String? {
        val markerFile = getCrashMarkerFile(context)
        if (!markerFile.exists()) {
            return null
        }

        return try {
            markerFile.readText().also {
                markerFile.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read crash marker", e)
            markerFile.delete()
            null
        }
    }

    private fun writeCrashMarker(
        context: Context,
        crashLog: String,
    ) {
        if (!crashMarkerWritten.compareAndSet(false, true)) {
            return
        }

        val payload =
            JSONObject().apply {
                put("crashLog", crashLog.take(900))
                put("timestamp", System.currentTimeMillis())
            }

        getCrashMarkerFile(context).writeText(payload.toString())
    }

    private fun getCrashMarkerFile(context: Context): File {
        val baseDir = context.getExternalFilesDir(null) ?: context.filesDir
        return File(baseDir, CRASH_MARKER_FILENAME)
    }

    @JvmStatic
    private external fun initNativeSignalHandler(markerPath: String)
}
