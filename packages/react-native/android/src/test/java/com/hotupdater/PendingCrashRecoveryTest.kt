package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PendingCrashRecoveryTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `a watchdog reader waits until the native crash marker is fully written`() {
        val marker = temporaryFolder.newFile("crash-marker.json")
        marker.writeText("{\"bundleId\":\"crashed-bundle\",\"shouldRollback\":")

        assertNull(PendingCrashRecovery.loadFromFile(marker))

        marker.appendText("true}\n")
        assertEquals(
            PendingCrashRecovery("crashed-bundle", true),
            PendingCrashRecovery.loadFromFile(marker),
        )
    }

    @Test
    fun `missing or empty markers do not request a restart`() {
        assertNull(PendingCrashRecovery.loadFromFile(File(temporaryFolder.root, "missing.json")))
        assertNull(PendingCrashRecovery.loadFromFile(temporaryFolder.newFile("empty.json")))
    }

    @Test
    fun `a crash after content appeared does not request rollback`() {
        val marker = temporaryFolder.newFile("verified-crash.json")
        marker.writeText("{\"bundleId\":\"verified-bundle\",\"shouldRollback\":false}")

        val recovery = requireNotNull(PendingCrashRecovery.loadFromFile(marker))
        assertFalse(recovery.shouldRollback)
        assertEquals("verified-bundle", recovery.launchedBundleId)
    }
}
