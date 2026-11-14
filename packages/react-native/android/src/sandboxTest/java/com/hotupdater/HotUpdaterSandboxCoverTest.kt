package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeCoveredHost : HotUpdaterSandboxCoveredHost {
    override var isGone = false
    val calls = ArrayList<String>()

    override fun resumeReact() {
        calls += "resume"
    }

    override fun pauseReact() {
        calls += "pause"
    }

    override fun finish() {
        calls += "finish"
    }
}

/** A frame scheduler run by hand: each scheduled block waits for [runAll]. */
private class Frames {
    private val pending = ArrayList<() -> Unit>()

    fun schedule(block: () -> Unit): () -> Unit {
        pending += block
        return { pending.remove(block) }
    }

    val waiting get() = pending.size

    fun runAll() {
        val due = pending.toList()
        pending.clear()
        due.forEach { it() }
    }
}

class HotUpdaterSandboxCoverTest {
    @Test
    fun `a start asked for before the first frame waits for the frame after it`() {
        val frames = Frames()
        var starts = 0
        val start = HotUpdaterSandboxFirstFrameStart(frames::schedule) { starts += 1 }
        start.request()
        assertEquals(0, starts)
        start.drew()
        assertEquals("drawn, but not on the display yet", 0, starts)
        frames.runAll()
        assertEquals(1, starts)
        // Drawn already: a later request starts at once, and only once.
        start.request()
        assertEquals(2, starts)
    }

    @Test
    fun `a screen recreated between its draw and the next frame hands its start on, which runs once`() {
        val frames = Frames()
        var oldStarts = 0
        var newStarts = 0
        val old = HotUpdaterSandboxFirstFrameStart(frames::schedule) { oldStarts += 1 }
        old.request()
        old.drew()
        assertEquals(1, frames.waiting)

        // Recreated: the old screen's frame callback is cancelled, and its request goes on.
        val handedOn = old.destroy()
        assertTrue(handedOn)
        assertEquals(0, frames.waiting)

        val successor = HotUpdaterSandboxFirstFrameStart(frames::schedule) { newStarts += 1 }
        if (handedOn) successor.request()
        frames.runAll()
        assertEquals("nothing runs before the successor draws", 0, newStarts)
        successor.drew()
        frames.runAll()
        assertEquals(0, oldStarts)
        assertEquals(1, newStarts)
    }

    @Test
    fun `a destroyed screen starts nothing, even if its frame comes after all`() {
        var late: (() -> Unit)? = null
        var starts = 0
        val start =
            HotUpdaterSandboxFirstFrameStart({ block ->
                late = block
                // A cancel that comes too late to stop the callback.
                {}
            }) { starts += 1 }
        start.request()
        start.drew()
        start.destroy()
        late?.invoke()
        start.request()
        assertEquals(0, starts)
    }

    @Test
    fun `Open withdraws a start still waiting for the first frame`() {
        val frames = Frames()
        var starts = 0
        val start = HotUpdaterSandboxFirstFrameStart(frames::schedule) { starts += 1 }
        start.request()
        start.withdraw()
        start.drew()
        frames.runAll()
        assertEquals(0, starts)
        assertFalse("nothing to hand on", start.destroy())
    }

    @Test
    fun `the screen's resume runs the covered app once, and its background pauses it again`() {
        val screen = Any()
        val host = FakeCoveredHost()
        val cover = HotUpdaterSandboxCover("com.app.MainActivity", 7, screen)
        cover.hostCreated(host)

        cover.screenResumed(screen)
        cover.screenResumed(screen)
        assertEquals(listOf("resume"), host.calls)
        assertTrue(cover.resumedBySandbox)

        // Backgrounded: what the sandbox resumed is paused, once.
        cover.screenPaused(screen)
        cover.screenPaused(screen)
        assertEquals(listOf("resume", "pause"), host.calls)
        assertFalse(cover.resumedBySandbox)

        // In front again.
        cover.screenResumed(screen)
        assertEquals(listOf("resume", "pause", "resume"), host.calls)
    }

