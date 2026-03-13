package com.hotupdater

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
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

        startActivity(launchIntent)
        finishWithoutAnimation()

        // Keep the trampoline alive just long enough to let Android settle the relaunch,
        // then tear down the helper process as well.
        Handler(Looper.getMainLooper()).postDelayed({ killCurrentProcess() }, PROCESS_KILL_DELAY_MS)
    }

    private fun finishWithoutAnimation() {
        finish()
        overridePendingTransition(0, 0)
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
        const val EXTRA_PACKAGE_NAME = "hot_updater.package_name"
        const val EXTRA_TARGET_PID = "hot_updater.target_pid"
    }
}
