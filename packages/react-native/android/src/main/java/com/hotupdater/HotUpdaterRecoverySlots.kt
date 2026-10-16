package com.hotupdater

/**
 * Which instances a crash charges. Each instance's launch is watched on its
 * own, but a crash ends the whole process, so the process-wide crash paths
 * (the uncaught exception handler, the native signal handler, and JavaScript
 * fatal errors) ask this table which instances' crash markers to write.
 *
 * Each instance that monitors a launch takes one of [capacity] slots, which
 * the native signal handler mirrors (HotUpdaterRecovery.cpp): main always
 * takes slot 0. The signal handler can't allocate, so the slots are fixed; an
 * instance that finds them full gets no marker from a native crash, and its
 * unfinished launch still rolls back through `launchInProgress`.
 */
internal class HotUpdaterRecoverySlots(
    private val capacity: Int = SLOT_COUNT,
) {
    /** What one instance's crash monitoring knows about its current launch. */
    data class Launch(
        val name: String,
        val bundleId: String?,
        /** The launch waits for its first content, so a crash rolls it back. */
        val shouldRollback: Boolean,
        /** One of its views was shown. Main counts from the start, as it always has. */
        val armed: Boolean,
        /** Its first content appeared, so its runtime finished loading its bundle. */
        val contentAppeared: Boolean = false,
    ) {
        val isMain: Boolean
            get() = name == HotUpdaterInstanceEnvironment.MAIN_NAME

        /** A crash nobody claims charges this launch. */
        val unverified: Boolean
            get() = shouldRollback && armed
    }

    private val slots = HashMap<String, Int>()
    private var attributedName: String? = null

    /** The slot of [name], taken on first use, or null when every slot is taken. */
    @Synchronized
    fun slotOf(name: String): Int? {
        if (name == HotUpdaterInstanceEnvironment.MAIN_NAME) return MAIN_SLOT
        slots[name]?.let { return it }
        // Names stay in their slot for the process: there are only a few, and a
        // slot reused for another name could write a marker into the wrong store.
        val slot = slots.size + 1
        if (slot >= capacity) return null
        slots[name] = slot
        return slot
    }

    /** The slot [name] already has, without taking one. */
    @Synchronized
    fun assignedSlot(name: String): Int? = if (name == HotUpdaterInstanceEnvironment.MAIN_NAME) MAIN_SLOT else slots[name]

    /**
     * Records that the crash about to happen is [name]'s JavaScript fatal
     * error, so the crash paths it ends in charge no other instance.
     */
    @Synchronized
    fun attribute(name: String) {
        attributedName = name
    }

    /** Ends the claim: the claimed error did not end the process. */
    @Synchronized
    fun clearAttribution() {
        attributedName = null
    }

    /**
     * The instance the current crash belongs to, or null when nobody claimed
     * it. A claim holds until its release ([clearAttribution]): a fatal error
     * that didn't end the process, such as one a development build shows on
     * screen, must not claim a later crash, and the launches it left alone
     * count again only with that release.
     */
    @Synchronized
    fun attributedName(): String? = attributedName

    companion object {
        /** Kept equal to kSlotCount in HotUpdaterRecovery.cpp. */
        const val SLOT_COUNT = 8
        const val MAIN_SLOT = 0

        /**
         * How long a claimed error has to end the process before its claim is
         * released. The native claim falls back to expiring later
         * (kNativeClaimFallbackMilliseconds in HotUpdaterRecovery.cpp), only
         * for a release that never runs.
         */
        const val ATTRIBUTION_WINDOW_MS = 5_000L

        /**
         * The instance a JavaScript error no runtime claimed most likely came
         * from, or null to leave it unclaimed. A runtime whose bundle throws
         * while it loads, before JavaScript reaches HotUpdater, never has its
         * module, so nothing hooks its errors. Any launch of this process
         * whose runtime hasn't shown it finished loading may have thrown: one
         * without first content and, for a named instance, without its module
         * (main's runtime never registers one). Whether it may roll back says
         * nothing about that: a built-in bundle throws as well. Only when the
         * one such launch is a named launch waiting for its first content is
         * the error its: charging every armed launch instead would miss it
         * until one of its views is shown, and the next start would select
         * the same failing bundle.
         */
        fun inferJavaScriptErrorOwner(
            launches: Collection<Launch>,
            registeredRuntimes: Set<String>,
        ): String? {
            val possibleOwner =
                launches
                    .filter { !it.contentAppeared && (it.isMain || it.name !in registeredRuntimes) }
                    .singleOrNull() ?: return null
            return possibleOwner.name.takeIf { !possibleOwner.isMain && possibleOwner.shouldRollback }
        }

        /**
         * The launches whose crash markers a crash writes. A crash claimed by
         * an instance writes only that instance's marker, for any launch still
         * waiting for its first content: its runtime threw, shown or not.
         * Otherwise every launch a crash can be blamed on gets one: an armed
         * launch still waiting for its first content. Main also records a
         * verified launch, which never rolls back, as it always has.
         */
        fun markerTargets(
            launches: Collection<Launch>,
            attributedName: String?,
        ): List<Launch> =
            if (attributedName != null) {
                launches.filter { it.name == attributedName && (it.isMain || it.shouldRollback) }
            } else {
                launches.filter { it.isMain || it.unverified }
            }
    }
}
