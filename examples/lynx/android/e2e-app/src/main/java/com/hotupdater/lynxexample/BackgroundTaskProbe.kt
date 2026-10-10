package com.hotupdater.lynxexample

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Process
import android.util.Log
import com.hotupdater.lynx.LynxBackgroundResult
import java.io.File
import java.io.FileOutputStream
import org.json.JSONObject

/** Observes real cold-process execution without creating a Lynx host or changing its journal. */
internal class BackgroundTaskProbe(private val application: Application) : Application.ActivityLifecycleCallbacks {
    private var created = 0
    private var started = 0
    private var resumed = 0

    init { application.registerActivityLifecycleCallbacks(this) }

    fun completed(result: Result<LynxBackgroundResult>) {
        val record = JSONObject().put("processId", Process.myPid())
            .put("activitiesCreated", created).put("activitiesStarted", started).put("activitiesResumed", resumed)
        result.fold(
            { value -> record.put("success", true).put("taskId", value.taskId)
                .put("bundleId", value.bundleId).put("releaseId", value.releaseId ?: JSONObject.NULL)
                .put("entry", value.entry).put("manifestHash", value.manifestHash)
                .put("selection", value.selection()).put("value", value.value) },
            { error -> record.put("success", false).put("error", error.message ?: error.toString()) },
        )
        val target = File(application.filesDir, "lynx-background-result.json")
        val temporary = File(application.filesDir, "lynx-background-result.json.tmp")
        FileOutputStream(temporary).use { output ->
            output.write(record.toString().toByteArray(Charsets.UTF_8))
            output.fd.sync()
        }
        check(temporary.renameTo(target)) { "Could not publish the background observation" }
        Log.i("HotUpdaterE2E", "Lynx background observation recorded")
    }

    override fun onActivityCreated(activity: Activity, state: Bundle?) { created++ }
    override fun onActivityStarted(activity: Activity) { started++ }
    override fun onActivityResumed(activity: Activity) { resumed++ }
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
