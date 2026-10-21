package com.hotupdaterexample

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Runs the JS headless task in a process that may have no activity. */
class HeadlessTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
      HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), TIMEOUT_MS)

  companion object {
    private const val TASK_KEY = "HotUpdaterE2EHeadlessTask"
    private const val TIMEOUT_MS = 30_000L
  }
}
