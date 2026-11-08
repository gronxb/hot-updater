package com.hotupdater

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** A shelf over a directory of its own, beside a fake bundle store. */
internal fun testShelf(
    root: File = Files.createTempDirectory("sandbox-shelf").toFile(),
    key: String = "key",
) = HotUpdaterSandboxShelf(File(root, "shelf"), File(root, "bundle-store"), key)

/** A bundle as main's store installs it: its manifest, the JavaScript, and an image. */
internal fun installTestBundle(
    store: File,
    bundleId: String,
    skipping: String? = null,
) {
    val directory = File(store, bundleId)
    val assets = listOf("index.android.bundle", "drawable-mdpi/logo.png")
    val manifest = JSONObject().put("bundleId", bundleId).put("assets", JSONObject())
    assets.forEach { asset ->
        manifest.getJSONObject("assets").put(asset, JSONObject().put("fileHash", "hash"))
        if (asset != skipping) File(directory, asset).apply { parentFile?.mkdirs() }.writeText("$bundleId $asset")
    }
    File(directory, "manifest.json").writeText(manifest.toString())
}

class HotUpdaterSandboxShelfTest {
    @Test
    fun `a partial copy lists nothing`() {
        val shelf = testShelf()
        installTestBundle(shelf.source, "broken", skipping = "drawable-mdpi/logo.png")
        shelf.add("broken", "pr-1", null, 0, null)
        assertTrue(shelf.entries.isEmpty())
        assertTrue(
            shelf.root
                .listFiles()
                .orEmpty()
                .isEmpty(),
        )
    }

    @Test
    fun `a stored bundle is what main answers`() {
        val shelf = testShelf()
        installTestBundle(shelf.source, "a")
        shelf.add("a", "pr-1", "words", 5, null)
        val stored = shelf.stored("a")!!
        assertEquals("index.android.bundle", stored.bundle.name)
        assertEquals("file://${File(shelf.root, "a").absolutePath}", stored.baseURL)
        assertEquals("a", stored.manifest["bundleId"])
        assertEquals(listOf(HotUpdaterSandboxShelfEntry("a", "pr-1", "words", "key", 5)), shelf.entries)
        // Main's store can prune its copy: the shelf's stays.
        File(shelf.source, "a").deleteRecursively()
        assertNotNull(shelf.stored("a"))
    }

    @Test
    fun `the cap drops the oldest but never the running one`() {
        val shelf = testShelf()
        for (index in 0..HotUpdaterSandboxShelf.LIMIT) {
            installTestBundle(shelf.source, "b$index")
            shelf.add("b$index", "pr-$index", null, index.toLong(), running = "b0")
        }
        assertEquals(HotUpdaterSandboxShelf.LIMIT, shelf.entries.size)
        assertEquals("b10", shelf.entries.first().bundleId)
        assertNotNull(shelf.stored("b0"))
        assertFalse(shelf.entries.any { it.bundleId == "b1" })
        assertNull(shelf.stored("b1"))
    }

    @Test
    fun `another build's entries and stray files go`() {
        val root = Files.createTempDirectory("sandbox-shelf").toFile()
        val old = testShelf(root, "old-build")
        installTestBundle(old.source, "a")
        old.add("a", "pr-1", null, 0, null)
        File(old.root, "b.tmp").mkdirs()
        File(old.root, "c").mkdirs()

        val new = testShelf(root, "new-build")
        new.reconcile()
        assertTrue(new.entries.isEmpty())
        assertEquals(listOf("index.json"), new.root.list()!!.toList())
    }

    /** The list and the files agree, and every listed bundle is whole. */
    private fun assertAgreement(
        shelf: HotUpdaterSandboxShelf,
        round: Int,
    ) {
        val names =
            shelf.root
                .list()
                .orEmpty()
                .filter { it != "index.json" }
                .toSet()
        val listed = shelf.entries.map { it.bundleId }
        assertEquals("round $round", names, listed.toSet())
        listed.forEach { assertNotNull("round $round: $it isn't whole", shelf.stored(it)) }
    }

    @Test
    fun `a refresh while a bundle is shelved keeps it`() {
        repeat(40) { round ->
            val shelf = testShelf()
            installTestBundle(shelf.source, "b$round")
            val copy = Thread { shelf.add("b$round", "pr-1", null, 0, null) }.apply { start() }
            // A pause between turns, as a person's refreshes have: a lock isn't fair,
            // and a loop that takes it back at once can starve the copy.
            do {
                shelf.reconcile()
                copy.join(0, 200_000)
            } while (copy.isAlive)
            assertAgreement(shelf, round)
            assertEquals("round $round", listOf("b$round"), shelf.entries.map { it.bundleId })
        }
    }

    @Test
    fun `a clear while a bundle is shelved leaves the list and files in agreement`() {
        repeat(40) { round ->
            val shelf = testShelf()
            installTestBundle(shelf.source, "old")
            shelf.add("old", "pr-0", null, 0, null)
            installTestBundle(shelf.source, "b$round")
            val copy = Thread { shelf.add("b$round", "pr-1", null, 1, null) }.apply { start() }
            do {
                shelf.clear(null)
                copy.join(0, 200_000)
            } while (copy.isAlive)
            assertAgreement(shelf, round)
        }
    }

    @Test
    fun `a list that can't be saved loses the row, not the switch`() {
        val shelf = testShelf()
        installTestBundle(shelf.source, "a")
        // The list's temporary file can't be written: a directory holds its name.
        File(shelf.root, "index.json.tmp").mkdirs()
        shelf.add("a", "pr-1", null, 0, null)
        assertTrue(shelf.entries.isEmpty())
        // The copy nothing lists goes at the next refresh.
        shelf.reconcile()
        assertFalse(File(shelf.root, "a").exists())
    }

    @Test
    fun `a link or a path outside the bundle fails the check`() {
        val root = Files.createTempDirectory("sandbox-shelf").toFile()
        installTestBundle(root, "x")
        val directory = File(root, "x")
        val logo = File(directory, "drawable-mdpi/logo.png")
        logo.delete()
        Files.createSymbolicLink(logo.toPath(), File(directory, "index.android.bundle").toPath())
        assertNull(HotUpdaterSandboxShelf.check(directory, "x"))

        File(directory, "manifest.json").writeText(
            JSONObject()
                .put("bundleId", "x")
                .put("assets", JSONObject().put("../x/index.android.bundle", JSONObject().put("fileHash", "h")))
                .toString(),
        )
        assertNull(HotUpdaterSandboxShelf.check(directory, "x"))
        assertNull(HotUpdaterSandboxShelf.check(directory, "y"))
    }
}
