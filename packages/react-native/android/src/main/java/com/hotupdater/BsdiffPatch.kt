package com.hotupdater

import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream

object BsdiffPatch {
    private const val HEADER = "BSDIFF40"
    private const val HEADER_SIZE = 32

    fun apply(
        baseFile: File,
        patchFile: File,
        outputFile: File,
    ) {
        val baseBytes = baseFile.readBytes()
        val patchBytes = patchFile.readBytes()
        val restored = apply(baseBytes, patchBytes)

        outputFile.parentFile?.mkdirs()
        outputFile.writeBytes(restored)
    }

    fun apply(
        baseBytes: ByteArray,
        patchBytes: ByteArray,
    ): ByteArray {
        if (
            patchBytes.size < HEADER_SIZE ||
            String(patchBytes, 0, 8, Charsets.US_ASCII) != HEADER
        ) {
            throw IllegalArgumentException("Invalid BSDIFF40 header")
        }

        val ctrlLen = readOfft(patchBytes, 8)
        val diffLen = readOfft(patchBytes, 16)
        val newSize = readOfft(patchBytes, 24)
        if (ctrlLen < 0 || diffLen < 0 || newSize < 0) {
            throw IllegalArgumentException("Negative BSDIFF40 header values")
        }

        val ctrlStart = HEADER_SIZE
        val ctrlEnd = checkedEnd(ctrlStart, ctrlLen, "control block overflow")
        val diffEnd = checkedEnd(ctrlEnd, diffLen, "diff block overflow")
        if (diffEnd > patchBytes.size) {
            throw IllegalArgumentException("BSDIFF40 block bounds are invalid")
        }

        createBzipStream(patchBytes, ctrlStart, ctrlEnd).use { ctrlReader ->
            createBzipStream(patchBytes, ctrlEnd, diffEnd).use { diffReader ->
                createBzipStream(patchBytes, diffEnd, patchBytes.size).use { extraReader ->
                    val output = ByteArrayOutputStream(newSize.toInt())
                    var oldPos = 0L

                    while (output.size() < newSize) {
                        val controlBytes = ByteArray(24)
                        readExactly(ctrlReader, controlBytes)

                        val addLen = readOfft(controlBytes, 0)
                        val copyLen = readOfft(controlBytes, 8)
                        val seekLen = readOfft(controlBytes, 16)
                        if (addLen < 0 || copyLen < 0) {
                            throw IllegalArgumentException(
                                "Negative add/copy length in control block",
                            )
                        }

                        val diffBytes = ByteArray(addLen.toInt())
                        readExactly(diffReader, diffBytes)
                        for (deltaByte in diffBytes) {
                            if (oldPos < 0 || oldPos >= baseBytes.size) {
                                throw IllegalArgumentException("Old file offset out of bounds")
                            }
                            val oldByte = baseBytes[oldPos.toInt()].toInt() and 0xFF
                            val nextByte = ((deltaByte.toInt() and 0xFF) + oldByte) and 0xFF
                            output.write(nextByte)
                            oldPos += 1
                        }

                        val extraBytes = ByteArray(copyLen.toInt())
                        readExactly(extraReader, extraBytes)
                        output.write(extraBytes)

                        oldPos += seekLen
                        if (output.size().toLong() > newSize) {
                            throw IllegalArgumentException("Patch output exceeds target size")
                        }
                    }

                    if (output.size().toLong() != newSize) {
                        throw IllegalArgumentException("Patch output length mismatch")
                    }

                    return output.toByteArray()
                }
            }
        }
    }

    private fun checkedEnd(
        start: Int,
        length: Long,
        message: String,
    ): Int {
        val end = start.toLong() + length
        if (end > Int.MAX_VALUE) {
            throw IllegalArgumentException(message)
        }
        return end.toInt()
    }

    private fun createBzipStream(
        bytes: ByteArray,
        start: Int,
        end: Int,
    ): InputStream =
        BZip2CompressorInputStream(
            ByteArrayInputStream(bytes, start, end - start),
            true,
        )

    private fun readExactly(
        input: InputStream,
        target: ByteArray,
    ) {
        var offset = 0
        while (offset < target.size) {
            val read = input.read(target, offset, target.size - offset)
            if (read < 0) {
                throw EOFException("Unexpected end of BSDIFF40 stream")
            }
            offset += read
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
}
