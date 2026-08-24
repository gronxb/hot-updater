package com.hotupdater

import org.apache.commons.compress.archivers.tar.TarArchiveEntry as CommonsTarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class TarArchiveInputStreamTest {
    @Test
    fun `reads a long basename from a POSIX PAX header`() {
        val path = "raw/${"long-name-".repeat(14)}asset.bmp"
        val contents = "pax asset".toByteArray()
        val archive = createPaxArchive(path, contents)

        TarArchiveInputStream(ByteArrayInputStream(archive)).use { tar ->
            val entry = tar.getNextEntry()

            assertEquals(path, entry?.name)
            assertArrayEquals(contents, tar.readBytes())
            assertNull(tar.getNextEntry())
        }
    }

    @Test
    fun `rejects path traversal from a POSIX PAX header`() {
        val path = "../${"long-name-".repeat(14)}asset.bmp"
        val archive =
            createPaxArchive(
                path = path,
                contents = "malicious".toByteArray(),
                headerPath = "safe.bmp",
            )

        val error =
            assertThrows(SecurityException::class.java) {
                TarArchiveInputStream(ByteArrayInputStream(archive)).use { tar ->
                    tar.getNextEntry()
                }
            }

        assertEquals("Path traversal detected: $path", error.message)
    }

    private fun createPaxArchive(
        path: String,
        contents: ByteArray,
        headerPath: String = path,
    ): ByteArray {
        val output = ByteArrayOutputStream()
        TarArchiveOutputStream(output).use { tar ->
            tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
            val entry =
                CommonsTarArchiveEntry(headerPath).apply {
                    size = contents.size.toLong()
                    if (path != headerPath) addPaxHeader("path", path)
                }
            tar.putArchiveEntry(entry)
            tar.write(contents)
            tar.closeArchiveEntry()
        }
        return output.toByteArray()
    }
}
