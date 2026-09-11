package com.hotupdater.lynx.internal

import java.io.ByteArrayOutputStream
import java.io.File
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
    @Test fun `rejects duplicate files before a later entry can replace bytes`() {
        for (bytes in listOf(zip("entry", "entry"), gzip(tar("entry", "entry")))) fixture(bytes) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) { StrictArchive.extract(archive, out) }
        }
    }
    @Test fun `rejects ZIP Unix symlink and TAR symlink metadata`() {
        for (bytes in listOf(zip("link", symlink = true), gzip(tar("link", symlink = true)))) fixture(bytes) { archive, out ->
            assertThrows(IllegalArgumentException::class.java) { StrictArchive.extract(archive, out) }; assertFalse(File(out, "link").exists())
        }
    }
    @Test fun `rejects missing TAR termination after an otherwise complete file`() {
        fixture(gzip(tar("entry").copyOf(1024))) { archive, out -> assertThrows(IllegalArgumentException::class.java) { StrictArchive.extract(archive, out) } }
    }
    @Test fun `rejects truncated archive and excessive ZIP entry count`() {
        for (bytes in listOf(zip("entry").copyOf(20), zip(*Array(ArchiveLimits.MAX_ENTRIES + 1) { "entry-$it" }))) fixture(bytes) { archive, out ->
            assertThrows(Exception::class.java) { StrictArchive.extract(archive, out) }
        }
    }
    @Test fun `rejects oversized GNU metadata before allocating its declared size`() {
        val header = tar("entry").copyOf(512)
        header[156] = 'L'.code.toByte()
        val size = "00010000000\u0000".toByteArray(); System.arraycopy(size, 0, header, 124, size.size)
        for (i in 148..155) header[i] = 32
        val checksum = header.sumOf { it.toInt() and 255 }.toString(8).padStart(6, '0').plus("\u0000 ").toByteArray()
        System.arraycopy(checksum, 0, header, 148, checksum.size)
        fixture(gzip(header)) { archive, out -> assertThrows(IllegalArgumentException::class.java) { StrictArchive.extract(archive, out) } }
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
