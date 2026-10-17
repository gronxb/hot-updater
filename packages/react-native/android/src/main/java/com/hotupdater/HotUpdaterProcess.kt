package com.hotupdater

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File

/**
 * The process [HotUpdaterRestartActivity] runs in (its manifest's
 * `android:process`). Android runs the app's `Application.onCreate` there too,
 * so an app that starts React Native from it, as a brownfield app does, reaches
 * Hot Updater in this process as well.
 */
internal object HotUpdaterProcess {
    private const val RESTART_PROCESS_SUFFIX = ":hotupdater_restart"

    fun isRestartProcess(context: Context): Boolean = isRestartProcessName(context.packageName, currentProcessName())

    fun isRestartProcessName(
        packageName: String,
        processName: String?,
    ): Boolean = processName == packageName + RESTART_PROCESS_SUFFIX

    private fun currentProcessName(): String? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Application.getProcessName()
        } else {
            runCatching { File("/proc/self/cmdline").readText().trimEnd('\u0000') }.getOrNull()
        }
}
