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
        if (HotUpdaterSandboxLink.isSandboxScheme(facts.dataScheme)) {
            val fromRecents = facts.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
            return if (facts.restored || fromRecents) {
                HotUpdaterSandboxStartDecision.SHOW_SCREEN
            } else {
                HotUpdaterSandboxStartDecision.SHOW_LINK
            }
        }
        if (facts.restored) return HotUpdaterSandboxStartDecision.SHOW_SCREEN
        if (facts.flags and Intent.FLAG_ACTIVITY_CLEAR_TASK != 0) return HotUpdaterSandboxStartDecision.OPEN_HOST
        val fromLauncher =
            facts.action == Intent.ACTION_MAIN &&
                facts.categories.contains(Intent.CATEGORY_LAUNCHER) &&
                !facts.hasData &&
                !facts.hasExtras &&
                !facts.hasClipData
        return if (fromLauncher) HotUpdaterSandboxStartDecision.SHOW_SCREEN else HotUpdaterSandboxStartDecision.OPEN_HOST
    }

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
