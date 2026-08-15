package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class ReleaseCatalogCacheServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `persists checksum verified entries without credential filenames`() {
        val root = temporaryFolder.newFolder("catalog-cache")
        val first = createService(root)
        val partition = "https://updates.example.com|x-api-key=raw-secret"

        assertTrue(first.set(partition, "validated-catalog"))
        assertEquals("validated-catalog", createService(root).get(partition))

        val entry = root.listFiles()!!.single()
        assertTrue(entry.name.matches(Regex("[0-9a-f]{64}\\.catalog")))
        assertFalse(entry.name.contains("raw-secret"))
        assertFalse(entry.readText().contains("raw-secret"))

        entry.appendText("corrupt")
        assertNull(createService(root).get(partition))
        assertFalse(entry.exists())
    }

    @Test
    fun `failed atomic replacement preserves the previous entry`() {
        val root = temporaryFolder.newFolder("interrupted-write")
        val partition = "partition"
        assertTrue(createService(root).set(partition, "previous"))

        val interrupted =
            ReleaseCatalogCacheService(
                rootDirectory = root,
                atomicReader = ::readForTest,
                atomicWriter = { _, _ -> false },
                atomicRemover = ::removeForTest,
            )
        assertFalse(interrupted.set(partition, "replacement"))
        assertEquals("previous", createService(root).get(partition))
    }

    @Test
    fun `evicts least recently used entries and rejects oversized payloads`() {
        val root = temporaryFolder.newFolder("bounded-cache")
        val service =
            ReleaseCatalogCacheService(
                rootDirectory = root,
                maxEntries = 2,
                maxEntryBytes = 16,
                maxTotalBytes = 200,
                atomicReader = ::readForTest,
                atomicWriter = ::writeForTest,
                atomicRemover = ::removeForTest,
            )

        assertTrue(service.set("one", "first"))
        Thread.sleep(5)
        assertTrue(service.set("two", "second"))
        Thread.sleep(5)
        assertTrue(service.set("three", "third"))

        assertNull(service.get("one"))
        assertEquals("second", service.get("two"))
        assertEquals("third", service.get("three"))
        assertFalse(service.set("two", "x".repeat(17)))
        assertEquals("second", service.get("two"))
    }

    private fun createService(root: File): ReleaseCatalogCacheService =
        ReleaseCatalogCacheService(
            rootDirectory = root,
            atomicReader = ::readForTest,
            atomicWriter = ::writeForTest,
            atomicRemover = ::removeForTest,
        )

    private fun readForTest(file: File): ByteArray? = if (file.isFile) file.readBytes() else null

    private fun removeForTest(file: File): Boolean = !file.exists() || file.delete()

    private fun writeForTest(
        destination: File,
        bytes: ByteArray,
    ): Boolean =
        try {
            val temporary = File.createTempFile("entry", ".tmp", destination.parentFile)
            temporary.writeBytes(bytes)
            try {
                Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: Exception) {
                Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
            true
        } catch (_: Exception) {
            false
        }
}
