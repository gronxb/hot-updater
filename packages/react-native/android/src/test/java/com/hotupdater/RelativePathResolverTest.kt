package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RelativePathResolverTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `resolves a standard archive directory entry ending in a slash`() {
        val root = temporaryFolder.root

        val resolved = RelativePathResolver.resolveInside(root, "drawable-mdpi/")

        assertEquals(
            File(root, "drawable-mdpi").canonicalFile,
            resolved?.canonicalFile,
        )
    }

    @Test
    fun `rejects unsafe archive directory paths ending in a slash`() {
        val root = temporaryFolder.root
        val unsafePaths =
            listOf(
                "/",
                "../",
                "drawable-mdpi/../",
                "drawable-mdpi//",
            )

        unsafePaths.forEach { path ->
            assertNull(path, RelativePathResolver.resolveInside(root, path))
        }
    }
}
