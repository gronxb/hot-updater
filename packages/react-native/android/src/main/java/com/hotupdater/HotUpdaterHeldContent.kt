package com.hotupdater

/**
 * First content no instance could be told for yet. A named runtime may render
 * before its HotUpdater module exists, in an activity nothing followed, so
 * its view can't be found until the module hands over its activity. Crediting
 * that content to main would leave the named launch unfinished, and its next
 * process would roll a working bundle back.
 *
 * Held content is resolved again whenever a named runtime registers. After
 * [HOLD_MS] still-unresolved content verifies main, as unattributed content
 * always has, once; it stays held, so a named runtime that registers later
 * still verifies its own launch with it.
 *
 * Each hold remembers every instance's launch generation then, so content
 * never verifies a launch that started after it appeared.
 */
internal class HotUpdaterHeldContent(
    private val mainThread: HotUpdaterMainThread,
    private val clock: () -> Long,
    /** The instance of the view with this root tag, or null while it can't be found. Main thread only. */
    private val resolve: (Int) -> String?,
    /** Verifies the launch of [generation] of the instance. */
    private val credit: (instanceName: String, generation: Long) -> Unit,
) {
    private class Held(
        val rootTag: Int,
        val heldAt: Long,
        val generations: Map<String, Long>,
        var creditedToMain: Boolean = false,
    )

    private val held = ArrayList<Held>()

    /** Holds the content of [rootTag], seen while the instances had these launch [generations]. */
    fun hold(
        rootTag: Int,
        generations: Map<String, Long>,
    ) {
        synchronized(this) {
            held += Held(rootTag, clock(), generations)
            // Each held view is a root view that rendered; a few cover any app.
            while (held.size > MAX_HELD) held.removeAt(0)
        }
        mainThread.postDelayed({ creditExpiredToMain() }, HOLD_MS)
    }

    /** A named runtime registered: its views may be found now. */
    fun runtimeRegistered() {
        if (mainThread.isCurrent()) resolveHeld() else mainThread.post { resolveHeld() }
    }

    /** Main thread: verifies the launches whose views can be told now. */
    fun resolveHeld() {
        val candidates = synchronized(this) { held.toList() }
        candidates.forEach { content ->
            val instanceName = resolve(content.rootTag) ?: return@forEach
            val generation = content.generations[instanceName]
            val alreadyCredited = instanceName == HotUpdaterInstanceEnvironment.MAIN_NAME && content.creditedToMain
            synchronized(this) { held.remove(content) }
            if (generation != null && !alreadyCredited) credit(instanceName, generation)
        }
    }

    /** Content held [HOLD_MS] without an instance verifies main, once. */
    fun creditExpiredToMain() {
        val now = clock()
        val expired =
            synchronized(this) {
                held.filter { !it.creditedToMain && now - it.heldAt >= HOLD_MS }.onEach { it.creditedToMain = true }
            }
        expired.forEach { content ->
            content.generations[HotUpdaterInstanceEnvironment.MAIN_NAME]?.let { credit(HotUpdaterInstanceEnvironment.MAIN_NAME, it) }
        }
    }

    companion object {
        const val HOLD_MS = 10_000L
        private const val MAX_HELD = 16
    }
}
