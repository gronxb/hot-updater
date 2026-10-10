package com.hotupdater.lynx.internal

import java.nio.file.Files
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class BsdiffPatchTest {
    @Test
    fun appliesTheServerPatchFormatAndPublishesOnlyTheCompletedOutput() {
        val root = Files.createTempDirectory("lynx-bsdiff-").toFile()
        try {
            val base = root.resolve("base").apply { writeBytes(BASE) }
            val patch = root.resolve("patch").apply {
                writeBytes(Base64.getDecoder().decode(PATCH))
            }
            val output = root.resolve("output")

            BsdiffPatch.apply(base, patch, output)

            assertArrayEquals(TARGET, output.readBytes())
            assertFalse(root.resolve("output.tmp").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun cancellationAndTrailingPatchDataLeaveNoOutput() {
        val root = Files.createTempDirectory("lynx-bsdiff-cancel-").toFile()
        try {
            val base = root.resolve("base").apply { writeBytes(BASE) }
            val patch = root.resolve("patch").apply {
                writeBytes(Base64.getDecoder().decode(PATCH))
            }
            val output = root.resolve("output")
            assertThrows(InterruptedException::class.java) {
                BsdiffPatch.apply(base, patch, output) {
                    throw InterruptedException("cancelled")
                }
            }
            assertFalse(output.exists())
            assertFalse(root.resolve("output.tmp").exists())

            patch.appendBytes(byteArrayOf(1))
            assertThrows(Exception::class.java) {
                BsdiffPatch.apply(base, patch, output)
            }
            assertFalse(output.exists())
        } finally {
            root.deleteRecursively()
        }
    }

    companion object {
        private val BASE = "console.log(\"base bundle\");\n".toByteArray()
        private val TARGET = "console.log(\"patched bundle\");\n".toByteArray()
        private const val PATCH =
            "RU5EU0xFWS9CU0RJRkY0Mx8AAAAAAAAAQlpoOTFBWSZTWb12MIEAAAB5gEQYAADQYQAIPsXOACAAIo0A0NAaNCgAGgZMgHAtYscVxxRtTt4nmaj70g4gQSF5+T4u5IpwoSF67GEC"
    }
}
