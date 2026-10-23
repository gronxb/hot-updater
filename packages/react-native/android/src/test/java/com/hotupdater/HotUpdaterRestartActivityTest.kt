package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Test

class HotUpdaterRestartActivityTest {
    /** A clock that only sleeping moves. */
    private class Clock {
        var now = 0L
        var sleeps = 0

        fun sleep(ms: Long) {
            now += ms
            sleeps += 1
        }
    }

    @Test
    fun `relaunches at once when the old process is already gone`() {
        val clock = Clock()

        HotUpdaterRestartActivity.awaitProcessExit({ false }, clock::sleep, { clock.now })

        assertEquals(0, clock.sleeps)
    }

    @Test
    fun `waits until the old process is gone`() {
        val clock = Clock()
        var alive = 3

        HotUpdaterRestartActivity.awaitProcessExit({ alive-- > 0 }, clock::sleep, { clock.now })

        assertEquals(3, clock.sleeps)
        assertEquals(75L, clock.now)
    }

    @Test
    fun `relaunches anyway when the old process outlives the wait`() {
        val clock = Clock()

        HotUpdaterRestartActivity.awaitProcessExit({ true }, clock::sleep, { clock.now })

        assertEquals(HotUpdaterRestartActivity.PROCESS_EXIT_TIMEOUT_MS, clock.now)
    }
}
