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

    private fun opensBeneath(
        hostRunning: Boolean,
        switched: Boolean,
        coversHost: Boolean,
        hostUnderScreen: Boolean,
    ) = HotUpdaterSandboxStart.opensBeneath(hostRunning, switched, coversHost, hostUnderScreen)

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
    fun `the SDK's restart of an app the screen covered comes back to the screen, which asks the waiting link`() {
        // A forced update the app's check under the screen found restarts the process.
        val restart =
            launcher.copy(
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK,
                coveredStartInterrupted = true,
            )
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(restart))
        // Anything else that names the app still opens it.
        val shortcut = restart.copy(flags = 0, hasExtras = true, action = "com.example.SHORTCUT")
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(shortcut))
    }

    @Test
    fun `only its own scheme's link stops, and another is the app's`() {
        val own = sandboxLink.copy(dataScheme = "acme-preview", ownScheme = "acme-preview")
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_LINK, decide(own))
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_LINK, decide(own.copy(dataScheme = "ACME-Preview")))
        val derived = sandboxLink.copy(ownScheme = "acme-preview")
        assertEquals(HotUpdaterSandboxStartDecision.OPEN_HOST, decide(derived))
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

    @Test
    fun `a link that starts its task moves once, to a task of its own`() {
        val link = HotUpdaterSandboxStartDecision.SHOW_LINK
        assertEquals(true, HotUpdaterSandboxStart.movesToOwnTask(link, created = true, taskRoot = true, carried = false))
        // The start the move made carries the link, and stays.
        assertEquals(false, HotUpdaterSandboxStart.movesToOwnTask(link, created = true, taskRoot = true, carried = true))
        // Over a task that runs already, or delivered to the screen in front, its identity isn't the link.
        assertEquals(false, HotUpdaterSandboxStart.movesToOwnTask(link, created = true, taskRoot = false, carried = false))
        assertEquals(false, HotUpdaterSandboxStart.movesToOwnTask(link, created = false, taskRoot = true, carried = false))
        for (other in listOf(HotUpdaterSandboxStartDecision.SHOW_SCREEN, HotUpdaterSandboxStartDecision.OPEN_HOST)) {
            assertEquals(false, HotUpdaterSandboxStart.movesToOwnTask(other, created = true, taskRoot = true, carried = false))
        }
    }

    @Test
    fun `the moved start asks the link it carries, and Recents or a restore only show the screen`() {
        val link = "hu-sandbox-com-example://hot-updater/preview?channel=pr-1&fingerprint=f"
        assertEquals(link, HotUpdaterSandboxStart.linkOf(null, link))
        assertEquals(link, HotUpdaterSandboxStart.linkOf(link, "other://x"))
        // The launcher's intent the move starts, read with the link it carries.
        val moved = launcher.copy(dataScheme = "hu-sandbox-com-example", hasData = true, flags = HotUpdaterSandboxStart.OWN_TASK_FLAGS)
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_LINK, decide(moved))
        val fromRecents = moved.copy(flags = moved.flags or Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(fromRecents))
        assertEquals(HotUpdaterSandboxStartDecision.SHOW_SCREEN, decide(moved.copy(restored = true)))
    }

    @Test
    fun `opening the app over its activity a process death left only closes the screen`() {
        assertEquals(true, opensBeneath(hostRunning = false, switched = true, coversHost = false, hostUnderScreen = true))
        assertEquals(true, opensBeneath(hostRunning = false, switched = false, coversHost = false, hostUnderScreen = true))
        // As before: over the running app with nothing switched, or the app this screen started before a death.
        assertEquals(true, opensBeneath(hostRunning = true, switched = false, coversHost = false, hostUnderScreen = false))
        assertEquals(true, opensBeneath(hostRunning = false, switched = true, coversHost = true, hostUnderScreen = false))
        // Not the app beneath: its activity starts.
        assertEquals(false, opensBeneath(hostRunning = false, switched = true, coversHost = false, hostUnderScreen = false))
        assertEquals(false, opensBeneath(hostRunning = false, switched = false, coversHost = false, hostUnderScreen = false))
    }

    @Test
    fun `only the app's activity alone under the screen counts as the app beneath`() {
        val host = "com.example/com.example.MainActivity"
        val screen = "com.example/com.hotupdater.HotUpdaterSandboxActivity"
        val camera = "com.android.camera2/com.android.camera.CameraActivity"
        val implementations = mapOf(host to host, screen to screen, camera to camera)

        fun holds(
            base: String?,
            count: Int,
        ) = HotUpdaterSandboxStart.holdsHostUnderScreen(base, count, host, implementations::get)
        // [app, left by a process death; screen]
        assertEquals(true, holds(host, 2))
        // [Home; the camera Scan started in its task; the link's screen]
        assertEquals(false, holds(screen, 3))
        // [screen; screen]
        assertEquals(false, holds(screen, 2))
        // [app; camera; screen]: closing the screen would show the camera.
        assertEquals(false, holds(host, 3))
        // [camera; screen]
        assertEquals(false, holds(camera, 2))
        // The screen alone, or a task that can't be read.
        assertEquals(false, holds(screen, 1))
        assertEquals(false, holds(null, 0))
    }

    @Test
    fun `the app's activity counts under its launcher alias, on either side`() {
        val alias = "com.example/com.example.Launcher"
        val target = "com.example/com.example.MainActivity"
        val other = "com.example/com.example.SettingsActivity"
        val implementations = mapOf(alias to target, target to target, other to other)

        fun holds(
            base: String?,
            count: Int,
            host: String,
        ) = HotUpdaterSandboxStart.holdsHostUnderScreen(base, count, host, implementations::get)
        // The manifest names the alias. Android 24-28 report the task's base as the alias it started, later ones as the target.
        assertEquals(true, holds(alias, 2, alias))
        assertEquals(true, holds(target, 2, alias))
        assertEquals(true, holds(alias, 2, target))
        // Still exactly the app's activity and the screen.
        assertEquals(false, holds(alias, 3, alias))
        assertEquals(false, holds(other, 2, alias))
        // An activity that can't be read isn't the app's.
        assertEquals(false, holds("com.other/com.other.Main", 2, alias))
    }

    /** What the SDK's restart builds, pinned against what the platform defines it to set. */
    @Test
    fun `the restart's flag is the one the decision reads`() {
        assertEquals(0x00008000, Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}
