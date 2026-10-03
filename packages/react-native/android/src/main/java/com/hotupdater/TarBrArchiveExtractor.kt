package com.hotupdater

import com.hotupdater.vendor.brotli.dec.BrotliInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream

internal object TarBrArchiveExtractor {
    fun extract(
        archiveFile: File,
        destination: File,
        expectedTarByteSize: Long,
        expectedFiles: Map<String, Long>,
    ) {
        require(expectedTarByteSize >= 0) { "Invalid TAR byte size" }
        if (destination.exists() && !destination.deleteRecursively()) {
            throw IOException("Cannot clear archive extraction directory")
        }
        if (!destination.mkdirs()) throw IOException("Cannot create archive extraction directory")

        try {
            FileInputStream(archiveFile).use { compressedInput ->
                BrotliInputStream(compressedInput).use { brotliInput ->
                    val boundedInput = ExactSizeInputStream(brotliInput, expectedTarByteSize)
                    TarArchiveInputStream(boundedInput).use { tarInput ->
                        val extractedPaths = linkedSetOf<String>()
                        var entry = tarInput.getNextEntry()
                        while (entry != null) {
                            if (!entry.isRegularFile) {
                                throw IOException("Unsupported TAR entry type for ${entry.name}")
                            }
                            val normalizedPath = RelativePathResolver.normalizeRelativePath(entry.name)
                            if (normalizedPath == null || normalizedPath != entry.name) {
                                throw IOException("Unsafe TAR entry path: ${entry.name}")
                            }
                            val expectedSize =
                                expectedFiles[normalizedPath]
                                    ?: throw IOException("Unexpected TAR entry: $normalizedPath")
                            if (!extractedPaths.add(normalizedPath)) {
                                throw IOException("Duplicate TAR entry: $normalizedPath")
                            }
                            if (entry.size != expectedSize) {
                                throw IOException("TAR entry size mismatch: $normalizedPath")
                            }

                            val outputFile =
                                RelativePathResolver.resolveInside(destination, normalizedPath)
                                    ?: throw IOException("Unsafe TAR entry path: $normalizedPath")
                            if (outputFile.exists()) throw IOException("TAR output already exists: $normalizedPath")
                            val parentDirectory = outputFile.parentFile
                            if (parentDirectory != null && !parentDirectory.isDirectory && !parentDirectory.mkdirs()) {
                                throw IOException("Cannot create TAR output directory: $normalizedPath")
                            }
                            outputFile.outputStream().use { output ->
                                val buffer = ByteArray(8192)
                                var written = 0L
                                while (true) {
                                    val count = tarInput.read(buffer)
                                    if (count < 0) break
                                    output.write(buffer, 0, count)
                                    written += count
                                }
                                if (written != expectedSize) {
                                    throw IOException("TAR entry was truncated: $normalizedPath")
                                }
                            }
                            entry = tarInput.getNextEntry()
                        }

                        if (extractedPaths != expectedFiles.keys) {
                            throw IOException("TAR file set does not match manifest")
                        }
                    }
                    boundedInput.requireExactSize()
                }
            }
        } catch (error: Throwable) {
            destination.deleteRecursively()
            throw error
        }
    }

    private class ExactSizeInputStream(
        private val input: InputStream,
        private val expectedSize: Long,
    ) : InputStream() {
        private var byteCount = 0L

        override fun read(): Int {
            val result = input.read()
            if (result >= 0) recordRead(1)
            return result
        }

        override fun read(
            buffer: ByteArray,
            offset: Int,
            length: Int,
        ): Int {
            val count = input.read(buffer, offset, length)
            if (count > 0) recordRead(count.toLong())
            return count
        }

        fun requireExactSize() {
            if (byteCount != expectedSize) {
                throw IOException("TAR stream size mismatch: expected $expectedSize, got $byteCount")
            }
        }

        private fun recordRead(count: Long) {
            if (byteCount > expectedSize - count) {
                throw IOException("TAR stream exceeds declared size")
            }
            byteCount += count
        }
    }
}
