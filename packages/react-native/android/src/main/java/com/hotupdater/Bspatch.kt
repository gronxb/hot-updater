package com.hotupdater

import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream

/**
 * BSDIFF40 patch applier for OTA v2 incremental updates.
 */
object Bspatch {
    private const val HEADER_SIZE = 32
    private const val MAGIC = "BSDIFF40"

    fun apply(
        base: ByteArray,
        patch: ByteArray,
    ): ByteArray {
        if (patch.size < HEADER_SIZE) {
            throw IllegalArgumentException("Invalid BSDIFF40 patch header")
        }

        val magic = patch.copyOfRange(0, 8).decodeToString()
        if (magic != MAGIC) {
            throw IllegalArgumentException("Invalid BSDIFF40 magic")
        }

        val ctrlLen = readOfft(patch, 8)
        val diffLen = readOfft(patch, 16)
        val newSize = readOfft(patch, 24)
        if (ctrlLen < 0 || diffLen < 0 || newSize < 0) {
            throw IllegalArgumentException("Negative BSDIFF40 header values")
        }

        val ctrlLengthInt =
            ctrlLen.toIntOrNull() ?: throw IllegalArgumentException("Control block too large")
        val diffLengthInt =
            diffLen.toIntOrNull() ?: throw IllegalArgumentException("Diff block too large")
        val newSizeInt =
            newSize.toIntOrNull() ?: throw IllegalArgumentException("Output size too large")

        val ctrlStart = HEADER_SIZE
        val ctrlEnd = ctrlStart + ctrlLengthInt
        val diffEnd = ctrlEnd + diffLengthInt
        if (ctrlEnd > patch.size || diffEnd > patch.size) {
            throw IllegalArgumentException("BSDIFF40 block bounds are invalid")
        }

        val ctrlReader =
            BZip2CompressorInputStream(ByteArrayInputStream(patch, ctrlStart, ctrlLengthInt))
        val diffReader =
            BZip2CompressorInputStream(ByteArrayInputStream(patch, ctrlEnd, diffLengthInt))
        val extraReader =
            BZip2CompressorInputStream(
                ByteArrayInputStream(patch, diffEnd, patch.size - diffEnd),
            )

        val output = ByteArrayOutputStream(newSizeInt)
        var oldPos = 0L
        val controlBuffer = ByteArray(24)

        while (output.size() < newSizeInt) {
            readFully(ctrlReader, controlBuffer)

            val addLen = readOfft(controlBuffer, 0)
            val copyLen = readOfft(controlBuffer, 8)
            val seekLen = readOfft(controlBuffer, 16)

            if (addLen < 0 || copyLen < 0) {
                throw IllegalArgumentException("Negative add/copy length in control block")
            }

            val addLengthInt =
                addLen.toIntOrNull() ?: throw IllegalArgumentException("add length overflow")
            val copyLengthInt =
                copyLen.toIntOrNull() ?: throw IllegalArgumentException("copy length overflow")

            val diffBytes = ByteArray(addLengthInt)
            readFully(diffReader, diffBytes)
            for (delta in diffBytes) {
                if (oldPos < 0 || oldPos >= base.size) {
                    throw IllegalArgumentException("Old file offset out of bounds")
                }
                val oldByte = base[oldPos.toInt()].toInt() and 0xFF
                val newByte = ((delta.toInt() and 0xFF) + oldByte) and 0xFF
                output.write(newByte)
                oldPos += 1
            }

            val extraBytes = ByteArray(copyLengthInt)
            readFully(extraReader, extraBytes)
            output.write(extraBytes)

            oldPos += seekLen

            if (output.size() > newSizeInt) {
                throw IllegalArgumentException("Patch output exceeds target size")
            }
        }

        if (output.size() != newSizeInt) {
            throw IllegalArgumentException("Patch output length mismatch")
        }

        return output.toByteArray()
    }

    private fun readFully(
        input: InputStream,
        bytes: ByteArray,
    ) {
        var offset = 0
        while (offset < bytes.size) {
            val read = input.read(bytes, offset, bytes.size - offset)
            if (read == -1) {
                throw EOFException("Unexpected EOF while reading patch block")
            }
            offset += read
        }
    }

    private fun readOfft(
        bytes: ByteArray,
        offset: Int,
    ): Long {
        var raw = 0L
        for (index in 0 until 8) {
            raw = raw or ((bytes[offset + index].toLong() and 0xFF) shl (index * 8))
        }
        return if ((raw and Long.MIN_VALUE) == 0L) {
            raw
        } else {
            -(raw and Long.MAX_VALUE)
        }
    }

    private fun Long.toIntOrNull(): Int? {
        if (this < Int.MIN_VALUE.toLong() || this > Int.MAX_VALUE.toLong()) {
            return null
        }
        return this.toInt()
    }
}
