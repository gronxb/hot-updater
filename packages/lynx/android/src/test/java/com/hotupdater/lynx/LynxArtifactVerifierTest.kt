package com.hotupdater.lynx

import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.HashUtils
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import com.hotupdater.lynx.internal.LynxBackgroundScript
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class LynxArtifactVerifierTest {
    private val runtime = "android-sparkling-2.1.0-rc.12-lynx-4.0.3-primjs-4.0.0-ota-v2"
    private val bundleId = "01900000-0000-7000-8000-000000000020"

    @Test fun schemaCompatibilityIsCheckedWithoutPagePayloadsAtTheSameRuntimeId() {
        val root = Files.createTempDirectory("lynx-schema-gate-").toFile().canonicalFile
        try {
            writeTree(root)
            val request = request(root)
            val paths = setOf("main.lynx.bundle", "hot-updater-lynx.json")
            root.resolve("main.lynx.bundle").delete()
            for (version in listOf(1, 2)) {
                rewriteMetadata(root) { it.put("schemaVersion", version) }
                assertEquals(runtime, verifier().verifyMetadata(root, request, paths, false).runtimeId)
                assertTrue(!root.resolve("main.lynx.bundle").exists())
            }
            for (version in listOf<Any>(3, "2", true, 1.5)) {
                rewriteMetadata(root) { it.put("schemaVersion", version) }
                org.junit.Assert.assertThrows(LynxIncompatibleArtifactException::class.java) {
                    verifier().verifyMetadata(root, request, paths, false)
                }
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun backgroundScriptIsDeclaredVerifiedAndCopiedBeforeInstalledFilesDisappear() {
        val root = Files.createTempDirectory("lynx-background-").toFile().canonicalFile
        try {
            writeTree(root)
            addManagedFile(root, "task.js", "globalThis.marker = 'B';".toByteArray())
            assertEquals(null, verifier().verify(root, request(root)).backgroundEntry)
            rewriteMetadata(root) { it.put("backgroundEntry", "task.js") }
            val verified = verifier().verify(root, request(root))
            assertEquals("task.js", verified.backgroundEntry)
            assertEquals(listOf("main.lynx.bundle"), verified.pageEntries)
            val copied = LynxBackgroundScript.read(root, verified.backgroundEntry!!,
                verified.managedFileHashes.getValue("task.js"))
            File(root, "task.js").writeText("globalThis.marker = 'untrusted';")
            try {
                LynxBackgroundScript.read(root, "task.js", verified.managedFileHashes.getValue("task.js"))
                fail("Changed background script accepted")
            } catch (_: IllegalArgumentException) {}
            root.deleteRecursively()
            assertEquals("globalThis.marker = 'B';", copied)
        } finally { root.deleteRecursively() }
    }

    @Test fun invalidBackgroundDeclarationOrBytesRejectInstallation() {
        val cases = listOf(
            "missing.js" to "valid".toByteArray(),
            "./task.js" to "valid".toByteArray(),
            "main.lynx.bundle" to "valid".toByteArray(),
            "task.js" to byteArrayOf(),
            "task.js" to byteArrayOf(0xff.toByte(), 0x80.toByte()),
            "task.js" to "globalThis.marker = 'A';//\u0000\nglobalThis.marker = 'B';".toByteArray(),
            "task.js" to ByteArray(LynxBackgroundScript.MAX_BYTES + 1) { 32 },
        )
        for ((entry, bytes) in cases) {
            val root = Files.createTempDirectory("lynx-background-invalid-").toFile().canonicalFile
            try {
                writeTree(root)
                addManagedFile(root, "task.js", bytes)
                rewriteMetadata(root) { it.put("backgroundEntry", entry) }
                try {
                    verifier().verify(root, request(root))
                    fail("Invalid background script accepted: $entry (${bytes.size} bytes)")
                } catch (_: LynxIncompatibleArtifactException) {}
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun metadataCheckDoesNotDownloadBackgroundScript() {
        val root = Files.createTempDirectory("lynx-background-metadata-").toFile().canonicalFile
        try {
            writeTree(root)
            rewriteMetadata(root) { it.put("backgroundEntry", "task.js") }
            val paths = setOf("main.lynx.bundle", "hot-updater-lynx.json", "task.js")
            val metadata = verifier().verifyMetadata(root, request(root), paths, verifyPageFiles = false)
            assertEquals("task.js", metadata.backgroundEntry)
            assertTrue(!File(root, "task.js").exists())
        } finally { root.deleteRecursively() }
    }

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
            val request = LynxArtifactRequest(bundleId,
                            manifestFileHash = digest)
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

    @Test fun strictPageMetadataPreservesTheDeclaredAllowlistAndResources() {
        val root = Files.createTempDirectory("lynx-pages-").toFile().canonicalFile
        try {
            writeTree(root)
            addManagedFile(root, "detail.lynx.bundle", "detail-B".toByteArray())
            addManagedFile(root, "assets/detail.png", byteArrayOf(1, 2, 3))
            rewriteMetadata(root) { metadata ->
                metadata.put(
                    "pageEntries",
                    JSONArray(listOf("detail.lynx.bundle", "main.lynx.bundle")),
                )
                metadata.put(
                    "pageEssentialResources",
                    JSONArray(
                        listOf(
                            JSONObject()
                                .put("entry", "detail.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(
                                        listOf(
                                            "assets/detail.png",
                                            "detail.lynx.bundle",
                                        ),
                                    ),
                                ),
                            JSONObject()
                                .put("entry", "main.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(listOf("main.lynx.bundle")),
                                ),
                        ),
                    ),
                )
            }

            val verified = verifier().verify(root, request(root))

            assertEquals(
                listOf("detail.lynx.bundle", "main.lynx.bundle"),
                verified.pageEntries,
            )
            assertEquals(
                listOf("assets/detail.png", "detail.lynx.bundle"),
                verified.essentialResources("detail.lynx.bundle"),
            )
            assertEquals(
                listOf("main.lynx.bundle"),
                verified.essentialResources("main.lynx.bundle"),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun legacyMetadataDoesNotInferAnAdditionalPageFromManifestAssets() {
        val root = Files.createTempDirectory("lynx-pages-legacy-")
            .toFile().canonicalFile
        try {
            writeTree(root)
            addManagedFile(root, "detail.lynx.bundle", "detail-B".toByteArray())

            val verified = verifier().verify(root, request(root))

            assertEquals(listOf("main.lynx.bundle"), verified.pageEntries)
            assertEquals(
                listOf("main.lynx.bundle"),
                verified.essentialResources("main.lynx.bundle"),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun malformedPageMetadataRejectsTheCompleteInstallation() {
        data class Case(val name: String, val change: (JSONObject) -> Unit)
        val cases = listOf(
            Case("one field only") {
                it.put(
                    "pageEntries",
                    JSONArray(listOf("detail.lynx.bundle", "main.lynx.bundle")),
                )
            },
            Case("unsorted pages") {
                it.put(
                    "pageEntries",
                    JSONArray(listOf("main.lynx.bundle", "detail.lynx.bundle")),
                ).put(
                    "pageEssentialResources",
                    descriptors("main.lynx.bundle", "detail.lynx.bundle"),
                )
            },
            Case("noncanonical route") {
                it.put(
                    "pageEntries",
                    JSONArray(listOf("Detail.lynx.bundle", "main.lynx.bundle")),
                ).put(
                    "pageEssentialResources",
                    descriptors("Detail.lynx.bundle", "main.lynx.bundle"),
                )
            },
            Case("duplicate resources") {
                it.put(
                    "pageEntries",
                    JSONArray(listOf("detail.lynx.bundle", "main.lynx.bundle")),
                ).put(
                    "pageEssentialResources",
                    JSONArray(
                        listOf(
                            JSONObject()
                                .put("entry", "detail.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(
                                        listOf(
                                            "detail.lynx.bundle",
                                            "detail.lynx.bundle",
                                        ),
                                    ),
                                ),
                            JSONObject()
                                .put("entry", "main.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(listOf("main.lynx.bundle")),
                                ),
                        ),
                    ),
                )
            },
            Case("extra descriptor key") {
                it.put(
                    "pageEntries",
                    JSONArray(listOf("detail.lynx.bundle", "main.lynx.bundle")),
                ).put(
                    "pageEssentialResources",
                    JSONArray(
                        listOf(
                            JSONObject()
                                .put("entry", "detail.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(listOf("detail.lynx.bundle")),
                                )
                                .put("optional", true),
                            JSONObject()
                                .put("entry", "main.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(listOf("main.lynx.bundle")),
                                ),
                        ),
                    ),
                )
            },
            Case("resource outside manifest") {
                it.put(
                    "pageEntries",
                    JSONArray(listOf("detail.lynx.bundle", "main.lynx.bundle")),
                ).put(
                    "pageEssentialResources",
                    JSONArray(
                        listOf(
                            JSONObject()
                                .put("entry", "detail.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(
                                        listOf(
                                            "assets/missing.png",
                                            "detail.lynx.bundle",
                                        ),
                                    ),
                                ),
                            JSONObject()
                                .put("entry", "main.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray(listOf("main.lynx.bundle")),
                                ),
                        ),
                    ),
                )
            },
        )
        cases.forEach { testCase ->
            val root = Files.createTempDirectory("lynx-pages-invalid-")
                .toFile().canonicalFile
            try {
                writeTree(root)
                addManagedFile(
                    root,
                    if (testCase.name == "noncanonical route") {
                        "Detail.lynx.bundle"
                    } else {
                        "detail.lynx.bundle"
                    },
                    "detail-B".toByteArray(),
                )
                rewriteMetadata(root, testCase.change)

                try {
                    verifier().verify(root, request(root))
                    fail("${testCase.name} metadata was accepted")
                } catch (_: Exception) {
                }
            } finally {
                root.deleteRecursively()
            }
        }
    }

    private fun descriptors(vararg entries: String) = JSONArray(
        entries.map { entry ->
            JSONObject()
                .put("entry", entry)
                .put("resources", JSONArray(listOf(entry)))
        },
    )

    private fun addManagedFile(root: File, path: String, bytes: ByteArray) {
        val file = root.resolve(path).apply {
            parentFile.mkdirs()
            writeBytes(bytes)
        }
        val manifest = JSONObject(root.resolve("manifest.json").readText())
        manifest.getJSONObject("assets").put(
            path,
            JSONObject().put("fileHash", HashUtils.calculateSHA256(file)),
        )
        root.resolve("manifest.json").writeText(manifest.toString())
    }

    private fun rewriteMetadata(
        root: File,
        change: (JSONObject) -> Unit,
    ) {
        val metadataFile = root.resolve("hot-updater-lynx.json")
        val metadata = JSONObject(metadataFile.readText())
        change(metadata)
        metadataFile.writeText(metadata.toString())
        val manifest = JSONObject(root.resolve("manifest.json").readText())
        manifest.getJSONObject("assets").put(
            "hot-updater-lynx.json",
            JSONObject().put("fileHash", HashUtils.calculateSHA256(metadataFile)),
        )
        root.resolve("manifest.json").writeText(manifest.toString())
    }

    private fun request(root: File) = LynxArtifactRequest(bundleId,
                            manifestFileHash = HashUtils.calculateSHA256(root.resolve("manifest.json")))

    private fun verifier() = LynxArtifactVerifier(
        LynxInstallConfiguration(runtime),
        ArchiveIntegrity(null),
    )
}
