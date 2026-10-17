package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class WeakIdentitySetTest {
    // Equal to every other one, with one hash code: only identity tells them apart.
    private class Same {
        override fun equals(other: Any?): Boolean = other is Same

        override fun hashCode(): Int = 1
    }

    @Test
    fun `distinct objects are tracked by identity`() {
        val set = WeakIdentitySet<Same>()
        val first = Same()
        val second = Same()

        assertTrue(set.add(first))
        assertTrue(set.add(second))
        assertFalse(set.add(first))
        assertEquals(2, set.size)

        assertTrue(set.remove(first))
        assertFalse(first in set)
        assertTrue(second in set)
    }

    @Test
    fun `a collected object leaves the set`() {
        val set = WeakIdentitySet<Any>()
        set.add(Any())

        // A new object may reuse a collected one's identity hash code; the
        // collected one must not stay in its place.
        repeat(50) {
            if (set.isEmpty()) return
            System.gc()
            @Suppress("UNUSED_VARIABLE")
            val pressure = ByteArray(1 shl 20)
            Thread.sleep(10)
        }
        // A JVM that never collects the object can't show it; skip rather
        // than fail on garbage-collector timing.
        assumeTrue("the JVM did not collect the object", set.isEmpty())
    }
}
