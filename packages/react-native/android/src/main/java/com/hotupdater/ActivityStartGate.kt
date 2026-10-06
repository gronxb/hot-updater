package com.hotupdater

import android.app.Activity
import android.app.Application
import android.os.Bundle

/**
 * Runs an action once this process has a started activity.
 *
 * A headless JS task (HeadlessJsTaskService, which background push libraries
 * start) loads the bundle with no activity and never renders. Waiting for an
 * activity keeps that launch from counting as one that ended before its first
 * render.
 */
internal class ActivityStartGate(
    private val application: Application?,
) : Application.ActivityLifecycleCallbacks {
    private var startedActivities = 0
    private var pendingAction: (() -> Unit)? = null

    init {
        application?.registerActivityLifecycleCallbacks(this)
    }

    /**
     * Runs [action] now when an activity is started, otherwise at the next
     * activity start. It replaces an action still waiting; null cancels it.
     * Without an application to observe, it runs [action] now.
     */
    fun runWhenActivityStarted(action: (() -> Unit)?) {
        val runNow =
            synchronized(this) {
                val waits = application != null && startedActivities == 0
                pendingAction = action.takeIf { waits }
                action.takeUnless { waits }
            }
        runNow?.invoke()
    }

    override fun onActivityStarted(activity: Activity) {
        val action =
            synchronized(this) {
                startedActivities += 1
                pendingAction.also { pendingAction = null }
            }
        action?.invoke()
    }

    override fun onActivityStopped(activity: Activity) {
        synchronized(this) {
            // An activity started before this gate existed was never counted.
            if (startedActivities > 0) startedActivities -= 1
        }
    }

    override fun onActivityCreated(
        activity: Activity,
        savedInstanceState: Bundle?,
    ) {}

    override fun onActivityResumed(activity: Activity) {}

    override fun onActivityPaused(activity: Activity) {}

    override fun onActivitySaveInstanceState(
        activity: Activity,
        outState: Bundle,
    ) {}

    override fun onActivityDestroyed(activity: Activity) {}
}
