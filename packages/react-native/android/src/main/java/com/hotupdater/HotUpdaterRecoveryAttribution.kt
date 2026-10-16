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
    private val isStarted: (Activity) -> Boolean = { isActivityStarted(it) },
) {
    companion object {
        val shared = HotUpdaterRecoveryAttribution()

        // A JavaScript stack frame's source: an absolute path or a URL, such
        // as Hermes' "at f (address at /data/.../index.android.bundle:1:2345)",
        // "f@/data/.../index.android.bundle:1:2345", or "assets://widget.android.bundle:1:9".
        private val FRAME_SOURCE = Regex("""((?:[A-Za-z][A-Za-z0-9+.-]*://|/)[^\s()]*?)(?::\d+){1,2}(?=[)\s,]|$)""")

        /** The bundle locations the frames of [stack] run from. */
        fun frameSources(stack: String): List<String> =
            FRAME_SOURCE
                .findAll(stack)
                .map { it.groupValues[1] }
                .distinct()
                .toList()

        /**
         * The named instance whose bundle every located frame of [stacks]
         * runs from, or null when no frame is located or they name main, an
         * unknown bundle, or more than one instance. A runtime runs one
         * bundle, so its error's frames name its instance even before its
         * HotUpdater module exists.
         */
        fun namedInstanceOfStack(
            stacks: List<String>,
            resolve: (String) -> String,
        ): String? {
            val sources = stacks.flatMap(::frameSources).distinct()
            if (sources.isEmpty()) return null
            return sources
                .map(resolve)
                .toSet()
                .singleOrNull()
                ?.takeIf { it != HotUpdaterInstanceEnvironment.MAIN_NAME }
        }

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
     * Remembers [activity], which the app handed over as a context: it may
     * start, or have started, before [track] registered for lifecycle
     * callbacks. It counts as started only while it is.
     */
    fun noteActivity(activity: Activity) {
        synchronized(activities) { activities += activity }
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
     * seen starting since [track], and any other known activity, such as a
     * registered runtime's current one, that reports it is started now. A
     * runtime keeps its activity after it stops. A gate created after they
     * started reads them here.
     */
    fun startedActivities(): List<Activity> {
        val (seenStarted, known) = synchronized(activities) { startedActivities.toList() to activities.toList() }
        val runtimeActivities = synchronized(runtimes) { runtimes.mapNotNull { it.get()?.currentActivity } }
        return (seenStarted + (known + runtimeActivities).filter(isStarted)).distinct()
    }

    /** [namedInstanceOfStack] with this process's instances. */
    fun namedInstanceOfStack(stacks: List<String>): String? {
        val context = context ?: return null
        return namedInstanceOfStack(stacks) { resolveName(context, it) }
    }

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
