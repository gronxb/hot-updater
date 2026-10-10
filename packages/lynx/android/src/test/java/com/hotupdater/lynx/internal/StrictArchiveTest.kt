package com.hotupdater.lynx.internal

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.nio.file.Files
import java.util.zip.GZIPOutputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry
import org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream
import org.junit.Assert.*
import org.junit.Test

class StrictArchiveTest {
    private fun fixture(bytes: ByteArray, action: (File, File) -> Unit) {
        val root = Files.createTempDirectory("lynx-archive-test").toFile()
        try { val archive = File(root, "archive").apply { writeBytes(bytes) }; val out = File(root, "out").apply { mkdir() }; action(archive, out) }
        finally { root.deleteRecursively() }
    }
    private fun zip(vararg names: String, symlink: Boolean = false): ByteArray {
        val bytes = ByteArrayOutputStream()
        ZipArchiveOutputStream(bytes).use { output ->
            names.forEach { name -> val entry = ZipArchiveEntry(name); entry.unixMode = if (symlink) 0xa1ff else 0x81a4; output.putArchiveEntry(entry); output.write("content".toByteArray()); output.closeArchiveEntry() }
        }
        return bytes.toByteArray()
    }
    private fun tar(vararg names: String, symlink: Boolean = false): ByteArray {
        val bytes = ByteArrayOutputStream()
        TarArchiveOutputStream(bytes).use { output ->
            output.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
            names.forEach { name ->
                val entry = if (symlink) TarArchiveEntry(name, '2'.code.toByte()).apply { linkName = "../outside" } else TarArchiveEntry(name).apply { size = 7 }
                output.putArchiveEntry(entry); if (!symlink) output.write("content".toByteArray()); output.closeArchiveEntry()
            }
        }
        return bytes.toByteArray()
    }
    private fun gzip(bytes: ByteArray): ByteArray { val output = ByteArrayOutputStream(); GZIPOutputStream(output).use { it.write(bytes) }; return output.toByteArray() }

    private fun tarEntry(name: String, type: Char, payload: ByteArray = byteArrayOf(), declaredSize: Int = payload.size): ByteArray {
        val header = tar("entry").copyOf(512)
        header.fill(0, 0, 100)
        name.toByteArray().copyInto(header)
        header[156] = type.code.toByte()
        (declaredSize.toString(8).padStart(11, '0') + "\u0000").toByteArray().copyInto(header, 124)
        checksum(header)
        return header + payload + ByteArray((512 - payload.size % 512) % 512)
    }

    private fun checksum(header: ByteArray) {
        header.fill(32, 148, 156)
        (header.take(512).sumOf { it.toInt() and 255 }.toString(8).padStart(6, '0') + "\u0000 ").toByteArray().copyInto(header, 148)
    }

    private fun pax(key: String, value: String): ByteArray {
        var length = 0
        while (true) {
            val bytes = "$length $key=$value\n".toByteArray()
            if (bytes.size == length) return bytes
            length = bytes.size
        }
    }

    @Test fun `rejects malformed TAR termination padding and extension metadata`() {
        val file = tarEntry("entry", '0', "data".toByteArray())
        val end = ByteArray(1024)
        val extension = tarEntry("PaxHeader", 'x', pax("path", "entry"))
        val invalidName = file.copyOf().apply { this[0] = 0xff.toByte(); checksum(this) }
        val cases = mapOf(
            "one end block" to (file + ByteArray(512)),
            "partial end block" to (file + ByteArray(1023)),
            "partial trailing block" to (file + end + byteArrayOf(0)),
            "nonzero trailing block" to (file + end + ByteArray(512).apply { this[0] = 1 }),
            "nonzero file padding" to (file.copyOf().apply { this[516] = 1 } + end),
            "dangling PAX" to (file + extension + end),
            "empty dangling PAX" to (file + tarEntry("PaxHeader", 'x') + end),
            "consecutive PAX" to (extension + extension + file + end),
            "global PAX" to (tarEntry("Global", 'g', pax("path", "entry")) + file + end),
            "GNU long name" to (tarEntry("LongLink", 'L', "entry\u0000".toByteArray()) + file + end),
            "duplicate PAX key" to (tarEntry("PaxHeader", 'x', pax("path", "entry") + pax("path", "other")) + file + end),
            "PAX link" to (tarEntry("PaxHeader", 'x', pax("linkpath", "other")) + file + end),
            "invalid UTF-8" to (invalidName + end),
            "bad checksum" to (file.copyOf().apply { this[0] = 'z'.code.toByte() } + end),
        )
        cases.forEach { (name, bytes) -> fixture(gzip(bytes)) { archive, out ->
            assertThrows(name, Exception::class.java) { StrictArchive.extract(archive, out) }
        } }
    }