    @Test
    fun `a host destroyed while covered gets nothing more, and no crash finishes it`() {
        val screen = Any()
        val host = FakeCoveredHost()
        val cover = HotUpdaterSandboxCover("com.app.MainActivity", 7, screen)
        cover.hostCreated(host)
        cover.screenResumed(screen)

        host.isGone = true
        cover.hostDestroyed(host)
        assertNull(cover.liveHost())
        assertFalse(cover.resumedBySandbox)
        cover.screenPaused(screen)
        cover.screenResumed(screen)
        assertEquals(listOf("resume"), host.calls)

        // A gone host is never forwarded to, even before its destruction is reported.
        val other = FakeCoveredHost()
        val second = HotUpdaterSandboxCover("com.app.MainActivity", 7, screen)
        second.hostCreated(other)
        other.isGone = true
        second.screenResumed(screen)
        assertTrue(other.calls.isEmpty())
    }

    @Test
    fun `only the owning screen forwards, and a recreated one takes over`() {
        val owner = Any()
        val stranger = Any()
        val host = FakeCoveredHost()
        val cover = HotUpdaterSandboxCover("com.app.MainActivity", 7, owner)
        cover.hostCreated(host)
        cover.screenResumed(stranger)
        assertTrue(host.calls.isEmpty())

        cover.screenResumed(owner)
        cover.screenPaused(owner)
        val recreated = Any()
        cover.adopt(recreated)
        cover.screenResumed(owner)
        assertEquals(listOf("resume", "pause"), host.calls)
        cover.screenResumed(recreated)
        assertEquals(listOf("resume", "pause", "resume"), host.calls)
        assertSame(recreated, cover.owner())
    }

    @Test
    fun `the cover's end pauses what the sandbox resumed and lets go of the host`() {
        val screen = Any()
        val host = FakeCoveredHost()
        val cover = HotUpdaterSandboxCover("com.app.MainActivity", 7, screen)
        cover.hostCreated(host)
        cover.screenResumed(screen)
        cover.end(screen)
        assertEquals(listOf("resume", "pause"), host.calls)
        assertNull(cover.liveHost())
    }

    @Test
    fun `a crash finishes the covered app, then goes on unchanged to the handler before`() {
        val host = FakeCoveredHost()
        val seen = ArrayList<Throwable>()
        var killed = false
        val crash = IllegalStateException("startup crash")
        val guard =
            HotUpdaterSandboxCrashGuard.wrap(
                previous = { _, throwable ->
                    seen += throwable
                    host.calls += "previous"
                },
                hiddenHost = { host },
                kill = { killed = true },
            )
        guard.uncaughtException(Thread.currentThread(), crash)
        assertEquals(listOf("finish", "previous"), host.calls)
        assertSame(crash, seen.single())
        assertFalse(killed)
    }

    @Test
    fun `with nothing covered, or a finish that fails, the crash still goes on`() {
        var previousCalls = 0
        HotUpdaterSandboxCrashGuard
            .wrap(previous = { _, _ -> previousCalls += 1 }, hiddenHost = { null }, kill = {})
            .uncaughtException(Thread.currentThread(), RuntimeException())
        val failing =
            object : HotUpdaterSandboxCoveredHost {
                override val isGone = false

                override fun resumeReact() = Unit

                override fun pauseReact() = Unit

                override fun finish(): Unit = throw IllegalStateException("gone")
            }
        HotUpdaterSandboxCrashGuard
            .wrap(previous = { _, _ -> previousCalls += 1 }, hiddenHost = { failing }, kill = {})
            .uncaughtException(Thread.currentThread(), RuntimeException())
        assertEquals(2, previousCalls)

        var killed = false
        HotUpdaterSandboxCrashGuard
            .wrap(previous = null, hiddenHost = { null }, kill = { killed = true })
            .uncaughtException(Thread.currentThread(), RuntimeException())
        assertTrue(killed)
    }
}
