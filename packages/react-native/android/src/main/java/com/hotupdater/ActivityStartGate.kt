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
import androidx.lifecycle.LifecycleOwner
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
 * [processHasStartedActivity] instead, and counts at once. A gate that knows
 * those activities ([activitiesStartedBefore]) checks them for a React Native
 * view instead, as a named instance's gate must: a started activity says
 * nothing about whether that instance's view is shown.
 */
internal class ActivityStartGate(
    private val application: Application?,
    private val processHasStartedActivity: () -> Boolean = ::hasStartedActivity,
    private val showsReactView: (Activity) -> Boolean = ::hasReactRootView,
    private val watchLayout: (Activity, () -> Unit) -> () -> Unit = ::watchGlobalLayout,
    private val activitiesStartedBefore: (() -> Collection<Activity>)? = null,
    private val isStarted: (Activity) -> Boolean = { isActivityStarted(it) },
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
                if (application != null) activitiesStartedBefore?.let { startedActivities += it() }
                val waits =
                    application != null &&
                        startedActivities.none(showsReactView) &&
                        (startedActivities.isNotEmpty() || activitiesStartedBefore != null || !processHasStartedActivity())
                if (waits && action != null) {
                    pendingAction = action
                    startedActivities.forEach(::watch)
                }
                action.takeUnless { waits }
            }
        runNow?.invoke()
    }

    /**
     * Counts [activity], which this gate may never have seen start, as
     * started when it is, and while an action waits, checks it for a React
     * Native view and watches its layout for one. A named instance's runtime hands over its activity when its
     * module is created.
     */
    fun watchActivity(activity: Activity) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { watchActivity(activity) }
            return
        }
        val action =
            synchronized(this) {
                // A runtime keeps its activity after it stops, as when the app
                // goes to the background while the bundle loads. One that
                // isn't started now counts when this gate sees it start.
                if (application == null || !isStarted(activity)) return
                // Counted until it stops, as one this gate saw start.
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

/**
 * Whether [activity] is started now. An activity that reports its lifecycle
 * (ComponentActivity, which ReactActivity and AppCompatActivity are) says so.
 * Any other, such as a plain Activity hosting a ReactRootView itself, is
 * started while its window is shown: the framework hides a stopped
 * activity's window.
 */
internal fun isActivityStarted(
    activity: Activity,
    windowShown: (Activity) -> Boolean = ::isWindowShown,
): Boolean {
    if (activity.isFinishing || activity.isDestroyed) return false
    val owner = activity as? LifecycleOwner ?: return windowShown(activity)
    return runCatching { owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }.getOrDefault(false)
}

private fun isWindowShown(activity: Activity): Boolean {
    val decorView = activity.window?.peekDecorView() ?: return false
    return decorView.isAttachedToWindow && decorView.windowVisibility == View.VISIBLE
}

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
