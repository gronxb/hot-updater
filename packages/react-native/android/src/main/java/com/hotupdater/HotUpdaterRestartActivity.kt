package com.hotupdater

import android.app.Activity
import android.app.ActivityManager
import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log

class HotUpdaterRestartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val targetPid = intent.getIntExtra(EXTRA_TARGET_PID, -1)
        val packageName = intent.getStringExtra(EXTRA_PACKAGE_NAME) ?: this.packageName
        val launchIntent = getRestartIntent(packageName)

        if (launchIntent == null) {
            Log.e(TAG, "Cannot relaunch app: launch intent not found for $packageName")
            finishWithoutAnimation()
            killCurrentProcess()
            return
        }

        if (targetPid > 0) {
            Process.killProcess(targetPid)
        }

        // The kill is asynchronous. An activity started while the system still
        // has the old process registered is handed to it and lost with it
        // ("removed with pending start"), which leaves the app closed. The wait
        // stays in onCreate: a Theme.NoDisplay activity must finish before
        // onResume, and once finished this process may no longer start one.
        awaitProcessExit(
            isAlive = { targetPid > 0 && isProcessRegistered(targetPid) },
            sleep = { Thread.sleep(it) },
            now = SystemClock::uptimeMillis,
        )

        val options = ActivityOptions.makeCustomAnimation(this, 0, 0)
        startActivity(launchIntent, options.toBundle())
        finishWithoutAnimation()

        // Keep the trampoline alive just long enough to let Android settle the relaunch,
        // then tear down the helper process as well.
        Handler(Looper.getMainLooper()).postDelayed({ killCurrentProcess() }, PROCESS_KILL_DELAY_MS)
    }

    private fun isProcessRegistered(pid: Int): Boolean {
        val activityManager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return activityManager.runningAppProcesses.orEmpty().any { it.pid == pid }
    }

    private fun finishWithoutAnimation() {
        finish()
    }

    private fun getRestartIntent(packageName: String): Intent? {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        val component = launchIntent.component ?: return null

        return Intent.makeRestartActivityTask(component).apply {
            `package` = packageName
            addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        }
    }

    private fun killCurrentProcess() {
        Process.killProcess(Process.myPid())
    }

    companion object {
        private const val TAG = "HotUpdaterRestart"
        private const val PROCESS_KILL_DELAY_MS = 100L
        private const val PROCESS_EXIT_POLL_MS = 25L

        /** How long the relaunch waits for the old process; it starts anyway after. */
        internal const val PROCESS_EXIT_TIMEOUT_MS = 2_000L
        const val EXTRA_PACKAGE_NAME = "hot_updater.package_name"
        const val EXTRA_TARGET_PID = "hot_updater.target_pid"

        /**
         * Returns once [isAlive] is false, checking every
         * [PROCESS_EXIT_POLL_MS], and at the latest once
         * [PROCESS_EXIT_TIMEOUT_MS] passed. At once when it is already gone.
         */
        internal fun awaitProcessExit(
            isAlive: () -> Boolean,
            sleep: (Long) -> Unit,
            now: () -> Long,
        ) {
            val deadline = now() + PROCESS_EXIT_TIMEOUT_MS
            while (isAlive() && now() < deadline) {
                sleep(PROCESS_EXIT_POLL_MS)
            }
        }
    }
}
