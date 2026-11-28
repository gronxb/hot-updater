package com.hotupdater

import java.lang.ref.WeakReference

/** The app's activity under a screen, as that screen sees it. */
internal interface HotUpdaterSandboxCoveredHost {
    /** Finished, destroyed, or moved out of the screen's task: nothing to forward to. */
    val isGone: Boolean

    /** Its React Native runs as the app in front would. */
    fun resumeReact()

    fun pauseReact()

    fun finish()
}

/**
 * One start of the app under a screen, from the request to the screen's end. It
 * belongs to the screen that asked and the task it's in. A recreation of that
 * screen adopts it, so the start never runs twice.
 *
 * While the screen is in front, it resumes the covered app's React Native, whose
 * own pause stopped its timers. That resume is the sandbox's, so the sandbox
 * pauses it again when the screen leaves, the host goes, or the cover ends.
 */
internal class HotUpdaterSandboxCover(
    /** The manifest's host activity, by class name. */
    val hostClassName: String,
    val taskId: Int,
    owner: Any,
) {
    private var owner = WeakReference(owner)

    var host: HotUpdaterSandboxCoveredHost? = null
        private set

    /** Whether the covered app's React Native runs on the sandbox's resume, not its own. */
    var resumedBySandbox = false
        private set

    fun isOwnedBy(screen: Any) = owner.get() === screen

    fun owner(): Any? = owner.get()

    /** A recreated screen takes over its predecessor's cover. */
    fun adopt(screen: Any) {
        owner = WeakReference(screen)
    }

    /** The app's activity this cover started, while it's still there to cover. */
    fun liveHost(): HotUpdaterSandboxCoveredHost? = host?.takeUnless { it.isGone }

    fun hostCreated(created: HotUpdaterSandboxCoveredHost) {
        host = created
    }

    /** The covered activity went: nothing is forwarded to it any more. */
    fun hostDestroyed(destroyed: HotUpdaterSandboxCoveredHost) {
        if (host !== destroyed) return
        host = null
        resumedBySandbox = false
    }

    fun screenResumed(screen: Any) {
        if (!isOwnedBy(screen) || resumedBySandbox) return
        val covered = liveHost() ?: return
        covered.resumeReact()
        resumedBySandbox = true
    }

    fun screenPaused(screen: Any) {
        if (!isOwnedBy(screen) || !resumedBySandbox) return
        resumedBySandbox = false
        liveHost()?.pauseReact()
    }

    /** The screen goes for good: what the sandbox resumed is paused, and the app's own lifecycle takes over. */
    fun end(screen: Any) {
        screenPaused(screen)
        if (isOwnedBy(screen)) host = null
    }
}

/**
 * A start under the screen waits for the screen's first frame to be on the display,
 * or the app's would be what shows. [schedule] runs its block after the next frame
 * and returns what cancels it.
 */
internal class HotUpdaterSandboxFirstFrameStart(
    private val schedule: (() -> Unit) -> (() -> Unit),
    private val start: () -> Unit,
) {
    private var drawn = false
    private var requested = false
    private var destroyed = false
    private var cancelScheduled: (() -> Unit)? = null

    /** Starts now if the screen is on the display, or once it is. */
    fun request() {
        if (destroyed) return
        if (drawn) {
            start()
        } else {
            requested = true
        }
    }

    /** The screen drew its first frame: it's on the display by the next one. */
    fun drew() {
        if (destroyed || drawn || cancelScheduled != null) return
        cancelScheduled =
            schedule {
                cancelScheduled = null
                if (destroyed) return@schedule
                drawn = true
                if (requested) {
                    requested = false
                    start()
                }
            }
    }

    /** Lets go of [request] without starting it. */
    fun withdraw() {
        requested = false
    }

    /** The screen goes: nothing scheduled runs. Returns whether a request was still waiting, for its successor. */
    fun destroy(): Boolean {
        destroyed = true
        cancelScheduled?.invoke()
        cancelScheduled = null
        val waiting = requested
        requested = false
        return waiting
    }
}

/**
 * Android relaunches the activity beneath one that crashed, from its saved state:
 * after a crash in the app started under the screen, that would show the app the
 * screen was covering, and run it again. This finishes the covered app first, then
 * hands the crash on unchanged: the crash and its bookkeeping are the app's.
 */
internal object HotUpdaterSandboxCrashGuard {
    private var installed = false

    fun install(hiddenHost: () -> HotUpdaterSandboxCoveredHost?) {
        synchronized(this) {
            if (installed) return
            installed = true
            Thread.setDefaultUncaughtExceptionHandler(wrap(Thread.getDefaultUncaughtExceptionHandler(), hiddenHost))
        }
    }

    fun wrap(
        previous: Thread.UncaughtExceptionHandler?,
        hiddenHost: () -> HotUpdaterSandboxCoveredHost?,
        kill: () -> Unit = {
            android.os.Process.killProcess(android.os.Process.myPid())
            kotlin.system.exitProcess(10)
        },
    ): Thread.UncaughtExceptionHandler =
        Thread.UncaughtExceptionHandler { thread, throwable ->
            try {
                hiddenHost()?.finish()
            } catch (_: Throwable) {
                // The crash goes on as it would.
            }
            previous?.uncaughtException(thread, throwable) ?: kill()
        }
}
