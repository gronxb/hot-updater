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

/**
 * Replaces the app's process with a dev session's or the first screen's, in the
 * SDK's restart process, whose getters never prepare a launch. It stays alive
 * until the new process took its claim: being alive is what tells a relaunch
 * from an icon tap, before anything in the new process could read a bundle.
 */
class HotUpdaterSandboxRelaunchActivity : Activity() {
    internal companion object {
        const val EXTRA_TARGET_PID = "com.hotupdater.sandbox.TARGET_PID"
        const val EXTRA_SESSION = "com.hotupdater.sandbox.SESSION"
        const val EXTRA_HOST = "com.hotupdater.sandbox.HOST"
        private const val TAG = "HotUpdaterSandboxDev"
        private const val CLAIM_POLL_MS = 50L
        private const val KILL_DELAY_MS = 100L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val targetPid = intent.getIntExtra(EXTRA_TARGET_PID, -1)
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.component
        if (launch == null) {
            Log.e(TAG, "This app has no launcher to relaunch")
            finish()
            Process.killProcess(Process.myPid())
            return
        }
        if (targetPid > 0) Process.killProcess(targetPid)
        // As in the SDK's restart: an activity started while the system still has
        // the old process registered is lost with it.
        HotUpdaterRestartActivity.awaitProcessExit(
            isAlive = { targetPid > 0 && isProcessRegistered(targetPid) },
            sleep = { Thread.sleep(it) },
            now = SystemClock::uptimeMillis,
        )

        val session = intent.getStringExtra(EXTRA_SESSION)
        val host = intent.getStringExtra(EXTRA_HOST)
        val files = HotUpdaterSandboxDev.filesOf(this)
        val restart = Intent.makeRestartActivityTask(launch).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        if (session != null && host != null) {
            files.writeClaim(
                HotUpdaterSandboxDevClaim(session, host, Process.myPid(), SystemClock.elapsedRealtime()),
            )
        } else {
            // Back to the first screen, not straight into the app's JavaScript.
            restart.putExtra(HotUpdaterSandboxActivity.EXTRA_OVER_APP, true)
        }
        startActivity(restart, ActivityOptions.makeCustomAnimation(this, 0, 0).toBundle())
        finish()

        val handler = Handler(Looper.getMainLooper())
        val deadline = SystemClock.elapsedRealtime() + HotUpdaterSandboxDevFiles.CLAIM_MAX_AGE_MS
        val poll =
            object : Runnable {
                override fun run() {
                    if (files.claim.exists() && SystemClock.elapsedRealtime() < deadline) {
                        handler.postDelayed(this, CLAIM_POLL_MS)
                        return
                    }
                    files.claim.delete()
                    Process.killProcess(Process.myPid())
                }
            }
        handler.postDelayed(poll, KILL_DELAY_MS)
    }

    private fun isProcessRegistered(pid: Int): Boolean {
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return manager.runningAppProcesses.orEmpty().any { it.pid == pid }
    }
}
