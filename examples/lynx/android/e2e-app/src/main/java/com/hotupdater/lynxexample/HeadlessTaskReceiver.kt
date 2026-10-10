package com.hotupdater.lynxexample

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.hotupdater.lynx.LynxBackgroundJobService

/** Test-only trigger; execution and OS lifetime are owned by the published SDK JobService. */
class HeadlessTaskReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        check(LynxBackgroundJobService.schedule(context, JOB_ID)) { "Could not schedule the Lynx task" }
    }

    companion object { const val JOB_ID = 1300 }
}
