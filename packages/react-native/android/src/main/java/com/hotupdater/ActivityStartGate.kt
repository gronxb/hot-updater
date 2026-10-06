package com.hotupdater

import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

/**
 * Runs an action once this process has a started activity.
 *
 * A headless JS task (HeadlessJsTaskService, which background push libraries
 * start) loads the bundle with no activity and never renders. Waiting for an
 * activity keeps that launch from counting as one that ended before its first
 * render.
 *
 * Android does not replay lifecycle callbacks to a late registration. An
 * activity that started before this gate existed, as when a brownfield app adds
 * React Native to an activity already on screen, is read from
 * [processHasStartedActivity] instead.
 */
internal class ActivityStartGate(
    private val application: Application?,
    private val processHasStartedActivity: () -> Boolean = ::hasStartedActivity,
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
                val waits =
                    application != null &&
                        startedActivities == 0 &&
                        !processHasStartedActivity()
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

// ProcessLifecycleOwner observes activities from process start, through the
// androidx.startup initializer that lifecycle-process registers. It is STARTED
// while an activity of this process is started, and stays at INITIALIZED when
// an app removes that initializer, so the gate then waits for the next start.
private fun hasStartedActivity(): Boolean =
    runCatching {
        ProcessLifecycleOwner
            .get()
            .lifecycle.currentState
            .isAtLeast(Lifecycle.State.STARTED)
    }.getOrDefault(false)
