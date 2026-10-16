package com.hotupdater

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import com.facebook.react.ReactRootView
import com.facebook.react.bridge.ReactContext
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap

/**
 * Which instance a React Native view, runtime, or JavaScript error belongs to:
 * the instance whose bundle the runtime runs, by the URL React Native loaded
 * it from ([HotUpdaterInstanceRegistry.resolveName]). With only main, all of
 * it is main's.
 */
internal class HotUpdaterRecoveryAttribution(
    private val resolveName: (Context, String) -> String = HotUpdaterInstanceRegistry.shared::resolveName,
) {
    companion object {
        val shared = HotUpdaterRecoveryAttribution()

        /**
         * Whether a view of [viewInstance] counts for [instanceName]. Main
         * takes every view no named instance claims, so a view whose runtime
         * isn't known yet counts for main, as every view always has.
         */
        fun owns(
            instanceName: String,
            viewInstance: String?,
        ): Boolean =
            if (instanceName == HotUpdaterInstanceEnvironment.MAIN_NAME) {
                viewInstance == null || viewInstance == HotUpdaterInstanceEnvironment.MAIN_NAME
            } else {
                viewInstance == instanceName
            }
    }

    @Volatile
    private var context: Context? = null
    private var trackedApplication: Application? = null

    // Activities that may hold a React Native view whose first content appears.
    private val activities = Collections.newSetFromMap(WeakHashMap<Activity, Boolean>())
    private val startedActivities = Collections.newSetFromMap(WeakHashMap<Activity, Boolean>())
    private val runtimes = mutableListOf<WeakReference<ReactContext>>()

    private val activityCallbacks =
        object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(
                activity: Activity,
                savedInstanceState: Bundle?,
            ) {
                synchronized(activities) { activities += activity }
            }

            override fun onActivityStarted(activity: Activity) {
                synchronized(activities) {
                    activities += activity
                    startedActivities += activity
                }
            }

            override fun onActivityDestroyed(activity: Activity) {
                synchronized(activities) {
                    activities -= activity
                    startedActivities -= activity
                }
            }

            override fun onActivityResumed(activity: Activity) {}

            override fun onActivityPaused(activity: Activity) {}

            override fun onActivityStopped(activity: Activity) {
                synchronized(activities) { startedActivities -= activity }
            }

            override fun onActivitySaveInstanceState(
                activity: Activity,
                outState: Bundle,
            ) {}
        }

    /** Starts following the app's activities, once per process. */
    fun track(context: Context) {
        this.context = context.applicationContext
        val application = context.applicationContext as? Application ?: return
        synchronized(this) {
            if (trackedApplication != null) return
            trackedApplication = application
        }
        application.registerActivityLifecycleCallbacks(activityCallbacks)
    }

    /**
     * Remembers a runtime whose HotUpdater module was created. Its current
     * activity is searched for its views even when that activity started
     * before [track], as when a brownfield app adds React Native to a screen
     * already shown.
     */
    fun registerRuntime(reactContext: ReactContext) {
        if (context == null) context = reactContext.applicationContext
        synchronized(runtimes) {
            runtimes.removeAll { it.get() == null }
            if (runtimes.none { it.get() === reactContext }) runtimes += WeakReference(reactContext)
        }
    }

    /**
     * The activities started now, as far as this process has seen: the ones
     * started since [track], and the current activity of each registered
     * runtime. A gate created after they started reads them here.
     */
    fun startedActivities(): List<Activity> =
        (
            synchronized(activities) { startedActivities.toList() } +
                synchronized(runtimes) { runtimes.mapNotNull { it.get()?.currentActivity } }
        ).distinct()

    /** The instance whose bundle runs from [sourceURL], or null when it isn't known. */
    fun instanceOf(sourceURL: String?): String? {
        val url = sourceURL?.takeIf { it.isNotEmpty() } ?: return null
        val context = context ?: return HotUpdaterInstanceEnvironment.MAIN_NAME
        return resolveName(context, url)
    }

    /** The instance of [rootView]'s runtime, or null before the view joins one. */
    fun instanceOf(rootView: ReactRootView): String? = instanceOf(runCatching { rootView.currentReactContext?.sourceURL }.getOrNull())

    /** Whether [activity] shows a React Native view that counts for [instanceName]. */
    fun showsViewOf(
        activity: Activity,
        instanceName: String,
    ): Boolean {
        val decorView = activity.window?.peekDecorView() ?: return false
        return findRootView(decorView) { owns(instanceName, instanceOf(it)) } != null
    }

    /**
     * The instance of the root view whose first content appeared, which React
     * Native names by its root tag; null when no known activity shows it.
     */
    fun instanceOfRootTag(rootTag: Int): String? {
        val candidates =
            synchronized(activities) { activities.toList() } +
                synchronized(runtimes) { runtimes.mapNotNull { it.get()?.currentActivity } }
        candidates.distinct().forEach { activity ->
            val decorView = activity.window?.peekDecorView() ?: return@forEach
            findRootView(decorView) { it.rootViewTag == rootTag }?.let { return instanceOf(it) ?: HotUpdaterInstanceEnvironment.MAIN_NAME }
        }
        return null
    }
}

internal fun findRootView(
    view: View,
    matches: (ReactRootView) -> Boolean,
): ReactRootView? {
    if (view is ReactRootView && matches(view)) return view
    if (view is ViewGroup) {
        for (index in 0 until view.childCount) {
            findRootView(view.getChildAt(index), matches)?.let { return it }
        }
    }
    return null
}
