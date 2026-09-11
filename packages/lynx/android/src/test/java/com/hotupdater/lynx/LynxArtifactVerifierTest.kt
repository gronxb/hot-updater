package com.hotupdater.lynx

import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.HashUtils
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class LynxArtifactVerifierTest {
    private val runtime = "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2"
    private val bundleId = "01900000-0000-7000-8000-000000000020"

    private fun writeTree(root: File, runtimeId: String = runtime, entry: String = "main.lynx.bundle"): String {
        root.mkdirs()
        val files = mapOf(
            entry to "entry-B".toByteArray(),
            "assets/probe.png" to byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47),
            "hot-updater-lynx.json" to JSONObject()
                .put("schemaVersion", 1).put("bundleId", bundleId).put("platform", "android")
                .put("entry", entry).put("runtimeId", runtimeId).toString().toByteArray(),
        )
        val assets = JSONObject()
        files.forEach { (name, bytes) ->
            val file = File(root, name)
            file.parentFile.mkdirs()
            file.writeBytes(bytes)
            assets.put(name, JSONObject().put("fileHash", HashUtils.calculateSHA256(file)))
        }
        val manifest = JSONObject().put("bundleId", bundleId).put("assets", assets)
        File(root, "manifest.json").writeText(manifest.toString())
        return HashUtils.calculateSHA256(File(root, "manifest.json"))
    }

    @Test fun compatibilityMismatchAndEmptyEntryAreRejectedBeforeUse() {
        val root = Files.createTempDirectory("lynx-verify-").toFile().canonicalFile
        try {
            val digest = writeTree(root)
            val request = LynxArtifactRequest(bundleId, "native-embedded", "native-embedded", digest)
            val verifier = LynxArtifactVerifier(LynxInstallConfiguration(runtime), ArchiveIntegrity(null))
            val verified = verifier.verify(root, request)
            assertEquals(bundleId, verified.bundleId)
            assertEquals("main.lynx.bundle", verified.entry)
            try {
                LynxArtifactVerifier(LynxInstallConfiguration("other-runtime"), ArchiveIntegrity(null))
                    .verify(root, request)
                fail("Mismatched runtime identity was accepted")
            } catch (error: LynxIncompatibleArtifactException) {
                assertTrue(error.message!!.contains("compatibility"))
            }
            File(root, "main.lynx.bundle").writeBytes(ByteArray(0))
            val emptyAssets = JSONObject(File(root, "manifest.json").readText()).getJSONObject("assets")
            emptyAssets.put("main.lynx.bundle", JSONObject().put("fileHash", HashUtils.calculateSHA256(File(root, "main.lynx.bundle"))))
            File(root, "manifest.json").writeText(JSONObject().put("bundleId", bundleId).put("assets", emptyAssets).toString())
            val emptyDigest = HashUtils.calculateSHA256(File(root, "manifest.json"))
            try {
                verifier.verify(root, request.copy(manifestFileHash = emptyDigest))
                fail("Empty entry was accepted")
            } catch (_: Exception) {}
        } finally { root.deleteRecursively() }
    }

    @Test fun interruptedExtractLeavesNoUsableInstallation() {
        val root = Files.createTempDirectory("lynx-install-").toFile()
        try {
            val payload = File(root, "payload").apply { mkdirs() }
            writeTree(payload)
            val archive = File(root, "archive.zip")
            ZipOutputStream(archive.outputStream()).use { zip ->
                payload.walkTopDown().filter { it.isFile }.forEach { file ->
                    zip.putNextEntry(ZipEntry(file.relativeTo(payload).invariantSeparatorsPath))
                    zip.write(file.readBytes())
                    zip.closeEntry()
                }
            }
            archive.writeBytes(archive.readBytes().copyOf(20))
            val out = File(root, "out").apply { mkdir() }
            try {
                com.hotupdater.lynx.internal.StrictArchive.extract(archive, out)
                fail("Truncated archive extracted")
            } catch (_: Exception) {}
            assertTrue(out.list().orEmpty().isEmpty() || !File(out, "main.lynx.bundle").isFile)
        } finally { root.deleteRecursively() }
    }
}
