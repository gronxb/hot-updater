package com.hotupdater.lynx

import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LynxClientStorageTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun `pages share identity and preserve each other's keys across recreation`() {
        val directory = temporary.newFolder("no-backup")
        val first = LynxClientStorage(directory)
        val second = LynxClientStorage(directory)
        val id = first.installId()
        assertEquals(id, UUID.fromString(id).toString())
        first.set("plugins/insights/user", "alice")
        second.set("plugins/other/user", "bob")
        assertEquals("alice", second.get("plugins/insights/user"))
        first.set("plugins/insights/user", null)
        assertNull(second.get("plugins/insights/user"))
        assertEquals("bob", LynxClientStorage(directory).get("plugins/other/user"))
        assertEquals(id, LynxClientStorage(directory).installId())
        assertNotEquals(id, LynxClientStorage(temporary.newFolder("reinstalled")).installId())
    }

    @Test fun `concurrent pages do not lose writes or generate distinct installation ids`() {
        val directory = temporary.newFolder("no-backup")
        val executor = Executors.newFixedThreadPool(4)
        try {
            val futures = (0 until 16).map { index -> executor.submit<String> {
                val store = LynxClientStorage(directory)
                store.set("plugins/test/$index", "$index")
                store.installId()
            } }
            assertEquals(1, futures.map { it.get() }.toSet().size)
            val store = LynxClientStorage(directory)
            (0 until 16).forEach { assertEquals("$it", store.get("plugins/test/$it")) }
        } finally { executor.shutdownNow() }
    }

    @Test fun `rejected values and corrupt storage never overwrite existing bytes`() {
        val directory = temporary.newFolder("no-backup")
        val store = LynxClientStorage(directory)
        store.installId()
        val file = File(directory, "client.json")
        val before = file.readText()
        assertThrows(IllegalArgumentException::class.java) { store.set("installId", "overwrite") }
        assertThrows(IllegalArgumentException::class.java) { store.set("plugins/test/value", "x".repeat(65_537)) }
        assertEquals(before, file.readText())
        file.writeText("broken json")
        assertThrows(Exception::class.java) { store.installId() }
        assertEquals("broken json", file.readText())
    }
}
