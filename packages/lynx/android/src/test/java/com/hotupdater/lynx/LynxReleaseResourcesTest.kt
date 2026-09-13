package com.hotupdater.lynx

import com.hotupdater.lynx.internal.HashUtils
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LynxReleaseResourcesTest {
    @Test
    fun byteHandoffRejectsAnInstalledFileChangedAfterStartupVerification() {
        val root = Files.createTempDirectory("lynx-resource-bytes-").toFile()
        try {
            val file = root.resolve("main.lynx.bundle").apply {
                writeText("verified entry")
            }
            val expected = file.readBytes()
            val resources = LynxReleaseResources(
                root,
                "01900000-0000-7000-8000-000000000121",
                mapOf("main.lynx.bundle" to HashUtils.calculateSHA256(file)),
                root.resolve("snapshots"),
            )
            var delivered: ByteArray? = null
            resources.loadBytes("hot-updater:///main.lynx.bundle") {
                delivered = it
            }
            assertArrayEquals(expected, delivered)

            file.writeText("tampered entry")
            delivered = null
            assertThrows(IllegalArgumentException::class.java) {
                resources.loadBytes("hot-updater:///main.lynx.bundle") {
                    delivered = it
                }
            }
            assertEquals(null, delivered)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun uriAndPathHandoffsRejectAnInstalledFileChangedAfterVerification() {
        val root = Files.createTempDirectory("lynx-resource-path-").toFile()
        try {
            val file = root.resolve("assets/probe.txt").apply {
                parentFile.mkdirs()
                writeText("verified resource")
            }
            val resources = LynxReleaseResources(
                root,
                "01900000-0000-7000-8000-000000000121",
                mapOf("assets/probe.txt" to HashUtils.calculateSHA256(file)),
                root.resolve("snapshots"),
            )
            val snapshot = resources.resolve("hot-updater:///assets/probe.txt")
            assertTrue(snapshot.canonicalFile != file.canonicalFile)
            assertEquals("verified resource", snapshot.readText())
            val fileUrl = file.canonicalFile.toURI().toString()
            assertEquals(snapshot, resources.resolve(fileUrl))

            file.writeText("tampered resource")
            assertThrows(IllegalArgumentException::class.java) {
                resources.resolve("hot-updater:///assets/probe.txt")
            }
            assertThrows(IllegalArgumentException::class.java) {
                resources.resolve(fileUrl)
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun pathHandoffKeepsVerifiedBytesWhenTheSourcePathIsReplacedAfterHashing() {
        val root = Files.createTempDirectory("lynx-resource-snapshot-").toFile()
        try {
            val file = root.resolve("assets/probe.txt").apply {
                parentFile.mkdirs()
                writeText("verified resource")
            }
            val resources = LynxReleaseResources(
                root,
                "01900000-0000-7000-8000-000000000121",
                mapOf("assets/probe.txt" to HashUtils.calculateSHA256(file)),
                root.resolve("snapshots"),
            )
            var handedPath: String? = null

            resources.loadPath("hot-updater:///assets/probe.txt") { path ->
                handedPath = path
                assertTrue(file.delete())
                file.writeText("replacement after verified hash")
                assertEquals("verified resource", File(path).readText())
            }

            assertEquals("replacement after verified hash", file.readText())
            assertEquals("verified resource", File(checkNotNull(handedPath)).readText())
            assertTrue(File(checkNotNull(handedPath)).canonicalFile != file.canonicalFile)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun byteLoadIsObservedOnlyAfterConsumerCompletionAndFinalVerification() {
        val root = Files.createTempDirectory("lynx-resource-consumer-").toFile()
        try {
            val file = root.resolve("assets/bootstrap.js").apply {
                parentFile.mkdirs()
                writeText("verified resource")
            }
            val expectedHash = HashUtils.calculateSHA256(file)
            val resources = LynxReleaseResources(
                root,
                "01900000-0000-7000-8000-000000000121",
                mapOf("assets/bootstrap.js" to expectedHash),
                root.resolve("snapshots"),
            )
            val events = mutableListOf<String>()
            resources.onLoaded = { _, _, _ -> events += "loaded" }

            resources.loadBytes("hot-updater:///assets/bootstrap.js") {
                events += "consumer"
            }
            assertEquals(listOf("consumer", "loaded"), events)

            assertThrows(IllegalArgumentException::class.java) {
                resources.loadBytes("hot-updater:///assets/bootstrap.js") {
                    events += "tampering-consumer"
                    file.writeText("changed during handoff")
                }
            }
            assertEquals(
                listOf("consumer", "loaded", "tampering-consumer"),
                events,
            )
            assertTrue(HashUtils.calculateSHA256(file) != expectedHash)
        } finally {
            root.deleteRecursively()
        }
    }
}
