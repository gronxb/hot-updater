package com.hotupdater

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.util.Log

/**
 * Why the app's previous main process exited, from
 * `ActivityManager.getHistoricalProcessExitReasons` (Android 11+).
 *
 * HotUpdater calls [initialize] when it starts. The reason is read once, on
 * first use, and kept for the life of the process: the running process never
 * appears in its own exit history, so reading later returns the same entry.
 */
internal object PreviousProcessExit {
    private const val TAG = "PreviousProcessExit"
    private const val MAX_EXIT_RECORDS = 5

    /** `ApplicationExitInfo.REASON_*` values, named without the prefix. */
    private val REASON_NAMES =
        mapOf(
            0 to "UNKNOWN",
            1 to "EXIT_SELF",
            2 to "SIGNALED",
            3 to "LOW_MEMORY",
            4 to "CRASH",
            5 to "CRASH_NATIVE",
            6 to "ANR",
            7 to "INITIALIZATION_FAILURE",
            8 to "PERMISSION_CHANGE",
            9 to "EXCESSIVE_RESOURCE_USAGE",
            10 to "USER_REQUESTED",
            11 to "USER_STOPPED",
            12 to "DEPENDENCY_DIED",
            13 to "OTHER",
            14 to "FREEZER",
            15 to "PACKAGE_STATE_CHANGE",
            16 to "PACKAGE_UPDATED",
        )

    data class ExitRecord(
        val processName: String?,
        val reason: Int,
        val timestamp: Long,
    )

    // The application context, which lives as long as the process.
    @Volatile
    private var applicationContext: Context? = null

    private val reason: String? by lazy { applicationContext?.let(::read) }

    fun initialize(context: Context) {
        if (applicationContext == null) {
            applicationContext = context.applicationContext ?: context
        }
    }

    /** The previous main process's exit reason, or null when it is not known. */
    fun get(): String? = if (applicationContext == null) null else reason

    fun reasonName(reason: Int): String = REASON_NAMES[reason] ?: "UNKNOWN"

    /**
     * The reason of [mainProcessName]'s most recent exit. Other processes of
     * the app, such as `:hotupdater_restart`, are skipped.
     */
    fun selectReason(
        records: List<ExitRecord>,
        mainProcessName: String,
    ): Int? = records.filter { it.processName == mainProcessName }.maxByOrNull { it.timestamp }?.reason

    private fun read(context: Context): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
            val records =
                activityManager
                    .getHistoricalProcessExitReasons(null, 0, MAX_EXIT_RECORDS)
                    .map { ExitRecord(it.processName, it.reason, it.timestamp) }
            selectReason(records, context.applicationInfo.processName)?.let(::reasonName)
        } catch (error: Throwable) {
            // Never let this diagnostic break startup.
            Log.w(TAG, "Could not read the previous process exit reason", error)
            null
        }
    }
}
