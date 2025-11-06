package com.hotupdater

import android.util.Log
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * Secure TAR archive input stream for Android API 21+
 * Replaces Apache Commons Compress to avoid java.nio.file dependencies
 */
class TarArchiveInputStream(
    private val input: InputStream
) : InputStream() {
    private var currentEntry: TarArchiveEntry? = null
    private var currentEntryBytesRead: Long = 0
    private var longName: String? = null

    companion object {
        private const val TAG = "TarInputStream"
        private const val BLOCK_SIZE = 512
        private const val NAME_OFFSET = 0
        private const val NAME_LENGTH = 100
        private const val MODE_OFFSET = 100
        private const val SIZE_OFFSET = 124
        private const val SIZE_LENGTH = 12
        private const val CHECKSUM_OFFSET = 148
        private const val CHECKSUM_LENGTH = 8
        private const val TYPEFLAG_OFFSET = 156
        private const val LINKNAME_OFFSET = 157
        private const val LINKNAME_LENGTH = 100
        private const val MAGIC_OFFSET = 257
        private const val PREFIX_OFFSET = 345
        private const val PREFIX_LENGTH = 155

        // Maximum file size: 1GB per file
        private const val MAX_FILE_SIZE = 1_073_741_824L
    }

    /**
     * Get the next TAR entry
     */
    fun getNextEntry(): TarArchiveEntry? {
            // Skip remaining bytes of current entry
            if (currentEntry != null) {
                val remaining = currentEntry!!.size - currentEntryBytesRead
                if (remaining > 0) {
                    skipBytes(remaining)
                }
                skipPadding(currentEntry!!.size)
            }

            currentEntryBytesRead = 0

            while (true) {
                val headerBytes = readBlock() ?: return null

                // Check for end of archive (all zeros)
                if (isAllZeros(headerBytes)) {
                    return null
                }

                // Verify header
                if (!isValidHeader(headerBytes)) {
                    throw IOException("Invalid TAR header")
                }

                if (!verifyChecksum(headerBytes)) {
                    throw IOException("TAR header checksum verification failed")
                }

                // Parse header
                val entry = parseHeader(headerBytes)

                // Handle GNU long filename extension
                if (entry.typeFlag == 'L') {
                    longName = readLongName(entry.size)
                    continue
                }

                // Apply long name if present
                if (longName != null) {
                    entry.name = longName!!
                    longName = null
                }

                // Validate entry
                validateEntry(entry)

                currentEntry = entry
                return entry
            }
        }

    override fun read(): Int {
        val b = ByteArray(1)
        val n = read(b, 0, 1)
        return if (n <= 0) -1 else b[0].toInt() and 0xFF
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (currentEntry == null) {
            throw IllegalStateException("No current entry")
        }

        val remaining = currentEntry!!.size - currentEntryBytesRead
        if (remaining <= 0) {
            return -1
        }

        val toRead = minOf(len.toLong(), remaining).toInt()
        val bytesRead = input.read(b, off, toRead)

        if (bytesRead > 0) {
            currentEntryBytesRead += bytesRead
        }

        return bytesRead
    }

    override fun close() {
        input.close()
    }

    /**
     * Read a 512-byte block from input
     */
    private fun readBlock(): ByteArray? {
        val block = ByteArray(BLOCK_SIZE)
        var offset = 0

        while (offset < BLOCK_SIZE) {
            val n = input.read(block, offset, BLOCK_SIZE - offset)
            if (n < 0) {
                return if (offset == 0) null else throw EOFException("Unexpected end of TAR archive")
            }
            offset += n
        }

        return block
    }

    /**
     * Check if block is all zeros
     */
    private fun isAllZeros(block: ByteArray): Boolean {
        return block.all { it == 0.toByte() }
    }

    /**
     * Verify TAR header has valid magic number
     */
    private fun isValidHeader(header: ByteArray): Boolean {
        // Check for "ustar" magic (may have \0 or space after)
        val magic = String(header, MAGIC_OFFSET, 5, Charsets.US_ASCII)
        return magic == "ustar"
    }

    /**
     * Verify header checksum
     */
    private fun verifyChecksum(header: ByteArray): Boolean {
        val storedChecksum = parseOctal(header, CHECKSUM_OFFSET, CHECKSUM_LENGTH).toInt()

        // Calculate checksums (both signed and unsigned for compatibility)
        var unsignedSum = 0
        var signedSum = 0

        for (i in 0 until BLOCK_SIZE) {
            val value = if (i in CHECKSUM_OFFSET until CHECKSUM_OFFSET + CHECKSUM_LENGTH) {
                32 // Space character
            } else {
                header[i].toInt()
            }

            unsignedSum += value and 0xFF
            signedSum += value.toByte().toInt()
        }

        return storedChecksum == unsignedSum || storedChecksum == signedSum
    }

    /**
     * Parse TAR header into TarArchiveEntry
     */
    private fun parseHeader(header: ByteArray): TarArchiveEntry {
        val name = parseString(header, NAME_OFFSET, NAME_LENGTH)
        val mode = parseOctal(header, MODE_OFFSET, 8).toInt()
        val size = parseNumeric(header, SIZE_OFFSET, SIZE_LENGTH)
        val typeFlag = header[TYPEFLAG_OFFSET].toInt().toChar()
        val linkName = parseString(header, LINKNAME_OFFSET, LINKNAME_LENGTH)
        val prefix = parseString(header, PREFIX_OFFSET, PREFIX_LENGTH)

        // Combine prefix and name
        val fullName = if (prefix.isNotEmpty()) "$prefix/$name" else name

        return TarArchiveEntry(
            name = fullName,
            mode = mode,
            size = size,
            typeFlag = typeFlag,
            linkName = linkName
        )
    }

    /**
     * Parse string field from header
     */
    private fun parseString(bytes: ByteArray, offset: Int, length: Int): String {
        var end = offset
        while (end < offset + length && bytes[end] != 0.toByte()) {
            end++
        }
        return String(bytes, offset, end - offset, Charsets.UTF_8).trim()
    }

    /**
     * Parse octal number from header field
     */
    private fun parseOctal(bytes: ByteArray, offset: Int, length: Int): Long {
        var result = 0L
        var i = offset
        val end = offset + length

        // Skip leading spaces
        while (i < end && bytes[i] == ' '.code.toByte()) i++

        // Parse octal digits
        while (i < end) {
            val b = bytes[i]
            if (b == 0.toByte() || b == ' '.code.toByte()) break
            if (b < '0'.code.toByte() || b > '7'.code.toByte()) {
                throw IOException("Invalid octal digit: ${b.toInt()}")
            }
            result = result * 8 + (b - '0'.code.toByte())
            i++
        }

        return result
    }

    /**
     * Parse numeric field (supports both octal and base-256 encoding)
     */
    private fun parseNumeric(bytes: ByteArray, offset: Int, length: Int): Long {
        // Check for base-256 encoding (high bit set)
        if ((bytes[offset].toInt() and 0x80) != 0) {
            return parseBase256(bytes, offset, length)
        }
        return parseOctal(bytes, offset, length)
    }

    /**
     * Parse base-256 encoded number (for files > 8GB)
     */
    private fun parseBase256(bytes: ByteArray, offset: Int, length: Int): Long {
        var result = 0L

        // Skip first byte (marker) and read big-endian
        for (i in 1 until length) {
            result = (result shl 8) or (bytes[offset + i].toInt() and 0xFF).toLong()
        }

        return result
    }

    /**
     * Read GNU long filename extension
     */
    private fun readLongName(size: Long): String {
        val nameBytes = ByteArray(size.toInt())
        var offset = 0

        while (offset < size) {
            val n = input.read(nameBytes, offset, size.toInt() - offset)
            if (n < 0) throw EOFException("Unexpected end reading long name")
            offset += n
        }

        skipPadding(size)

        // Remove trailing NUL
        val nameLength = nameBytes.indexOfFirst { it == 0.toByte() }
            .takeIf { it >= 0 } ?: nameBytes.size

        return String(nameBytes, 0, nameLength, Charsets.UTF_8)
    }

    /**
     * Skip padding to 512-byte boundary
     */
    private fun skipPadding(size: Long) {
        val remainder = size % BLOCK_SIZE
        if (remainder != 0L) {
            skipBytes(BLOCK_SIZE - remainder)
        }
    }

    /**
     * Skip specified number of bytes
     */
    private fun skipBytes(n: Long) {
        var remaining = n
        val buffer = ByteArray(8192)

        while (remaining > 0) {
            val toSkip = minOf(buffer.size.toLong(), remaining).toInt()
            val skipped = input.read(buffer, 0, toSkip)
            if (skipped < 0) throw EOFException("Unexpected end of stream")
            remaining -= skipped
        }
    }

    /**
     * Validate entry for security issues
     */
    private fun validateEntry(entry: TarArchiveEntry) {
        // Check for negative or excessive file size
        if (entry.size < 0) {
            throw SecurityException("Negative file size: ${entry.size}")
        }

        if (entry.size > MAX_FILE_SIZE) {
            throw SecurityException("File size ${entry.size} exceeds maximum $MAX_FILE_SIZE")
        }

        // Check for absolute paths
        if (entry.name.startsWith("/")) {
            throw SecurityException("Absolute path not allowed: ${entry.name}")
        }

        // Check for path traversal
        val normalized = entry.name.replace('\\', '/')
        if (normalized.contains("../") ||
            normalized.contains("/..") ||
            normalized == ".." ||
            normalized.startsWith("../")) {
            throw SecurityException("Path traversal detected: ${entry.name}")
        }

        // Check for null bytes in filename
        if (entry.name.contains('\u0000')) {
            throw SecurityException("Null byte in filename: ${entry.name}")
        }
    }
}

/**
 * TAR archive entry
 */
data class TarArchiveEntry(
    var name: String,
    val mode: Int,
    val size: Long,
    val typeFlag: Char,
    val linkName: String
) {
    val isDirectory: Boolean
        get() = typeFlag == '5' || name.endsWith('/')

    val isFile: Boolean
        get() = typeFlag == '0' || typeFlag == '\u0000'

    val isSymbolicLink: Boolean
        get() = typeFlag == '2'
}
