package com.hotupdater.lynx.internal

import com.hotupdater.lynx.vendor.brotli.dec.BrotliInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.RandomAccessFile
import java.text.Normalizer
import java.util.Locale
import java.util.zip.CRC32
import java.util.zip.GZIPInputStream
import java.util.zip.ZipFile

internal object ManagedPaths {
    fun normalize(path: String): String {
        require(
            path.isNotBlank() &&
                path.toByteArray(Charsets.UTF_8).size <= ArchiveLimits.MAX_PATH_BYTES &&
                !path.contains('\\') &&
                path.none { it in '\u0000'..'\u001f' || it == '\u007f' || it == ':' },
        ) { "Invalid managed path" }
        require(!path.startsWith('/') && !Regex("^[A-Za-z]:").containsMatchIn(path)) { "Absolute managed path" }
        val result = path.removeSuffix("/")
        require(result.split('/').none { it.isEmpty() || it == "." || it == ".." }) { "Managed path traversal" }
        return result
    }
    fun resolve(root: File, path: String): File {
        val result = File(root.canonicalFile, normalize(path)).absoluteFile
        require(result == result.canonicalFile && result.path.startsWith(root.canonicalPath + File.separator)) { "Managed path escapes root or uses a symbolic link" }
        return result
    }
}

/** Portable namespace shared by archive extraction and manifest-backed installs. */
internal class ManagedPathNamespace {
    private val portablePaths = mutableMapOf<String, String>()
    private val portableDirectories = mutableSetOf<String>()
    private val portableFiles = mutableSetOf<String>()

    fun directory(path: String): String = add(path, directory = true)

    fun file(path: String): String = add(path, directory = false)

    private fun add(path: String, directory: Boolean): String {
        val normalized = ManagedPaths.normalize(path)
        require(normalized == path) { "Noncanonical managed path" }
        var prefix = ""
        val segments = normalized.split('/')
        segments.forEachIndexed { index, segment ->
            prefix = if (prefix.isEmpty()) segment else "$prefix/$segment"
            val key = portable(prefix)
            require(portablePaths[key].let { it == null || it == prefix }) {
                "Portable managed path collision"
            }
            portablePaths[key] = prefix
            if (index < segments.lastIndex || directory) {
                require(key !in portableFiles) {
                    "Portable managed ancestor collision"
                }
                portableDirectories.add(key)
            } else {
                require(key !in portableDirectories && portableFiles.add(key)) {
                    "Portable managed ancestor or duplicate file collision"
                }
            }
            require(portableDirectories.size + portableFiles.size <= ArchiveLimits.MAX_ENTRIES) {
                "Managed namespace entry limit exceeded"
            }
        }
        return normalized
    }

    private fun portable(path: String) =
        Normalizer.normalize(path, Normalizer.Form.NFC)
            .uppercase(Locale.ROOT)
            .lowercase(Locale.ROOT)
}

/** Bounds decoded TAR bytes, including headers, padding, metadata, and end blocks. */
internal class BoundedTarInput(input: InputStream) : FilterInputStream(input) {
    private var count = 0L

    private fun add(size: Int) {
        if (size > 0) {
            count += size
            require(count <= ArchiveLimits.MAX_TAR_STREAM_BYTES) {
                "Decoded TAR stream exceeds limit"
            }
        }
    }

    override fun read(): Int = `in`.read().also { add(if (it < 0) 0 else 1) }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        `in`.read(buffer, offset, length).also(::add)
}

