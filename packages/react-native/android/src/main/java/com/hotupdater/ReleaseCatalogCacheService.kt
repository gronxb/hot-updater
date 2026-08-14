package com.hotupdater

import android.util.AtomicFile
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal class ReleaseCatalogCacheService(
    private val rootDirectory: File,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val maxEntryBytes: Int = DEFAULT_MAX_ENTRY_BYTES,
    private val maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
    private val atomicReader: (File) -> ByteArray? = ::readAtomically,
    private val atomicWriter: (File, ByteArray) -> Boolean = ::writeAtomically,
    private val atomicRemover: (File) -> Boolean = ::removeAtomically,
) {
    companion object {
        private const val DIGEST_BYTES = 64
        private const val MAX_COMPILED_CATALOG_BYTES = 256 * 1024
        private const val MAX_WIRE_ENVELOPE_BYTES = 4 * 1024
        private const val MAX_ETAG_BYTES = 1024
        private const val CACHE_FORMAT_BYTES = 3
        const val DEFAULT_MAX_ENTRIES = 8
        const val DEFAULT_MAX_ENTRY_BYTES =
            MAX_COMPILED_CATALOG_BYTES + MAX_WIRE_ENVELOPE_BYTES + MAX_ETAG_BYTES + CACHE_FORMAT_BYTES
        const val DEFAULT_MAX_TOTAL_BYTES =
            DEFAULT_MAX_ENTRIES.toLong() * (DEFAULT_MAX_ENTRY_BYTES + DIGEST_BYTES + 1)
        private const val ENTRY_SUFFIX = ".catalog"

        private fun readAtomically(file: File): ByteArray? =
            try {
                val atomicFile = AtomicFile(file)
                atomicFile.openRead().use { input -> input.readBytes() }
            } catch (_: Exception) {
                null
            }

        private fun removeAtomically(file: File): Boolean {
            val atomicFile = AtomicFile(file)
            atomicFile.delete()
            return !file.exists() &&
                !File("${file.path}.bak").exists() &&
                !File("${file.path}.new").exists()
        }

        private fun writeAtomically(
            destination: File,
            bytes: ByteArray,
        ): Boolean {
            val atomicFile = AtomicFile(destination)
            var output: FileOutputStream? = null
            return try {
                output = atomicFile.startWrite()
                output.write(bytes)
                output.fd.sync()
                atomicFile.finishWrite(output)
                true
            } catch (_: Exception) {
                output?.let(atomicFile::failWrite)
                false
            }
        }
    }

    init {
        recoverInterruptedWrites()
        trim()
    }

    @Synchronized
    fun get(partition: String): String? {
        val file = entryFile(partition)
        return try {
            val stored = atomicReader(file) ?: return null
            if (stored.size > maxEntryBytes + DIGEST_BYTES + 1) {
                atomicRemover(file)
                return null
            }
            val separator = stored.indexOf('\n'.code.toByte())
            if (separator != DIGEST_BYTES) {
                atomicRemover(file)
                return null
            }
            val expectedDigest = String(stored, 0, separator, StandardCharsets.US_ASCII)
            val payload = stored.copyOfRange(separator + 1, stored.size)
            if (payload.size > maxEntryBytes || sha256(payload) != expectedDigest) {
                atomicRemover(file)
                return null
            }

            file.setLastModified(System.currentTimeMillis())
            String(payload, StandardCharsets.UTF_8)
        } catch (_: Exception) {
            atomicRemover(file)
            null
        }
    }

    @Synchronized
    fun set(
        partition: String,
        value: String,
    ): Boolean {
        val payload = value.toByteArray(StandardCharsets.UTF_8)
        if (payload.size > maxEntryBytes) return false
        if (!rootDirectory.exists() && !rootDirectory.mkdirs()) return false

        val destination = entryFile(partition)
        return try {
            val stored =
                sha256(payload).toByteArray(StandardCharsets.US_ASCII) +
                    byteArrayOf('\n'.code.toByte()) +
                    payload
            if (!atomicWriter(destination, stored)) return false
            destination.setLastModified(System.currentTimeMillis())
            trim()
            true
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun remove(partition: String): Boolean = atomicRemover(entryFile(partition))

    private fun entryFile(partition: String): File =
        File(rootDirectory, "${sha256(partition.toByteArray(StandardCharsets.UTF_8))}$ENTRY_SUFFIX")

    private fun recoverInterruptedWrites() {
        rootDirectory.listFiles()?.forEach { file ->
            when {
                file.name.endsWith("$ENTRY_SUFFIX.bak") -> {
                    val destination = File(file.parentFile, file.name.removeSuffix(".bak"))
                    if (atomicReader(destination) == null) atomicRemover(destination)
                }

                file.name.endsWith("$ENTRY_SUFFIX.new") -> {
                    val destination = File(file.parentFile, file.name.removeSuffix(".new"))
                    if (atomicReader(destination) == null) atomicRemover(destination)
                }
            }
        }
    }

    private fun trim() {
        val entries =
            rootDirectory
                .listFiles { file -> file.isFile && file.name.endsWith(ENTRY_SUFFIX) }
                ?.sortedByDescending { it.lastModified() }
                .orEmpty()
        var retainedBytes = 0L
        entries.forEachIndexed { index, file ->
            retainedBytes += file.length()
            if (index >= maxEntries || retainedBytes > maxTotalBytes) {
                atomicRemover(file)
            }
        }
    }

    private fun sha256(value: ByteArray): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(value)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
