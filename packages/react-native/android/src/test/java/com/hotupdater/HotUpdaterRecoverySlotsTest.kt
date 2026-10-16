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

        assertEquals(WIDGET, infer(listOf(launch(MAIN, shouldRollback = false), widgetPending)))
        assertEquals(WIDGET, infer(listOf(widgetPending)))
        // Main's own launch may have thrown.
        assertNull(infer(listOf(launch(MAIN, shouldRollback = true), widgetPending)))
        // Two candidates can't be told apart.
        assertNull(infer(listOf(widgetPending, launch("chat", shouldRollback = true, armed = false))))
        // A runtime with its module has its errors hooked, so this one isn't its.
        assertNull(infer(listOf(widgetPending), registeredRuntimes = setOf(WIDGET)))
        assertNull(infer(listOf(launch(MAIN, shouldRollback = false), launch(WIDGET, shouldRollback = false))))
    }

    private fun infer(
        launches: List<HotUpdaterRecoverySlots.Launch>,
        registeredRuntimes: Set<String> = emptySet(),
    ) = HotUpdaterRecoverySlots.inferJavaScriptErrorOwner(launches, registeredRuntimes)

    @Test
    fun `a claim lasts only as long as the crash it announces`() {
        var now = 1_000L
        val slots = HotUpdaterRecoverySlots(clock = { now })
        assertNull(slots.attributedName())

        slots.attribute(WIDGET)
        now += HotUpdaterRecoverySlots.ATTRIBUTION_WINDOW_MS
        assertEquals(WIDGET, slots.attributedName())

        // A fatal error that didn't end the process, such as one a development
        // build shows, must not claim a later crash.
        now += 1
        assertNull(slots.attributedName())
    }

    private fun launch(
        name: String,
        shouldRollback: Boolean,
        armed: Boolean = true,
    ) = HotUpdaterRecoverySlots.Launch(name, "$name-bundle", shouldRollback, armed)

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
    }
}
