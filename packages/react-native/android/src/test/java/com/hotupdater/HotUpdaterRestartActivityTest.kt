package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Test

class HotUpdaterRestartActivityTest {
    /** A clock and a queue of posted checks, run in order. */
    private class Scheduler {
        var now = 0L
        val posted = ArrayDeque<Pair<Long, () -> Unit>>()

        fun post(
            delayMs: Long,
            action: () -> Unit,
        ) {
            posted.addLast(delayMs to action)
        }

        fun runAll() {
            while (posted.isNotEmpty()) {
                val (delayMs, action) = posted.removeFirst()
                now += delayMs
                action()
            }
        }
    }

    @Test
    fun `relaunches at once when the old process is already gone`() {
        val scheduler = Scheduler()
        var relaunches = 0

        HotUpdaterRestartActivity.awaitProcessExit({ false }, scheduler::post, { scheduler.now }) { relaunches += 1 }

        assertEquals(1, relaunches)
        assertEquals(0, scheduler.posted.size)
    }

    @Test
    fun `relaunches only once the old process is gone`() {
        val scheduler = Scheduler()
        var alive = 3
        var relaunchedAt = -1L

        HotUpdaterRestartActivity.awaitProcessExit({ alive-- > 0 }, scheduler::post, { scheduler.now }) {
            relaunchedAt = scheduler.now
        }
        assertEquals(-1L, relaunchedAt)

        scheduler.runAll()
        assertEquals(75L, relaunchedAt)
    }

    @Test
    fun `relaunches anyway when the old process outlives the wait`() {
        val scheduler = Scheduler()
        var relaunches = 0
        var relaunchedAt = -1L

        HotUpdaterRestartActivity.awaitProcessExit({ true }, scheduler::post, { scheduler.now }) {
            relaunches += 1
            relaunchedAt = scheduler.now
        }
        scheduler.runAll()

        assertEquals(1, relaunches)
        assertEquals(HotUpdaterRestartActivity.PROCESS_EXIT_TIMEOUT_MS, relaunchedAt)
    }
}
