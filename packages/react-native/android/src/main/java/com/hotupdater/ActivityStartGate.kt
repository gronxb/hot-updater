package com.hotupdater

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.react.ReactRootView

/**
 * Runs an action once a started activity of this process shows a React Native
 * view.
 *
 * A headless JS task (HeadlessJsTaskService, which background push libraries
 * start) loads the bundle with no activity and never renders. A brownfield app
 * loads the bundle with its first native screen, and the user may never open a
 * React Native screen in that process. Waiting for a React Native view keeps
 * both launches from counting as one that ended before its first render.
 *
 * Android does not replay lifecycle callbacks to a late registration. An
 * activity that started before this gate existed, as when a brownfield app adds
 * React Native to an activity already on screen, is read from
 * [processHasStartedActivity] instead, and counts at once.
 */
internal class ActivityStartGate(
    private val application: Application?,
    private val processHasStartedActivity: () -> Boolean = ::hasStartedActivity,
    private val showsReactView: (Activity) -> Boolean = ::hasReactRootView,
    private val watchLayout: (Activity, () -> Unit) -> () -> Unit = ::watchGlobalLayout,
) : Application.ActivityLifecycleCallbacks {
    private val startedActivities = mutableSetOf<Activity>()
    private val layoutWatches = mutableMapOf<Activity, () -> Unit>()
    private var pendingAction: (() -> Unit)? = null

    init {
        application?.registerActivityLifecycleCallbacks(this)
    }

    /**
     * Runs [action] now when a started activity shows a React Native view,
     * otherwise when one does. It replaces an action still waiting; null
     * cancels it. Without an application to observe, it runs [action] now.
     */
    fun runWhenActivityStarted(action: (() -> Unit)?) {
        // Views and their layout listeners belong to the main thread.
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { runWhenActivityStarted(action) }
            return
        }
        val runNow =
            synchronized(this) {
                stopWatching()
                pendingAction = null
                val waits =
                    application != null &&
                        startedActivities.none(showsReactView) &&
                        (startedActivities.isNotEmpty() || !processHasStartedActivity())
                if (waits && action != null) {
                    pendingAction = action
                    startedActivities.forEach(::watch)
                }
                action.takeUnless { waits }
            }
        runNow?.invoke()
    }

    override fun onActivityStarted(activity: Activity) {
        val action =
            synchronized(this) {
                startedActivities += activity
                if (pendingAction == null) return
                if (!showsReactView(activity)) {
                    watch(activity)
                    return
                }
                takePendingAction()
            }
        action?.invoke()
    }

    override fun onActivityStopped(activity: Activity) {
        synchronized(this) {
            // An activity started before this gate existed was never counted.
            startedActivities -= activity
            layoutWatches.remove(activity)?.invoke()
        }
    }

    private fun watch(activity: Activity) {
        if (activity in layoutWatches) return
        layoutWatches[activity] = watchLayout(activity) { onLayout(activity) }
    }

    private fun onLayout(activity: Activity) {
        val action =
            synchronized(this) {
                if (pendingAction == null ||
                    activity !in startedActivities ||
                    !showsReactView(activity)
                ) {
                    return
                }
                takePendingAction()
            }
        action?.invoke()
    }

    private fun takePendingAction(): (() -> Unit)? {
        stopWatching()
        return pendingAction.also { pendingAction = null }
    }

    private fun stopWatching() {
        layoutWatches.values.forEach { it() }
        layoutWatches.clear()
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

private fun hasReactRootView(activity: Activity): Boolean = activity.window?.peekDecorView()?.let(::containsReactRootView) ?: false

private fun containsReactRootView(view: View): Boolean =
    view is ReactRootView ||
        (view is ViewGroup && (0 until view.childCount).any { containsReactRootView(view.getChildAt(it)) })

// A React Native screen added later, such as a fragment of a native activity,
// changes the activity's layout.
private fun watchGlobalLayout(
    activity: Activity,
    onLayout: () -> Unit,
): () -> Unit {
    val decorView = activity.window?.decorView ?: return {}
    val listener = ViewTreeObserver.OnGlobalLayoutListener(onLayout)
    decorView.viewTreeObserver.addOnGlobalLayoutListener(listener)
    return { runCatching { decorView.viewTreeObserver.removeOnGlobalLayoutListener(listener) } }
}