/** Strict policy over the existing TAR decoder and Android's ZIP decoder. */
internal object StrictArchive {
    fun extract(archive: File, root: File): Set<String> {
        require(archive.length() in 1..ArchiveLimits.MAX_ARCHIVE_BYTES) { "Invalid archive size" }
        require(root.isDirectory && root.list().orEmpty().isEmpty()) { "Extraction requires a new empty directory" }
        val writer = Writer(root)
        val magic = archive.inputStream().use { it.readNBytesCompat(4) }
        if (magic.contentEquals(byteArrayOf(0x50, 0x4b, 0x03, 0x04))) {
            rejectZipLinks(archive)
            ZipFile(archive).use { zip ->
                val entries = zip.entries()
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement()
                    if (entry.isDirectory) writer.directory(entry.name)
                    else zip.getInputStream(entry).use { writer.file(entry.name, entry.size, it, entry.crc) }
                }
            }
        } else {
            archive.inputStream().buffered().use { input ->
                val decoded = if (magic.size >= 2 && magic[0] == 0x1f.toByte() && magic[1] == 0x8b.toByte()) GZIPInputStream(input) else BrotliInputStream(input)
                TarArchiveInputStream(BoundedTarInput(decoded)).use { tar ->
                    while (true) {
                        val entry = tar.getNextEntry() ?: break
                        require(entry.typeFlag == '5' || entry.isFile) { "Archive links and special entries are forbidden" }
                        if (entry.typeFlag == '5') { require(entry.size == 0L) { "Directory has content" }; writer.directory(entry.name) }
                        else { require(!entry.name.endsWith('/')) { "Invalid regular file name" }; writer.file(entry.name, entry.size, tar) }
                    }
                    require(tar.hasEndMarker) { "Truncated TAR archive" }
                }
            }
        }
        check(writer.files.isNotEmpty()) { "Empty archive" }
        return writer.files.toSet()
    }

    private class Writer(private val root: File) {
        private val entries = mutableSetOf<String>()
        private val namespace = ManagedPathNamespace()
        val files = mutableSetOf<String>()
        private var bytes = 0L
        private fun destination(name: String, directory: Boolean): File {
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Archive extraction interrupted")
            val normalized = ManagedPaths.normalize(name)
            require(entries.add(normalized)) { "Duplicate archive entry" }
            if (directory) namespace.directory(normalized) else namespace.file(normalized)
            return ManagedPaths.resolve(root, normalized)
        }
        fun directory(name: String) { val target = destination(name, true); check(target.mkdirs() || target.isDirectory) { "Archive directory conflicts with a file" } }
        fun file(name: String, expectedSize: Long, input: InputStream, expectedCrc: Long = -1) {
            require(expectedSize in 0..ArchiveLimits.MAX_FILE_BYTES) { "Archive entry exceeds size limit" }
            val target = destination(name, false)
            check(!target.exists()) { "Archive entry conflicts with an existing path" }
            check(target.parentFile!!.mkdirs() || target.parentFile!!.isDirectory) { "Cannot create archive parent" }
            var count = 0L
            val crc = CRC32()
            FileOutputStream(target).use { output ->
                val buffer = ByteArray(8192)
                while (true) {
                    if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Archive extraction interrupted")
                    val size = input.read(buffer)
                    if (size < 0) break
                    count += size; bytes += size
                    require(count <= expectedSize && bytes <= ArchiveLimits.MAX_EXTRACTED_BYTES) { "Archive expansion exceeds limit" }
                    output.write(buffer, 0, size); crc.update(buffer, 0, size)
                }
                output.fd.sync()
            }
            check(count == expectedSize && (expectedCrc < 0 || crc.value == expectedCrc)) { "Truncated or corrupt archive entry" }
            files.add(ManagedPaths.normalize(name))
        }
    }

    /** ZIP's Java API hides Unix link metadata; inspect bounded central records before extraction. */
    private fun rejectZipLinks(file: File) = RandomAccessFile(file, "r").use { input ->
        val length = input.length()
        val tail = ByteArray(minOf(length, 65557L).toInt())
        input.seek(length - tail.size); input.readFully(tail)
        fun number(bytes: ByteArray, offset: Int, size: Int): Long = (0 until size).fold(0L) { n, i -> n or ((bytes[offset + i].toLong() and 255) shl (8 * i)) }
        val end = (tail.size - 22 downTo 0).firstOrNull { i -> number(tail, i, 4) == 0x06054b50L && i + 22 + number(tail, i + 20, 2) == tail.size.toLong() }
        require(end != null) { "ZIP end record missing" }
        val count = number(tail, end + 10, 2)
        val size = number(tail, end + 12, 4)
        val offset = number(tail, end + 16, 4)
        require(number(tail, end + 4, 2) == 0L && number(tail, end + 6, 2) == 0L && number(tail, end + 8, 2) == count) { "Split ZIP is unsupported" }
        require(count in 1..ArchiveLimits.MAX_ENTRIES && offset + size == length - tail.size + end) { "ZIP64 or invalid central directory" }
        input.seek(offset)
        repeat(count.toInt()) {
            val header = ByteArray(46); input.readFully(header)
            require(number(header, 0, 4) == 0x02014b50L) { "Invalid ZIP central entry" }
            val type = (number(header, 38, 4) ushr 16) and 0xf000
            require(type == 0L || type == 0x8000L || type == 0x4000L) { "ZIP links and special entries are forbidden" }
            require((number(header, 8, 2) and 1) == 0L) { "Encrypted ZIP is unsupported" }
            val next = input.filePointer + number(header, 28, 2) + number(header, 30, 2) + number(header, 32, 2)
            require(next <= offset + size) { "ZIP central entry exceeds directory" }
            input.seek(next)
        }
        require(input.filePointer == offset + size) { "ZIP central directory count mismatch" }
    }

    private fun InputStream.readNBytesCompat(count: Int): ByteArray { val data = ByteArray(count); var n = 0; while (n < count) { val read = read(data, n, count - n); if (read < 0) break; n += read }; return data.copyOf(n) }
}
