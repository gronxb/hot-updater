package com.hotupdater

import android.app.Activity
import android.app.Application
import android.content.ComponentName
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import java.io.File
import java.lang.ref.WeakReference

/**
 * A host start the sandbox's screen covers: the next creation of [host] in the
 * screen's task brings that screen back on top, before the host's first frame.
 */
internal class HotUpdaterSandboxCover(
    val host: ComponentName,
    val taskId: Int,
    screen: HotUpdaterSandboxActivity,
) {
    private val screen = WeakReference(screen)

    fun isFrom(activity: HotUpdaterSandboxActivity) = screen.get() === activity

    fun screen(): HotUpdaterSandboxActivity? = screen.get()
}

/**
 * Follows the app's own activities from the process's start, since a provider
 * runs before `Application.onCreate`. Whether the sandbox's activity is over a
 * running app is read from here, so it dies with the process: an activity
 * restored after a process death sees no app beneath it.
 */
internal class HotUpdaterSandboxProcess : ContentProvider() {
    companion object {
        /** The app's activities alive now, without the sandbox's and the SDK's restart. */
        @Volatile
        var hostActivities = 0
            private set

        /** An activity of the app ran in this process, so its React Native may have too. */
        @Volatile
        var hostStarted = false
            private set

        /**
         * What the previous process's crash left, read here because settling
         * deletes it, and a launch that skips the screen settles it too.
         */
        @Volatile
        var crashMarkerAtStart: PendingCrashRecovery? = null
            private set

        /** The host start a screen covers, until that host is created or the screen lets go. */
        @Volatile
        var pendingCover: HotUpdaterSandboxCover? = null

        /** The app's activity a screen started under itself and covers. */
        @Volatile
        var coveredHost: WeakReference<Activity>? = null

        /** Lets go of [screen]'s cover, if the pending one is its. */
        fun dropCover(screen: HotUpdaterSandboxActivity) {
            if (pendingCover?.isFrom(screen) == true) pendingCover = null
        }

        /** Main's marker, under the app's files directory. */
        internal fun crashMarkerFile(filesDir: File?) = File(File(filesDir, "bundle-store"), "recovery-crash-marker.json")

        private fun isHost(activity: Activity) =
            activity !is HotUpdaterSandboxActivity &&
                activity !is HotUpdaterRestartActivity &&
                activity !is HotUpdaterSandboxRelaunchActivity
    }

    override fun onCreate(): Boolean {
        // Before `Application.onCreate`, where a host may already read its bundle.
        context?.let(HotUpdaterSandboxDev::session)
        val application = context?.applicationContext as? Application
        crashMarkerAtStart =
            crashMarkerFile(application?.filesDir)
                .takeIf(File::exists)
                ?.let(PendingCrashRecovery::loadFromFile)
        val shake = application?.let(::HotUpdaterSandboxShake)
        application?.registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                private var notedLastLaunch = false

                override fun onActivityCreated(
                    activity: Activity,
                    savedInstanceState: Bundle?,
                ) {
                    if (!isHost(activity)) return
                    hostActivities += 1
                    hostStarted = true
                    val cover = pendingCover
                    if (cover != null && activity.componentName == cover.host && activity.taskId == cover.taskId) {
                        pendingCover = null
                        cover.screen()?.coverHost(activity)
                    }
                }

                override fun onActivityDestroyed(activity: Activity) {
                    if (isHost(activity)) hostActivities -= 1
                }

                override fun onActivityStarted(activity: Activity) = Unit

                override fun onActivityResumed(activity: Activity) {
                    if (!isHost(activity)) return
                    shake?.watch(activity)
                    if (!notedLastLaunch) {
                        notedLastLaunch = true
                        HotUpdaterSandbox.coordinator(activity).noteLastLaunch()
                    }
                }

                override fun onActivityPaused(activity: Activity) {
                    if (isHost(activity)) shake?.stop(activity)
                }

                override fun onActivityStopped(activity: Activity) = Unit

                override fun onActivitySaveInstanceState(
                    activity: Activity,
                    outState: Bundle,
                ) = Unit
            },
        )
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(
        uri: Uri,
        values: ContentValues?,
    ): Uri? = null

    override fun delete(
        uri: Uri,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