    @Test fun `applies PAX path and size to the following file only`() {
        val name = "pages/" + "nested-".repeat(20) + "detail.bundle"
        val payload = "data".toByteArray()
        val bytes = tarEntry("PaxHeader", 'x', pax("path", name) + pax("size", "4")) +
            tarEntry("placeholder", '0', payload, declaredSize = 1) +
            tarEntry("next", '0', "next".toByteArray()) + ByteArray(1024)
        fixture(gzip(bytes)) { archive, out ->
            assertEquals(setOf(name, "next"), StrictArchive.extract(archive, out))
            assertArrayEquals(payload, File(out, name).readBytes())
            assertEquals("next", File(out, "next").readText())
        }
    }

    @Test fun `binds archive paths and sizes to the manifest before writing bytes`() {
        val bytes = gzip(tarEntry("entry", '0', "data".toByteArray()) + ByteArray(1024))
        for (expected in listOf(mapOf("unknown" to 4L), mapOf("entry" to 3L), mapOf("entry" to 5L))) {
            fixture(bytes) { archive, out ->
                assertThrows(IllegalArgumentException::class.java) {
                    StrictArchive.extract(archive, out, expectedFiles = expected)
                }
                assertTrue(out.list().orEmpty().isEmpty())
            }
        }
        fixture(bytes) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) {
                StrictArchive.extract(archive, out, expectedFiles = mapOf("entry" to 4L, "missing" to 0L))
            }
        }
        fixture(bytes) { archive, out ->
            assertEquals(setOf("entry"), StrictArchive.extract(archive, out, expectedFiles = mapOf("entry" to 4L)))
            assertEquals("data", File(out, "entry").readText())
        }
        fixture(gzip(tarEntry("empty/", '5') + ByteArray(1024))) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) {
                StrictArchive.extract(archive, out, expectedFiles = mapOf("empty" to 0L))
            }
            assertTrue(out.list().orEmpty().isEmpty())
        }
    }
    private class SyntheticInput(private var remaining: Long) : InputStream() {
        override fun read(): Int {
            if (remaining == 0L) return -1
            remaining -= 1
            return 0
        }
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining == 0L) return -1
            return minOf(remaining, length.toLong()).toInt().also { remaining -= it }
        }
    }
    private fun drain(input: InputStream): Long {
        var total = 0L
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val size = input.read(buffer)
            if (size < 0) return total
            total += size
        }
    }

    @Test fun `preserves nested underscore and whitespace paths in real ZIP and PAX TAR`() {
        val name = "async/__/" + "long-name-".repeat(18) + " source .bundle "
        for (bytes in listOf(zip(name), gzip(tar(name)))) fixture(bytes) { archive, out ->
            assertEquals(setOf(name), StrictArchive.extract(archive, out)); assertEquals("content", File(out, name).readText())
        }
    }
    @Test fun `rejects traversal instead of silently skipping it`() {
        for (bytes in listOf(zip("../outside"), gzip(tar("../outside")))) fixture(bytes) { archive, out ->
            assertThrows(Exception::class.java) { StrictArchive.extract(archive, out) }; assertFalse(File(out.parentFile, "outside").exists())
        }
    }
    @Test fun `enforces the 1024 UTF-8 byte managed path boundary`() {
        val asciiBoundary = "a".repeat(ArchiveLimits.MAX_PATH_BYTES)
        val unicodeBoundary = "é".repeat(ArchiveLimits.MAX_PATH_BYTES / 2)
        assertEquals(asciiBoundary, ManagedPaths.normalize(asciiBoundary))
        assertEquals(unicodeBoundary, ManagedPaths.normalize(unicodeBoundary))
        assertThrows(IllegalArgumentException::class.java) {
            ManagedPaths.normalize("a".repeat(ArchiveLimits.MAX_PATH_BYTES + 1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            ManagedPaths.normalize(unicodeBoundary + "é")
        }
    }
    @Test fun `rejects C0 DEL and colon in managed and archive paths`() {
        val controls = (0x00..0x1f).map(Int::toChar) + '\u007f'
        (controls.map { "asset${it}name" } + "asset:name").forEach { path ->
            assertThrows(IllegalArgumentException::class.java) {
                ManagedPaths.normalize(path)
            }
        }
        listOf("asset\u001fname", "asset\u007fname", "asset:name").forEach { path ->
            fixture(zip(path)) { archive, out ->
                assertThrows(IllegalArgumentException::class.java) {
                    StrictArchive.extract(archive, out)
                }
                assertTrue(out.list().orEmpty().isEmpty())
            }
        }
    }
    @Test fun `rejects duplicate files before a later entry can replace bytes`() {
        for (bytes in listOf(zip("entry", "entry"), gzip(tar("entry", "entry")))) fixture(bytes) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) { StrictArchive.extract(archive, out) }
        }
    }
    @Test fun `rejects shared portable full case-fold collision fixtures`() {
        for (names in listOf(
            arrayOf("Straße", "STRASSE"),
            arrayOf("μέρος", "ΜΈΡΟσ"),
            arrayOf("Straße", "strasse/entry.lynxbc"),
        )) {
            for (bytes in listOf(zip(*names), gzip(tar(*names)))) fixture(bytes) { archive, out ->
                assertThrows(IllegalArgumentException::class.java) {
                    StrictArchive.extract(archive, out)
                }
            }
        }
    }
    @Test fun `rejects ZIP Unix symlink and TAR symlink metadata`() {
        for (bytes in listOf(zip("link", symlink = true), gzip(tar("link", symlink = true)))) fixture(bytes) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) { StrictArchive.extract(archive, out) }; assertFalse(File(out, "link").exists())
        }
    }
    @Test fun `rejects missing TAR termination after an otherwise complete file`() {
        fixture(gzip(tar("entry").copyOf(1024))) { archive, out -> assertThrows(IOException::class.java) { StrictArchive.extract(archive, out) } }
    }
    @Test fun `rejects truncated archive and excessive ZIP entry count`() {
        for (bytes in listOf(zip("entry").copyOf(20), zip(*Array(ArchiveLimits.MAX_ENTRIES + 1) { "entry-$it" }))) fixture(bytes) { archive, out ->
            assertThrows(Exception::class.java) { StrictArchive.extract(archive, out) }
        }
    }
    @Test fun `counts implicit directories toward the portable entry limit`() {
        val names = Array(ArchiveLimits.MAX_ENTRIES / 2 + 1) { "directory-$it/entry" }
        fixture(zip(*names)) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) {
                StrictArchive.extract(archive, out)
            }
        }
    }
    @Test fun `allows the derived TAR framing ceiling and rejects the next byte`() {
        assertEquals(
            30_711_024L,
            ArchiveLimits.MAX_TAR_STREAM_BYTES - ArchiveLimits.MAX_EXTRACTED_BYTES,
        )
        assertEquals(
            ArchiveLimits.MAX_TAR_STREAM_BYTES,
            drain(BoundedTarInput(SyntheticInput(ArchiveLimits.MAX_TAR_STREAM_BYTES))),
        )
        assertThrows(IllegalArgumentException::class.java) {
            drain(
                BoundedTarInput(
                    SyntheticInput(ArchiveLimits.MAX_TAR_STREAM_BYTES + 1),
                ),
            )
        }
    }
    @Test fun `rejects oversized GNU metadata before allocating its declared size`() {
        val header = tar("entry").copyOf(512)
        header[156] = 'L'.code.toByte()
        val size = "00010000000\u0000".toByteArray(); System.arraycopy(size, 0, header, 124, size.size)
        for (i in 148..155) header[i] = 32
        val checksum = header.sumOf { it.toInt() and 255 }.toString(8).padStart(6, '0').plus("\u0000 ").toByteArray()
        System.arraycopy(checksum, 0, header, 148, checksum.size)
        fixture(gzip(header)) { archive, out -> assertThrows(IOException::class.java) { StrictArchive.extract(archive, out) }; assertTrue(out.list().orEmpty().isEmpty()) }
    }
    @Test fun `interruption never writes outside its new extraction directory`() {
        fixture(zip("entry")) { archive, out ->
            Thread.currentThread().interrupt()
            try { assertThrows(InterruptedIOException::class.java) { StrictArchive.extract(archive, out) } }
            finally { Thread.interrupted() }
            assertFalse(File(out, "entry").exists())
        }
    }
    @Test fun `rejects in-root symbolic aliases as well as escapes`() {
        val root = Files.createTempDirectory("lynx-path-test").toFile()
        try { File(root, "entry").writeText("content"); Files.createSymbolicLink(File(root, "alias").toPath(), File(root, "entry").toPath()); assertThrows(IllegalArgumentException::class.java) { ManagedPaths.resolve(root, "alias") } }
        finally { root.deleteRecursively() }
    }
}
