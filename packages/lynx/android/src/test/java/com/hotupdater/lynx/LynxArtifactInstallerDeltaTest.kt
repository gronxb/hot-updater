package com.hotupdater.lynx

import com.hotupdater.lynx.internal.ArchiveDownload
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.ArchiveLimits
import com.hotupdater.lynx.internal.DirectorySyncPlatform
import com.hotupdater.lynx.internal.DurableFiles
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import com.hotupdater.lynx.internal.LynxDeltaAssembler
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LynxArtifactInstallerDeltaTest {
    private val runtime =
        "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2"
    private val baseId = "01900000-0000-7000-8000-000000000020"
    private val targetId = "01900000-0000-7000-8000-000000000021"
    private val targetReleaseId = "01900000-0000-7000-8000-000000000121"

    @Test
    fun independentProcessesShareResourceLeasesAndBlockExclusivePrune() {
        val root = Files.createTempDirectory("lynx-install-lease-").toFile()
        var reader: Process? = null
        try {
            val store = root.resolve("store")
            val installer = LynxArtifactInstaller(store, config())
            val installations = store.resolve("installations")
            val ids = listOf(
                baseId,
                targetId,
                "01900000-0000-7000-8000-000000000022",
            )
            val directories = ids.mapIndexed { index, id ->
                installations.resolve(id).apply {
                    resolve("payload").mkdirs()
                    setLastModified(3_000L - index)
                }
            }
            val leasedDirectory = directories.last()
            reader = leaseProcess(
                leasedDirectory.resolve("resource.lease"),
                "shared",
            )
            assertEquals("LOCKED", reader.inputStream.bufferedReader().readLine())
            val lease = installer.retain(
                VerifiedLynxInstallation(
                    leasedDirectory.name,
                    leasedDirectory.resolve("payload"),
                    "main.lynx.bundle",
                    runtime,
                    "a".repeat(64),
                    emptyMap(),
                ),
            )
            leasedDirectory.setLastModified(1_000L)

            installer.prune { removeUnused -> removeUnused(emptySet()) }
            assertTrue(leasedDirectory.isDirectory)

            lease.close()
            installer.prune { removeUnused -> removeUnused(emptySet()) }
            assertTrue(leasedDirectory.isDirectory)

            reader.outputStream.bufferedWriter().use { it.newLine() }
            assertTrue(reader.waitFor(5, TimeUnit.SECONDS))
            installer.prune { removeUnused -> removeUnused(emptySet()) }
            assertFalse(leasedDirectory.exists())
        } finally {
            reader?.destroyForcibly()
            root.deleteRecursively()
        }
    }

    @Test
    fun retainRechecksInstallationAfterSerializedPruneUnlinksIt() {
        val root = Files.createTempDirectory("lynx-install-retain-race-").toFile()
        val executor = Executors.newSingleThreadExecutor()
        var pruner: Process? = null
        try {
            val store = root.resolve("store")
            val installer = LynxArtifactInstaller(store, config())
            val directory = store.resolve("installations/$targetId")
            val payload = directory.resolve("payload").apply { mkdirs() }
            val installation = VerifiedLynxInstallation(
                targetId,
                payload,
                "main.lynx.bundle",
                runtime,
                "a".repeat(64),
                emptyMap(),
            )
            pruner = leaseProcess(
                store.resolve("installation.lock"),
                "exclusive",
                directory,
            )
            val output = pruner.inputStream.bufferedReader()
            assertEquals("LOCKED", output.readLine())
            val started = CountDownLatch(1)
            val retained = executor.submit<InstallationLease> {
                started.countDown()
                installer.retain(installation)
            }
            assertTrue(started.await(5, TimeUnit.SECONDS))

            pruner.outputStream.bufferedWriter().apply {
                write("DELETE")
                newLine()
                flush()
            }
            assertEquals("DELETED", output.readLine())
            pruner.outputStream.bufferedWriter().use { it.newLine() }
            assertTrue(pruner.waitFor(5, TimeUnit.SECONDS))

            val error = runCatching {
                retained.get(5, TimeUnit.SECONDS)
            }.exceptionOrNull()
            assertTrue(error?.cause is IllegalStateException)
            assertFalse(directory.exists())
        } finally {
            pruner?.destroyForcibly()
            executor.shutdownNow()
            root.deleteRecursively()
        }
    }

    private fun leaseProcess(
        lockFile: File,
        mode: String,
        deleteDirectory: File? = null,
    ): Process = ProcessBuilder(
        buildList {
            add(File(System.getProperty("java.home"), "bin/java").path)
            add("-cp")
            add(System.getProperty("java.class.path"))
            add("com.hotupdater.lynx.LynxLeaseProcess")
            add(lockFile.path)
            add(mode)
            deleteDirectory?.let { add(it.path) }
        },
    ).redirectErrorStream(true).start()

    @Test
    fun nativeParserRejectsPartialOptionalDescriptorsAndImplicitCompression() {
        val validHash = "a".repeat(64)
        val changed = JSONObject()
            .put("fileHash", validHash)
            .put(
                "file",
                JSONObject()
                    .put("url", "https://example.test/file")
                    .put("compression", JSONObject.NULL),
            )
            .put("patch", JSONObject.NULL)
        val partialArchive = JSONObject()
            .put("bundleId", targetId)
            .put("fileUrl", "https://example.test/archive")
            .put("fileHash", JSONObject.NULL)
            .put("manifestUrl", "https://example.test/manifest")
            .put("manifestFileHash", validHash)
            .put("changedAssets", JSONObject().put("main.lynx.bundle", changed))

        assertThrows(IllegalArgumentException::class.java) {
            LynxArtifactRequest.fromJson(partialArchive)
        }
        partialArchive.put("fileHash", validHash)
        changed.getJSONObject("file").remove("compression")
        assertThrows(IllegalArgumentException::class.java) {
            LynxArtifactRequest.fromJson(partialArchive)
        }
        partialArchive.put("fileUrl", "https://example.test:99999/archive")
        changed.getJSONObject("file").put("compression", JSONObject.NULL)
        assertThrows(IllegalArgumentException::class.java) {
            LynxArtifactRequest.fromJson(partialArchive)
        }
    }

    @Test
    fun changedAssetParserRejectsPortableNamespaceAliases() {
        val hash = "a".repeat(64)
        fun changed() = JSONObject()
            .put("fileHash", hash)
            .put(
                "file",
                JSONObject()
                    .put("url", "https://example.test/file")
                    .put("compression", JSONObject.NULL),
            )
            .put("patch", JSONObject.NULL)
        val artifact = JSONObject()
            .put("bundleId", targetId)
            .put("fileUrl", JSONObject.NULL)
            .put("fileHash", JSONObject.NULL)
            .put("manifestUrl", "https://example.test/manifest")
            .put("manifestFileHash", hash)
            .put(
                "changedAssets",
                JSONObject()
                    .put("A/x.bin", changed())
                    .put("a/y.bin", changed()),
            )

        assertThrows(IllegalArgumentException::class.java) {
            LynxArtifactRequest.fromJson(artifact)
        }
    }

    @Test
    fun changedAssetParserEnforcesPortablePathSyntaxAndUtf8Boundary() {
        val hash = "a".repeat(64)
        fun artifact(path: String) = JSONObject()
            .put("bundleId", targetId)
            .put("fileUrl", JSONObject.NULL)
            .put("fileHash", JSONObject.NULL)
            .put("manifestUrl", "https://example.test/manifest")
            .put("manifestFileHash", hash)
            .put(
                "changedAssets",
                JSONObject().put(
                    path,
                    JSONObject()
                        .put("fileHash", hash)
                        .put(
                            "file",
                            JSONObject()
                                .put("url", "https://example.test/file")
                                .put("compression", JSONObject.NULL),
                        )
                        .put("patch", JSONObject.NULL),
                ),
            )
        val boundary = "a/".repeat(511) + "aa"
        assertEquals(
            targetId,
            LynxArtifactRequest.fromJson(artifact(boundary)).bundleId,
        )
        listOf(
            boundary + "a",
            "asset:name",
            "asset\u001fname",
            "asset\u007fname",
        ).forEach { path ->
            assertThrows(IllegalArgumentException::class.java) {
                LynxArtifactRequest.fromJson(artifact(path))
            }
        }
    }

    @Test
    fun deltaManifestRejectsPortableAliasesBeforeCreatingAssetDirectories() =
        runBlocking {
            val root = Files.createTempDirectory("lynx-delta-paths-").toFile()
            try {
                val baseRoot = root.resolve("running")
                val baseManifest = writeTree(
                    baseRoot,
                    baseId,
                    files(baseId, BASE_ENTRY),
                )
                val base = verifier().verify(
                    baseRoot,
                    LynxArtifactRequest(baseId, null, null, baseManifest.hash),
                )
                val aliases = listOf(
                    "A/x.bin" to "a/y.bin",
                    "Straße" to "STRASSE",
                    "μέρος" to "ΜΈΡΟσ",
                )
                aliases.forEachIndexed { index, (first, second) ->
                    val targetManifest = manifest(
                        targetId,
                        files(targetId, TARGET_ENTRY) + mapOf(
                            first to byteArrayOf(1),
                            second to byteArrayOf(2),
                        ),
                    )
                    FixtureServer(mapOf("/manifest" to targetManifest)).use { server ->
                        val transaction = root.resolve("transaction-$index")
                            .apply { mkdir() }
                        val payload = transaction.resolve("payload")
                            .apply { mkdir() }
                        val request = LynxArtifactRequest(
                            targetId,
                            null,
                            null,
                            targetManifest.hash,
                            server.url("/manifest"),
                            emptyMap(),
                        )

                        val error = runCatching {
                            LynxDeltaAssembler(
                                ArchiveIntegrity(null),
                                ArchiveDownload(),
                            ).assemble(transaction, payload, request, base) {}
                        }.exceptionOrNull()

                        assertTrue("case $index", error is IllegalArgumentException)
                        assertEquals(
                            setOf("manifest.json"),
                            payload.listFiles().orEmpty().map { it.name }.toSet(),
                        )
                    }
                }
            } finally {
                root.deleteRecursively()
            }
        }

    @Test
    fun deltaManifestCountsImplicitParentsBeforeCreatingAssetDirectories() =
        runBlocking {
            val root = Files.createTempDirectory("lynx-delta-entry-count-").toFile()
            try {
                val baseRoot = root.resolve("running")
                val baseManifest = writeTree(
                    baseRoot,
                    baseId,
                    files(baseId, BASE_ENTRY),
                )
                val base = verifier().verify(
                    baseRoot,
                    LynxArtifactRequest(baseId, null, null, baseManifest.hash),
                )
                val assets = JSONObject()
                repeat(ArchiveLimits.MAX_ENTRIES / 2) { index ->
                    assets.put(
                        "directory-$index/entry",
                        JSONObject().put("fileHash", "a".repeat(64)),
                    )
                }
                val targetManifest = JSONObject()
                    .put("bundleId", targetId)
                    .put("assets", assets)
                    .toString()
                    .toByteArray()
                FixtureServer(mapOf("/manifest" to targetManifest)).use { server ->
                    val transaction = root.resolve("transaction").apply { mkdir() }
                    val payload = transaction.resolve("payload").apply { mkdir() }
                    val request = LynxArtifactRequest(
                        targetId,
                        null,
                        null,
                        targetManifest.hash,
                        server.url("/manifest"),
                        emptyMap(),
                    )

                    val error = runCatching {
                        LynxDeltaAssembler(
                            ArchiveIntegrity(null),
                            ArchiveDownload(),
                        ).assemble(transaction, payload, request, base) {}
                    }.exceptionOrNull()

                    assertTrue(error is IllegalArgumentException)
                    assertEquals(
                        setOf("manifest.json"),
                        payload.listFiles().orEmpty().map { it.name }.toSet(),
                    )
                }
            } finally {
                root.deleteRecursively()
            }
        }

    @Test
    fun deltaRequiresExactlyTheAssetsWhoseManifestHashesChanged() = runBlocking {
        val root = Files.createTempDirectory("lynx-delta-change-set-").toFile()
        try {
            val baseFiles = files(baseId, BASE_ENTRY) +
                ("assets/unchanged.txt" to "same".toByteArray())
            val baseRoot = root.resolve("running")
            val baseManifest = writeTree(baseRoot, baseId, baseFiles)
            val base = verifier().verify(
                baseRoot,
                LynxArtifactRequest(baseId, null, null, baseManifest.hash),
            )
            val targetFiles = files(targetId, TARGET_ENTRY) +
                ("assets/unchanged.txt" to "same".toByteArray())
            val targetManifest = manifest(targetId, targetFiles)
            FixtureServer(mapOf("/manifest" to targetManifest)).use { server ->
                fun changed(path: String) = LynxChangedAsset(
                    targetFiles.hash(path),
                    LynxChangedFile(server.url("/unused")),
                )
                val required = mapOf(
                    "main.lynx.bundle" to changed("main.lynx.bundle"),
                    "hot-updater-lynx.json" to changed("hot-updater-lynx.json"),
                )
                val cases = listOf(
                    required - "hot-updater-lynx.json",
                    required + (
                        "assets/unchanged.txt" to
                            changed("assets/unchanged.txt")
                        ),
                )

                cases.forEachIndexed { index, changes ->
                    val transaction = root.resolve("transaction-$index").apply {
                        mkdir()
                    }
                    val payload = transaction.resolve("payload").apply { mkdir() }
                    val request = LynxArtifactRequest(
                        targetId,
                        null,
                        null,
                        targetManifest.hash,
                        server.url("/manifest"),
                        changes,
                    )

                    val error = runCatching {
                        LynxDeltaAssembler(
                            ArchiveIntegrity(null),
                            ArchiveDownload(),
                        ).assemble(transaction, payload, request, base) {}
                    }.exceptionOrNull()

                    assertTrue("case $index", error is IllegalArgumentException)
                    assertEquals(
                        setOf("manifest.json"),
                        payload.listFiles().orEmpty().map { it.name }.toSet(),
                    )
                }
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun cancellationClosesTheDownloadAndRemovesThePrivatePreparation() = runBlocking {
        val root = Files.createTempDirectory("lynx-delta-cancel-").toFile()
        try {
            val baseRoot = root.resolve("running")
            val baseFiles = files(baseId, BASE_ENTRY)
            val baseManifest = writeTree(baseRoot, baseId, baseFiles)
            val base = verifier().verify(
                baseRoot,
                LynxArtifactRequest(baseId, null, null, baseManifest.hash),
            )
            FixtureServer(emptyMap(), setOf("/manifest")).use { server ->
                val request = LynxArtifactRequest(
                    targetId,
                    null,
                    null,
                    "a".repeat(64),
                    server.url("/manifest"),
                    emptyMap(),
                )
                val store = root.resolve("store")
                val installer = LynxArtifactInstaller(store, config())
                val job = launch(Dispatchers.Default) { installer.prepare(request, base) }
                assertTrue(server.await("/manifest"))
                withTimeout(5_000) { job.cancelAndJoin() }
                assertTrue(
                    store.resolve("preparations").listFiles().orEmpty().isEmpty(),
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun manifestInstallAppliesBsdiffRawAndBrotliWithoutAPhantomArchive() =
        runBlocking {
            val root = Files.createTempDirectory("lynx-delta-").toFile()
            try {
                val baseFiles = files(baseId, BASE_ENTRY).toMutableMap().apply {
                    put("assets/unchanged.txt", "same".toByteArray())
                    put("assets/raw.txt", "old".toByteArray())
                    put("assets/br.txt", "old-br".toByteArray())
                }
                val baseRoot = root.resolve("running")
                val baseManifest = writeTree(baseRoot, baseId, baseFiles)
                val base = verifier().verify(
                    baseRoot,
                    LynxArtifactRequest(baseId, null, null, baseManifest.hash),
                )
                val targetFiles = files(targetId, TARGET_ENTRY).toMutableMap().apply {
                    put("assets/unchanged.txt", "same".toByteArray())
                    put("assets/raw.txt", "raw-target".toByteArray())
                    put("assets/br.txt", "probe-brotli-target".toByteArray())
                    put("assets/empty.txt", byteArrayOf())
                }
                val targetManifest = manifest(targetId, targetFiles)
                val patch = Base64.getDecoder().decode(PATCH)
                FixtureServer(
                    mapOf(
                        "/manifest" to targetManifest,
                        "/patch" to patch,
                        "/raw" to targetFiles.getValue("assets/raw.txt"),
                        "/br" to Base64.getDecoder().decode(BROTLI_TARGET),
                        "/empty" to byteArrayOf(),
                        "/metadata" to targetFiles.getValue("hot-updater-lynx.json"),
                    ),
                ).use { server ->
                    fun file(path: String, compression: String? = null) =
                        LynxChangedFile(server.url(path), compression)
                    val request = LynxArtifactRequest(
                        targetId,
                        null,
                        null,
                        targetManifest.hash,
                        server.url("/manifest"),
                        mapOf(
                            "main.lynx.bundle" to LynxChangedAsset(
                                targetFiles.hash("main.lynx.bundle"),
                                patch = LynxAssetPatch(
                                    "bsdiff",
                                    baseId,
                                    baseFiles.hash("main.lynx.bundle"),
                                    patch.hash,
                                    server.url("/patch"),
                                ),
                            ),
                            "assets/raw.txt" to LynxChangedAsset(
                                targetFiles.hash("assets/raw.txt"),
                                file("/raw"),
                            ),
                            "assets/br.txt" to LynxChangedAsset(
                                targetFiles.hash("assets/br.txt"),
                                file("/br", "br"),
                            ),
                            "assets/empty.txt" to LynxChangedAsset(
                                targetFiles.hash("assets/empty.txt"),
                                file("/empty"),
                            ),
                            "hot-updater-lynx.json" to LynxChangedAsset(
                                targetFiles.hash("hot-updater-lynx.json"),
                                file("/metadata"),
                            ),
                        ),
                    )
                    val installer = LynxArtifactInstaller(root.resolve("store"), config())
                    val prepared = installer.prepare(
                        request,
                        base,
                        releaseId = targetReleaseId,
                    )
                    assertTrue(prepared.manifestBacked)
                    val patched = prepared.patchedAssets.single()
                    assertEquals("main.lynx.bundle", patched.path)
                    assertEquals(patch.hash, patched.patchFileHash)
                    assertEquals(
                        targetFiles.hash("main.lynx.bundle"),
                        patched.reconstructedFileHash,
                    )
                    val patchEvent = JSONObject(
                        LynxInstallEvent.json(
                            "HotUpdaterBsdiffPatchApplied",
                            prepared,
                            baseId,
                            patched,
                        ),
                    )
                    assertEquals(1, patchEvent.getInt("schemaVersion"))
                    assertEquals(
                        "HotUpdaterBsdiffPatchApplied",
                        patchEvent.getString("event"),
                    )
                    assertEquals(
                        prepared.transactionId,
                        patchEvent.getString("transactionId"),
                    )
                    assertEquals(targetId, patchEvent.getString("bundleId"))
                    assertEquals(
                        targetReleaseId,
                        patchEvent.getString("releaseId"),
                    )
                    assertEquals(baseId, patchEvent.getString("baseBundleId"))
                    assertEquals(patched.path, patchEvent.getString("asset"))
                    assertEquals(
                        patched.patchFileHash,
                        patchEvent.getString("patchFileHash"),
                    )
                    assertEquals(
                        patched.reconstructedFileHash,
                        patchEvent.getString("reconstructedFileHash"),
                    )
                    val manifestEvent = JSONObject(
                        LynxInstallEvent.json(
                            "HotUpdaterManifestDiffApplied",
                            prepared,
                            baseId,
                        ),
                    )
                    assertEquals(
                        prepared.transactionId,
                        manifestEvent.getString("transactionId"),
                    )
                    assertFalse(manifestEvent.has("asset"))
                    val installed = installer.commitPrepared(prepared) { publish -> publish() }

                    assertFalse(installed.directory.parentFile.resolve("archive").exists())
                    targetFiles.forEach { (path, expected) ->
                        assertArrayEquals(expected, installed.directory.resolve(path).readBytes())
                    }
                    val later = verifier().verify(
                        installed.directory,
                        LynxArtifactRequest(targetId, null, null, targetManifest.hash),
                        manifestBacked = true,
                    )
                    assertTrue(later.manifestBacked)
                }
            } finally {
                root.deleteRecursively()
            }
        }

    @Test
    fun unusablePatchFallsBackToVerifiedArchiveAndKeepsManifestAuthority() =
        runBlocking {
            val root = Files.createTempDirectory("lynx-delta-archive-").toFile()
            try {
                val baseRoot = root.resolve("running")
                val baseFiles = files(baseId, BASE_ENTRY)
                val baseManifest = writeTree(baseRoot, baseId, baseFiles)
                val base = verifier().verify(
                    baseRoot,
                    LynxArtifactRequest(baseId, null, null, baseManifest.hash),
                )
                val targetFiles = files(targetId, TARGET_ENTRY)
                val targetManifest = manifest(targetId, targetFiles)
                val archive = zip(targetFiles + ("manifest.json" to targetManifest))
                val invalidPatch = "not-a-bsdiff-patch".toByteArray()
                FixtureServer(
                    mapOf(
                        "/manifest" to targetManifest,
                        "/patch" to invalidPatch,
                        "/archive" to archive,
                        "/metadata" to targetFiles.getValue("hot-updater-lynx.json"),
                    ),
                ).use { server ->
                    val request = LynxArtifactRequest(
                        targetId,
                        server.url("/archive"),
                        archive.hash,
                        targetManifest.hash,
                        server.url("/manifest"),
                        mapOf(
                            "main.lynx.bundle" to LynxChangedAsset(
                                targetFiles.hash("main.lynx.bundle"),
                                patch = LynxAssetPatch(
                                    "bsdiff",
                                    baseId,
                                    baseFiles.hash("main.lynx.bundle"),
                                    invalidPatch.hash,
                                    server.url("/patch"),
                                ),
                            ),
                            "hot-updater-lynx.json" to LynxChangedAsset(
                                targetFiles.hash("hot-updater-lynx.json"),
                                LynxChangedFile(server.url("/metadata")),
                            ),
                        ),
                    )
                    val installer = LynxArtifactInstaller(root.resolve("store"), config())
                    val prepared = installer.prepare(request, base)
                    assertFalse(prepared.manifestBacked)
                    val installed = installer.commitPrepared(prepared) { publish -> publish() }
                    assertTrue(installed.directory.parentFile.resolve("archive").isFile)
                    assertArrayEquals(TARGET_ENTRY, installed.directory.resolve("main.lynx.bundle").readBytes())
                }
            } finally {
                root.deleteRecursively()
            }
        }

    @Test
    fun archiveFallbackRejectsAManifestOutsideThePreservedAuthority() = runBlocking {
        val root = Files.createTempDirectory("lynx-delta-authority-").toFile()
        try {
            val baseRoot = root.resolve("running")
            val baseFiles = files(baseId, BASE_ENTRY)
            val baseManifest = writeTree(baseRoot, baseId, baseFiles)
            val base = verifier().verify(
                baseRoot,
                LynxArtifactRequest(baseId, null, null, baseManifest.hash),
            )
            val targetFiles = files(targetId, TARGET_ENTRY)
            val targetManifest = manifest(targetId, targetFiles)
            val archive = zip(targetFiles + ("manifest.json" to targetManifest))
            FixtureServer(
                mapOf(
                    "/manifest" to targetManifest,
                    "/archive" to archive,
                ),
            ).use { server ->
                val request = LynxArtifactRequest(
                    targetId,
                    server.url("/archive"),
                    archive.hash,
                    "f".repeat(64),
                    server.url("/manifest"),
                    emptyMap(),
                )
                val store = root.resolve("store")

                assertThrows(IllegalStateException::class.java) {
                    runBlocking {
                        LynxArtifactInstaller(store, config()).prepare(request, base)
                    }
                }
                assertTrue(
                    store.resolve("preparations").listFiles().orEmpty().isEmpty(),
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun stateDirectorySyncFailuresKeepThePreviousJournal() {
        SyncFault.values().forEach { fault ->
            val root = Files.createTempDirectory("lynx-state-sync-$fault-").toFile()
            try {
                val directory = root.resolve("journal")
                val sync = FaultingDirectorySync(fault, directory.name)
                val store = LynxStateStore(directory, sync::invoke)
                store.update { it.put("selection", "previous") }
                val previous = directory.resolve("state.json").readBytes()
                sync.arm()

                val error = runCatching {
                    store.update { it.put("selection", "candidate") }
                }.exceptionOrNull()

                assertTrue("$fault must propagate", error is IOException)
                assertArrayEquals(previous, directory.resolve("state.json").readBytes())
                assertTrue(store.value.getString("selection") == "previous")
                assertFalse(
                    directory.listFiles().orEmpty().any {
                        it.name.startsWith("state.next-") ||
                            it.name.startsWith("state.rollback-")
                    },
                )
                store.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun installationDirectorySyncFailuresKeepThePreviousInstallation() =
        runBlocking {
            SyncFault.values().forEach { fault ->
                val root = Files.createTempDirectory("lynx-install-sync-$fault-").toFile()
                try {
                    val previousFiles = files(baseId, BASE_ENTRY)
                    val previousManifest = manifest(baseId, previousFiles)
                    val previousArchive = zip(
                        previousFiles + ("manifest.json" to previousManifest),
                    )
                    val targetFiles = files(targetId, TARGET_ENTRY)
                    val targetManifest = manifest(targetId, targetFiles)
                    val targetArchive = zip(
                        targetFiles + ("manifest.json" to targetManifest),
                    )
                    FixtureServer(
                        mapOf(
                            "/previous" to previousArchive,
                            "/target" to targetArchive,
                        ),
                    ).use { server ->
                        val store = root.resolve("store")
                        val sync = FaultingDirectorySync(fault, "installations")
                        val installer = LynxArtifactInstaller(
                            store,
                            config(),
                            sync::invoke,
                        )
                        val previous = installer.prepare(
                            LynxArtifactRequest(
                                baseId,
                                server.url("/previous"),
                                previousArchive.hash,
                                previousManifest.hash,
                            ),
                        )
                        installer.commitPrepared(previous) { publish -> publish() }
                        val candidate = installer.prepare(
                            LynxArtifactRequest(
                                targetId,
                                server.url("/target"),
                                targetArchive.hash,
                                targetManifest.hash,
                            ),
                        )
                        sync.arm()

                        val error = runCatching {
                            installer.commitPrepared(candidate) { publish ->
                                publish()
                            }
                        }.exceptionOrNull()

                        assertTrue("$fault must propagate", error is IOException)
                        val installations = store.resolve("installations")
                        assertArrayEquals(
                            BASE_ENTRY,
                            installations.resolve(baseId)
                                .resolve("payload/main.lynx.bundle")
                                .readBytes(),
                        )
                        assertFalse(installations.resolve(targetId).exists())
                        assertTrue(
                            store.resolve("preparations").listFiles()
                                .orEmpty().isEmpty(),
                        )
                    }
                } finally {
                    root.deleteRecursively()
                }
            }
        }

    @Test
    fun repeatedStageJournalFailuresReleasePreparedArtifactsAndCapacity() =
        runBlocking {
            val root = Files.createTempDirectory("lynx-stage-journal-").toFile()
            try {
                val embeddedRoot = root.resolve("embedded")
                val embeddedManifest = writeTree(
                    embeddedRoot,
                    baseId,
                    files(baseId, BASE_ENTRY),
                )
                val embedded = verifier().verify(
                    embeddedRoot,
                    LynxArtifactRequest(baseId, null, null, embeddedManifest.hash),
                )
                val binary = root.resolve("binary").apply {
                    writeBytes(byteArrayOf(1, 2, 3, 4))
                }
                val channel = "ota-react"
                val host = LynxHostConfiguration(
                    runtime,
                    channel,
                    "1.0.0",
                    embeddedRoot.path,
                    baseId,
                    embeddedManifest.hash,
                    baseId,
                    "1",
                )
                val targetFiles = files(targetId, TARGET_ENTRY)
                val targetManifest = manifest(targetId, targetFiles)
                val archive = zip(
                    targetFiles + ("manifest.json" to targetManifest),
                )
                FixtureServer(mapOf("/target" to archive)).use { server ->
                    val controller = LynxUpdaterController(
                        root,
                        binary,
                        embedded,
                        host,
                    )
                    try {
                        val primary = controller.pinPrimary().also {
                            it.firstScreen = true
                            controller.confirm(it)
                        }
                        val (guard, selection) =
                            acceptTarget(controller, primary, channel)
                        val artifact = JSONObject()
                            .put("bundleId", targetId)
                            .put("fileUrl", server.url("/target"))
                            .put("fileHash", archive.hash)
                            .put("manifestUrl", JSONObject.NULL)
                            .put("manifestFileHash", targetManifest.hash)
                            .put("changedAssets", JSONObject.NULL)
                        val store = root.resolve("hot-updater-lynx/scopes")
                            .listFiles()!!.single()
                        val stateFile = store.resolve("state.json")
                        val previousState = stateFile.readBytes()

                        repeat(20) { index ->
                            val prepared = controller.prepare(
                                primary,
                                JSONObject()
                                    .put("guard", guard)
                                    .put("selection", selection)
                                    .put("artifact", artifact),
                            )
                            val saved = root.resolve("state-$index.json")
                            assertTrue(stateFile.renameTo(saved))
                            assertTrue(stateFile.mkdir())
                            val error = try {
                                runCatching {
                                    controller.stage(
                                        primary,
                                        prepared.getString("preparedId"),
                                    )
                                }.exceptionOrNull()
                            } finally {
                                assertTrue(stateFile.deleteRecursively())
                                assertTrue(saved.renameTo(stateFile))
                            }

                            assertTrue("stage $index must fail", error != null)
                            assertArrayEquals(previousState, stateFile.readBytes())
                            assertTrue(
                                store.resolve("artifacts/preparations")
                                    .listFiles().orEmpty().isEmpty(),
                            )
                        }

                        val finalPreparation = controller.prepare(
                            primary,
                            JSONObject()
                                .put("guard", guard)
                                .put("selection", selection)
                                .put("artifact", artifact),
                        )
                        assertTrue(
                            controller.stage(
                                primary,
                                finalPreparation.getString("preparedId"),
                            ).getString("status") == "STAGED",
                        )
                    } finally {
                        controller.close()
                    }
                }
            } finally {
                root.deleteRecursively()
            }
        }

    @Test
    fun validateSelectionReportsIncompatibleWithoutRetainingAPreparation() =
        runBlocking {
            val root = Files.createTempDirectory("lynx-validate-incompatible-").toFile()
            try {
                val embeddedRoot = root.resolve("embedded")
                val embeddedManifest = writeTree(
                    embeddedRoot,
                    baseId,
                    files(baseId, BASE_ENTRY),
                )
                val embedded = verifier().verify(
                    embeddedRoot,
                    LynxArtifactRequest(baseId, null, null, embeddedManifest.hash),
                )
                val binary = root.resolve("binary").apply {
                    writeBytes(byteArrayOf(1, 2, 3, 4))
                }
                val channel = "ota-react"
                val host = LynxHostConfiguration(
                    runtime,
                    channel,
                    "1.0.0",
                    embeddedRoot.path,
                    baseId,
                    embeddedManifest.hash,
                    baseId,
                    "1",
                )
                val incompatibleFiles = files(targetId, TARGET_ENTRY)
                    .toMutableMap()
                    .apply {
                        put(
                            "hot-updater-lynx.json",
                            JSONObject()
                                .put("schemaVersion", 1)
                                .put("bundleId", targetId)
                                .put("platform", "android")
                                .put("entry", "main.lynx.bundle")
                                .put("runtimeId", "$runtime-incompatible")
                                .toString()
                                .toByteArray(),
                        )
                    }
                val incompatibleManifest = manifest(targetId, incompatibleFiles)
                val incompatibleArchive = zip(
                    incompatibleFiles +
                        ("manifest.json" to incompatibleManifest),
                )
                FixtureServer(mapOf("/incompatible" to incompatibleArchive)).use {
                    server ->
                    val controller = LynxUpdaterController(
                        root,
                        binary,
                        embedded,
                        host,
                    )
                    try {
                        val primary = controller.pinPrimary().also {
                            it.firstScreen = true
                            controller.confirm(it)
                        }
                        val (guard, selection) =
                            acceptTarget(controller, primary, channel)
                        val artifact = JSONObject()
                            .put("bundleId", targetId)
                            .put("fileUrl", server.url("/incompatible"))
                            .put("fileHash", incompatibleArchive.hash)
                            .put("manifestUrl", JSONObject.NULL)
                            .put(
                                "manifestFileHash",
                                incompatibleManifest.hash,
                            )
                            .put("changedAssets", JSONObject.NULL)
                        val error = runCatching {
                            controller.validate(
                                primary,
                                JSONObject()
                                    .put("guard", guard)
                                    .put("selection", selection)
                                    .put("artifact", artifact),
                            )
                        }.exceptionOrNull()

                        assertTrue(error is LynxIncompatibleArtifactException)
                        val store = root.resolve("hot-updater-lynx/scopes")
                            .listFiles()!!.single()
                        assertTrue(
                            store.resolve("artifacts/preparations")
                                .listFiles().orEmpty().isEmpty(),
                        )
                        assertTrue(
                            controller.state(primary).opt("nextSelection") ==
                                JSONObject.NULL,
                        )
                    } finally {
                        controller.close()
                    }
                }
            } finally {
                root.deleteRecursively()
            }
        }

    private fun config() = LynxInstallConfiguration(runtime)

    private fun verifier() = LynxArtifactVerifier(config(), ArchiveIntegrity(null))

    private fun files(bundleId: String, entry: ByteArray) = mapOf(
        "main.lynx.bundle" to entry,
        "hot-updater-lynx.json" to JSONObject()
            .put("schemaVersion", 1)
            .put("bundleId", bundleId)
            .put("platform", "android")
            .put("entry", "main.lynx.bundle")
            .put("runtimeId", runtime)
            .toString()
            .toByteArray(),
    )

    private fun manifest(bundleId: String, files: Map<String, ByteArray>) =
        JSONObject()
            .put("bundleId", bundleId)
            .put(
                "assets",
                JSONObject().also { assets ->
                    files.forEach { (path, bytes) ->
                        assets.put(path, JSONObject().put("fileHash", bytes.hash))
                    }
                },
            )
            .toString()
            .toByteArray()

    private fun writeTree(root: java.io.File, bundleId: String, files: Map<String, ByteArray>): ByteArray {
        files.forEach { (path, bytes) ->
            root.resolve(path).also { it.parentFile.mkdirs(); it.writeBytes(bytes) }
        }
        return manifest(bundleId, files).also { root.resolve("manifest.json").writeBytes(it) }
    }

    private fun zip(files: Map<String, ByteArray>): ByteArray = ByteArrayOutputStream().use { bytes ->
        ZipOutputStream(bytes).use { zip ->
            files.forEach { (path, content) ->
                zip.putNextEntry(ZipEntry(path))
                zip.write(content)
                zip.closeEntry()
            }
        }
        bytes.toByteArray()
    }

    private val ByteArray.hash: String
        get() = java.security.MessageDigest.getInstance("SHA-256")
            .digest(this)
            .joinToString("") { "%02x".format(it) }

    private fun Map<String, ByteArray>.hash(path: String) = getValue(path).hash

    private fun acceptTarget(
        controller: LynxUpdaterController,
        primary: LynxLaunchSession,
        channel: String,
    ): Pair<JSONObject, JSONObject> {
        val scope =
            "v1:app-version:android:${CatalogPolicy.channelKey(channel)}"
        val catalogHash = "sha256:" + "c".repeat(64)
        val catalog = JSONObject()
            .put("schemaVersion", 1)
            .put("catalogId", "lynx-stage-test")
            .put("scopeKey", scope)
            .put("generation", 2)
            .put("catalogHash", catalogHash)
            .put("fallbackPolicy", "BUILTIN_IF_ACTIVE_INELIGIBLE")
            .put(
                "releases",
                org.json.JSONArray().put(
                    JSONObject()
                        .put("releaseId", targetReleaseId)
                        .put("kind", "BUNDLE")
                        .put("bundleId", targetId)
                        .put("rolloutCohortCount", 1000)
                        .put("targetCohorts", org.json.JSONArray())
                        .put("shouldForceUpdate", false)
                        .put("message", JSONObject.NULL),
                ),
            )
        val before = controller.state(primary)
        val contextHash = CatalogPolicy.selectionContextHash(
            nativeSnapshot(before),
            scope,
        )
        val guard = controller.accept(
            primary,
            JSONObject()
                .put("catalog", catalog)
                .put("expectedRevision", before.getString("revision"))
                .put("targetChannel", channel)
                .put("explicitScopeSwitch", false)
                .put("selectionContextHash", contextHash),
        )
        return guard to CatalogPolicy.Receipt(
            "BUNDLE",
            targetReleaseId,
            targetId,
            "lynx-stage-test",
            scope,
            2,
            catalogHash,
            channel,
            contextHash,
        ).toJson()
    }

    private fun nativeSnapshot(state: JSONObject): CatalogPolicy.NativeSnapshot {
        val next = state.opt("nextSelection")
        return CatalogPolicy.NativeSnapshot(
            state.getString("revision"),
            state.getString("appVersion"),
            state.getString("channel"),
            state.getString("runtimeId"),
            state.getString("embeddedBundleId"),
            state.getString("minimumBundleId"),
            state.getString("cohort"),
            CatalogPolicy.parseReceipt(state.getJSONObject("runningSelection")),
            if (next == null || next == JSONObject.NULL) {
                null
            } else {
                CatalogPolicy.parseReceipt(state.getJSONObject("nextSelection"))
            },
            (0 until state.getJSONArray("crashedBundleIds").length()).map {
                state.getJSONArray("crashedBundleIds").getString(it)
            },
            (0 until state.getJSONArray("unconfirmedReleaseIds").length()).map {
                state.getJSONArray("unconfirmedReleaseIds").getString(it)
            },
            state.optString("fingerprintHash").takeIf { it.isNotEmpty() },
        )
    }

    private class FixtureServer(
        private val responses: Map<String, ByteArray>,
        private val stalls: Set<String> = emptySet(),
    ) : AutoCloseable {
        private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        private val executor = Executors.newCachedThreadPool()
        private val requests = ConcurrentHashMap<String, CountDownLatch>()
        @Volatile private var closed = false

        init {
            executor.execute {
                while (!closed) {
                    val client = try { socket.accept() } catch (_: Exception) { break }
                    executor.execute {
                        client.use {
                            val reader = it.getInputStream().bufferedReader()
                            val path = reader.readLine().split(' ')[1]
                            while (!reader.readLine().isNullOrEmpty()) Unit
                            requests.computeIfAbsent(path) { CountDownLatch(1) }.countDown()
                            if (path in stalls) Thread.sleep(30_000)
                            val body = responses[path]
                            val status = if (body == null) "404 Not Found" else "200 OK"
                            val bytes = body ?: byteArrayOf()
                            val output = it.getOutputStream()
                            output.write("HTTP/1.1 $status\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            output.write(bytes)
                            output.flush()
                        }
                    }
                }
            }
        }

        fun url(path: String) = "http://127.0.0.1:${socket.localPort}$path"

        fun await(path: String) = requests
            .computeIfAbsent(path) { CountDownLatch(1) }
            .await(5, TimeUnit.SECONDS)

        override fun close() {
            closed = true
            socket.close()
            executor.shutdownNow()
        }
    }

    private enum class SyncFault { OPEN, FSYNC, CLOSE }

    private class FaultingDirectorySync(
        private val fault: SyncFault,
        private val targetName: String,
    ) {
        private var armed = false
        private var failed = false

        fun arm() {
            armed = true
        }

        operator fun invoke(directory: java.io.File) {
            val failHere = armed && directory.name == targetName
            DurableFiles.syncDirectory(
                directory,
                object : DirectorySyncPlatform {
                    override fun open(path: String): FileDescriptor {
                        fail(failHere, SyncFault.OPEN)
                        return FileDescriptor()
                    }

                    override fun fsync(descriptor: FileDescriptor) {
                        fail(failHere, SyncFault.FSYNC)
                    }

                    override fun close(descriptor: FileDescriptor) {
                        fail(failHere, SyncFault.CLOSE)
                    }
                },
            )
        }

        private fun fail(failHere: Boolean, operation: SyncFault) {
            if (failHere && !failed && fault == operation) {
                failed = true
                throw IOException("Injected directory $operation failure")
            }
        }
    }

    companion object {
        private val BASE_ENTRY = "console.log(\"base bundle\");\n".toByteArray()
        private val TARGET_ENTRY = "console.log(\"patched bundle\");\n".toByteArray()
        private const val PATCH =
            "RU5EU0xFWS9CU0RJRkY0Mx8AAAAAAAAAQlpoOTFBWSZTWb12MIEAAAB5gEQYAADQYQAIPsXOACAAIo0A0NAaNCgAGgZMgHAtYscVxxRtTt4nmaj70g4gQSF5+T4u5IpwoSF67GEC"
        private const val BROTLI_TARGET = "CwmAcHJvYmUtYnJvdGxpLXRhcmdldAM="
    }
}

object LynxLeaseProcess {
    @JvmStatic
    fun main(arguments: Array<String>) {
        val lockFile = File(arguments[0])
        lockFile.parentFile?.mkdirs()
        RandomAccessFile(lockFile, "rw").use { file ->
            val shared = arguments[1] == "shared"
            file.channel.lock(0L, Long.MAX_VALUE, shared).use {
                println("LOCKED")
                System.out.flush()
                if (readLine() == "DELETE") {
                    File(arguments[2]).deleteRecursively()
                    println("DELETED")
                    System.out.flush()
                    readLine()
                }
            }
        }
    }
}
