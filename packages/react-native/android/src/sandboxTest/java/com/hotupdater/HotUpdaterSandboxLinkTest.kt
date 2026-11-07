package com.hotupdater

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Runs test-utils' `sandbox-preview-links.json`, which `parsePreviewLink` in the protocol runs too. */
class HotUpdaterSandboxLinkTest {
    private val vectors by lazy { JSONObject(locateFixture().readText()) }

    @Test
    fun `reads what the protocol reads`() {
        val valid = vectors.getJSONArray("valid")
        assertTrue(valid.length() > 0)
        for (index in 0 until valid.length()) {
            val vector = valid.getJSONObject(index)
            val parsed = HotUpdaterSandboxLink.parse(vector.getString("link"))
            assertNotNull(vector.getString("link"), parsed)
            assertEquals(vector.getString("urlScheme"), parsed!!.urlScheme)
            assertEquals(vector.getString("channel"), parsed.channel)
            assertEquals(vector.getString("fingerprintHash"), parsed.fingerprintHash)
        }
    }

    @Test
    fun `refuses what the protocol refuses`() {
        val invalid = vectors.getJSONArray("invalid")
        assertTrue(invalid.length() > 0)
        for (index in 0 until invalid.length()) {
            assertNull(invalid.getString(index), HotUpdaterSandboxLink.parse(invalid.getString(index)))
        }
    }

    private fun locateFixture(): File {
        val relative = "test-utils/fixtures/sandbox-preview-links.json"
        var directory: File? = File("").absoluteFile.canonicalFile
        while (directory != null) {
            val candidates = listOf(File(directory, "packages/$relative"), File(directory, relative))
            candidates.firstOrNull { it.isFile }?.let { return it }
            directory = directory.parentFile
        }
        throw IllegalStateException("Cannot find packages/$relative above ${File("").absolutePath}")
    }
}
