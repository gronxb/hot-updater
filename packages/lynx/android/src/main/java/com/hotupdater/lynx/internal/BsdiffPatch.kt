package com.hotupdater.lynx.internal

import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import kotlin.math.min

/** RN-free patch decoder; output and work are bounded before materialization. */
internal object BsdiffPatch {
    private const val HEADER = "ENDSLEY/BSDIFF43"
    private val HEADER_BYTES = HEADER.toByteArray(Charsets.US_ASCII)
    private const val HEADER_SIZE = 24
    private const val STREAM_BUFFER_SIZE = 64 * 1024
    private const val MAX_CONTROL_BLOCKS = 1_000_000

    fun apply(
        baseFile: File,
        patchFile: File,
        outputFile: File,
        checkCancelled: () -> Unit = {},
    ) {
        require(baseFile.isFile && baseFile.length() <= ArchiveLimits.MAX_FILE_BYTES) {
            "Invalid or oversized patch base"
        }
        require(patchFile.isFile && patchFile.length() in 1..ArchiveLimits.MAX_FILE_BYTES) {
            "Invalid or oversized patch file"
        }
        outputFile.parentFile?.mkdirs()
        val tempOutputFile =
            File(
                outputFile.parentFile ?: outputFile.absoluteFile.parentFile,
                "${outputFile.name}.tmp",
            )

        if (tempOutputFile.exists()) {
            tempOutputFile.delete()
        }

        try {
            RandomAccessFileBaseReader(RandomAccessFile(baseFile, "r")).use { baseReader ->
                FileInputStream(patchFile).use { patchStream ->
                    FileOutputStream(tempOutputFile).use { outputStream ->
                        apply(baseReader, patchStream, outputStream, checkCancelled)
                        outputStream.fd.sync()
                    }
                }
            }

            check(!outputFile.exists() || outputFile.delete()) {
                "Cannot replace patched output inside the private preparation"
            }
            check(tempOutputFile.renameTo(outputFile)) {
                "Cannot publish patched output inside the private preparation"
            }
        } catch (error: Throwable) {
            tempOutputFile.delete()
            throw error
        }
    }

    fun apply(
        baseBytes: ByteArray,
        patchBytes: ByteArray,
    ): ByteArray {
        require(baseBytes.size.toLong() <= ArchiveLimits.MAX_FILE_BYTES) {
            "Oversized patch base"
        }
        require(patchBytes.isNotEmpty() && patchBytes.size.toLong() <= ArchiveLimits.MAX_FILE_BYTES) {
            "Invalid or oversized patch bytes"
        }
        RandomAccessByteArray(baseBytes).use { baseReader ->
            ByteArrayInputStream(patchBytes).use { patchStream ->
                ByteArrayOutputStream().use { outputStream ->
                    apply(baseReader, patchStream, outputStream)
                    return outputStream.toByteArray()
                }
            }
        }
    }

    private fun apply(
        baseReader: BaseReader,
        patchStream: InputStream,
        outputStream: OutputStream,
        checkCancelled: () -> Unit = {},
    ) {
        val header = ByteArray(HEADER_SIZE)
        readExactly(patchStream, header)

        if (!header.copyOfRange(0, 16).contentEquals(HEADER_BYTES)) {
            throw IllegalArgumentException("Invalid ENDSLEY/BSDIFF43 header")
        }

        val newSize = readOfft(header, 16)
        if (newSize < 0 || newSize > ArchiveLimits.MAX_FILE_BYTES) {
            throw IllegalArgumentException("Invalid or oversized ENDSLEY/BSDIFF43 target size")
        }

        val diffBuffer = ByteArray(STREAM_BUFFER_SIZE)
        val baseBuffer = ByteArray(STREAM_BUFFER_SIZE)
        val newBuffer = ByteArray(STREAM_BUFFER_SIZE)
        var oldPos = 0L
        var outputSize = 0L
        var controlBlocks = 0

        BZip2CompressorInputStream(patchStream, true).use { patchReader ->
            while (outputSize < newSize) {
                checkCancelled()
                require(++controlBlocks <= MAX_CONTROL_BLOCKS) {
                    "Patch control block limit exceeded"
                }
                val controlBytes = ByteArray(24)
                readExactly(patchReader, controlBytes)

                val addLen = readOfft(controlBytes, 0)
                val copyLen = readOfft(controlBytes, 8)
                val seekLen = readOfft(controlBytes, 16)
                if (addLen < 0 || copyLen < 0) {
                    throw IllegalArgumentException(
                        "Negative add/copy length in control block",
                    )
                }

                require(addLen != 0L || copyLen != 0L) { "Patch control block makes no progress" }
                val addCount = checkedInt(addLen, "add length overflow")
                val copyCount = checkedInt(copyLen, "copy length overflow")
                val remainingOutput = newSize - outputSize
                if (addLen > remainingOutput || copyLen > remainingOutput - addLen) {
                    throw IllegalArgumentException("ENDSLEY/BSDIFF43 stream is truncated")
                }

                var remainingAdd = addCount
                while (remainingAdd > 0) {
                    checkCancelled()
                    val chunkSize = min(STREAM_BUFFER_SIZE, remainingAdd)
                    readExactly(patchReader, diffBuffer, chunkSize)
                    baseReader.readAt(oldPos, baseBuffer, chunkSize)
                    for (index in 0 until chunkSize) {
                        val oldByte = baseBuffer[index].toInt() and 0xFF
                        val deltaByte = diffBuffer[index].toInt() and 0xFF
                        newBuffer[index] = ((deltaByte + oldByte) and 0xFF).toByte()
                    }
                    outputStream.write(newBuffer, 0, chunkSize)
                    oldPos = checkedAdd(oldPos, chunkSize.toLong(), "old file position overflow")
                    outputSize += chunkSize
                    remainingAdd -= chunkSize
                }

                var remainingCopy = copyCount
                while (remainingCopy > 0) {
                    checkCancelled()
                    val chunkSize = min(STREAM_BUFFER_SIZE, remainingCopy)
                    readExactly(patchReader, diffBuffer, chunkSize)
                    outputStream.write(diffBuffer, 0, chunkSize)
                    outputSize += chunkSize
                    remainingCopy -= chunkSize
                }

                oldPos =
                    checkedAdd(
                        oldPos,
                        seekLen,
                        "old file seek overflow",
                    )
            }
            require(patchReader.read() == -1) { "Trailing patch content" }
        }

        if (outputSize != newSize) {
            throw IllegalArgumentException("Patch output length mismatch")
        }
    }

