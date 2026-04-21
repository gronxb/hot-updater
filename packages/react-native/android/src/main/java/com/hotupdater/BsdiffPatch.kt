package com.hotupdater

import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream

object BsdiffPatch {
    private const val HEADER = "ENDSLEY/BSDIFF43"
    private const val HEADER_SIZE = 24

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
            String(patchBytes, 0, 16, Charsets.US_ASCII) != HEADER
        ) {
            throw IllegalArgumentException("Invalid ENDSLEY/BSDIFF43 header")
        }

        val newSize = readOfft(patchBytes, 16)
        if (newSize < 0) {
            throw IllegalArgumentException("Negative ENDSLEY/BSDIFF43 target size")
        }

        val output =
            ByteArrayOutputStream(
                checkedInt(newSize, "new size overflow"),
            )
        var oldPos = 0L

        createBzipStream(patchBytes, HEADER_SIZE, patchBytes.size).use { patchReader ->
            while (output.size() < newSize) {
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

                val addCount = checkedInt(addLen, "add length overflow")
                val copyCount = checkedInt(copyLen, "copy length overflow")
                val remainingOutput = newSize - output.size().toLong()
                if (addLen > remainingOutput || copyLen > remainingOutput - addLen) {
                    throw IllegalArgumentException("ENDSLEY/BSDIFF43 stream is truncated")
                }

                val diffBytes = ByteArray(addCount)
                readExactly(patchReader, diffBytes)
                for (deltaByte in diffBytes) {
                    val oldByte =
                        if (oldPos >= 0 && oldPos < baseBytes.size) {
                            baseBytes[oldPos.toInt()].toInt() and 0xFF
                        } else {
                            0
                        }
                    val nextByte = ((deltaByte.toInt() and 0xFF) + oldByte) and 0xFF
                    output.write(nextByte)
                    oldPos += 1
                }

                val extraBytes = ByteArray(copyCount)
                readExactly(patchReader, extraBytes)
                output.write(extraBytes)

                oldPos += seekLen
            }
        }

        if (output.size().toLong() != newSize) {
            throw IllegalArgumentException("Patch output length mismatch")
        }

        return output.toByteArray()
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
                throw EOFException("Unexpected end of ENDSLEY/BSDIFF43 stream")
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
