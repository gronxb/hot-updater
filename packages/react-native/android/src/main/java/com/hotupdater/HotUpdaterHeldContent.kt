package com.hotupdater

/**
 * First content no instance could be told for yet. A named runtime may render
 * before its HotUpdater module exists, in an activity nothing followed, or
 * before its root view is attached to an activity, so its view can't be found
 * until the module hands over its activity or the view is attached. Crediting
 * that content to main would leave the named launch unfinished, and its next
 * process would roll a working bundle back.
 *
 * Held content is resolved again whenever a named runtime registers and
 * whenever a launch gate looks at an activity's views. After
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
    /** The instance of the view with this root tag, with its runtime's launch, or null while it can't be found. Main thread only. */
    private val resolve: (Int) -> HotUpdaterRootOwner?,
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
        val evicted =
            synchronized(this) {
                // A root view's first content counts once.
                if (held.any { it.rootTag == rootTag }) return
                held += Held(rootTag, clock(), generations)
                // Root tags are small and each is a root view that rendered,
                // so every one is kept while a named launch may own it. Only
                // past this bound does the oldest leave, and only after it
                // verified main, as content no instance claims does.
                if (held.size > MAX_HELD) held.removeAt(0).takeUnless { it.creditedToMain } else null
            }
        evicted?.generations?.get(HotUpdaterInstanceEnvironment.MAIN_NAME)?.let { credit(HotUpdaterInstanceEnvironment.MAIN_NAME, it) }
        mainThread.postDelayed({ creditExpiredToMain() }, HOLD_MS)
    }

    /** A named runtime registered: its views may be found now. */
    fun runtimeRegistered() {
        if (mainThread.isCurrent()) resolveHeld() else mainThread.post { resolveHeld() }
    }

    /** Main thread: verifies the launches whose views can be told now. */
    fun resolveHeld() {
        val candidates = synchronized(this) { held.toList() }
        if (candidates.isEmpty()) return
        candidates.forEach { content ->
            val owner = resolve(content.rootTag) ?: return@forEach
            val instanceName = owner.instanceName
            val generation = owner.boundTo(content.generations)[instanceName]
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
        private const val MAX_HELD = 1024
    }
}
