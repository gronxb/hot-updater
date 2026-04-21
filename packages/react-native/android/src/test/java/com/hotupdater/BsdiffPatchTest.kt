package com.hotupdater

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Base64

class BsdiffPatchTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `applies bsdiff patch and verifies patched output hash`() {
        val base = "console.log(\"base bundle\");\n".toByteArray()
        val expected = "console.log(\"patched bundle\");\n".toByteArray()
        val patch = Base64.getDecoder().decode(BSDIFF_PATCH_FIXTURE_BASE64)
        val baseFile = temporaryFolder.newFile("base.bundle").apply { writeBytes(base) }
        val patchFile = temporaryFolder.newFile("patch.bsdiff").apply { writeBytes(patch) }
        val outputFile = temporaryFolder.newFile("output.bundle")

        BsdiffPatch.apply(baseFile, patchFile, outputFile)

        assertArrayEquals(expected, outputFile.readBytes())
        assertTrue(HashUtils.verifyHash(outputFile, HashUtils.calculateSHA256(outputFile)))
        assertFalse(HashUtils.verifyHash(outputFile, HashUtils.calculateSHA256(baseFile)))
    }

    @Test
    fun `rejects invalid bsdiff patch`() {
        val base = "console.log(\"base bundle\");\n".toByteArray()
        val invalidPatch = "not-a-bsdiff-patch-with-header".toByteArray()

        assertThrows(IllegalArgumentException::class.java) {
            BsdiffPatch.apply(base, invalidPatch)
        }
    }

    companion object {
        private const val BSDIFF_PATCH_FIXTURE_BASE64 =
            "RU5EU0xFWS9CU0RJRkY0Mx8AAAAAAAAAQlpoOTFBWSZTWb12MIEAAAB5gEQYAADQYQAIPsXOACAAIo0A0NAaNCgAGgZMgHAtYscVxxRtTt4nmaj70g4gQSF5+T4u5IpwoSF67GEC"
    }
}
