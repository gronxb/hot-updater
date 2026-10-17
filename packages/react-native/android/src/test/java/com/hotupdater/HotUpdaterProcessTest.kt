package com.hotupdater

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HotUpdaterProcessTest {
    @Test
    fun `recognizes only Hot Updater's restart process of this app`() {
        assertTrue(HotUpdaterProcess.isRestartProcessName("com.example", "com.example:hotupdater_restart"))
        assertFalse(HotUpdaterProcess.isRestartProcessName("com.example", "com.example"))
        assertFalse(HotUpdaterProcess.isRestartProcessName("com.example", "com.example:other"))
        assertFalse(HotUpdaterProcess.isRestartProcessName("com.example", "com.other:hotupdater_restart"))
        assertFalse(HotUpdaterProcess.isRestartProcessName("com.example", null))
    }
}
