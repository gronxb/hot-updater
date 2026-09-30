package com.hotupdater

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class KeyValueStorageServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `sets replaces and removes values`() {
        val storage = KeyValueStorageService(storageFile())
        assertNull(storage.getItem("plugins/insights/queue"))

        storage.setItem("plugins/insights/queue", "[1]")
        storage.setItem("plugins/insights/day", "2026-09-30")
        storage.setItem("plugins/insights/queue", "[1,2]")
        storage.setItem("plugins/other/empty", "")
        assertEquals("[1,2]", storage.getItem("plugins/insights/queue"))
        assertEquals("", storage.getItem("plugins/other/empty"))

        storage.setItem("plugins/insights/queue", null)
        storage.setItem("plugins/never-set", null)
        assertNull(storage.getItem("plugins/insights/queue"))
        assertEquals("2026-09-30", storage.getItem("plugins/insights/day"))
    }

    @Test
    fun `values persist across instances`() {
        val file = storageFile()
        KeyValueStorageService(file).apply {
            setItem("plugins/insights/queue", "[{\"id\":\"é\",\"note\":\"line\\nbreak\"}]")
            setItem("plugins/insights/day", "2026-09-30")
            setItem("plugins/insights/day", null)
        }

        val reloaded = KeyValueStorageService(file)

        assertEquals("[{\"id\":\"é\",\"note\":\"line\\nbreak\"}]", reloaded.getItem("plugins/insights/queue"))
        assertNull(reloaded.getItem("plugins/insights/day"))
    }

    @Test
    fun `a corrupt file reads as empty and the next set replaces it`() {
        val file = storageFile().apply { writeText("{\"plugins/a\":") }
        val storage = KeyValueStorageService(file)

        assertNull(storage.getItem("plugins/a"))
        storage.setItem("plugins/b", "value")

        assertEquals(mapOf("plugins/b" to "value"), readStored(file))
    }

    @Test
    fun `values that are not strings read as missing`() {
        val file = storageFile().apply { writeText("{\"plugins/a\":1,\"plugins/b\":\"kept\",\"plugins/c\":null}") }
        val storage = KeyValueStorageService(file)

        assertNull(storage.getItem("plugins/a"))
        assertEquals("kept", storage.getItem("plugins/b"))
        assertNull(storage.getItem("plugins/c"))
    }

    @Test
    fun `concurrent sets are all persisted`() {
        val file = storageFile()
        val storage = KeyValueStorageService(file)

        (0 until 4)
            .map { worker ->
                Thread {
                    repeat(25) { index -> storage.setItem("plugins/worker-$worker/$index", "$worker:$index") }
                }.apply { start() }
            }.forEach(Thread::join)

        val stored = readStored(file)
        assertEquals(100, stored.size)
        (0 until 4).forEach { worker ->
            repeat(25) { index -> assertEquals("$worker:$index", stored["plugins/worker-$worker/$index"]) }
        }
    }

    @Test
    fun `is stored under noBackupFilesDir`() {
        val noBackupDirectory = temporaryFolder.newFolder("no_backup")

        KeyValueStorageService.create(NoBackupContext(noBackupDirectory)).setItem("plugins/insights/queue", "[]")

        assertEquals(
            mapOf("plugins/insights/queue" to "[]"),
            readStored(File(noBackupDirectory, "hot-updater/storage.json")),
        )
    }

    private fun storageFile(): File = File(temporaryFolder.newFolder(), "hot-updater/storage.json").apply { parentFile?.mkdirs() }

    private fun readStored(file: File): Map<String, String> {
        val json = JSONObject(file.readText())
        return json.keys().asSequence().associateWith { json.getString(it) }
    }
}
