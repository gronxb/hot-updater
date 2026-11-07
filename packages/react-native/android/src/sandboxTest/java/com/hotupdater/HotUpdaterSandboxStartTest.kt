package com.hotupdater

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Test

class HotUpdaterSandboxStartTest {
    private val launcher =
        HotUpdaterSandboxStartFacts(
            action = Intent.ACTION_MAIN,
            dataScheme = null,
            hasData = false,
            categories = setOf(Intent.CATEGORY_LAUNCHER),
            hasExtras = false,
            hasClipData = false,
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
            restored = false,
        )
    private val sandboxLink =
        launcher.copy(
            action = Intent.ACTION_VIEW,
            dataScheme = "hu-sandbox-com-example",
            hasData = true,
            categories = setOf(Intent.CATEGORY_BROWSABLE),
        )

    private fun decide(facts: HotUpdaterSandboxStartFacts) = HotUpdaterSandboxStart.decide(facts)

    @Test
    fun `the launcher's plain intent shows the screen`() {
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(launcher))
    }

    @Test
    fun `a restart passes through the screen`() {
        val restart = launcher.copy(flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(restart))
    }

    @Test
    fun `a sandbox link always stops, whatever flags it sets`() {
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_LINK, decide(sandboxLink))
        val forged = sandboxLink.copy(flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_LINK, decide(forged))
        val anyAction = sandboxLink.copy(action = Intent.ACTION_MAIN)
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_LINK, decide(anyAction))
    }

    @Test
    fun `a link Recents repeats isn't asked again`() {
        val fromRecents = sandboxLink.copy(flags = sandboxLink.flags or Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(fromRecents))
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(sandboxLink.copy(restored = true)))
    }

    @Test
    fun `a restored screen stays a screen`() {
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(launcher.copy(restored = true)))
    }

    @Test
    fun `a launcher intent that carries anything is for the app`() {
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(launcher.copy(hasExtras = true)))
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(launcher.copy(hasData = true, dataScheme = "myapp")))
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(launcher.copy(hasClipData = true)))
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(launcher.copy(categories = emptySet())))
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(launcher.copy(action = "com.example.SHORTCUT")))
    }

    @Test
    fun `the copy keeps the sender's grants and start, and drops what described this start`() {
        val kept =
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION or
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_NO_ANIMATION
        val dropped =
            Intent.FLAG_ACTIVITY_CLEAR_TASK or
                Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY or
                Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT or
                Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED or
                Intent.FLAG_ACTIVITY_MULTIPLE_TASK or
                Intent.FLAG_ACTIVITY_NEW_DOCUMENT or
                Intent.FLAG_ACTIVITY_TASK_ON_HOME
        assertEquals(kept, HotUpdaterSandboxStart.hostFlags(kept or dropped))
    }

    /** What the SDK's restart builds, pinned against what the platform defines it to set. */
    @Test
    fun `the restart's flag is the one the decision reads`() {
        assertEquals(0x00008000, Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}
