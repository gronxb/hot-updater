package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class HotUpdaterRecoveryStateTest {
    @Test
    fun `content queued after a fatal error cannot verify the failed bundle`() {
        val state = HotUpdaterRecoveryState()
        state.start("crashed-bundle", true)

        val request = requireNotNull(state.requestRecovery())
        assertNull(state.completeLaunch())
        state.finishRecoveryRequest(request, true)

        assertNull(state.completeLaunch())
        assertEquals(HotUpdaterRecoveryState.Launch("crashed-bundle", true), state.snapshot())
    }

    @Test
    fun `a fatal error after first content preserves the verified bundle`() {
        val state = HotUpdaterRecoveryState()
        state.start("verified-bundle", true)

        assertNotNull(state.completeLaunch())

        assertNull(state.requestRecovery())
        assertNull(state.completeLaunch())
        assertEquals(HotUpdaterRecoveryState.Launch("verified-bundle", false), state.snapshot())
    }

    @Test
    fun `concurrent fatal errors schedule only one restart while the request is in flight`() {
        val state = HotUpdaterRecoveryState()
        state.start("crashed-bundle", true)
        val begin = CountDownLatch(1)
        val finished = CountDownLatch(2)
        val restartRequests = AtomicInteger()
        val handledErrors = AtomicInteger()
        val workers =
            List(2) {
                Thread {
                    begin.await()
                    val request = state.requestRecovery()
                    if (request != null) {
                        handledErrors.incrementAndGet()
                        if (request.shouldRestart) restartRequests.incrementAndGet()
                    }
                    finished.countDown()
                }.apply { start() }
            }
        begin.countDown()
        assertTrue(finished.await(5, TimeUnit.SECONDS))
        workers.forEach { it.join() }

        assertEquals(2, handledErrors.get())
        assertEquals(1, restartRequests.get())
        assertNull(state.completeLaunch())
    }

    @Test
    fun `a failed restart keeps the crash unverified and permits another restart request`() {
        val state = HotUpdaterRecoveryState()
        state.start("crashed-bundle", true)
        val request = requireNotNull(state.requestRecovery())

        state.finishRecoveryRequest(request, false)

        assertNull(state.completeLaunch())
        val retry = requireNotNull(state.requestRecovery())
        assertTrue(retry.shouldRestart)
        state.finishRecoveryRequest(retry, true)
        assertFalse(requireNotNull(state.requestRecovery()).shouldRestart)
    }

    @Test
    fun `a previous launch restart completion cannot change the next launch`() {
        val state = HotUpdaterRecoveryState()
        state.start("crashed-bundle", true)
        val request = requireNotNull(state.requestRecovery())
        state.start("safe-bundle", false)

        state.finishRecoveryRequest(request, true)

        assertEquals("safe-bundle", state.completeLaunch()?.bundleId)
        state.stop()
        assertNull(state.snapshot())
        assertNull(state.requestRecovery())
    }
}
