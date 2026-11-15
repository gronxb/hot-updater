package com.hotupdater

import android.content.Intent

/** What the sandbox's activity does with the intent that started it. */
internal enum class HotUpdaterSandboxStartDecision {
    /** A person opened the app: the screen, with JavaScript not started. */
    SHOW_SCREEN,

    /** A sandbox link: the screen, and the link never reaches the app. */
    SHOW_LINK,

    /** The app was asked for: its activity at once, with a copy of the intent. */
    OPEN_HOST,
}

/** The parts of a start's intent the decision reads. */
internal data class HotUpdaterSandboxStartFacts(
    val action: String?,
    val dataScheme: String?,
    val hasData: Boolean,
    val categories: Set<String>,
    val hasExtras: Boolean,
    val hasClipData: Boolean,
    val flags: Int,
    /** The system recreated this activity from its saved state. */
    val restored: Boolean,
    /** This build's own URL scheme, or null in a build from before it was recorded. */
    val ownScheme: String? = null,
    /**
     * The process before this one was covering the app it started under the
     * screen, for a waiting link, when it ended.
     */
    val coveredStartInterrupted: Boolean = false,
)

internal object HotUpdaterSandboxStart {
    /**
     * Sandbox links come first, so no flag can apply one unconfirmed. A
     * relaunch from Recents repeats the task's first intent, whose link was
     * already taken: the pending links hold it if it is still unanswered.
     *
     * `FLAG_ACTIVITY_CLEAR_TASK` is how the SDK's restart reaches this activity,
     * and keeps `reload()` from stopping at the screen. Anyone can set it, so it
     * only ever skips the screen, as any other start of the app's own activity
     * does. Only the launcher's plain intent shows the screen; anything more,
     * such as a notification's extras or a shortcut's data, is for the app.
     */
    fun decide(facts: HotUpdaterSandboxStartFacts): HotUpdaterSandboxStartDecision {
        if (HotUpdaterSandboxLink.isOwnScheme(facts.dataScheme, facts.ownScheme)) {
            val fromRecents = facts.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
            return if (facts.restored || fromRecents) {
                HotUpdaterSandboxStartDecision.SHOW_SCREEN
            } else {
                HotUpdaterSandboxStartDecision.SHOW_LINK
            }
        }
        if (facts.restored) return HotUpdaterSandboxStartDecision.SHOW_SCREEN
        if (facts.flags and Intent.FLAG_ACTIVITY_CLEAR_TASK != 0) {
            // An SDK restart, such as a forced update, of an app the screen covered for a
            // link comes back to the screen, which asks that link.
            return if (facts.coveredStartInterrupted) {
                HotUpdaterSandboxStartDecision.SHOW_SCREEN
            } else {
                HotUpdaterSandboxStartDecision.OPEN_HOST
            }
        }
        val fromLauncher =
            facts.action == Intent.ACTION_MAIN &&
                facts.categories.contains(Intent.CATEGORY_LAUNCHER) &&
                !facts.hasData &&
                !facts.hasExtras &&
                !facts.hasClipData
        return if (fromLauncher) HotUpdaterSandboxStartDecision.SHOW_SCREEN else HotUpdaterSandboxStartDecision.OPEN_HOST
    }

    /**
     * Whether the screen for a link starts again in a task of its own before it
     * shows. A task keeps the intent that started it as its identity, after this
     * activity hands it to the app and finishes, and Android only brings forward
     * a task whose identity equals a new start's: the same link again would reach
     * nothing. The task it moves to has the launcher's intent, with the link
     * carried along, so it is one the launcher could have started, and the start
     * there, which carries the link, stays.
     */
    fun movesToOwnTask(
        decision: HotUpdaterSandboxStartDecision,
        created: Boolean,
        taskRoot: Boolean,
        carried: Boolean,
    ): Boolean = decision == HotUpdaterSandboxStartDecision.SHOW_LINK && created && taskRoot && !carried

    /**
     * Whether opening the app from a screen only closes the screen, over the app's
     * activity beneath it: a running one, when nothing was switched, or one a
     * process death left in the task, which the system brings back on what's
     * selected. Starting the app's activity there would stack a second one.
     */
    fun opensBeneath(
        hostRunning: Boolean,
        switched: Boolean,
        coversHost: Boolean,
        hostUnderScreen: Boolean,
    ): Boolean = (hostRunning && !switched) || (!hostRunning && (coversHost || hostUnderScreen))

    /**
     * Whether a task holds the app's activity under the screen and nothing else:
     * its first activity is the app's, and the screen is the only other one. Only
     * then does closing the screen show the app. The sandbox's own camera, for
     * one, can start in the screen's task. [implementation] names the activity a
     * component runs as, an alias's target, or null for one it can't read: the
     * app's activity can be named by its launcher alias on either side.
     */
    fun holdsHostUnderScreen(
        baseActivity: String?,
        numActivities: Int,
        host: String,
        implementation: (String) -> String?,
    ): Boolean {
        if (numActivities != 2 || baseActivity == null) return false
        val expected = implementation(host) ?: return false
        return implementation(baseActivity) == expected
    }

    /** The link an intent holds: its data, or, with none, the one a move to a task of its own carried. */
    fun linkOf(
        data: String?,
        carried: String?,
    ): String? = data ?: carried

    /** How the move starts that task: a new one, even beside this one, which it then removes. */
    const val OWN_TASK_FLAGS =
        Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION

    /**
     * The flags of the copy that opens the app's activity: its grants and how
     * the sender wanted it started, without what only described this start.
     * `CLEAR_TASK` would clear the task this activity is about to hand over.
     */
    fun hostFlags(flags: Int): Int =
        flags and
            (
                Intent.FLAG_ACTIVITY_CLEAR_TASK or
                    Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY or
                    Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT or
                    Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED or
                    Intent.FLAG_ACTIVITY_MULTIPLE_TASK or
                    Intent.FLAG_ACTIVITY_NEW_DOCUMENT or
                    Intent.FLAG_ACTIVITY_TASK_ON_HOME or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                    Intent.FLAG_ACTIVITY_RETAIN_IN_RECENTS or
                    Intent.FLAG_ACTIVITY_FORWARD_RESULT
            ).inv()
}
