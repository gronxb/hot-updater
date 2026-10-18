package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HotUpdaterRecoverySlotsTest {
    @Test
    fun `main keeps slot 0 and each name keeps its own slot until the slots run out`() {
        val slots = HotUpdaterRecoverySlots(capacity = 3)

        assertEquals(0, slots.slotOf(MAIN))
        assertEquals(1, slots.slotOf("widget-0"))
        assertEquals(2, slots.slotOf("widget-1"))
        assertEquals(1, slots.slotOf("widget-0"))
        // Past the last slot a name gets no native marker; its unfinished
        // launch still rolls back through launchInProgress.
        assertNull(slots.slotOf("widget-2"))
        assertNull(slots.assignedSlot("widget-2"))
        assertEquals(2, slots.assignedSlot("widget-1"))
        assertEquals(0, slots.assignedSlot(MAIN))
    }

    @Test
    fun `a native crash charges only the launches still waiting for their first content`() {
        val mainVerified = launch(MAIN, shouldRollback = false)
        val widgetPending = launch(WIDGET, shouldRollback = true)

        // Main records its verified launch, as it always has, but it asks for no rollback.
        assertEquals(listOf(WIDGET), charged(listOf(mainVerified, widgetPending), null))
        assertEquals(listOf(MAIN, WIDGET), written(listOf(mainVerified, widgetPending), null))

        assertEquals(listOf(MAIN), charged(listOf(launch(MAIN, shouldRollback = true), launch(WIDGET, shouldRollback = false)), null))
        assertEquals(listOf(MAIN), written(listOf(launch(MAIN, shouldRollback = true), launch(WIDGET, shouldRollback = false)), null))

        assertEquals(listOf(MAIN, WIDGET), charged(listOf(launch(MAIN, shouldRollback = true), widgetPending), null))
    }

    @Test
    fun `a named launch none of whose views was shown is not charged for a crash elsewhere`() {
        val prewarmed = launch(WIDGET, shouldRollback = true, armed = false)

        assertEquals(emptyList<String>(), charged(listOf(launch(MAIN, shouldRollback = false), prewarmed), null))
        // Its own runtime's fatal error is its crash, shown or not.
        assertEquals(listOf(WIDGET), charged(listOf(launch(MAIN, shouldRollback = true), prewarmed), WIDGET))
    }

    @Test
    fun `a claimed crash writes only the marker of the instance that threw`() {
        val launches = listOf(launch(MAIN, shouldRollback = true), launch(WIDGET, shouldRollback = true), launch("chat", true))

        assertEquals(listOf(WIDGET), written(launches, WIDGET))
        assertEquals(listOf(MAIN), written(launches, MAIN))
        // A verified named launch is not charged for its own error, and nobody else is.
        assertEquals(emptyList<String>(), written(listOf(launch(MAIN, shouldRollback = true), launch(WIDGET, false)), WIDGET))
        // An instance that monitors nothing claims the crash all the same.
        assertEquals(emptyList<String>(), written(launches, "other"))
    }

    @Test
    fun `an unclaimed JavaScript error is the one named launch whose runtime never reached HotUpdater`() {
        val widgetPending = launch(WIDGET, shouldRollback = true, armed = false)
        val mainShown = launch(MAIN, shouldRollback = false, contentAppeared = true)

        assertEquals(WIDGET, infer(listOf(mainShown, widgetPending)))
        assertEquals(WIDGET, infer(listOf(widgetPending)))
        // Main's own launch may have thrown.
        assertNull(infer(listOf(launch(MAIN, shouldRollback = true), widgetPending)))
        // Two candidates can't be told apart.
        assertNull(infer(listOf(widgetPending, launch("chat", shouldRollback = true, armed = false))))
        // A runtime with its module has its errors hooked, so this one isn't its.
        assertNull(infer(listOf(widgetPending), registeredRuntimes = setOf(WIDGET)))
        assertEquals(CHAT, infer(listOf(mainShown, widgetPending, launch(CHAT, true)), registeredRuntimes = setOf(WIDGET)))
        // A launch that may not roll back is never charged.
        assertNull(infer(listOf(mainShown, launch(WIDGET, shouldRollback = false))))
    }

    @Test
    fun `a launch that may not roll back still may have thrown while its bundle loaded`() {
        val widgetPending = launch(WIDGET, shouldRollback = true, armed = false)

        // Main runs its built-in bundle, or a bundle it already verified, and
        // has shown nothing yet.
        assertNull(infer(listOf(launch(MAIN, shouldRollback = false), widgetPending)))
        // So does another named instance whose runtime hasn't reached HotUpdater.
        assertNull(infer(listOf(mainShownLaunch(), widgetPending, launch(CHAT, shouldRollback = false))))
        // Once its module or its first content shows it loaded, it is not.
        assertEquals(WIDGET, infer(listOf(mainShownLaunch(), widgetPending, launch(CHAT, false)), registeredRuntimes = setOf(CHAT)))
        assertEquals(WIDGET, infer(listOf(mainShownLaunch(), widgetPending, launch(CHAT, false, contentAppeared = true))))
    }

    private fun mainShownLaunch() = launch(MAIN, shouldRollback = false, contentAppeared = true)

    private fun infer(
        launches: List<HotUpdaterRecoverySlots.Launch>,
        registeredRuntimes: Set<String> = emptySet(),
    ) = HotUpdaterRecoverySlots.inferJavaScriptErrorOwner(launches, registeredRuntimes)

    @Test
    fun `a claim holds until it is released`() {
        val slots = HotUpdaterRecoverySlots()
        assertNull(slots.attributedName())

        // However long releasing it takes, the launches it left alone stay
        // left alone, and a crash meanwhile is still the claimed error's.
        slots.attribute(WIDGET)
        Thread.sleep(1)
        assertEquals(WIDGET, slots.attributedName())

        // A fatal error that didn't end the process, such as one a development
        // build shows, must not claim a later crash.
        slots.clearAttribution()
        assertNull(slots.attributedName())
    }

    @Test
    fun `a released claim claims nothing`() {
        val slots = HotUpdaterRecoverySlots()
        slots.attribute(WIDGET)

        slots.clearAttribution()

        assertNull(slots.attributedName())
    }

    private fun launch(
        name: String,
        shouldRollback: Boolean,
        armed: Boolean = true,
        contentAppeared: Boolean = false,
    ) = HotUpdaterRecoverySlots.Launch(name, "$name-bundle", shouldRollback, armed, contentAppeared)

    private fun written(
        launches: List<HotUpdaterRecoverySlots.Launch>,
        attributedName: String?,
    ) = HotUpdaterRecoverySlots.markerTargets(launches, attributedName).map { it.name }

    private fun charged(
        launches: List<HotUpdaterRecoverySlots.Launch>,
        attributedName: String?,
    ) = HotUpdaterRecoverySlots.markerTargets(launches, attributedName).filter { it.shouldRollback }.map { it.name }

    companion object {
        private const val MAIN = HotUpdaterInstanceEnvironment.MAIN_NAME
        private const val WIDGET = "widget"
        private const val CHAT = "chat"
    }
}
