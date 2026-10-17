package com.hotupdater

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import com.facebook.react.ReactRootView
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UIManager
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
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
    runtimeRoots: HotUpdaterRuntimeRoots? = null,
    decorRoots: HotUpdaterDecorRoots? = null,
    /**
     * Whether a runtime that loaded the URL runs the instance's current
     * launch. A lambda, not a reference: the manager's companion reads
     * [shared], so creating [shared] must not initialize the manager.
     */
    private val runsCurrentLaunch: (instanceName: String, sourceURL: String?) -> Boolean = { name, url ->
        HotUpdaterRecoveryManager.runsCurrentLaunch(name, url)
    },
) {
    /**
     * Root views of the registered runtimes, found through their UI
     * managers in whichever window shows them: a dialog or a presentation
     * has its own window, which no activity's decor view contains.
     */
    private val runtimeRoots: HotUpdaterRuntimeRoots = runtimeRoots ?: UIManagerRuntimeRoots()

    /** Root views in activities' decor views, for a runtime not registered yet. */
    private val decorRoots: HotUpdaterDecorRoots =
        decorRoots ?: HotUpdaterDecorRoots { activity ->
            val decorView = activity.window?.peekDecorView()
            if (decorView == null) {
                emptyList()
            } else {
                rootViewsIn(decorView).map { rootView ->
                    HotUpdaterDecorRoots.Root(rootView.rootViewTag, runCatching { rootView.currentReactContext?.sourceURL }.getOrNull())
                }
            }
        }

    companion object {
        val shared = HotUpdaterRecoveryAttribution()

        // Instance names have no "@", so this names no launch.
        private const val EARLIER_LAUNCH_SUFFIX = "@earlier-launch"

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
        ): String? = instanceOfStack(stacks, resolve)?.takeIf { it != HotUpdaterInstanceEnvironment.MAIN_NAME }

        /**
         * The instance, main included, whose bundle every located frame of
         * [stacks] runs from; null when no frame is located or they name more
         * than one instance. Main's frames are main's own bundle or any the
         * named instances don't know, as [HotUpdaterInstanceRegistry.resolveName] has it.
         */
        fun instanceOfStack(
            stacks: List<String>,
            resolve: (String) -> String,
        ): String? {
            val sources = stacks.flatMap(::frameSources).distinct()
            if (sources.isEmpty()) return null
            return sources.map(resolve).toSet().singleOrNull()
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

    /** Forgets [reactContext], whose runtime was torn down. */
    fun unregisterRuntime(reactContext: ReactContext) {
        synchronized(runtimes) { runtimes.removeAll { it.get().let { runtime -> runtime == null || runtime === reactContext } } }
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

    /** [instanceOfStack] with this process's instances. */
    fun instanceOfStack(stacks: List<String>): String? {
        val context = context ?: return null
        return instanceOfStack(stacks) { resolveName(context, it) }
    }

    /** The instance whose bundle runs from [sourceURL], or null when it isn't known. */
    fun instanceOf(sourceURL: String?): String? {
        val url = sourceURL?.takeIf { it.isNotEmpty() } ?: return null
        val context = context ?: return HotUpdaterInstanceEnvironment.MAIN_NAME
        return resolveName(context, url)
    }

    /**
     * The instance whose current launch a view of a runtime that loaded
     * [sourceURL] belongs to. A named host may still show a view of its
     * previous runtime while its next launch starts: that view belongs to an
     * earlier launch, which neither arms nor verifies the current one. Main
     * takes any view, as it always has. Every view that arms or verifies a
     * launch is attributed here, null before the view joins a runtime.
     */
    fun launchInstanceOf(sourceURL: String?): String? {
        val instanceName = instanceOf(sourceURL) ?: return null
        if (instanceName == HotUpdaterInstanceEnvironment.MAIN_NAME || runsCurrentLaunch(instanceName, sourceURL)) return instanceName
        return "$instanceName$EARLIER_LAUNCH_SUFFIX"
    }

    /** Whether [activity] shows a React Native view that counts for [instanceName]. */
    fun showsViewOf(
        activity: Activity,
        instanceName: String,
    ): Boolean {
        if (decorRoots.rootsIn(activity).any { owns(instanceName, launchInstanceOf(it.sourceURL)) }) return true
        // Main takes the views no named instance claims, which a decor view shows.
        if (instanceName == HotUpdaterInstanceEnvironment.MAIN_NAME) return false
        return runtimeRoots.runtimeURLsShownIn(activity).any { launchInstanceOf(it) == instanceName }
    }

    /**
     * The instance of the root view whose first content appeared, which React
     * Native names by its root tag; null when no known activity shows it or
     * its runtime isn't known yet.
     */
    fun instanceOfRootTag(rootTag: Int): String? {
        runtimeRoots.runtimeOfRootTag(rootTag)?.let { return launchInstanceOf(it.sourceURL) }
        val candidates =
            synchronized(activities) { activities.toList() } +
                synchronized(runtimes) { runtimes.mapNotNull { it.get()?.currentActivity } }
        candidates.distinct().forEach { activity ->
            // A view whose runtime isn't known yet tells nothing either.
            decorRoots.rootsIn(activity).firstOrNull { it.rootTag == rootTag }?.let { return launchInstanceOf(it.sourceURL) }
        }
        return null
    }

    private fun registeredRuntimes(): List<ReactContext> = synchronized(runtimes) { runtimes.mapNotNull { it.get() } }

    /** Root views through the registered runtimes' UI managers. Main thread, as UI managers require. */
    private inner class UIManagerRuntimeRoots : HotUpdaterRuntimeRoots {
        private val liveRootTags = HotUpdaterLiveRootTags()

        // The runtimes the root tags were looked at with.
        private val scannedRuntimes = WeakIdentitySet<ReactContext>()

        override fun runtimeOfRootTag(rootTag: Int): HotUpdaterRuntimeRoots.Runtime? {
            registeredRuntimes().forEach { runtime ->
                if (RootViews.rootViewOf(RootViews.uiManagersOf(runtime), rootTag) != null) {
                    return HotUpdaterRuntimeRoots.Runtime(runCatching { runtime.sourceURL }.getOrNull())
                }
            }
            return null
        }

        override fun runtimeURLsShownIn(activity: Activity): List<String?> {
            val runtimes = registeredRuntimes()
            if (runtimes.isEmpty()) return emptyList()
            val nextRootViewTag = RootViews.nextRootViewTag() ?: return emptyList()
            val uiManagers = runtimes.associateWith { RootViews.uiManagersOf(it) }
            // A runtime registered since: its roots may be older than the recent tags.
            if (runtimes.map(scannedRuntimes::add).any { it }) liveRootTags.rescanAll()
            val rootTags =
                liveRootTags.liveTags(nextRootViewTag) { rootTag ->
                    uiManagers.values.any { RootViews.rootViewOf(it, rootTag) != null }
                }
            return runtimes
                .filter { runtime ->
                    rootTags.any { rootTag ->
                        RootViews.rootViewOf(uiManagers.getValue(runtime), rootTag)?.let { isShownIn(it, activity) } ==
                            true
                    }
                }.map { runCatching { it.sourceURL }.getOrNull() }
        }

        private fun isShownIn(
            view: View,
            activity: Activity,
        ): Boolean =
            view.isAttachedToWindow &&
                view.isShown &&
                view.windowVisibility == View.VISIBLE &&
                RootViews.ownerActivity(view.context) === activity &&
                isStarted(activity)
    }

    internal object RootViews {
        // UIManagerType.LEGACY, named DEFAULT before React Native 0.80.
        private const val LEGACY_UI_MANAGER = 1

        /** [runtime]'s UI managers: Fabric's, and the legacy one of a runtime on the bridge. */
        fun uiManagersOf(runtime: ReactContext): List<UIManager> =
            listOf(UIManagerType.FABRIC, LEGACY_UI_MANAGER)
                .mapNotNull { type -> runCatching { UIManagerHelper.getUIManager(runtime, type) }.getOrNull() }
                .distinct()

        /**
         * The view of [rootTag] one of [uiManagers] holds: Fabric's surfaces
         * hold their root view under the surface id, which is the root tag,
         * and the legacy UI manager its root views under theirs.
         */
        fun rootViewOf(
            uiManagers: List<UIManager>,
            rootTag: Int,
        ): View? = uiManagers.firstNotNullOfOrNull { runCatching { it.resolveView(rootTag) }.getOrNull() }

        /**
         * Every root tag React Native handed out so far: one counter serves
         * every runtime and both renderers, from 1 in steps of 10. Null when
         * the counter can't be read.
         */
        fun nextRootViewTag(): Int? =
            runCatching {
                val generator = Class.forName("com.facebook.react.uimanager.ReactRootViewTagGenerator")
                // A Kotlin object's field from React Native 0.80, a Java static before.
                listOf("nextRootViewTag", "sNextRootViewTag")
                    .firstNotNullOfOrNull { name -> runCatching { generator.getDeclaredField(name) }.getOrNull() }
                    ?.apply { isAccessible = true }
                    ?.getInt(null)
            }.getOrNull()

        /** The activity a view's context belongs to, through wrappers such as a dialog's theme. */
        fun ownerActivity(context: Context?): Activity? {
            var current = context
            repeat(MAX_CONTEXT_DEPTH) {
                when (current) {
                    is Activity -> return current as Activity
                    is ReactContext -> return (current as ReactContext).currentActivity
                    is ContextWrapper -> current = (current as ContextWrapper).baseContext
                    else -> return null
                }
            }
            return null
        }

        private const val MAX_CONTEXT_DEPTH = 16
    }
}

/**
 * The root tags whose root view a registered runtime holds, however many
 * React Native handed out before them. React Native hands out root tags from
 * one counter for every runtime and both renderers, from 1 in steps of 10,
 * and lists no live roots: each tag handed out is looked at once it is, and
 * the ones a runtime holds are kept until their root goes, which no age
 * bounds. Tags no runtime held yet, such as main's (whose runtime isn't
 * registered), are looked at again only while they are among the latest
 * [maxUnheld]: a dead tag is never live again. A runtime that registers may
 * hold an older one, shown before its HotUpdater module was created, so
 * [rescanAll] has every tag handed out looked at once more.
 */
internal class HotUpdaterLiveRootTags(
    private val maxUnheld: Int = 64,
) {
    private var nextUnseen = ROOT_TAG_FIRST
    private val live = linkedSetOf<Int>()
    private val unheld = ArrayDeque<Int>()

    /** Looks at every tag handed out again on the next [liveTags], as after a runtime registered. Rare. */
    @Synchronized
    fun rescanAll() {
        nextUnseen = ROOT_TAG_FIRST
        unheld.clear()
    }

    /** The live root tags, with [nextRootViewTag] React Native's counter; [isHeld] whether a runtime holds a tag's root. */
    @Synchronized
    fun liveTags(
        nextRootViewTag: Int,
        isHeld: (Int) -> Boolean,
    ): List<Int> {
        while (nextUnseen < nextRootViewTag) {
            if (nextUnseen !in live) unheld.addLast(nextUnseen)
            nextUnseen += ROOT_TAG_STEP
        }
        live.retainAll(isHeld)
        val held = unheld.filter(isHeld)
        unheld.removeAll(held.toSet())
        live += held
        while (unheld.size > maxUnheld) unheld.removeFirst()
        return live.toList()
    }

    private companion object {
        const val ROOT_TAG_FIRST = 1
        const val ROOT_TAG_STEP = 10
    }
}

/** Root views React Native's UI managers know, in any window. Main thread. */
internal interface HotUpdaterRuntimeRoots {
    /** A registered runtime, by the URL it loaded its bundle from. */
    data class Runtime(
        val sourceURL: String?,
    )

    /** The registered runtime holding root view [rootTag], or null. */
    fun runtimeOfRootTag(rootTag: Int): Runtime?

    /** The source URLs of the registered runtimes whose root view a started [activity] shows in any of its windows. */
    fun runtimeURLsShownIn(activity: Activity): List<String?>
}

/** React Native root views an activity's decor view contains. Main thread. */
internal fun interface HotUpdaterDecorRoots {
    /** A root view, by its root tag and the URL its runtime loaded, null before it joins one. */
    data class Root(
        val rootTag: Int,
        val sourceURL: String?,
    )

    fun rootsIn(activity: Activity): List<Root>
}

internal fun rootViewsIn(view: View): List<ReactRootView> {
    if (view is ReactRootView) return listOf(view)
    if (view !is ViewGroup) return emptyList()
    return (0 until view.childCount).flatMap { rootViewsIn(view.getChildAt(it)) }
}
