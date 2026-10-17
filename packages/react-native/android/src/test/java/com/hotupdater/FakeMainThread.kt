package com.hotupdater

/** A main thread whose posted and delayed work the test runs by hand. */
internal class FakeMainThread(
    var current: Boolean = true,
) : HotUpdaterMainThread {
    private val tasks = mutableListOf<Runnable>()

    val waiting: Int
        get() = tasks.size

    override fun isCurrent(): Boolean = current

    override fun post(task: Runnable) {
        tasks += task
    }

    override fun postDelayed(
        task: Runnable,
        delayMs: Long,
    ) {
        tasks += task
    }

    override fun remove(task: Runnable) {
        tasks.removeAll { it === task }
    }

    /** Takes the waiting work off the queue, as the looper does just before running it. */
    fun take(): List<Runnable> = tasks.toList().also { tasks.clear() }

    fun runAll() = take().forEach(Runnable::run)
}
