package com.hotupdater

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.Base64

class TarBrArchiveExtractorTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `extracts exact regular file set`() {
        val destination = extract(VALID, 3072, mapOf("assets/image.png" to 5, "index.android.bundle" to 6))

        assertArrayEquals("image".toByteArray(), File(destination, "assets/image.png").readBytes())
        assertArrayEquals("bundle".toByteArray(), File(destination, "index.android.bundle").readBytes())
    }

    @Test
    fun `supports a POSIX PAX long path`() {
        val path = "assets/${"x".repeat(120)}.bin"
        val destination = extract(PAX_LONG_PATH, 3072, mapOf(path to 4))

        assertArrayEquals("long".toByteArray(), File(destination, path).readBytes())
    }

    @Test
    fun `rejects duplicate unsafe linked and malformed archives`() {
        val cases =
            listOf(
                Triple(DUPLICATE, 3072L, mapOf("index.android.bundle" to 6L)),
                Triple(TRAVERSAL, 2048L, mapOf("../escape" to 3L)),
                Triple(SYMLINK, 1536L, mapOf("index.android.bundle" to 0L)),
                Triple(SINGLE_END_BLOCK, 1536L, mapOf("index.android.bundle" to 6L)),
                Triple(TRAILING_NON_ZERO, 2560L, mapOf("index.android.bundle" to 6L)),
            )

        cases.forEachIndexed { index, (fixture, tarSize, files) ->
            val archive = temporaryFolder.newFile("invalid-$index.tar.br").apply { writeBytes(decode(fixture)) }
            val destination = File(temporaryFolder.root, "invalid-$index")

            assertThrows(Exception::class.java) {
                TarBrArchiveExtractor.extract(archive, destination, tarSize, files)
            }
            check(!destination.exists())
        }
    }

    @Test
    fun `rejects dangling consecutive duplicate and unsupported extension metadata`() {
        val pathRecord = paxRecord("path", "index.android.bundle")
        val malformedShortRecord = "3 \n".toByteArray()
        val cases =
            listOf(
                tarArchive(tarEntry("PaxHeader", 'x', pathRecord)),
                tarArchive(
                    tarEntry("PaxHeader", 'x', pathRecord),
                    tarEntry("PaxHeader", 'x', pathRecord),
                ),
                tarArchive(
                    tarEntry("PaxHeader", 'x', pathRecord + paxRecord("path", "other")),
                    regularEntry("ignored", "bundle"),
                ),
                tarArchive(
                    tarEntry("PaxHeader", 'x', malformedShortRecord),
                    regularEntry("ignored", "bundle"),
                ),
                tarArchive(
                    tarEntry("PaxHeader", 'x', paxRecord("linkpath", "target")),
                    regularEntry("index.android.bundle", "bundle"),
                ),
                tarArchive(tarEntry("LongLink", 'L', "name\u0000".toByteArray())),
            )

        cases.forEach { bytes ->
            assertThrows(IOException::class.java) { consumeTar(bytes) }
        }
    }

    @Test
    fun `preserves exact header paths and applies PAX size`() {
        val spacedPathArchive = tarArchive(regularEntry("index.android.bundle ", "bundle"))
        TarArchiveInputStream(ByteArrayInputStream(spacedPathArchive)).use { input ->
            assertEquals("index.android.bundle ", input.getNextEntry()?.name)
        }

        val payload = "data".toByteArray()
        val paxSizeArchive =
            tarArchive(
                tarEntry("PaxHeader", 'x', paxRecord("size", payload.size.toString())),
                tarEntry("index.android.bundle", '0', payload, declaredSize = 1),
            )
        TarArchiveInputStream(ByteArrayInputStream(paxSizeArchive)).use { input ->
            val entry = input.getNextEntry()
            assertEquals(payload.size.toLong(), entry?.size)
            assertArrayEquals(payload, input.readBytes())
            assertEquals(null, input.getNextEntry())
        }
    }

    private fun extract(
        fixture: String,
        tarSize: Long,
        files: Map<String, Long>,
    ): File {
        val archive = temporaryFolder.newFile("fixture-${System.nanoTime()}.tar.br").apply { writeBytes(decode(fixture)) }
        val destination = File(temporaryFolder.root, "extracted-${System.nanoTime()}")
        TarBrArchiveExtractor.extract(archive, destination, tarSize, files)
        return destination
    }

    private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)

    private fun consumeTar(bytes: ByteArray) {
        TarArchiveInputStream(ByteArrayInputStream(bytes)).use { input ->
            while (input.getNextEntry() != null) input.readBytes()
        }
    }

    private fun paxRecord(
        key: String,
        value: String,
    ): ByteArray {
        var length = key.toByteArray().size + value.toByteArray().size + 3
        while (true) {
            val record = "$length $key=$value\n".toByteArray()
            if (record.size == length) return record
            length = record.size
        }
    }

    private fun regularEntry(
        name: String,
        content: String,
    ): ByteArray = tarEntry(name, '0', content.toByteArray())

    private fun tarEntry(
        name: String,
        type: Char,
        payload: ByteArray,
        declaredSize: Int = payload.size,
    ): ByteArray {
        val header = ByteArray(512)
        name.toByteArray().copyInto(header, endIndex = name.toByteArray().size.coerceAtMost(100))
        writeOctal(header, 100, 8, 420)
        writeOctal(header, 108, 8, 0)
        writeOctal(header, 116, 8, 0)
        writeOctal(header, 124, 12, declaredSize)
        writeOctal(header, 136, 12, 0)
        for (index in 148 until 156) header[index] = ' '.code.toByte()
        header[156] = type.code.toByte()
        "ustar".toByteArray().copyInto(header, 257)
        writeOctal(header, 148, 8, header.sumOf { it.toInt() and 0xff })

        return ByteArrayOutputStream()
            .apply {
                write(header)
                write(payload)
                write(ByteArray((512 - payload.size % 512) % 512))
            }.toByteArray()
    }

    private fun tarArchive(vararg entries: ByteArray): ByteArray =
        ByteArrayOutputStream()
            .apply {
                entries.forEach(::write)
                write(ByteArray(1024))
            }.toByteArray()

    private fun writeOctal(
        target: ByteArray,
        offset: Int,
        length: Int,
        value: Int,
    ) {
        val digits = value.toString(8).padStart(length - 2, '0')
        digits.toByteArray().copyInto(target, offset)
        target[offset + length - 2] = 0
        target[offset + length - 1] = ' '.code.toByte()
    }

    companion object {
        const val VALID =
            "G/8LYI7UVnlCO6lhAMTqIo5tMQLiY7NptuP57iYyogHNeF9BlHNiXHeDMLCAJL3h9im3UyYnSs3aLbJIIBsjml0YwV1+Hd11htDfIA8GgPKHFrFNtD7SOfZo/h9mbgDYuSAJIPmy9Z2b"
        private const val DUPLICATE =
            "G/8L4I/UVnlCO6lh6sQAIm5ssV7ksdnUyXHelkgImbdLFCl08DwgyVOGdSmhfs8LgniesZ82/bHw7qIYoXwdSTsMVSkOBkDMM0vqHj11Ew=="
        private const val TRAVERSAL =
            "G/8H+AfKbRfTdvBDW1YMVZ0c3w7fLhJCyAFHCIm3xTUACIRyzK7qNZRgrBkUGlOQ+PtOBlH/uDAUZ9s9Dw=="
        private const val SYMLINK =
            "G/8FoI7UYs0ZrwQiHgYxvWizaUNMJ8cnP4h9lyiDwKKELcCA8pSZdZEoyN91S9BvNObx0n8IcrtxYn2sUe6QrffCuHk8LCgA"
        private const val SINGLE_END_BLOCK =
            "G/8F4I/UVnlCO6lh6sQAIm5ssV7ksdnUyfH9WyIhZN4uUaQSeB6Q5DGGvrXYkguCOs/YT5v+GLy7ECOUryNph6EqxcEAinlmEw=="
        private const val TRAILING_NON_ZERO =
            "G/8J4Adqc2ds55CPYbC2qk6O87ZEQsi0tUsUKUXN80TyGEPfWmyJBUGcZ6y72vQfJjUzyChogu7Xu5ODMLcUB0MBYu7ZOLkF"
        private const val PAX_LONG_PATH =
            "G/8LYAbCtn2mBfjh0GTohqrNYvNuZjueb2Ij3vmAJjz8C6jLIEtYgqi7gAMNAII62ZkiZILxgnbd1QSM8usRpO6ZyCgYZiz8dTRcx0YB/gG5MBRqZPyVyrk8J47iYenP+zXoZcGa8QLgayISZoflgdi14Q=="
    }
}
