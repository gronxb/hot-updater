package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Test

class HotUpdaterHeldContentTest {
    private val mainThread = FakeMainThread()
    private var now = 1_000L
    private val views = mutableMapOf<Int, String>()
    private val credits = mutableListOf<Pair<String, Long>>()
    private val held =
        HotUpdaterHeldContent(
            mainThread = mainThread,
            clock = { now },
            resolve = { views[it] },
            credit = { name, generation -> credits += name to generation },
        )

    @Test
    fun `content held until its named runtime registers verifies that launch`() {
        held.hold(ROOT_TAG, mapOf(MAIN to 1L, WIDGET to 3L))
        assertEquals(emptyList<Pair<String, Long>>(), credits)

        // The runtime's module hands over its activity, where the view is found.
        views[ROOT_TAG] = WIDGET
        held.runtimeRegistered()

        assertEquals(listOf(WIDGET to 3L), credits)
        // Resolved once.
        held.runtimeRegistered()
        now += HotUpdaterHeldContent.HOLD_MS
        mainThread.runAll()
        assertEquals(listOf(WIDGET to 3L), credits)
    }

    @Test
    fun `content nobody claims verifies main once after the hold and still verifies a late named launch`() {
        held.hold(ROOT_TAG, mapOf(MAIN to 1L, WIDGET to 3L))

        now += HotUpdaterHeldContent.HOLD_MS - 1
        held.creditExpiredToMain()
        assertEquals(emptyList<Pair<String, Long>>(), credits)

        now += 1
        mainThread.runAll()
        held.creditExpiredToMain()
        assertEquals(listOf(MAIN to 1L), credits)

        views[ROOT_TAG] = WIDGET
        held.runtimeRegistered()
        assertEquals(listOf(MAIN to 1L, WIDGET to 3L), credits)
    }

    @Test
    fun `held content of main already credited is not credited again`() {
        held.hold(ROOT_TAG, mapOf(MAIN to 1L, WIDGET to 3L))
        now += HotUpdaterHeldContent.HOLD_MS
        held.creditExpiredToMain()

        views[ROOT_TAG] = MAIN
        held.runtimeRegistered()

        assertEquals(listOf(MAIN to 1L), credits)
    }

    @Test
    fun `many roots held at once all wait for their runtimes and each counts once`() {
        // Twenty other roots render before the widget's runtime registers.
        held.hold(ROOT_TAG, mapOf(MAIN to 1L, WIDGET to 3L))
        held.hold(ROOT_TAG, mapOf(MAIN to 1L, WIDGET to 3L))
        (1..20).forEach { held.hold(1_000 + it * 10, mapOf(MAIN to 1L, WIDGET to 3L)) }

        views[ROOT_TAG] = WIDGET
        held.runtimeRegistered()

        assertEquals(listOf(WIDGET to 3L), credits)
    }

    @Test
    fun `a registration off the main thread resolves on it`() {
        held.hold(ROOT_TAG, mapOf(WIDGET to 3L))
        views[ROOT_TAG] = WIDGET
        mainThread.current = false

        held.runtimeRegistered()
        assertEquals(emptyList<Pair<String, Long>>(), credits)

        mainThread.runAll()
        assertEquals(listOf(WIDGET to 3L), credits)
    }

    companion object {
        private const val ROOT_TAG = 11
        private const val MAIN = HotUpdaterInstanceEnvironment.MAIN_NAME
        private const val WIDGET = "widget"
    }
}
