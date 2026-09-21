package com.hotupdater

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

internal data class TarArchiveEntry(
    val name: String,
    val size: Long,
    val typeFlag: Char,
) {
    val isRegularFile: Boolean
        get() = typeFlag == '0' || typeFlag == '\u0000'
}

/** Small, strict TAR reader for the deterministic bundle.tar.br transport. */
internal class TarArchiveInputStream(
    private val input: InputStream,
) : InputStream() {
    companion object {
        private const val BLOCK_SIZE = 512
        private const val MAX_EXTENSION_SIZE = 1024 * 1024L
    }

    private var currentEntry: TarArchiveEntry? = null
    private var currentEntryBytesRead = 0L
    private var pendingPaxHeaders: Map<String, String>? = null
    private var finished = false

    fun getNextEntry(): TarArchiveEntry? {
        if (finished) return null
        finishCurrentEntry()

        while (true) {
            val header = readBlock(required = true)
            if (header.all { it == 0.toByte() }) {
                val secondEndBlock = readBlock(required = true)
                if (!secondEndBlock.all { it == 0.toByte() } || pendingPaxHeaders != null) {
                    throw IOException("Invalid TAR termination")
                }
                consumeTrailingZeroBlocks()
                finished = true
                return null
            }

            verifyHeader(header)
            val entry = parseHeader(header)
            when (entry.typeFlag) {
                'x' -> {
                    if (pendingPaxHeaders != null) throw IOException("Consecutive PAX headers are not supported")
                    pendingPaxHeaders = readPaxHeaders(entry.size)
                    continue
                }

                'g' -> throw IOException("Global PAX headers are not supported")
                'L' -> throw IOException("GNU long names are not supported")
            }

            val paxHeaders = pendingPaxHeaders.orEmpty()
            pendingPaxHeaders = null
            if (paxHeaders.containsKey("linkpath")) throw IOException("TAR links are not allowed")
            val resolvedEntry =
                entry.copy(
                    name = paxHeaders["path"] ?: entry.name,
                    size = paxHeaders["size"]?.let(::parsePaxSize) ?: entry.size,
                )
            currentEntry = resolvedEntry
            currentEntryBytesRead = 0
            return resolvedEntry
        }
    }

    override fun read(): Int {
        val byte = ByteArray(1)
        return if (read(byte, 0, 1) == -1) -1 else byte[0].toInt() and 0xff
    }

    override fun read(
        buffer: ByteArray,
        offset: Int,
        length: Int,
    ): Int {
        val entry = currentEntry ?: throw IllegalStateException("No current TAR entry")
        val remaining = entry.size - currentEntryBytesRead
        if (remaining == 0L) return -1
        val count = input.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
        if (count < 0) throw EOFException("TAR entry ${entry.name} is truncated")
        if (count == 0) throw IOException("TAR entry read made no progress")
        currentEntryBytesRead += count
        return count
    }

    private fun finishCurrentEntry() {
        val entry = currentEntry ?: return
        skipExactly(entry.size - currentEntryBytesRead)
        readPadding(entry.size)
        currentEntry = null
        currentEntryBytesRead = 0
    }

    private fun readBlock(required: Boolean): ByteArray {
        val block = ByteArray(BLOCK_SIZE)
        var offset = 0
        while (offset < block.size) {
            val count = input.read(block, offset, block.size - offset)
            if (count < 0) {
                if (!required && offset == 0) return ByteArray(0)
                throw EOFException("Unexpected end of TAR archive")
            }
            if (count == 0) throw IOException("TAR stream made no progress")
            offset += count
        }
        return block
    }

    private fun consumeTrailingZeroBlocks() {
        while (true) {
            val block = readBlock(required = false)
            if (block.isEmpty()) return
            if (!block.all { it == 0.toByte() }) {
                throw IOException("TAR archive has trailing non-zero data")
            }
        }
    }

    private fun verifyHeader(header: ByteArray) {
        val magic = String(header, 257, 5, Charsets.US_ASCII)
        if (magic != "ustar") throw IOException("Invalid TAR magic")

        val storedChecksum = parseOctal(header, 148, 8)
        var unsignedChecksum = 0L
        var signedChecksum = 0L
        header.forEachIndexed { index, byte ->
            val value = if (index in 148 until 156) 32 else byte.toInt()
            unsignedChecksum += value and 0xff
            signedChecksum += value.toByte().toInt()
        }
        if (storedChecksum != unsignedChecksum && storedChecksum != signedChecksum) {
            throw IOException("TAR header checksum mismatch")
        }
    }

    private fun parseHeader(header: ByteArray): TarArchiveEntry {
        val name = parseString(header, 0, 100)
        val prefix = parseString(header, 345, 155)
        val fullName =
            when {
                prefix.isEmpty() -> name
                name.isEmpty() -> prefix
                else -> "$prefix/$name"
            }
        return TarArchiveEntry(
            name = fullName,
            size = parseNumeric(header, 124, 12),
            typeFlag = header[156].toInt().toChar(),
        )
    }

    private fun parseString(
        bytes: ByteArray,
        offset: Int,
        length: Int,
    ): String {
        var end = offset
        while (end < offset + length && bytes[end] != 0.toByte()) end++
        return decodeUtf8(bytes, offset, end - offset)
    }

    private fun parseNumeric(
        bytes: ByteArray,
        offset: Int,
        length: Int,
    ): Long {
        if ((bytes[offset].toInt() and 0x80) == 0) {
            return parseOctal(bytes, offset, length)
        }
        if ((bytes[offset].toInt() and 0x40) != 0) {
            throw IOException("Negative TAR sizes are not supported")
        }
        var result = 0L
        for (index in offset until offset + length) {
            val value = bytes[index].toInt() and 0xff
            val payload = if (index == offset) value and 0x7f else value
            if (result > (Long.MAX_VALUE - payload) / 256) {
                throw IOException("TAR size overflows Long")
            }
            result = result * 256 + payload
        }
        return result
    }

    private fun parseOctal(
        bytes: ByteArray,
        offset: Int,
        length: Int,
    ): Long {
        var result = 0L
        var started = false
        for (index in offset until offset + length) {
            val value = bytes[index]
            if (!started && (value == 0.toByte() || value == ' '.code.toByte())) continue
            if (value == 0.toByte() || value == ' '.code.toByte()) break
            if (value !in '0'.code.toByte()..'7'.code.toByte()) {
                throw IOException("Invalid TAR octal value")
            }
            started = true
            val digit = value - '0'.code.toByte()
            if (result > (Long.MAX_VALUE - digit) / 8) {
                throw IOException("TAR octal value overflows Long")
            }
            result = result * 8 + digit
        }
        return result
    }

    private fun readPaxHeaders(size: Long): Map<String, String> {
        val data = readExtension(size)
        var offset = 0
        val headers = linkedMapOf<String, String>()
        while (offset < data.size) {
            val separator = data.indexOf(' '.code.toByte(), offset)
            if (separator <= offset) throw IOException("Invalid PAX record length")
            if ((offset until separator).any { data[it] !in '0'.code.toByte()..'9'.code.toByte() }) {
                throw IOException("Invalid PAX record length")
            }
            val recordLength =
                String(data, offset, separator - offset, Charsets.US_ASCII).toIntOrNull()
                    ?: throw IOException("Invalid PAX record length")
            if (recordLength <= separator - offset + 2 || recordLength > data.size - offset) {
                throw IOException("Invalid PAX record length")
            }
            val recordEnd = offset + recordLength
            if (data[recordEnd - 1] != '\n'.code.toByte()) throw IOException("Invalid PAX record")
            val equals = data.indexOf('='.code.toByte(), separator + 1, recordEnd - 1)
            if (equals <= separator + 1) throw IOException("Invalid PAX record")
            val key = decodeUtf8(data, separator + 1, equals - separator - 1)
            if (headers.containsKey(key)) throw IOException("Duplicate PAX key: $key")
            headers[key] = decodeUtf8(data, equals + 1, recordEnd - equals - 2)
            offset = recordEnd
        }
        return headers
    }

    private fun parsePaxSize(value: String): Long {
        if (value.isEmpty() || value.any { it !in '0'..'9' }) {
            throw IOException("Invalid PAX entry size")
        }
        return value.toLongOrNull() ?: throw IOException("Invalid PAX entry size")
    }

    private fun decodeUtf8(
        bytes: ByteArray,
        offset: Int,
        length: Int,
    ): String =
        try {
            Charsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, offset, length))
                .toString()
        } catch (error: Exception) {
            throw IOException("Invalid UTF-8 in TAR metadata", error)
        }

    private fun ByteArray.indexOf(
        value: Byte,
        start: Int,
        endExclusive: Int = size,
    ): Int {
        for (index in start until endExclusive) if (this[index] == value) return index
        return -1
    }

    private fun readExtension(size: Long): ByteArray {
        if (size < 0 || size > MAX_EXTENSION_SIZE) {
            throw IOException("TAR extension is too large")
        }
        val data = ByteArray(size.toInt())
        readExactly(data)
        readPadding(size)
        return data
    }

    private fun readExactly(buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val count = input.read(buffer, offset, buffer.size - offset)
            if (count < 0) throw EOFException("Unexpected end of TAR extension")
            if (count == 0) throw IOException("TAR extension read made no progress")
            offset += count
        }
    }

    private fun readPadding(size: Long) {
        val remainder = size % BLOCK_SIZE
        if (remainder == 0L) return
        val padding = ByteArray((BLOCK_SIZE - remainder).toInt())
        readExactly(padding)
        if (!padding.all { it == 0.toByte() }) throw IOException("Invalid TAR entry padding")
    }

    private fun skipExactly(count: Long) {
        var remaining = count
        val buffer = ByteArray(8192)
        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (read < 0) throw EOFException("Unexpected end of TAR archive")
            if (read == 0) throw IOException("TAR skip made no progress")
            remaining -= read
        }
    }
}