    private fun checkedInt(
        value: Long,
        message: String,
    ): Int {
        if (value > Int.MAX_VALUE) {
            throw IllegalArgumentException(message)
        }
        return value.toInt()
    }

    private fun checkedAdd(
        left: Long,
        right: Long,
        message: String,
    ): Long {
        val result = left + right
        if ((left xor result) and (right xor result) < 0) {
            throw IllegalArgumentException(message)
        }
        return result
    }

    private fun readExactly(
        input: InputStream,
        target: ByteArray,
    ) = readExactly(input, target, target.size)

    private fun readExactly(
        input: InputStream,
        target: ByteArray,
        count: Int,
    ) {
        var offset = 0
        while (offset < count) {
            val read = input.read(target, offset, count - offset)
            if (read < 0) {
                throw EOFException("Unexpected end of ENDSLEY/BSDIFF43 stream")
            }
            if (read == 0) {
                val byte = input.read()
                if (byte < 0) {
                    throw EOFException("Unexpected end of ENDSLEY/BSDIFF43 stream")
                }
                target[offset++] = byte.toByte()
            } else {
                offset += read
            }
        }
    }

    private fun readOfft(
        bytes: ByteArray,
        offset: Int,
    ): Long {
        if (bytes.size - offset < 8) {
            throw IllegalArgumentException("Offset bytes too short")
        }

        var value = 0L
        for (index in 0 until 8) {
            value = value or ((bytes[offset + index].toLong() and 0xFF) shl (index * 8))
        }

        return if ((value and Long.MIN_VALUE) == 0L) {
            value
        } else {
            -(value and Long.MAX_VALUE)
        }
    }

    private interface BaseReader : AutoCloseable {
        fun readAt(
            offset: Long,
            target: ByteArray,
            count: Int,
        )
    }

    private class RandomAccessFileBaseReader(
        private val file: RandomAccessFile,
    ) : BaseReader {
        private val length = file.length()

        override fun readAt(
            offset: Long,
            target: ByteArray,
            count: Int,
        ) {
            fillBaseBytes(offset, length, target, count) { position, buffer, bufferOffset, length ->
                file.seek(position)
                file.readFully(buffer, bufferOffset, length)
            }
        }

        override fun close() = file.close()
    }

    private class RandomAccessByteArray(
        private val bytes: ByteArray,
    ) : BaseReader {
        override fun readAt(
            offset: Long,
            target: ByteArray,
            count: Int,
        ) {
            fillBaseBytes(offset, bytes.size.toLong(), target, count) { position, buffer, bufferOffset, length ->
                bytes.copyInto(
                    destination = buffer,
                    destinationOffset = bufferOffset,
                    startIndex = position.toInt(),
                    endIndex = position.toInt() + length,
                )
            }
        }

        override fun close() = Unit
    }

    private inline fun fillBaseBytes(
        offset: Long,
        baseLength: Long,
        target: ByteArray,
        count: Int,
        readValidRange: (position: Long, buffer: ByteArray, bufferOffset: Int, length: Int) -> Unit,
    ) {
        target.fill(0, 0, count)
        val end = checkedAdd(offset, count.toLong(), "old file read overflow")
        if (count == 0 || offset >= baseLength || end <= 0) {
            return
        }

        val validStart = maxOf(offset, 0)
        val validEnd = minOf(end, baseLength)
        val destinationOffset = (validStart - offset).toInt()
        val validLength = (validEnd - validStart).toInt()
        readValidRange(validStart, target, destinationOffset, validLength)
    }
}
