package com.hotupdater

import com.hotupdater.PreviousProcessExit.ExitRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PreviousProcessExitTest {
    @Test
    fun `reasons are named after ApplicationExitInfo without the REASON prefix`() {
        val names =
            listOf(
                "UNKNOWN",
                "EXIT_SELF",
                "SIGNALED",
                "LOW_MEMORY",
                "CRASH",
                "CRASH_NATIVE",
                "ANR",
                "INITIALIZATION_FAILURE",
                "PERMISSION_CHANGE",
                "EXCESSIVE_RESOURCE_USAGE",
                "USER_REQUESTED",
                "USER_STOPPED",
                "DEPENDENCY_DIED",
                "OTHER",
                "FREEZER",
                "PACKAGE_STATE_CHANGE",
                "PACKAGE_UPDATED",
            )

        assertEquals(names, names.indices.map(PreviousProcessExit::reasonName))
        assertEquals("UNKNOWN", PreviousProcessExit.reasonName(99))
        assertEquals("UNKNOWN", PreviousProcessExit.reasonName(-1))
    }

    @Test
    fun `the most recent exit of the main process is selected`() {
        val records =
            listOf(
                ExitRecord("com.example:hotupdater_restart", reason = 1, timestamp = 300),
                ExitRecord("com.example", reason = 4, timestamp = 100),
                ExitRecord("com.example", reason = 6, timestamp = 200),
                ExitRecord("com.example:sync", reason = 3, timestamp = 250),
                ExitRecord(null, reason = 5, timestamp = 400),
            )

        assertEquals(6, PreviousProcessExit.selectReason(records, "com.example"))
        assertNull(PreviousProcessExit.selectReason(records.filter { it.processName != "com.example" }, "com.example"))
        assertNull(PreviousProcessExit.selectReason(emptyList(), "com.example"))
    }

    @Test
    fun `nothing is reported before HotUpdater initializes`() {
        assertNull(PreviousProcessExit.get())
    }
}
