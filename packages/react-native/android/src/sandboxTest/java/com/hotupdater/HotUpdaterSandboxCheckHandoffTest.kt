package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val LINK_A = "hu-sandbox-app://hot-updater/preview?channel=pr-1&fingerprint=abc"
private const val LINK_B = "hu-sandbox-app://hot-updater/preview?channel=pr-2&fingerprint=abc"
private const val HOST = "com.example.MainActivity"

/** The preferences behind the record, which outlive each process. */
private class Disk {
    var value: String? = null
    private var tokens = 0

    /** A process's view of the record, as `HotUpdaterSandboxProcess.checkHandoffs` gives it. */
    fun process() = HotUpdaterSandboxCheckHandoffs({ value }, { value = it }, { "token-${++tokens}" })
}

/** What the app's first resumed activity is handed, as the provider's lifecycle callback reads it. */
private fun firstResume(
    handoff: HotUpdaterSandboxHostHandoff?,
    activity: String,
): String? = handoff?.forFirstResume(activity)

class HotUpdaterSandboxCheckHandoffTest {
    @Test
    fun `the restart's own launch hands its link to the app's activity, once`() {
        val disk = Disk()
        val token = disk.process().issue(LINK_A)

        // The restarted process: the screen takes the handoff from the launch that carries it.
        val restarted = disk.process()
        assertEquals(LINK_A, restarted.take(token, LINK_A))
        assertNull("taking it clears it", disk.value)
        assertEquals(LINK_A, firstResume(HotUpdaterSandboxHostHandoff(LINK_A, HOST), HOST))

        // A copy of that launch takes nothing.
        assertNull(restarted.take(token, LINK_A))
    }

    @Test
    fun `a restart that never arrived leaves nothing for a notification's launch`() {
        val disk = Disk()
        disk.process().issue(LINK_A)
        // The process died before the restart reached the screen. A notification starts the app:
        // its intent goes to the app's activity, and carries no token.
        val next = disk.process()
        assertNull(next.take(null, null))
        assertNull(firstResume(null, HOST))
        // The record never matches a later launch either: the link waits for the next screen.
        assertNull(next.take("forged", LINK_A))
    }

    @Test
    fun `a handoff for one link is never another's`() {
        val disk = Disk()
        val token = disk.process().issue(LINK_A)
        assertNull(disk.process().take(token, LINK_B))
        // A newer restart, for another link, replaces the older record.
        val newer = disk.process().issue(LINK_B)
        assertNull(disk.process().take(token, LINK_A))
        assertEquals(LINK_B, disk.process().take(newer, LINK_B))
    }

    @Test
    fun `only the activity the screen started takes the link, as the first to resume`() {
        val handoff = HotUpdaterSandboxHostHandoff(LINK_A, HOST)
        // Another of the app's activities resumed first, such as a splash or a notification's.
        assertNull(firstResume(handoff, "com.example.SplashActivity"))
    }

    @Test
    fun `a process that dies after taking the handoff leaves nothing for the one the system restores`() {
        val disk = Disk()
        val token = disk.process().issue(LINK_A)
        assertEquals(LINK_A, disk.process().take(token, LINK_A))
        // The process died before the app's activity resumed: its in-memory handoff went with it.
        // The system restores the task with the same intent: the record is gone.
        assertNull(disk.process().take(token, LINK_A))
        assertNull(firstResume(null, HOST))
    }
}
