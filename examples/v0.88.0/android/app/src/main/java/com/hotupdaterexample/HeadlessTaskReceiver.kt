package com.hotupdaterexample

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

/**
 * Starts [HeadlessTaskService] from a broadcast, as a messaging library does
 * for a data-only push while the app has no activity.
 */
class HeadlessTaskReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    context.startService(Intent(context, HeadlessTaskService::class.java))
    HeadlessJsTaskService.acquireWakeLockNow(context)
  }
}
