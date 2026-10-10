package com.hotupdater.lynx

import com.hotupdater.lynx.internal.HashUtils
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicReference

class LynxUpdaterControllerTest {
    private val runtime = "android-sparkling-2.1.0-rc.12-navsrc-937f70d7c3012a5a-lynx-3.9.0-primjs-3.8.0-alpha.6-managed-pages-v1"
    private val embeddedId = "00000000-0000-0000-0000-000000000000"
    private val bundleB = "01900000-0000-7000-8000-000000000020"
    private val bundleC = "01900000-0000-7000-8000-000000000030"
    private val releaseB = "01900000-0000-7000-8000-000000000120"
    private val releaseC = "01900000-0000-7000-8000-000000000130"
    private val channel = "ota-react"
    private val catalogId = "lynx-local"
    private val scopeKey = "v1:app-version:android:b3RhLXJlYWN0"
    private val catalogHash = "sha256:" + "a".repeat(64)

    private fun temp(): File = Files.createTempDirectory("lynx-controller-").toFile()

    private fun binary(root: File): File = File(root, "binary").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }

    private fun embedded(root: File, background: Boolean = false): VerifiedLynxInstallation {
        val directory = File(root, "embedded").apply { mkdirs() }
        val entry = File(directory, "main.lynx.bundle").apply {
            writeText("entry-A")
        }
        val detail = File(directory, "detail.lynx.bundle").apply {
            writeText("detail-A")
        }
        val script = File(directory, "task.js").apply { if (background) writeText("globalThis.marker = 'A';") }
        return VerifiedLynxInstallation(
            embeddedId, directory, "main.lynx.bundle", runtime, "e".repeat(64),
            mapOf(
                "main.lynx.bundle" to HashUtils.calculateSHA256(entry),
                "detail.lynx.bundle" to HashUtils.calculateSHA256(detail),
            ) + if (background) mapOf("task.js" to HashUtils.calculateSHA256(script)) else emptyMap(),
            backgroundEntry = if (background) "task.js" else null,
            pageEntries = listOf("detail.lynx.bundle", "main.lynx.bundle"),
            pageEssentialResources = listOf(
                LynxPageEssentialResources(
                    "detail.lynx.bundle",
                    listOf("detail.lynx.bundle"),
                ),
                LynxPageEssentialResources(
                    "main.lynx.bundle",
                    listOf("main.lynx.bundle"),
                ),
            ),
        )
    }

    private fun config() = LynxHostConfiguration(
        runtimeId = runtime, channel = channel, appVersion = "1.0.0",
        embeddedAssetDirectory = "ota/react/A",
        embeddedBundleId = embeddedId,
        embeddedManifestHash = "e".repeat(64),
        minimumBundleId = embeddedId,
        cohort = "1",
    )

    private fun controller(root: File, processToken: String = "10000000-0000-4000-8000-000000000001") =
        LynxUpdaterController(
            root,
            binary(root),
            embedded(root),
            config(),
            processIdentity = { "4321" },
            processToken = processToken,
        )

    private fun withController(
        root: File,
        action: (LynxUpdaterController) -> Unit,
    ) {
        val controller = controller(root)
        try {
            action(controller)
        } finally {
            controller.close()
        }
    }

    private fun store(root: File): File = File(root, "hot-updater-lynx/scopes").listFiles()!!.single { it.isDirectory }

    private fun journal(root: File): JSONObject = JSONObject(File(store(root), "state.json").readText())

    private fun catalog(
        releaseId: String,
        bundleId: String,
        catalogIdentity: String = catalogId,
        scope: String = scopeKey,
        generation: Long = 2,
        hash: String = catalogHash,
    ): JSONObject {
        val descriptor = JSONObject()
            .put("releaseId", releaseId).put("kind", "BUNDLE").put("bundleId", bundleId)
            .put("rolloutCohortCount", 1000).put("targetCohorts", JSONArray())
            .put("shouldForceUpdate", false).put("message", JSONObject.NULL)
        return JSONObject()
            .put("schemaVersion", 1).put("catalogId", catalogIdentity).put("scopeKey", scope)
            .put("generation", generation).put("catalogHash", hash)
            .put("fallbackPolicy", "BUILTIN_IF_ACTIVE_INELIGIBLE")
            .put("releases", JSONArray().put(descriptor))
            .put("rollbackReleases", JSONArray().put(JSONObject(descriptor.toString())))
    }

    private fun writeTree(
        payload: File,
        bundleId: String,
        marker: String,
        includeDetailPage: Boolean = true,
        background: Boolean = false,
    ): String {
        val root = payload.canonicalFile
        root.mkdirs()
        val pageEntries = JSONArray()
        val pageEssentialResources = JSONArray()
        val files = mutableMapOf(
            "main.lynx.bundle" to "entry-$marker".toByteArray(),
            "assets/probe.png" to byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47),
        )
        if (includeDetailPage) {
            files["detail.lynx.bundle"] = "detail-$marker".toByteArray()
            pageEntries.put("detail.lynx.bundle")
            pageEssentialResources.put(
                JSONObject()
                    .put("entry", "detail.lynx.bundle")
                    .put(
                        "resources",
                        JSONArray().put("detail.lynx.bundle"),
                    ),
            )
        }
        pageEntries.put("main.lynx.bundle")
        pageEssentialResources.put(
            JSONObject()
                .put("entry", "main.lynx.bundle")
                .put(
                    "resources",
                    JSONArray().put("main.lynx.bundle"),
                ),
        )
        if (background) files["task.js"] = "globalThis.marker = '$marker';".toByteArray()
        files["hot-updater-lynx.json"] = JSONObject()
            .apply { if (background) put("backgroundEntry", "task.js") }
            .put("schemaVersion", 1).put("bundleId", bundleId).put("platform", "android")
            .put("entry", "main.lynx.bundle").put("runtimeId", runtime)
            .put("pageEntries", pageEntries)
            .put("pageEssentialResources", pageEssentialResources)
            .toString().toByteArray()
        val assets = JSONObject()
        files.forEach { (name, bytes) ->
            val file = File(root, name)
            file.parentFile.mkdirs()
            file.writeBytes(bytes)
            assets.put(name, JSONObject().put("fileHash", HashUtils.calculateSHA256(file)))
        }
        File(root, "manifest.json").writeText(JSONObject().put("bundleId", bundleId).put("assets", assets).toString())
        return HashUtils.calculateSHA256(File(root, "manifest.json"))
    }

    private fun plantNext(
        root: File,
        releaseId: String,
        bundleId: String,
        marker: String,
        manifestBacked: Boolean = false,
        selectionChannel: String = channel,
        selectionCatalogId: String = catalogId,
        selectionScope: String = scopeKey,
        generation: Long = 2,
        hash: String = catalogHash,
        includeDetailPage: Boolean = true,
        background: Boolean = false,
    ) {
        val home = store(root)
        val install = File(home, "artifacts/installations/$bundleId").canonicalFile
        val payload = File(install, "payload")
        val digest = writeTree(payload, bundleId, marker, includeDetailPage, background)
        val archive = File(install, "archive")
        val fileHash = if (manifestBacked) null else {
            archive.writeText("archive-$marker")
            HashUtils.calculateSHA256(archive)
        }
        val receipt = JSONObject()
            .put("kind", "BUNDLE").put("releaseId", releaseId).put("bundleId", bundleId)
            .put("catalogId", selectionCatalogId).put("scopeKey", selectionScope).put("generation", generation)
            .put("catalogHash", hash).put("channel", selectionChannel)
            .put("selectionContextHash", "v1:0123456789abcdef")
        val file = File(home, "state.json")
        val state = JSONObject(file.readText())
        val artifacts = state.optJSONObject("artifacts") ?: JSONObject()
        artifacts.put(
            bundleId,
            JSONObject().put("bundleId", bundleId).put("fileUrl", "http://127.0.0.1/unused")
                .put("fileHash", fileHash ?: JSONObject.NULL).put("manifestFileHash", digest)
                .put("manifestBacked", manifestBacked)
                .put("verifiedManifestHash", digest),
        )
        state.put("artifacts", artifacts)
        val catalog = catalog(
            releaseId,
            bundleId,
            selectionCatalogId,
            selectionScope,
            generation,
            hash,
        ).toString()
        state.put("catalog", catalog)
        val catalogs = state.optJSONObject("catalogs") ?: JSONObject()
        catalogs.put(
            digestString("$selectionCatalogId\u0000$selectionScope"),
            catalog,
        )
        state.put("catalogs", catalogs)
        state.put("channel", selectionChannel)
        state.put(
            "highWater",
            JSONObject().put("catalogId", selectionCatalogId).put("scopeKey", selectionScope)
                .put("generation", generation).put("catalogHash", hash),
        )
        val waters = state.optJSONObject("highWaters") ?: JSONObject()
        waters.put(
            digestString("$selectionCatalogId\u0000$selectionScope"),
            JSONObject().put("catalogId", selectionCatalogId)
                .put("scopeKey", selectionScope)
                .put("generation", generation)
                .put("catalogHash", hash),
        )
        state.put("highWaters", waters)
        state.put("next", receipt)
        file.writeText(state.toString())
    }

    private fun backgroundHost(root: File, token: String = "10000000-0000-4000-8000-000000000001") =
        LynxRuntimeHost(root, binary(root), embedded(root, background = true), config(),
            processIdentity = { "4321" }, processToken = token)

    private fun seedRecoveryHistory(root: File, count: Int) {
        val file = File(store(root), "state.json")
        val state = JSONObject(file.readText())
        state.put("unconfirmed", JSONArray((0 until count).map {
            "01900000-0000-7000-8000-" + String.format("%012x", 1000 + it)
        }))
        file.writeText(state.toString())
    }

    @Test fun directControllerCannotBypassTasksAndReleasesItsRejectedOwnership() {
        val root = temp()
        var task: LynxBackgroundTask? = null
        try {
            val host = backgroundHost(root)
            host.createForeground().also { it.close() }
            task = host.beginBackground()
            val file = File(store(root), "state.json")
            val before = file.readBytes()
            assertThrows(IllegalStateException::class.java) { controller(root) }
            assertTrue(before.contentEquals(file.readBytes()))
            // A rejected standalone constructor must release the journal file lock.
            host.beginBackground().close()
            task.close()
            controller(root).close()
        } finally {
            task?.close()
            root.deleteRecursively()
        }
    }

    @Test fun concurrentBackgroundTasksKeepIndependentRecoveryReservations() {
        val root = temp()
        val tasks = mutableListOf<LynxBackgroundTask>()
        try {
            val host = backgroundHost(root)
            host.createForeground().also { it.close() }
            seedRecoveryHistory(root, 127)
            plantNext(root, releaseB, bundleB, "B", background = true)
            val first = host.beginBackground().also(tasks::add)
            val second = host.beginBackground().also(tasks::add)
            assertEquals(releaseB, first.snapshot.selection.releaseId)
            assertFalse(first.snapshot.taskId == second.snapshot.taskId)
            val third = host.beginBackground().also(tasks::add)
            val fourth = host.beginBackground().also(tasks::add)
            assertEquals("Too many concurrent Lynx background tasks",
                assertThrows(IllegalStateException::class.java) { host.beginBackground() }.message)
            plantNext(root, releaseC, bundleC, "C", background = true)
            val file = File(store(root), "state.json")
            val before = file.readBytes()
            assertThrows(IllegalStateException::class.java) { host.beginBackground() }
            first.close()
            assertThrows(IllegalStateException::class.java) { host.beginBackground() }
            second.close()
            third.close()
            assertThrows(IllegalStateException::class.java) { host.beginBackground() }
            fourth.close()
            assertEquals(releaseC, host.beginBackground().also(tasks::add).snapshot.selection.releaseId)
            assertTrue(before.contentEquals(file.readBytes()))
        } finally {
            tasks.forEach { it.close() }
            root.deleteRecursively()
        }
    }

    @Test fun persistedFatalStillOccupiesAnEngineSlotUntilNativeDetach() {
        val root = temp()
        val tasks = mutableListOf<LynxBackgroundTask>()
        try {
            val host = backgroundHost(root)
            host.createForeground().also { it.close() }
            plantNext(root, releaseB, bundleB, "B", background = true)
            val failed = host.beginBackground().also(tasks::add)
            repeat(3) { host.beginBackground().also(tasks::add) }
            failed.reportFatal("native fatal before engine teardown")
            assertEquals(listOf(releaseB), jsonStrings(journal(root).getJSONArray("unconfirmed")))
            plantNext(root, releaseC, bundleC, "C", background = true)
            val revision = journal(root).getString("revision")
            assertEquals("Too many concurrent Lynx background tasks",
                assertThrows(IllegalStateException::class.java) { host.beginBackground() }.message)
            failed.reportFatal("duplicate callback before detach")
            assertEquals(revision, journal(root).getString("revision"))
            failed.close()
            assertEquals(releaseC, host.beginBackground().also(tasks::add).snapshot.selection.releaseId)
            assertEquals(revision, journal(root).getString("revision"))
        } finally {
            tasks.forEach { it.close() }
            root.deleteRecursively()
        }
    }

    @Test fun backgroundCountsLiveTrialAndForegroundCountsBackgroundReservations() {
        for (backgroundFirst in listOf(false, true)) {
            val root = temp()
            var foreground: LynxUpdaterController? = null
            var task: LynxBackgroundTask? = null
            try {
                val host = backgroundHost(root)
                host.createForeground().also { initial ->
                    initial.pinPrimary().also { it.firstScreen = true; initial.confirm(it) }
                    initial.close()
                }
                plantNext(root, releaseB, bundleB, "B", background = true)
                host.createForeground().also { previous ->
                    previous.pinPrimary().also { it.firstScreen = true; previous.confirm(it) }
                    previous.close()
                }
                seedRecoveryHistory(root, 127)
                if (backgroundFirst) task = host.beginBackground()
                plantNext(root, releaseC, bundleC, "C", selectionCatalogId = "catalog-C", background = true)
                val current = host.createForeground().also { foreground = it }
                val page = current.pinPrimary()
                assertEquals(if (backgroundFirst) bundleB else bundleC, current.diagnostics(page).bundleId)
                if (!backgroundFirst) {
                    // B is the background fallback while C is a live unconfirmed trial.
                    assertThrows(IllegalStateException::class.java) { host.beginBackground() }
                    page.firstScreen = true
                    current.confirm(page)
                    task = host.beginBackground()
                    assertEquals(releaseC, task!!.snapshot.selection.releaseId)
                }
                assertEquals(127, journal(root).getJSONArray("unconfirmed").length())
            } finally {
                task?.close()
                foreground?.close()
                root.deleteRecursively()
            }
        }
    }

    @Test fun backgroundFatalTargetsItsReceiptAndPreservesAnotherForegroundAttempt() {
        for (cold in listOf(false, true)) {
            val root = temp()
            var foreground: LynxUpdaterController? = null
            var task: LynxBackgroundTask? = null
            try {
                val host = backgroundHost(root)
                host.createForeground().also { it.close() }
                plantNext(root, releaseB, bundleB, "B", background = true)
                val background = host.beginBackground().also { task = it }
                plantNext(root, releaseC, bundleC, "C", selectionCatalogId = "catalog-C", background = true)
                val current = host.createForeground().also { foreground = it }
                val page = current.pinPrimary()
                assertEquals(bundleC, current.diagnostics(page).bundleId)
                val before = journal(root)
                if (cold) current.close()
                assertTrue(background.reportFatal("verified task B fatal"))
                val after = journal(root)
                for (key in listOf("pending", "active", "launchTransition", "logicalStack")) {
                    assertEquals(key, before.opt(key).toString(), after.opt(key).toString())
                }
                assertEquals(listOf(releaseB), jsonStrings(after.getJSONArray("unconfirmed")))
                assertEquals(listOf(bundleB), jsonStrings(after.getJSONArray("crashed")))
                background.close() // The native engine has now detached.
                assertFalse(background.reportFatal("duplicate fatal"))
                if (cold) {
                    val replacement = host.createForeground().also { foreground = it }
                    replacement.pinPrimary()
                    assertTrue(journal(root).getJSONObject("interruptedReleases").has(releaseC))
                } else {
                    page.firstScreen = true
                    current.confirm(page)
                    assertEquals(releaseC, journal(root).getJSONObject("confirmed").getString("releaseId"))
                }
            } finally {
                task?.close()
                foreground?.close()
                root.deleteRecursively()
            }
        }
    }

    @Test fun primaryPinRechecksTaskCapacityAfterWaitingForRetention() {
        val root = temp()
        val executor = Executors.newFixedThreadPool(2)
        val releasePruner = CountDownLatch(1)
        var foreground: LynxUpdaterController? = null
        var taskId: String? = null
        val host = backgroundHost(root)
        try {
            host.createForeground().close()
            plantNext(root, releaseB, bundleB, "B", background = true)
            host.createForeground().also { previous ->
                val page = previous.pinPrimary().also { it.firstScreen = true; previous.confirm(it) }
                val detail = previous.pinSecondary("detail.lynx.bundle", emptyMap(), 1, page.generationId, sourceContextId = page.id)
                detail.firstScreen = true
                previous.admitSecondary(detail)
                previous.close()
            }
            seedRecoveryHistory(root, 127)
            plantNext(root, releaseC, bundleC, "C", selectionCatalogId = "catalog-C", includeDetailPage = false, background = true)
            val background = host.backgroundSnapshot()
            assertEquals(releaseC, background.selection.releaseId)
            val current = host.createForeground().also { foreground = it }
            val file = File(store(root), "state.json")
            val before = file.readBytes()
            val installer = LynxArtifactInstaller(File(store(root), "artifacts"), LynxInstallConfiguration(runtime))
            val pruning = CountDownLatch(1)
            val pruner = executor.submit {
                installer.prune { pruning.countDown(); check(releasePruner.await(20, TimeUnit.SECONDS)) }
            }
            assertTrue(pruning.await(10, TimeUnit.SECONDS))
            val worker = AtomicReference<Thread>()
            val pin = executor.submit<LynxLaunchSession> {
                worker.set(Thread.currentThread())
                current.pinPrimary()
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (System.nanoTime() < deadline && worker.get()?.let {
                    it.state == Thread.State.BLOCKED && it.stackTrace.any { frame ->
                        frame.className == LynxArtifactInstaller::class.java.name && frame.methodName.startsWith("retain$")
                    }
                } != true) Thread.yield()
            assertEquals(Thread.State.BLOCKED, worker.get()?.state)
            assertTrue(worker.get().stackTrace.any { it.methodName.startsWith("retain$") })
            // Publish the native-verified C task while B's final pin is waiting.
            synchronized(host.stateLock) {
                host.reserveBackground(background, journal(root), null)
                taskId = background.taskId
            }
            assertTrue(before.contentEquals(file.readBytes()))
            releasePruner.countDown()
            pruner.get(10, TimeUnit.SECONDS)
            val error = assertThrows(ExecutionException::class.java) { pin.get(10, TimeUnit.SECONDS) }
            assertEquals("Recovery capacity exhausted", error.cause?.message)
            assertTrue(before.contentEquals(file.readBytes()))
            host.finishBackground(background.taskId, null, detached = true)
            assertEquals(bundleB, current.diagnostics(current.pinPrimary()).bundleId)
        } finally {
            releasePruner.countDown()
            executor.shutdown()
            executor.awaitTermination(20, TimeUnit.SECONDS)
            taskId?.let { host.finishBackground(it, null, detached = true) }
            foreground?.close()
            root.deleteRecursively()
        }
    }

    @Test fun metadataAdoptionRechecksTasksAdmittedAfterPreparation() = kotlinx.coroutines.runBlocking {
        val root = temp()
        var foreground: LynxUpdaterController? = null
        var task: LynxBackgroundTask? = null
        try {
            val host = backgroundHost(root)
            host.createForeground().close()
            plantNext(root, releaseB, bundleB, "B", background = true)
            seedRecoveryHistory(root, 127)
            val current = host.createForeground().also { foreground = it }
            val page = current.pinPrimary().also { it.firstScreen = true; current.confirm(it) }
            val updated = catalog(releaseC, bundleB, generation = 3, hash = "sha256:" + "b".repeat(64))
            val old = catalog(releaseB, bundleB)
            for (key in listOf("releases", "rollbackReleases")) updated.getJSONArray(key).put(old.getJSONArray(key).getJSONObject(0))
            val state = current.state(page)
            val guard = current.accept(page, JSONObject().put("catalog", updated)
                .put("expectedRevision", state.getString("revision"))
                .put("targetChannel", channel).put("explicitScopeSwitch", false)
                .put("selectionContextHash", CatalogPolicy.selectionContextHash(nativeSnapshot(state), scopeKey)))
            val selection = CatalogPolicy.Receipt("BUNDLE", releaseC, bundleB,
                guard.getString("catalogId"), guard.getString("scopeKey"), guard.getLong("generation"),
                guard.getString("catalogHash"), guard.getString("channel"), guard.getString("selectionContextHash")).toJson()
            val params = JSONObject().put("guard", guard).put("selection", selection)
            val prepared = current.prepare(page, params)
            val file = File(store(root), "state.json")
            val before = file.readBytes()
            val background = host.beginBackground().also { task = it }
            assertEquals(releaseB, background.snapshot.selection.releaseId)
            assertTrue(before.contentEquals(file.readBytes()))
            val error = runCatching { current.stage(page, prepared.getString("preparedId")) }.exceptionOrNull()
            assertEquals("Recovery capacity exhausted", error?.message)
            assertTrue(before.contentEquals(file.readBytes()))
            background.close()
            val retried = current.prepare(page, params)
            assertEquals("ADOPTED", current.stage(page, retried.getString("preparedId" )).getString("status"))
            assertEquals(releaseC, current.state(page).getJSONObject("runningSelection").getString("releaseId"))
        } finally {
            task?.close()
            foreground?.close()
            root.deleteRecursively()
        }
    }

    @Test fun failedBackgroundFatalWriteSurvivesCompletionAndGatesAnUnpinnedController() {
        val root = temp()
        var foreground: LynxUpdaterController? = null
        var task: LynxBackgroundTask? = null
        try {
            val host = backgroundHost(root)
            host.createForeground().also { it.close() }
            plantNext(root, releaseB, bundleB, "B", background = true)
            val background = host.beginBackground().also { task = it }
            val current = host.createForeground().also { foreground = it }
            val file = File(store(root), "state.json")
            val saved = File(root, "saved-state.json")
            val before = file.readBytes()
            assertTrue(file.renameTo(saved))
            assertTrue(file.mkdir())
            try {
                assertThrows(Throwable::class.java) { background.reportFatal("native fatal") }
                assertThrows(Throwable::class.java) { background.close() }
                assertThrows(Throwable::class.java) { current.pinPrimary() }
                assertTrue(before.contentEquals(saved.readBytes()))
            } finally {
                assertTrue(file.deleteRecursively())
                assertTrue(saved.renameTo(file))
            }
            val page = current.pinPrimary()
            assertEquals(embeddedId, current.diagnostics(page).bundleId)
            assertEquals(listOf(releaseB), jsonStrings(journal(root).getJSONArray("unconfirmed")))
            assertFalse(background.reportFatal("already recorded"))
        } finally {
            task?.close()
            foreground?.close()
            root.deleteRecursively()
        }
    }

    @Test fun failedTaskWriteRevokesOnlyTheMatchingLiveGeneration() {
        for (sameBundle in listOf(false, true)) {
            val root = temp()
            var foreground: LynxUpdaterController? = null
            var task: LynxBackgroundTask? = null
            try {
                val host = backgroundHost(root)
                host.createForeground().also { it.close() }
                plantNext(root, releaseB, bundleB, "B", background = true)
                val background = host.beginBackground().also { task = it }
                if (!sameBundle) plantNext(root, releaseC, bundleC, "C", selectionCatalogId = "catalog-C", background = true)
                val current = host.createForeground().also { foreground = it }
                val page = current.pinPrimary().also { it.firstScreen = true; current.confirm(it) }
                val file = File(store(root), "state.json")
                val saved = File(root, "saved-state.json")
                assertTrue(file.renameTo(saved))
                assertTrue(file.mkdir())
                try {
                    assertThrows(Throwable::class.java) { background.reportFatal("native fatal with unavailable storage") }
                    assertEquals(sameBundle, current.generationFailed)
                    if (sameBundle) {
                        assertThrows(CatalogPolicy.Rejected::class.java) { current.confirm(page) }
                    } else {
                        assertEquals(bundleC, current.state(page).getJSONObject("runningSelection").getString("bundleId"))
                        assertEquals("ALREADY_CONFIRMED", current.confirm(page).getString("status"))
                    }
                } finally {
                    assertTrue(file.deleteRecursively())
                    assertTrue(saved.renameTo(file))
                }
                background.close()
                assertEquals(listOf(releaseB), jsonStrings(journal(root).getJSONArray("unconfirmed")))
            } finally {
                task?.close()
                foreground?.close()
                root.deleteRecursively()
            }
        }
    }

    @Test fun replacementControllerDoesNotHoldStateWhileWaitingForInstaller() {
        val root = temp()
        val executor = Executors.newFixedThreadPool(3)
        val releasePruner = CountDownLatch(1)
        val replacement = AtomicReference<LynxUpdaterController>()
        try {
            val host = backgroundHost(root)
            host.createForeground().close()
            val installer = LynxArtifactInstaller(File(store(root), "artifacts"), LynxInstallConfiguration(runtime))
            val pruning = CountDownLatch(1)
            val pruner = executor.submit {
                installer.prune {
                    pruning.countDown()
                    check(releasePruner.await(20, TimeUnit.SECONDS))
                }
            }
            assertTrue(pruning.await(10, TimeUnit.SECONDS))
            val worker = AtomicReference<Thread>()
            val creator = executor.submit {
                worker.set(Thread.currentThread())
                host.createForeground().also(replacement::set)
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (System.nanoTime() < deadline && worker.get()?.let {
                    it.state == Thread.State.BLOCKED && it.stackTrace.any { frame ->
                        frame.className == LynxArtifactInstaller::class.java.name
                    }
                } != true) Thread.yield()
            assertEquals(Thread.State.BLOCKED, worker.get()?.state)
            assertTrue(worker.get().stackTrace.any { it.className == LynxArtifactInstaller::class.java.name })
            // Old-generation pruning needs this same state lock before releasing installer.
            executor.submit<Boolean> { synchronized(host.stateLock) { true } }.get(5, TimeUnit.SECONDS)
            releasePruner.countDown()
            pruner.get(10, TimeUnit.SECONDS)
            creator.get(10, TimeUnit.SECONDS)
        } finally {
            releasePruner.countDown()
            executor.shutdown()
            executor.awaitTermination(20, TimeUnit.SECONDS)
            replacement.get()?.close()
            root.deleteRecursively()
        }
    }

    private fun plantEmbeddedNext(root: File, releaseId: String = releaseB) {
        plantNext(root, releaseId, embeddedId, "A", background = true)
        val state = journal(root)
        state.getJSONObject("next").put("kind", "EMBEDDED")
        val catalog = JSONObject(state.getString("catalog"))
        for (key in listOf("releases", "rollbackReleases")) {
            catalog.getJSONArray(key).getJSONObject(0)
                .put("kind", "EMBEDDED").put("bundleId", JSONObject.NULL)
        }
        state.put("catalog", catalog.toString())
        state.getJSONObject("catalogs").put(digestString("$catalogId\u0000$scopeKey"), catalog.toString())
        File(store(root), "state.json").writeText(state.toString())
    }

    @Test fun pendingEmbeddedPageCannotReplaceAnExistingFailedBuiltin() {
        val root = temp()
        var foreground: LynxUpdaterController? = null
        var task: LynxBackgroundTask? = null
        try {
            val host = backgroundHost(root)
            host.createForeground().also { initial ->
                initial.pinPrimary().also { it.firstScreen = true; initial.confirm(it) }
                initial.close()
            }
            val background = host.beginBackground().also { task = it }
            plantEmbeddedNext(root)
            val current = host.createForeground().also { foreground = it }
            val page = current.pinPrimary().also { it.firstScreen = true; current.confirm(it) }
            current.pinSecondary("detail.lynx.bundle", emptyMap(), 1, page.generationId, sourceContextId = page.id)
            assertTrue(background.reportFatal("verified builtin task fatal"))
            current.close()
            val file = File(store(root), "state.json")
            val before = file.readBytes()
            assertThrows(IllegalStateException::class.java) { host.backgroundSnapshot() }
            assertTrue(before.contentEquals(file.readBytes()))
            val recovered = host.createForeground().also { foreground = it }
            assertEquals(JSONObject.NULL, journal(root).getJSONObject("failedEmbedded").get("releaseId"))
            assertThrows(IllegalStateException::class.java) { recovered.pinPrimary() }
        } finally {
            task?.close()
            foreground?.close()
            root.deleteRecursively()
        }
    }

    @Test fun overlappingEmbeddedFailuresNeverResurrectAFailedBuiltin() {
        for (builtinFirst in listOf(false, true)) {
            val root = temp()
            val tasks = mutableListOf<LynxBackgroundTask>()
            try {
                val host = backgroundHost(root)
                host.createForeground().close()
                val builtin = host.beginBackground().also(tasks::add)
                plantEmbeddedNext(root)
                val release = host.beginBackground().also(tasks::add)
                assertEquals("EMBEDDED", release.snapshot.selection.kind)
                assertEquals(releaseB, release.snapshot.selection.releaseId)
                val ordered = if (builtinFirst) listOf(builtin, release) else listOf(release, builtin)
                ordered.forEach { assertTrue(it.reportFatal("native embedded failure")) }
                assertEquals(JSONObject.NULL, journal(root).getJSONObject("failedEmbedded").get("releaseId"))
                assertEquals(listOf(releaseB), jsonStrings(journal(root).getJSONArray("unconfirmed")))
                assertThrows(IllegalStateException::class.java) { host.beginBackground() }
            } finally {
                tasks.forEach { it.close() }
                root.deleteRecursively()
            }
        }
    }

    @Test fun taskFatalForTheLiveBundleRevokesForegroundReadiness() {
        val root = temp()
        var foreground: LynxUpdaterController? = null
        var task: LynxBackgroundTask? = null
        try {
            val host = backgroundHost(root)
            host.createForeground().also { it.close() }
            plantNext(root, releaseB, bundleB, "B", background = true)
            val background = host.beginBackground().also { task = it }
            val current = host.createForeground().also { foreground = it }
            val page = current.pinPrimary()
            val pending = journal(root).getJSONObject("pending").toString()
            assertTrue(background.reportFatal("same bundle runtime fatal"))
            page.firstScreen = true
            assertThrows(CatalogPolicy.Rejected::class.java) { current.confirm(page) }
            assertEquals(pending, journal(root).getJSONObject("pending").toString())
            assertTrue(current.generationFailed)
        } finally {
            task?.close()
            foreground?.close()
            root.deleteRecursively()
        }
    }

    @Test fun directlyClosingForegroundAllowsBackgroundAndNextGeneration() {
        val root = temp()
        try {
            val host = backgroundHost(root)
            val first = host.createForeground()
            first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
            first.close()
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            val replacement = host.createForeground()
            // A repeated close on a retired generation must not close its replacement.
            first.close()
            val page = replacement.pinPrimary()
            assertEquals(embeddedId, replacement.diagnostics(page).bundleId)
            replacement.close()
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
        } finally { root.deleteRecursively() }
    }

    @Test fun liveEmbeddedFatalRejectsBackgroundEvenWhenPersistenceFails() {
        for (failWrite in listOf(false, true)) {
            val root = temp()
            try {
                val host = backgroundHost(root)
                val foreground = host.createForeground()
                val page = foreground.pinPrimary().also { it.firstScreen = true; foreground.confirm(it) }
                val file = File(store(root), "state.json")
                if (failWrite) {
                    val saved = File(root, "saved-state.json")
                    assertTrue(file.renameTo(saved))
                    assertTrue(file.mkdir())
                    try {
                        assertThrows(Throwable::class.java) {
                            foreground.fail(page, "verified fatal", allowConfirmed = true)
                        }
                    } finally {
                        assertTrue(file.deleteRecursively())
                        assertTrue(saved.renameTo(file))
                    }
                    assertFalse(journal(root).has("generationFailure"))
                } else {
                    assertTrue(foreground.fail(page, "verified fatal", allowConfirmed = true))
                    assertTrue(journal(root).has("generationFailure"))
                }
                val before = file.readBytes()
                assertThrows(CatalogPolicy.Rejected::class.java) { host.backgroundSnapshot() }
                assertTrue(before.contentEquals(file.readBytes()))
                foreground.close()
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun backgroundRechecksUnpersistedFatalAfterWaitingForArtifactRetention() {
        val root = temp()
        val executor = Executors.newFixedThreadPool(2)
        val releasePruner = CountDownLatch(1)
        var foreground: LynxUpdaterController? = null
        try {
            val host = backgroundHost(root)
            host.createForeground().also { first ->
                first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
                first.close()
            }
            plantNext(root, releaseB, bundleB, "B", background = true)
            val controller = host.createForeground().also { foreground = it }
            val page = controller.pinPrimary().also { it.firstScreen = true; controller.confirm(it) }
            val pruner = LynxArtifactInstaller(File(store(root), "artifacts"), LynxInstallConfiguration(runtime))
            val pruning = CountDownLatch(1)
            val pruningTask = executor.submit {
                pruner.prune {
                    pruning.countDown()
                    check(releasePruner.await(10, TimeUnit.SECONDS))
                }
            }
            assertTrue(pruning.await(10, TimeUnit.SECONDS))
            val worker = AtomicReference<Thread>()
            val snapshot = executor.submit<LynxBackgroundSnapshot> {
                worker.set(Thread.currentThread())
                host.backgroundSnapshot()
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (System.nanoTime() < deadline && worker.get()?.let {
                    it.state == Thread.State.BLOCKED && it.stackTrace.any { frame ->
                        frame.className == LynxArtifactInstaller::class.java.name && frame.methodName.startsWith("retain$")
                    }
                } != true) Thread.yield()
            assertEquals(Thread.State.BLOCKED, worker.get()?.state)
            assertTrue(worker.get().stackTrace.any { it.methodName.startsWith("retain$") })

            val file = File(store(root), "state.json")
            val before = file.readBytes()
            val saved = File(root, "saved-state.json")
            assertTrue(file.renameTo(saved))
            assertTrue(file.mkdir())
            try {
                assertThrows(Throwable::class.java) {
                    controller.fail(page, "fatal while retaining", allowConfirmed = true)
                }
            } finally {
                assertTrue(file.deleteRecursively())
                assertTrue(saved.renameTo(file))
            }
            assertTrue(before.contentEquals(file.readBytes()))
            releasePruner.countDown()
            pruningTask.get(10, TimeUnit.SECONDS)
            val failure = assertThrows(ExecutionException::class.java) { snapshot.get(10, TimeUnit.SECONDS) }
            assertTrue(failure.cause is CatalogPolicy.Rejected)
            assertTrue(before.contentEquals(file.readBytes()))
        } finally {
            releasePruner.countDown()
            executor.shutdownNow()
            executor.awaitTermination(10, TimeUnit.SECONDS)
            foreground?.close()
            root.deleteRecursively()
        }
    }

    @Test fun coldBackgroundCopiesStagedCodeWithoutConsumingForegroundState() {
        val root = temp()
        try {
            val host = backgroundHost(root)
            val first = host.createForeground()
            first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
            host.closeForeground(first)
            plantNext(root, releaseB, bundleB, "B", background = true)
            val file = File(store(root), "state.json")
            val before = file.readBytes()

            val task = host.backgroundSnapshot()
            assertEquals(bundleB, task.selection.bundleId)
            assertEquals(releaseB, task.selection.releaseId)
            assertEquals("globalThis.marker = 'B';", task.source)
            assertTrue(before.contentEquals(file.readBytes()))
            assertFalse(journal(root).has("pending"))

            val foreground = host.createForeground()
            val page = foreground.pinPrimary()
            assertEquals(bundleB, foreground.state(page).getJSONObject("runningSelection").getString("bundleId"))
            assertEquals("UPDATE_APPLIED", journal(root).getJSONObject("launchTransition").getString("kind"))
            page.firstScreen = true
            foreground.confirm(page)
            assertFalse(journal(root).has("pending"))
            host.closeForeground(foreground)
        } finally { root.deleteRecursively() }
    }

    @Test fun backgroundLeavesLivePendingAndColdInterruptionUntouched() {
        val root = temp()
        try {
            val host = backgroundHost(root)
            val first = host.createForeground()
            first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
            host.closeForeground(first)
            plantNext(root, releaseB, bundleB, "B", background = true)
            val trial = host.createForeground()
            trial.pinPrimary()
            val file = File(store(root), "state.json")
            val pending = file.readBytes()
            // A live foreground trial is neither another background candidate nor an interruption.
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            assertTrue(pending.contentEquals(file.readBytes()))
            host.closeForeground(trial)
            // Cold snapshot projects the abandoned trial without persisting recovery or retry holds.
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            assertTrue(pending.contentEquals(file.readBytes()))
            assertFalse(journal(root).has("interruptedReleases"))
            val fallback = host.createForeground()
            val page = fallback.pinPrimary()
            assertEquals(embeddedId, fallback.state(page).getJSONObject("runningSelection").getString("bundleId"))
            assertTrue(journal(root).getJSONObject("interruptedReleases").has(releaseB))
            host.closeForeground(fallback)
        } finally { root.deleteRecursively() }
    }

    @Test fun backgroundRespectsRetryHoldsAndDoesNotArmThem() {
        val root = temp()
        try {
            val host = backgroundHost(root)
            val initial = host.createForeground()
            initial.pinPrimary().also { it.firstScreen = true; initial.confirm(it) }
            host.closeForeground(initial)
            plantNext(root, releaseB, bundleB, "B", background = true)
            val file = File(store(root), "state.json")
            val state = JSONObject(file.readText()).put("interruptedReleases", JSONObject()
                .put(releaseB, JSONObject().put("bundleId", bundleB).put("retryReady", false)
                    .put("holdProcessToken", "10000000-0000-4000-8000-000000000001")))
            file.writeText(state.toString())
            var before = file.readBytes()
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            assertTrue(before.contentEquals(file.readBytes()))
            state.getJSONObject("interruptedReleases").getJSONObject(releaseB).put("retryReady", true)
            file.writeText(state.toString())
            before = file.readBytes()
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            val later = backgroundHost(root, "10000000-0000-4000-8000-000000000002")
            assertEquals(bundleB, later.backgroundSnapshot().selection.bundleId)
            assertTrue(before.contentEquals(file.readBytes()))
        } finally { root.deleteRecursively() }
    }

    @Test fun rejectedColdJournalReleasesOwnershipAndNeverInitializesMissingState() {
        val root = temp()
        try {
            val host = backgroundHost(root)
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            val file = File(store(root), "state.json")
            assertFalse(file.exists())
            file.writeText("invalid json")
            assertThrows(Exception::class.java) { host.backgroundSnapshot() }
            assertEquals("invalid json", file.readText())
            assertTrue(file.delete())
            assertEquals(embeddedId, host.backgroundSnapshot().selection.bundleId)
            assertFalse(file.exists())
            val first = host.createForeground()
            host.closeForeground(first)
        } finally { root.deleteRecursively() }
    }

    @Test fun detachedScriptSurvivesFilePruningAndMissingEntryDoesNotRunAnotherRelease() {
        val root = temp()
        try {
            val host = backgroundHost(root)
            val first = host.createForeground()
            first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
            host.closeForeground(first)
            plantNext(root, releaseB, bundleB, "B", background = true)
            val task = host.backgroundSnapshot()
            File(store(root), "artifacts/installations/$bundleB").deleteRecursively()
            assertEquals("globalThis.marker = 'B';", task.source)
            plantNext(root, releaseC, bundleC, "C", background = false)
            val file = File(store(root), "state.json")
            val before = file.readBytes()
            assertThrows(IllegalStateException::class.java) { host.backgroundSnapshot() }
            assertTrue(before.contentEquals(file.readBytes()))
        } finally { root.deleteRecursively() }
    }

    @Test fun manifestBackedInstallationStartsLaterWithoutAnArchiveFile() {
        val root = temp()
        try {
            val first = controller(root)
            first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
            first.close()
            plantNext(root, releaseB, bundleB, "B", manifestBacked = true)

            val nextGeneration = controller(root)
            val primary = nextGeneration.pinPrimary()
            assertEquals(
                bundleB,
                nextGeneration.state(primary).getJSONObject("runningSelection")
                    .getString("bundleId"),
            )
            assertFalse(File(store(root), "artifacts/installations/$bundleB/archive").exists())
            nextGeneration.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun builtinPrimaryConfirmsAndSecondaryMustWait() {
        val root = temp()
        try {
            val controller = controller(root)
            try {
                controller.pinSecondary()
                fail("Secondary started before primary")
            } catch (_: IllegalStateException) {}
            val primary = controller.pinPrimary()
            val primaryDiagnostics = controller.diagnostics(primary)
            assertEquals(primaryDiagnostics.contextId, primaryDiagnostics.startupAttemptId)
            assertEquals(embeddedId, primaryDiagnostics.bundleId)
            assertEquals(null, primaryDiagnostics.releaseId)
            primary.firstScreen = true
            assertEquals("CONFIRMED", controller.confirm(primary).getString("status"))
            val secondary = controller.pinSecondary(
                pageEntry = "detail.lynx.bundle",
                parameters = mapOf("title" to "Second Page"),
                stackPosition = 1,
                generationId = primaryDiagnostics.generationId,
            )
            assertFalse(secondary.isPrimary)
            val secondaryDiagnostics = controller.diagnostics(secondary)
            assertFalse(secondaryDiagnostics.contextId == primaryDiagnostics.contextId)
            assertEquals(primaryDiagnostics.startupAttemptId, secondaryDiagnostics.startupAttemptId)
            assertEquals(embeddedId, secondaryDiagnostics.bundleId)
            assertEquals(null, secondaryDiagnostics.releaseId)
            assertEquals("detail.lynx.bundle", secondaryDiagnostics.pageEntry)
            assertEquals(primaryDiagnostics.generationId, secondaryDiagnostics.generationId)
            val state = controller.state(primary)
            assertEquals(true, state.getBoolean("runningConfirmed"))
            assertEquals(embeddedId, state.getJSONObject("runningSelection").getString("bundleId"))
            controller.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun runtimeEventQueryIsBoundToTheLiveNativeContext() {
        val root = temp()
        try {
            LynxGenerationEventJournal(root).append(
                "generationWillEvaluate",
                mapOf(
                    "runtimeId" to runtime,
                    "processId" to "4321",
                    "generationId" to "generation-a",
                    "bundleId" to embeddedId,
                    "releaseId" to null,
                    "contextId" to null,
                    "pageAttemptId" to null,
                    "transitionId" to null,
                ),
            )
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")

            val snapshot = controller.runtimeEvents(primary)

            assertEquals(
                "generationWillEvaluate",
                snapshot.getJSONArray("events").getJSONObject(0)
                    .getString("name"),
            )
            primary.close()
            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.runtimeEvents(primary)
            }
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun synchronousBridgeReadsLiveStateWithoutConfirmingAndRejectsRetiredContexts() {
        val root = temp()
        val context = android.content.ContextWrapper(null)
        try {
            withController(root) { controller ->
                val module = HotUpdaterLynxModule(context)
                assertEquals("NO_CONTEXT", module.getStateSync().getMap("error").getString("code"))
                val primary = controller.pinPrimary()
                HotUpdaterLynxModule.bind(context, primary)
                try {
                    val initial = module.getStateSync()
                    assertTrue(initial.getBoolean("ok"))
                    assertFalse(initial.getMap("data").getBoolean("runningConfirmed"))
                    assertEquals("1", initial.getMap("data").getString("cohort"))
                    controller.setCohort("qa")
                    assertEquals("qa", module.getStateSync().getMap("data").getString("cohort"))
                    primary.close()
                    assertEquals("STALE_CONTEXT", module.getStateSync().getMap("error").getString("code"))
                } finally {
                    HotUpdaterLynxModule.unbind(context)
                }
                assertEquals("NO_CONTEXT", module.getStateSync().getMap("error").getString("code"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun coldUpdatePersistsAndAtomicallyConsumesLaunchTransitionId() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { update ->
                val primary = update.pinPrimary().also { it.firstScreen = true }
                val transitionId = journal(root).getJSONObject("launchTransition")
                    .getString("transitionId")
                assertTrue(transitionId.isNotEmpty())
                val confirmation = update.confirm(primary)
                assertEquals("UPDATE_APPLIED", confirmation.getJSONObject("transition").getString("kind"))
                assertEquals(transitionId, confirmation.getString("transitionId"))
                val consumed = journal(root)
                assertFalse(consumed.has("pending"))
                assertFalse(consumed.has("launchTransition"))
                assertFalse(consumed.has("managedTransition"))
                val repeated = update.confirm(primary)
                assertEquals(JSONObject.NULL, repeated.opt("transition"))
                assertEquals(JSONObject.NULL, repeated.opt("transitionId"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun recoveryPreservesTheUnconsumedLaunchTransitionId() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            val trial = controller(root)
            trial.pinPrimary()
            val transitionId = journal(root).getJSONObject("launchTransition")
                .getString("transitionId")
            trial.close()
            val recoveredBeforePin = controller(root)
            assertEquals(
                transitionId,
                journal(root).getJSONObject("launchTransition")
                    .getString("transitionId"),
            )
            assertEquals(
                "RECOVERED",
                journal(root).getJSONObject("launchTransition")
                    .getString("kind"),
            )
            recoveredBeforePin.close()
            withController(root) { recovered ->
                val primary = recovered.pinPrimary().also { it.firstScreen = true }
                assertEquals(
                    transitionId,
                    journal(root).getJSONObject("launchTransition")
                        .getString("transitionId"),
                )
                val confirmation = recovered.confirm(primary)
                assertEquals("RECOVERED", confirmation.getJSONObject("transition").getString("kind"))
                assertEquals(transitionId, confirmation.getString("transitionId"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun recoveryPreservesTheUnconsumedLaunchTransitionWithRevokedConfirmedRelease() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { stable ->
                stable.pinPrimary().also { it.firstScreen = true; stable.confirm(it) }
            }
            // C's catalog revokes confirmed B; recovery must choose embedded A.
            plantNext(root, releaseC, bundleC, "C")
            val trial = controller(root)
            trial.pinPrimary()
            val transitionId = journal(root).getJSONObject("launchTransition")
                .getString("transitionId")
            trial.close()
            val recoveredBeforePin = controller(root)
            assertEquals(
                transitionId,
                journal(root).getJSONObject("launchTransition")
                    .getString("transitionId"),
            )
            assertEquals(
                "RECOVERED",
                journal(root).getJSONObject("launchTransition")
                    .getString("kind"),
            )
            recoveredBeforePin.close()
            withController(root) { recovered ->
                val primary = recovered.pinPrimary().also { it.firstScreen = true }
                assertEquals(
                    transitionId,
                    journal(root).getJSONObject("launchTransition")
                        .getString("transitionId"),
                )
                val confirmation = recovered.confirm(primary)
                assertEquals("RECOVERED", confirmation.getJSONObject("transition").getString("kind"))
                assertEquals(transitionId, confirmation.getString("transitionId"))
                val transition = confirmation.getJSONObject("transition")
                assertEquals(releaseC, transition.getJSONObject("from").getString("releaseId"))
                assertEquals(bundleC, transition.getJSONObject("from").getString("bundleId"))
                assertEquals("BUILTIN", transition.getJSONObject("to").getString("kind"))
                assertEquals(embeddedId, transition.getJSONObject("to").getString("bundleId"))
                assertEquals(JSONObject.NULL, recovered.confirm(primary).opt("transition"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun legacyLaunchTransitionIsBackfilledAndInvalidIdsFailClosed() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            val trial = controller(root)
            trial.pinPrimary()
            val stateFile = File(store(root), "state.json")
            val legacy = journal(root)
            legacy.getJSONObject("launchTransition").remove("transitionId")
            legacy.remove("pending")
            stateFile.writeText(legacy.toString())
            trial.close()

            val upgraded = controller(root)
            val backfilled = journal(root).getJSONObject("launchTransition")
                .getString("transitionId")
            assertTrue(backfilled.isNotEmpty())
            upgraded.close()

            val base = journal(root)
            stateFile.writeText(
                JSONObject(base.toString()).apply {
                    getJSONObject("launchTransition")
                        .put("transitionId", "not-a-uuid")
                }.toString(),
            )
            assertThrows(IllegalStateException::class.java) { controller(root) }

            fun managedTransition(id: String) = JSONObject()
                .put("transitionId", id)
                .put("trigger", "reload")
                .put("sourceGenerationId", "generation-old")
                .put("source", base.getJSONObject("confirmed"))
                .put("target", base.getJSONObject("confirmed"))
                .put(
                    "stack",
                    JSONArray().put(
                        JSONObject().put("entry", "main.lynx.bundle")
                            .put("parameters", JSONArray()),
                    ),
                )

            stateFile.writeText(
                JSONObject(base.toString()).apply {
                    remove("launchTransition")
                    put("managedTransition", managedTransition("not-a-uuid"))
                }.toString(),
            )
            assertThrows(IllegalStateException::class.java) { controller(root) }

            stateFile.writeText(
                JSONObject(base.toString()).apply {
                    getJSONObject("launchTransition")
                        .put("transitionId", "not-a-uuid")
                    put("managedTransition", managedTransition("not-a-uuid"))
                }.toString(),
            )
            assertThrows(IllegalStateException::class.java) { controller(root) }

        } finally {
            root.deleteRecursively()
        }

        val mismatchRoot = temp()
        try {
            withController(mismatchRoot) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(mismatchRoot, releaseB, bundleB, "B")
            val trial = controller(mismatchRoot)
            trial.pinPrimary()
            val stateFile = File(store(mismatchRoot), "state.json")
            val mismatched = journal(mismatchRoot)
            mismatched.getJSONObject("launchTransition")
                .put(
                    "transitionId",
                    "11111111-1111-4111-8111-111111111111",
                )
            mismatched.put(
                "managedTransition",
                JSONObject().put(
                    "transitionId",
                    "22222222-2222-4222-8222-222222222222",
                ),
            )
            stateFile.writeText(mismatched.toString())
            trial.close()
            assertThrows(IllegalStateException::class.java) {
                controller(mismatchRoot)
            }
        } finally {
            mismatchRoot.deleteRecursively()
        }
    }

    @Test fun managedReloadAndLaunchTransitionShareIdentity() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            val stateFile = File(store(root), "state.json")
            val state = journal(root)
            val transitionId = java.util.UUID.randomUUID().toString()
            state.put(
                "managedTransition",
                JSONObject()
                    .put("transitionId", transitionId)
                    .put("trigger", "reload")
                    .put("sourceGenerationId", "generation-old")
                    .put("source", state.getJSONObject("confirmed"))
                    .put("target", state.getJSONObject("next"))
                    .put(
                        "stack",
                        JSONArray().put(
                            JSONObject().put("entry", "main.lynx.bundle")
                                .put("parameters", JSONArray()),
                        ),
                    ),
            )
            stateFile.writeText(state.toString())
            withController(root) { update ->
                val primary = update.pinPrimary(
                    generationId = "generation-new",
                ).also { it.firstScreen = true }
                assertEquals(
                    transitionId,
                    journal(root).getJSONObject("launchTransition")
                        .getString("transitionId"),
                )
                val confirmation = update.confirm(primary)
                assertEquals(transitionId, confirmation.getString("transitionId"))
                assertEquals("UPDATE_APPLIED", confirmation.getJSONObject("transition").getString("kind"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun secondaryAdmissionIsDurableAndBlocksPrimaryConfirmation() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            val detail = controller.pinSecondary(
                pageEntry = "detail.lynx.bundle",
                parameters = mapOf("title" to "Second Page", "value" to "a+b"),
                stackPosition = 1,
                generationId = "generation-a",
            )

            val pending = journal(root).getJSONObject("pageAttempt")
            assertEquals(detail.id, pending.getString("attemptId"))
            assertEquals(primary.id, pending.getString("sourceContextId"))
            assertEquals(primary.id, detail.openingSourceContextId)
            assertEquals("generation-a", pending.getString("generationId"))
            assertTrue(pending.get("processId") is String)
            assertTrue(
                pending.getString("processId").matches(Regex("^[1-9][0-9]*$")),
            )
            assertEquals("detail.lynx.bundle", pending.getString("entry"))
            assertEquals("Second Page", pending.getJSONObject("parameters").getString("title"))
            assertThrows(IllegalStateException::class.java) {
                controller.confirm(primary)
            }

            detail.firstScreen = true
            val confirmations = mutableListOf<JSONObject>()
            detail.notifyReady { confirmations += it.getOrThrow() }
            detail.notifyReady { confirmations += it.getOrThrow() }
            assertEquals(2, confirmations.size)
            confirmations.forEach { confirmation ->
                assertEquals("PAGE_ADMITTED", confirmation.getString("status"))
                assertEquals(detail.id, confirmation.getString("pageAttemptId"))
            }
            assertEquals(
                "admitted",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("terminal"),
            )
            assertFalse(controller.fail(detail, "late fatal after admission"))
            assertFalse(journal(root).has("generationFailure"))
            assertEquals("CONFIRMED", controller.confirm(primary).getString("status"))
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun acceptedTransitionTerminatesAPendingPageAttemptExactlyOnce() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)
            val detail = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("title" to "Pending"),
                1,
                "generation-a",
            )

            controller.acceptManagedTransition(
                primary,
                "generation-a",
                controller.retainedLogicalStack(primary),
                "reload",
            )

            val state = journal(root)
            assertFalse(state.has("pageAttempt"))
            val terminal = state.getJSONObject("lastPageAttempt")
            assertEquals(detail.id, terminal.getString("attemptId"))
            assertEquals("authorized-cancel", terminal.getString("terminal"))
            assertEquals("managedTransition", terminal.getString("reason"))
            assertEquals(
                state.getJSONObject("managedTransition")
                    .getString("transitionId"),
                terminal.getString("transitionId"),
            )
            assertFalse(controller.fail(detail, "late callback"))
            assertEquals(
                detail.id,
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("attemptId"),
            )
            controller.close()
            controller(root).close()
            val replayed = LynxGenerationEventJournal(root).snapshot()
                .getJSONArray("events").objects()
                .single { it.getString("name") == "pageAttemptTerminal" }
                .getJSONObject("details")
            assertEquals("authorized-cancel", replayed.getString("terminal"))
            assertEquals("managedTransition", replayed.getString("reason"))
            assertEquals(
                terminal.getString("transitionId"),
                replayed.getString("transitionId"),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun prelaunchRollbackRemovesTheAttemptWithoutInventingAUserCancel() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)
            val detail = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "throwing-launch-observer"),
                1,
                "generation-a",
                sourceContextId = primary.id,
            )

            assertTrue(controller.rollbackSecondary(detail))
            val state = journal(root)
            assertFalse(state.has("pageAttempt"))
            assertFalse(state.has("lastPageAttempt"))
            assertEquals(
                listOf("main.lynx.bundle"),
                controller.retainedLogicalStack(primary)
                    .map(LynxLogicalPage::entry),
            )
            assertFalse(controller.fail(detail, "late observer callback"))
            detail.close()
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun onlyTheExactLiveTopPageCanPopAndPendingCancelIsNotFatal() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)
            val first = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("position" to "first"),
                1,
                "generation-a",
            ).also {
                it.firstScreen = true
                controller.admitSecondary(it)
            }
            val top = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("position" to "top"),
                2,
                "generation-a",
                sourceContextId = first.id,
            )
            assertEquals(first.id, top.openingSourceContextId)
            assertEquals(
                first.id,
                journal(root).getJSONObject("pageAttempt")
                    .getString("sourceContextId"),
            )

            assertThrows(IllegalStateException::class.java) {
                controller.cancelSecondary(first, LynxPageCancelReason.NATIVE_BACK)
            }
            assertTrue(controller.cancelSecondary(top, LynxPageCancelReason.SPARKLING_CLOSE))
            assertEquals(
                "authorized-cancel",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("terminal"),
            )
            assertEquals(
                "sparklingClose",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("reason"),
            )
            assertEquals(0, journal(root).optJSONArray("crashed")?.length() ?: 0)
            assertEquals(0, journal(root).optJSONArray("unconfirmed")?.length() ?: 0)
            assertFalse(controller.fail(top, "late fatal callback"))
            assertTrue(controller.cancelSecondary(first, LynxPageCancelReason.NATIVE_BACK))
            val pendingBack = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("position" to "back"),
                1,
                "generation-a",
            )
            assertTrue(
                controller.cancelSecondary(
                    pendingBack,
                    LynxPageCancelReason.NATIVE_BACK,
                ),
            )
            assertEquals(
                "nativeBack",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("reason"),
            )
            assertEquals(
                listOf("main.lynx.bundle"),
                controller.retainedLogicalStack(primary).map(LynxLogicalPage::entry),
            )
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun pendingPageCancelFlushesTheBlockedPrimaryConfirmation() {
        listOf(
            LynxPageCancelReason.NATIVE_BACK,
            LynxPageCancelReason.SPARKLING_CLOSE,
        ).forEach { reason ->
            val root = temp()
            try {
                val controller = controller(root)
                val primary = controller.pinPrimary(generationId = "generation-a")
                primary.firstScreen = true
                val detail = controller.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("reason" to reason.wireValue),
                    1,
                    "generation-a",
                    sourceContextId = primary.id,
                )
                val confirmations = mutableListOf<Result<JSONObject>>()
                primary.notifyReady { confirmations += it }
                assertTrue(confirmations.isEmpty())

                assertTrue(controller.cancelSecondary(detail, reason))
                assertEquals(1, confirmations.size)
                assertEquals(
                    "CONFIRMED",
                    confirmations.single().getOrThrow().getString("status"),
                )
                assertEquals(
                    reason.wireValue,
                    journal(root).getJSONObject("lastPageAttempt")
                        .getString("reason"),
                )
                controller.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test fun durableTerminalLedgerReplaysMultipleCrashWindowsExactlyOnce() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)

            val admitted = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("terminal" to "admitted"),
                1,
                "generation-a",
                sourceContextId = primary.id,
            ).also {
                it.firstScreen = true
                controller.admitSecondary(it)
            }
            assertTrue(
                controller.cancelSecondary(
                    admitted,
                    LynxPageCancelReason.SPARKLING_CLOSE,
                ),
            )
            val canceled = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("terminal" to "authorized-cancel"),
                1,
                "generation-a",
                sourceContextId = primary.id,
            )
            assertTrue(
                controller.cancelSecondary(
                    canceled,
                    LynxPageCancelReason.NATIVE_BACK,
                ),
            )
            val fatal = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("terminal" to "verified-fatal"),
                1,
                "generation-a",
                sourceContextId = primary.id,
            )
            assertTrue(controller.fail(fatal, "verified engine failure"))
            controller.close()

            val beforeReplay = journal(root).getJSONArray("pageAttemptTerminals")
            assertEquals(3, beforeReplay.length())
            assertEquals(3L, journal(root).getLong("pageAttemptTerminalCount"))
            assertTrue((0 until beforeReplay.length()).all { index ->
                !beforeReplay.getJSONObject(index)
                    .getBoolean("runtimeEventEmitted")
            })

            controller(root).close()
            val events = LynxGenerationEventJournal(root).snapshot()
                .getJSONArray("events").objects()
                .filter { it.getString("name") == "pageAttemptTerminal" }
            assertEquals(3, events.size)
            assertEquals(
                setOf("admitted", "authorized-cancel", "verified-fatal"),
                events.map {
                    it.getJSONObject("details").getString("terminal")
                }.toSet(),
            )
            events.forEach { event ->
                val details = event.getJSONObject("details")
                assertTrue(details.get("processId") is String)
                assertEquals(runtime, details.getString("runtimeId"))
                assertTrue(
                    details.keySet().containsAll(
                        setOf(
                            "runtimeId",
                            "processId",
                            "generationId",
                            "bundleId",
                            "releaseId",
                            "contextId",
                            "pageAttemptId",
                            "transitionId",
                        ),
                    ),
                )
            }
            controller(root).close()
            assertEquals(
                3,
                LynxGenerationEventJournal(root).snapshot()
                    .getJSONArray("events").objects()
                    .count { it.getString("name") == "pageAttemptTerminal" },
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun durableTerminalLedgerIsOldestFirstBoundedWithMonotonicCount() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)
            val attemptIds = mutableListOf<String>()
            repeat(257) { index ->
                val pending = controller.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("index" to index.toString()),
                    1,
                    "generation-a",
                    sourceContextId = primary.id,
                )
                attemptIds += pending.id
                assertTrue(
                    controller.cancelSecondary(
                        pending,
                        LynxPageCancelReason.NATIVE_BACK,
                    ),
                )
                pending.close()
            }

            val state = journal(root)
            val terminals = state.getJSONArray("pageAttemptTerminals")
            assertEquals(256, terminals.length())
            assertEquals(257L, state.getLong("pageAttemptTerminalCount"))
            assertEquals(attemptIds[1], terminals.getJSONObject(0).getString("attemptId"))
            assertEquals(
                attemptIds.last(),
                terminals.getJSONObject(255).getString("attemptId"),
            )
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun acceptedTransitionPersistsStackAndRejectsOldGenerationWork() {
        val root = temp()
        try {
            val old = controller(root)
            val primary = old.pinPrimary(generationId = "generation-old")
            primary.firstScreen = true
            old.confirm(primary)
            assertThrows(IllegalArgumentException::class.java) {
                old.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("" to "invalid"),
                    1,
                    "generation-old",
                )
            }
            assertEquals(
                listOf("main.lynx.bundle"),
                old.retainedLogicalStack(primary).map(LynxLogicalPage::entry),
            )
            assertFalse(journal(root).has("pageAttempt"))
            old.pinSecondary(
                "detail.lynx.bundle",
                mapOf("title" to "Second Page"),
                1,
                "generation-old",
            ).also {
                it.firstScreen = true
                old.admitSecondary(it)
            }
            val stack = old.retainedLogicalStack(primary)
            val acceptance = old.acceptManagedTransition(
                primary,
                "generation-old",
                stack,
                "reload",
            )
            val transitionId = acceptance.getString("transitionId")
            assertEquals("TRANSITION_ACCEPTED", acceptance.getString("status"))
            assertEquals(
                transitionId,
                journal(root).getJSONObject("managedTransition")
                    .getString("transitionId"),
            )
            val competing = assertThrows(CatalogPolicy.Rejected::class.java) {
                old.acceptManagedTransition(
                    primary,
                    "generation-old",
                    stack,
                    "reload",
                )
            }
            assertEquals("TRANSITION_IN_PROGRESS", competing.code)
            assertThrows(CatalogPolicy.Rejected::class.java) {
                old.state(primary)
            }
            old.close()

            val fresh = controller(root)
            val freshPrimary = fresh.pinPrimary(generationId = "generation-new")
            assertEquals(
                transitionId,
                journal(root).getJSONObject("pending")
                    .getString("transitionId"),
            )
            assertEquals(stack, fresh.retainedLogicalStack(freshPrimary))
            val freshDetail = fresh.pinSecondary(
                "detail.lynx.bundle",
                mapOf("title" to "Second Page"),
                1,
                "generation-new",
                reconstructing = true,
            )
            freshPrimary.firstScreen = true
            assertThrows(IllegalStateException::class.java) {
                fresh.confirm(freshPrimary)
            }
            freshDetail.firstScreen = true
            fresh.admitSecondary(freshDetail)
            assertEquals(
                transitionId,
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("transitionId"),
            )
            val confirmation = fresh.confirm(freshPrimary)
            assertEquals("ALREADY_CONFIRMED", confirmation.getString("status"))
            assertEquals(JSONObject.NULL, confirmation.opt("transitionId"))
            assertEquals(JSONObject.NULL, confirmation.opt("transition"))
            val repeated = fresh.confirm(freshPrimary)
            assertEquals(JSONObject.NULL, repeated.opt("transitionId"))
            assertEquals(JSONObject.NULL, repeated.opt("transition"))
            assertFalse(journal(root).has("pending"))
            assertFalse(journal(root).has("managedTransition"))
            assertFalse(journal(root).has("launchTransition"))
            freshDetail.close()
            fresh.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun sameReleaseManagedGenerationCrashIsConsumedWithoutReloadLoop() {
        val root = temp()
        try {
            val transitionId = prepareAcceptedStack(root, 1)
            val interrupted = controller(root)
            interrupted.pinPrimary(generationId = "generation-interrupted")
            assertEquals(
                transitionId,
                journal(root).getJSONObject("pending")
                    .getString("transitionId"),
            )
            interrupted.close()

            val recovered = controller(root)
            val recoveredState = journal(root)
            assertFalse(recoveredState.has("pending"))
            assertFalse(recoveredState.has("managedTransition"))
            assertFalse(recoveredState.has("launchTransition"))
            val primary = recovered.pinPrimary(
                generationId = "generation-recovered",
            ).also { it.firstScreen = true }
            val confirmation = recovered.confirm(primary)
            assertEquals(JSONObject.NULL, confirmation.opt("transition"))
            assertEquals(JSONObject.NULL, confirmation.opt("transitionId"))
            assertFalse(journal(root).has("pending"))
            recovered.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun retainedStacksConfirmOnlyAfterFinalAdmission() {
        listOf(2, 3, 16).forEach { depth ->
            val root = temp()
            try {
                val transitionId = prepareAcceptedStack(root, depth)
                val fresh = controller(root)
                val primary = fresh.pinPrimary(generationId = "generation-$depth")
                var primaryReply: Result<JSONObject>? = null
                val eventOrder = mutableListOf<String>()
                primary.setReadinessHandlers(
                    firstContent = {},
                    confirmed = { confirmation ->
                        assertEquals(
                            JSONObject.NULL,
                            confirmation.opt("transitionId"),
                        )
                        eventOrder += "jsReady"
                    },
                )
                primary.firstScreen = true
                primary.notifyReady { primaryReply = it }
                assertEquals(null, primaryReply)

                lateinit var current: LynxLaunchSession
                fun open(position: Int): LynxLaunchSession {
                    val session = fresh.pinSecondary(
                        "detail.lynx.bundle",
                        mapOf("depth" to position.toString()),
                        position,
                        "generation-$depth",
                        reconstructing = true,
                    )
                    session.setReadinessHandlers(
                        firstContent = {},
                        confirmed = {
                            assertEquals(
                                transitionId,
                                fresh.pendingManagedTransition(session)?.transitionId,
                            )
                            eventOrder += "pageAdmitted:$position"
                            if (position + 1 < depth) {
                                current = open(position + 1)
                            }
                        },
                    )
                    return session
                }

                current = open(1)
                for (position in 1 until depth) {
                    current.firstScreen = true
                    current.notifyReady { assertTrue(it.isSuccess) }
                    val terminal = journal(root)
                        .getJSONObject("lastPageAttempt")
                    assertEquals("admitted", terminal.getString("terminal"))
                    assertEquals(
                        transitionId,
                        terminal.getString("transitionId"),
                    )
                    if (position + 1 < depth) {
                        assertEquals(null, primaryReply)
                        assertEquals(
                            position + 1,
                            journal(root).getInt("reconstructionPosition"),
                        )
                    }
                }

                assertEquals(
                    "ALREADY_CONFIRMED",
                    checkNotNull(primaryReply).getOrThrow().getString("status"),
                )
                assertEquals("jsReady", eventOrder.last())
                assertEquals(
                    (1 until depth).map { "pageAdmitted:$it" } + "jsReady",
                    eventOrder,
                )
                assertFalse(journal(root).has("managedTransition"))
                assertFalse(journal(root).has("reconstructionPosition"))
                fresh.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test fun admittedPageRebindWaitsForFreshReadinessWithoutReadmitting() {
        val root = temp()
        try {
            withController(root) { controller ->
                val primary = controller.pinPrimary(generationId = "generation-rebind")
                primary.firstScreen = true
                primary.notifyReady { }
                val secondary = controller.pinSecondary("detail.lynx.bundle", emptyMap(), 1, "generation-rebind")
                secondary.requireResourceBeforeReady(secondary.pageEntry)
                secondary.firstScreen = true
                secondary.resolveEssential(secondary.pageEntry)
                var original: JSONObject? = null
                secondary.notifyReady { original = it.getOrThrow() }
                assertEquals("PAGE_ADMITTED", checkNotNull(original).getString("status"))
                // Move the controller's last admission to another page. Recreating
                // this older page must reuse its receipt, not admit it a second time.
                val later = controller.pinSecondary("detail.lynx.bundle", mapOf("page" to "later"), 2, "generation-rebind")
                later.firstScreen = true
                later.notifyReady { assertTrue(it.isSuccess) }
                val persisted = journal(root).toString()
                LynxLaunchSession::class.java.getDeclaredField("context").apply {
                    isAccessible = true
                    set(secondary, android.app.Application())
                }
                secondary.prepareForRebind()
                var duplicateAdmissionEvents = 0
                secondary.setReadinessHandlers({}, { duplicateAdmissionEvents++ })
                var reply: Result<JSONObject>? = null
                secondary.notifyReady { reply = it }
                assertEquals(null, reply)
                secondary.firstScreen = true
                secondary.flushReady()
                assertEquals(null, reply)
                secondary.resolveEssential(secondary.pageEntry)
                assertEquals(original.toString(), checkNotNull(reply).getOrThrow().toString())
                assertEquals(0, duplicateAdmissionEvents)
                assertEquals(persisted, journal(root).toString())
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun rebindDrainsOldResourcesBeforeResettingReadiness() {
        val root = temp()
        val executor = Executors.newFixedThreadPool(2)
        val release = CountDownLatch(1)
        try {
            withController(root) { controller ->
                val session = controller.pinPrimary(generationId = "generation-rebind")
                val entry = session.pageEntry
                session.requireResourceBeforeReady(entry)
                val oldResources = session.resources
                val snapshot = oldResources.resolve(session.entryUrl)
                val entered = CountDownLatch(1)
                session.setResourceObserver { _, _, _ ->
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                }
                // Resource ownership does not require a JVM-mocked LynxView.
                LynxLaunchSession::class.java.getDeclaredField("context").apply {
                    isAccessible = true
                    set(session, android.app.Application())
                }
                val load = executor.submit { oldResources.loadBytes(session.entryUrl) {} }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val rebinding = CountDownLatch(1)
                val rebind = executor.submit {
                    rebinding.countDown()
                    session.prepareForRebind()
                }
                assertTrue(rebinding.await(5, TimeUnit.SECONDS))
                try {
                    assertThrows(java.util.concurrent.TimeoutException::class.java) {
                        rebind.get(100, TimeUnit.MILLISECONDS)
                    }
                } finally {
                    release.countDown()
                }
                load.get(5, TimeUnit.SECONDS)
                rebind.get(5, TimeUnit.SECONDS)
                assertTrue(oldResources !== session.resources)
                assertEquals("entry-A", snapshot.readText())
                val freshSnapshot = session.resources.resolve(session.entryUrl)
                assertTrue(snapshot != freshSnapshot)
                assertThrows(IllegalStateException::class.java) {
                    oldResources.resolve(session.entryUrl)
                }
                session.setResourceObserver { _, _, _ -> }
                session.firstScreen = true
                var reply: Result<JSONObject>? = null
                session.notifyReady { reply = it }
                assertEquals(null, reply)
                session.resolveEssential(entry)
                assertTrue(checkNotNull(reply).isSuccess)
                session.close()
                assertFalse(snapshot.exists())
                assertFalse(freshSnapshot.exists())
            }
        } finally {
            release.countDown()
            executor.shutdownNow()
            executor.awaitTermination(5, TimeUnit.SECONDS)
            root.deleteRecursively()
        }
    }

    @Test fun primaryReadinessTracksEssentialResourcesWithoutAnObserver() {
        val root = temp()
        try {
            withController(root) { controller ->
                val primary = controller.pinPrimary(generationId = "generation-no-observer")
                primary.requireResourceBeforeReady(primary.pageEntry)
                var confirmed: Result<JSONObject>? = null
                primary.firstScreen = true
                primary.notifyReady { confirmed = it }
                assertEquals(null, confirmed)
                assertTrue(journal(root).has("pending"))
                primary.resolveEssential(primary.pageEntry)
                assertTrue(checkNotNull(confirmed).isSuccess)
                assertFalse(journal(root).has("pending"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun rejectedHostResourceObservationDoesNotConfirmReadiness() {
        val root = temp()
        try {
            withController(root) { controller ->
                val primary = controller.pinPrimary(generationId = "generation-host-observation")
                primary.requireResourceBeforeReady(primary.pageEntry)
                var acceptObservation = false
                var confirmed: Result<JSONObject>? = null
                primary.setResourceObserver { _, path, _ ->
                    assertEquals(primary.pageEntry, path)
                    assertEquals(null, confirmed)
                    assertTrue(journal(root).has("pending"))
                    check(acceptObservation) { "Generation resource journal rejected the load" }
                }
                primary.firstScreen = true
                primary.notifyReady { confirmed = it }
                assertThrows(IllegalStateException::class.java) {
                    primary.resolveEssential(primary.pageEntry)
                }
                primary.flushReady()
                assertEquals(null, confirmed)
                assertTrue(journal(root).has("pending"))
                acceptObservation = true
                primary.resolveEssential(primary.pageEntry)
                assertTrue(checkNotNull(confirmed).isSuccess)
                assertFalse(journal(root).has("pending"))
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun secondaryAdmissionWaitsForResolvedEssentialPageEntry() {
        val root = temp()
        try {
            withController(root) { controller ->
                val primary = controller.pinPrimary(generationId = "generation-entry")
                primary.firstScreen = true
                primary.notifyReady { }
                val secondary = controller.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("title" to "Second Page"),
                    1,
                    "generation-entry",
                )
                secondary.requireResourceBeforeReady("detail.lynx.bundle")
                var admitted: Result<JSONObject>? = null
                secondary.firstScreen = true
                secondary.notifyReady { admitted = it }
                assertEquals(null, admitted)
                secondary.resolveEssential("detail.lynx.bundle")
                assertEquals(
                    "PAGE_ADMITTED",
                    checkNotNull(admitted).getOrThrow().getString("status"),
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun pendingIntermediateReconstructionCanBeCancelledWithoutFutureSuffix() {
        listOf(
            LynxPageCancelReason.NATIVE_BACK,
            LynxPageCancelReason.SPARKLING_CLOSE,
        ).forEach { reason ->
            val root = temp()
            try {
                prepareAcceptedStack(root, 3)
                val fresh = controller(root)
                val primary = fresh.pinPrimary(generationId = "generation-new")
                primary.firstScreen = true
                var primaryReply: Result<JSONObject>? = null
                primary.notifyReady { primaryReply = it }
                val pending = fresh.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("depth" to "1"),
                    1,
                    "generation-new",
                    reconstructing = true,
                )

                assertTrue(fresh.cancelSecondary(pending, reason))
                assertEquals(
                    listOf("main.lynx.bundle"),
                    fresh.retainedLogicalStack(primary).map { it.entry },
                )
                val terminal = journal(root).getJSONObject("lastPageAttempt")
                assertEquals("authorized-cancel", terminal.getString("terminal"))
                assertEquals(reason.wireValue, terminal.getString("reason"))
                assertEquals(JSONObject.NULL, terminal.get("transitionId"))
                assertEquals(
                    "ALREADY_CONFIRMED",
                    checkNotNull(primaryReply).getOrThrow().getString("status"),
                )
                fresh.close()

                val reopened = controller(root)
                val reopenedPrimary = reopened.pinPrimary(
                    generationId = "generation-reopened",
                )
                assertEquals(
                    listOf("main.lynx.bundle"),
                    reopened.retainedLogicalStack(reopenedPrimary).map { it.entry },
                )
                reopened.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test fun pendingCancellationPublishesTerminalBeforePrimaryConfirmation() {
        listOf(
            LynxPageCancelReason.NATIVE_BACK,
            LynxPageCancelReason.SPARKLING_CLOSE,
        ).forEach { reason ->
            val root = temp()
            try {
                prepareAcceptedStack(root, 2)
                val fresh = controller(root)
                val primary = fresh.pinPrimary(generationId = "generation-new")
                val order = mutableListOf<String>()
                primary.setReadinessHandlers(
                    firstContent = {},
                    confirmed = { order += "jsReady" },
                )
                primary.firstScreen = true
                primary.notifyReady { assertTrue(it.isSuccess) }
                val pending = fresh.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("depth" to "1"),
                    1,
                    "generation-new",
                    reconstructing = true,
                )

                assertTrue(fresh.cancelSecondaryForHost(pending, reason))
                assertTrue(order.isEmpty())
                val terminal = journal(root).getJSONObject("lastPageAttempt")
                assertEquals("authorized-cancel", terminal.getString("terminal"))
                assertEquals(reason.wireValue, terminal.getString("reason"))
                order += "pageAttemptTerminal"
                fresh.flushPrimaryReadinessAfterHostEvent()

                assertEquals(listOf("pageAttemptTerminal", "jsReady"), order)
                fresh.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test fun cancelledIntermediatePlanDoesNotResurrectAfterProcessReplacement() {
        val root = temp()
        try {
            prepareAcceptedStack(root, 3)
            val fresh = controller(root)
            val primary = fresh.pinPrimary(generationId = "generation-new")
            val pending = fresh.pinSecondary(
                "detail.lynx.bundle",
                mapOf("depth" to "1"),
                1,
                "generation-new",
                reconstructing = true,
            )
            assertTrue(
                fresh.cancelSecondary(
                    pending,
                    LynxPageCancelReason.NATIVE_BACK,
                ),
            )
            assertTrue(journal(root).has("managedTransition"))
            assertEquals(
                3,
                journal(root).getJSONObject("managedTransition")
                    .getJSONArray("stack").length(),
            )
            assertEquals(1, journal(root).getJSONArray("logicalStack").length())
            fresh.close()

            val reopened = controller(root)
            val reopenedPrimary = reopened.pinPrimary(
                generationId = "generation-reopened",
            )
            assertEquals(
                listOf("main.lynx.bundle"),
                reopened.retainedLogicalStack(reopenedPrimary).map { it.entry },
            )
            val terminal = journal(root).getJSONArray("pageAttemptTerminals")
                .let { it.getJSONObject(it.length() - 1) }
            assertEquals("authorized-cancel", terminal.getString("terminal"))
            assertEquals("nativeBack", terminal.getString("reason"))
            reopened.close()
            primary.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun intermediateReconstructionFatalRetainsFullPlanAndPrecedingTop() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            val source = controller(root)
            val sourcePrimary = source.pinPrimary(generationId = "generation-source")
            for (position in 1..2) {
                source.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("depth" to position.toString()),
                    position,
                    "generation-source",
                ).also { page ->
                    page.firstScreen = true
                    source.admitSecondary(page)
                }
            }
            sourcePrimary.firstScreen = true
            source.confirm(sourcePrimary)
            val transitionId = source.acceptManagedTransition(
                sourcePrimary,
                "generation-source",
                source.retainedLogicalStack(sourcePrimary),
                "reload",
            ).getString("transitionId")
            source.close()

            val failed = controller(root)
            val failedPrimary = failed.pinPrimary(generationId = "generation-failed")
            val intermediate = failed.pinSecondary(
                "detail.lynx.bundle",
                mapOf("depth" to "1"),
                1,
                "generation-failed",
                reconstructing = true,
                sourceContextId = failedPrimary.id,
            )
            assertTrue(failed.fail(intermediate, "intermediate fatal"))
            val terminal = journal(root).getJSONObject("lastPageAttempt")
            assertEquals("verified-fatal", terminal.getString("terminal"))
            assertEquals(transitionId, terminal.getString("transitionId"))
            assertEquals(failedPrimary.id, terminal.getString("topContextId"))
            assertEquals(3, terminal.getJSONArray("stack").length())
            failed.close()

            val recovered = controller(root)
            val recoveredPrimary = recovered.pinPrimary(
                generationId = "generation-recovered",
            )
            assertEquals(
                listOf("main.lynx.bundle", "detail.lynx.bundle", "detail.lynx.bundle"),
                recovered.retainedLogicalStack(recoveredPrimary).map { it.entry },
            )
            assertEquals(
                embeddedId,
                recovered.state(recoveredPrimary)
                    .getJSONObject("runningSelection").getString("bundleId"),
            )
            val events = recovered.runtimeEvents(recoveredPrimary)
                .getJSONArray("events")
            val replayed = (0 until events.length())
                .map { events.getJSONObject(it) }
                .last { it.getString("name") == "pageAttemptTerminal" }
                .getJSONObject("details")
            assertEquals(failedPrimary.id, replayed.getString("topContextId"))
            assertEquals("detail.lynx.bundle", replayed.getString("topPageEntry"))
            assertEquals(3, replayed.getJSONArray("orderedPageEntries").length())
            recovered.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun failedIntermediateActivityLaunchCanRetryTheSameRetainedPosition() {
        val root = temp()
        try {
            prepareAcceptedStack(root, 3)
            val fresh = controller(root)
            val primary = fresh.pinPrimary(generationId = "generation-new")
            val firstAttempt = fresh.pinSecondary(
                "detail.lynx.bundle",
                mapOf("depth" to "1"),
                1,
                "generation-new",
                reconstructing = true,
            )
            assertTrue(fresh.rollbackSecondary(firstAttempt))
            assertEquals(3, fresh.retainedLogicalStack(primary).size)
            assertEquals(1, journal(root).getInt("reconstructionPosition"))
            assertFalse(journal(root).has("pageAttempt"))

            val retry = fresh.pinSecondary(
                "detail.lynx.bundle",
                mapOf("depth" to "1"),
                1,
                "generation-new",
                reconstructing = true,
            )
            assertTrue(retry.live)
            fresh.close()
        } finally {
            root.deleteRecursively()
        }
    }

    private fun prepareAcceptedStack(root: File, depth: Int): String {
        val old = controller(root)
        val primary = old.pinPrimary(generationId = "generation-old")
        primary.firstScreen = true
        old.confirm(primary)
        for (position in 1 until depth) {
            old.pinSecondary(
                "detail.lynx.bundle",
                mapOf("depth" to position.toString()),
                position,
                "generation-old",
            ).also { page ->
                page.firstScreen = true
                old.admitSecondary(page)
            }
        }
        val result = old.acceptManagedTransition(
            primary,
            "generation-old",
            old.retainedLogicalStack(primary),
            "reload",
        )
        old.close()
        return result.getString("transitionId")
    }

    @Test fun replacementGenerationFatalTerminalRetainsAcceptedTransitionId() {
        val root = temp()
        try {
            val old = controller(root)
            val primary = old.pinPrimary(generationId = "generation-old")
            primary.firstScreen = true
            old.confirm(primary)
            val acceptance = old.acceptManagedTransition(
                primary,
                "generation-old",
                old.retainedLogicalStack(primary),
                "reload",
            )
            val transitionId = acceptance.getString("transitionId")
            old.close()

            val fresh = controller(root)
            val freshPrimary = fresh.pinPrimary(generationId = "generation-new")
            val detail = fresh.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "replacement-fatal"),
                1,
                "generation-new",
                sourceContextId = freshPrimary.id,
            )
            assertTrue(fresh.fail(detail, "fatal before transition confirmation"))
            val terminal = journal(root).getJSONObject("lastPageAttempt")
            assertEquals("verified-fatal", terminal.getString("terminal"))
            assertEquals(transitionId, terminal.getString("transitionId"))
            assertEquals(
                transitionId,
                journal(root).getJSONObject("managedTransition")
                    .getString("transitionId"),
            )
            fresh.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun managedStackAcceptsSixteenPagesAndRejectsTheSeventeenthBeforeMutation() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)
            repeat(15) { index ->
                controller.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("position" to (index + 1).toString()),
                    index + 1,
                    "generation-a",
                ).also {
                    it.firstScreen = true
                    controller.admitSecondary(it)
                }
            }
            assertEquals(16, controller.retainedLogicalStack(primary).size)

            assertThrows(IllegalArgumentException::class.java) {
                controller.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("position" to "16"),
                    16,
                    "generation-a",
                )
            }
            assertEquals(16, controller.retainedLogicalStack(primary).size)
            assertFalse(journal(root).has("pageAttempt"))
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun pendingOtaPageInterruptionSuppressesReleaseWithoutCrash() {
        for (confirmedBeforeOpen in listOf(false, true)) {
            val root = temp()
            try {
                withController(root) { initial ->
                    initial.pinPrimary().also {
                        it.firstScreen = true
                        initial.confirm(it)
                    }
                }
                plantNext(root, releaseB, bundleB, "B")
                val interrupted = controller(root)
                val primary = interrupted.pinPrimary(generationId = "generation-b")
                if (confirmedBeforeOpen) {
                    primary.firstScreen = true
                    interrupted.confirm(primary)
                }
                val pendingPage = interrupted.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("timing" to confirmedBeforeOpen.toString()),
                    1,
                    "generation-b",
                    nativePageClass = "test.ManagedPageActivity",
                )
                interrupted.close()

                val recovered = controller(root)
                val terminal = journal(root).getJSONObject("lastPageAttempt")
                assertEquals(pendingPage.id, terminal.getString("attemptId"))
                assertEquals("process-interruption", terminal.getString("terminal"))
                assertEquals("processRecovery", terminal.getString("reason"))
                assertTrue(terminal.getBoolean("runtimeEventEmitted"))
                val interruptionEvents = LynxGenerationEventJournal(root)
                    .snapshot()
                    .getJSONArray("events")
                    .objects()
                    .filter { it.getString("name") == "pageAttemptTerminal" }
                assertEquals(1, interruptionEvents.size)
                val interruption = interruptionEvents.single()
                    .getJSONObject("details")
                assertEquals(pendingPage.id, interruption.getString("pageAttemptId"))
                assertEquals(
                    "test.ManagedPageActivity",
                    interruption.getString("nativePageClass"),
                )
                assertEquals(
                    "process-interruption",
                    interruption.getString("terminal"),
                )
                assertEquals(
                    primary.id,
                    interruption.getString("sourceContextId"),
                )
                assertEquals(
                    listOf("main.lynx.bundle", "detail.lynx.bundle"),
                    jsonStrings(interruption.getJSONArray("orderedPageEntries")),
                )
                assertEquals(JSONObject.NULL, interruption.get("topContextId"))
                val recoveredPrimary = recovered.pinPrimary(
                    generationId = "generation-recovered",
                )
                assertEquals(embeddedId, recovered.diagnostics(recoveredPrimary).bundleId)
                val state = recovered.state(recoveredPrimary)
                assertEquals(
                    listOf(releaseB),
                    jsonStrings(state.getJSONArray("unconfirmedReleaseIds")),
                )
                assertEquals(0, state.getJSONArray("crashedBundleIds").length())
                assertEquals(
                    listOf("main.lynx.bundle", "detail.lynx.bundle"),
                    recovered.retainedLogicalStack(recoveredPrimary)
                        .map(LynxLogicalPage::entry),
                )
                recovered.close()
                val reopened = controller(root)
                assertEquals(
                    1,
                    LynxGenerationEventJournal(root).snapshot()
                        .getJSONArray("events")
                        .objects()
                        .count { it.getString("name") == "pageAttemptTerminal" },
                )
                reopened.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test fun confirmedOtaPageInterruptionPersistsExactRecoveryBeforePin() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            val interrupted = controller(root)
            val primary = interrupted.pinPrimary(
                generationId = "generation-b",
            ).also { it.firstScreen = true }
            interrupted.confirm(primary)
            val pendingPage = interrupted.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "confirmed-interruption"),
                1,
                "generation-b",
            )
            interrupted.close()

            val recoveredBeforePin = controller(root)
            val firstRecovery = journal(root).getJSONObject("launchTransition")
            val transitionId = firstRecovery.getString("transitionId")
            assertEquals("RECOVERED", firstRecovery.getString("kind"))
            assertEquals(
                bundleB,
                firstRecovery.getJSONObject("from").getString("bundleId"),
            )
            assertEquals(
                releaseB,
                firstRecovery.getJSONObject("from").getString("releaseId"),
            )
            assertEquals(
                embeddedId,
                firstRecovery.getJSONObject("to").getString("bundleId"),
            )
            assertEquals(
                transitionId,
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("transitionId"),
            )
            assertEquals(
                pendingPage.id,
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("attemptId"),
            )
            recoveredBeforePin.close()

            val recovered = controller(root)
            assertEquals(
                firstRecovery.toString(),
                journal(root).getJSONObject("launchTransition").toString(),
            )
            val recoveredPrimary = recovered.pinPrimary(
                generationId = "generation-recovered",
            ).also { it.firstScreen = true }
            assertEquals(embeddedId, recovered.diagnostics(recoveredPrimary).bundleId)
            val detail = recovered.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "confirmed-interruption"),
                1,
                "generation-recovered",
                reconstructing = true,
            ).also { it.firstScreen = true }
            recovered.admitSecondary(detail)
            val confirmation = recovered.confirm(recoveredPrimary)
            val transition = confirmation.getJSONObject("transition")
            assertEquals("RECOVERED", transition.getString("kind"))
            assertEquals(transitionId, confirmation.getString("transitionId"))
            assertEquals(bundleB, transition.getJSONObject("from").getString("bundleId"))
            assertEquals(embeddedId, transition.getJSONObject("to").getString("bundleId"))
            val repeated = recovered.confirm(recoveredPrimary)
            assertEquals(JSONObject.NULL, repeated.opt("transition"))
            assertEquals(JSONObject.NULL, repeated.opt("transitionId"))
            assertFalse(journal(root).has("launchTransition"))
            recovered.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun managedMultiPageInterruptionRecoversWithAcceptedIdAndCompleteStack() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            val source = controller(root)
            val sourcePrimary = source.pinPrimary(
                generationId = "generation-b",
            ).also { it.firstScreen = true }
            source.confirm(sourcePrimary)
            source.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "managed-interruption"),
                1,
                "generation-b",
            ).also {
                it.firstScreen = true
                source.admitSecondary(it)
            }
            val acceptance = source.acceptManagedTransition(
                sourcePrimary,
                "generation-b",
                source.retainedLogicalStack(sourcePrimary),
                "reload",
            )
            val transitionId = acceptance.getString("transitionId")
            source.close()

            val replacement = controller(root)
            replacement.pinPrimary(
                generationId = "generation-replacement",
            )
            val interruptedPage = replacement.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "managed-interruption"),
                1,
                "generation-replacement",
                reconstructing = true,
            )
            assertEquals(
                transitionId,
                journal(root).getJSONObject("pending").getString("transitionId"),
            )
            replacement.close()

            plantNext(
                root,
                releaseC,
                bundleC,
                "C",
                includeDetailPage = false,
            )

            val recoveredBeforePin = controller(root)
            val recovery = journal(root).getJSONObject("launchTransition")
            assertEquals("RECOVERED", recovery.getString("kind"))
            assertEquals(transitionId, recovery.getString("transitionId"))
            assertEquals(bundleB, recovery.getJSONObject("from").getString("bundleId"))
            assertEquals(releaseB, recovery.getJSONObject("from").getString("releaseId"))
            assertEquals(embeddedId, recovery.getJSONObject("to").getString("bundleId"))
            assertEquals(
                transitionId,
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("transitionId"),
            )
            assertEquals(
                interruptedPage.id,
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("attemptId"),
            )
            assertFalse(journal(root).has("pending"))
            assertFalse(journal(root).has("pageAttempt"))
            assertFalse(journal(root).has("managedTransition"))
            assertEquals(
                listOf(releaseB),
                jsonStrings(journal(root).getJSONArray("unconfirmed")),
            )
            recoveredBeforePin.close()

            val recovered = controller(root)
            assertEquals(
                recovery.toString(),
                journal(root).getJSONObject("launchTransition").toString(),
            )
            val recoveredPrimary = recovered.pinPrimary(
                generationId = "generation-fallback",
            ).also { it.firstScreen = true }
            assertEquals(embeddedId, recovered.diagnostics(recoveredPrimary).bundleId)
            val detail = recovered.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "managed-interruption"),
                1,
                "generation-fallback",
                reconstructing = true,
            ).also { it.firstScreen = true }
            recovered.admitSecondary(detail)
            val confirmation = recovered.confirm(recoveredPrimary)
            val transition = confirmation.getJSONObject("transition")
            assertEquals("RECOVERED", transition.getString("kind"))
            assertEquals(transitionId, confirmation.getString("transitionId"))
            assertEquals(bundleB, transition.getJSONObject("from").getString("bundleId"))
            assertEquals(embeddedId, transition.getJSONObject("to").getString("bundleId"))
            val repeated = recovered.confirm(recoveredPrimary)
            assertEquals(JSONObject.NULL, repeated.opt("transition"))
            assertEquals(JSONObject.NULL, repeated.opt("transitionId"))
            assertFalse(journal(root).has("launchTransition"))
            recovered.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun unavailableRuntimeJournalDoesNotBlockRecoveryAndRetriesLater() {
        val root = temp()
        try {
            val interrupted = controller(root)
            val primary = interrupted.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            interrupted.confirm(primary)
            val pending = interrupted.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "journal-unavailable"),
                1,
                "generation-a",
                sourceContextId = primary.id,
            )
            interrupted.close()

            val interruptedState = journal(root)
            interruptedState.getJSONObject("pageAttempt")
                .put("processId", "1234")
            File(store(root), "state.json").writeText(interruptedState.toString())

            val runtimeEventsPath = File(
                root,
                "hot-updater-lynx/runtime-events",
            )
            runtimeEventsPath.parentFile.mkdirs()
            runtimeEventsPath.writeText("blocks-directory-creation")

            assertThrows(IllegalStateException::class.java) {
                LynxGenerationEventJournal(root).snapshot()
            }

            val recovered = controller(root)
            assertEquals(
                "process-interruption",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("terminal"),
            )
            assertFalse(
                journal(root).getJSONObject("lastPageAttempt")
                    .optBoolean("runtimeEventEmitted", false),
            )
            recovered.close()

            assertTrue(runtimeEventsPath.delete())
            val retried = controller(root)
            val terminal = journal(root).getJSONObject("lastPageAttempt")
            assertTrue(terminal.getBoolean("runtimeEventEmitted"))
            val event = LynxGenerationEventJournal(root).snapshot()
                .getJSONArray("events").getJSONObject(0)
                .getJSONObject("details")
            assertEquals(pending.id, event.getString("pageAttemptId"))
            assertEquals(primary.id, event.getString("sourceContextId"))
            assertEquals("1234", event.getString("processId"))
            assertTrue(event.get("processId") is String)
            assertEquals(runtime, event.getString("runtimeId"))
            retried.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun fatalOtaPageFailureSuppressesBundleAndRecoversCompleteStack() {
        for (confirmedBeforeOpen in listOf(false, true)) {
            val root = temp()
            try {
                withController(root) { initial ->
                    initial.pinPrimary().also {
                        it.firstScreen = true
                        initial.confirm(it)
                    }
                }
                plantNext(root, releaseB, bundleB, "B")
                val failed = controller(root)
                val primary = failed.pinPrimary(generationId = "generation-b")
                if (confirmedBeforeOpen) {
                    primary.firstScreen = true
                    failed.confirm(primary)
                }
                val detail = failed.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("timing" to confirmedBeforeOpen.toString()),
                    1,
                    "generation-b",
                )

                assertTrue(failed.fail(detail, "fatal detail evaluation"))
                val failedState = journal(root)
                assertFalse(failedState.has("pageAttempt"))
                assertEquals(
                    "verified-fatal",
                    failedState.getJSONObject("lastPageAttempt")
                        .getString("terminal"),
                )
                assertEquals(
                    "detail.lynx.bundle",
                    failedState.getJSONObject("generationFailure")
                        .getString("pageEntry"),
                )
                failed.close()

                val recovered = controller(root)
                val recoveredPrimary = recovered.pinPrimary(
                    generationId = "generation-recovered",
                )
                assertEquals(embeddedId, recovered.diagnostics(recoveredPrimary).bundleId)
                val state = recovered.state(recoveredPrimary)
                assertEquals(
                    listOf(bundleB),
                    jsonStrings(state.getJSONArray("crashedBundleIds")),
                )
                assertEquals(
                    listOf(releaseB),
                    jsonStrings(state.getJSONArray("unconfirmedReleaseIds")),
                )
                assertEquals(
                    listOf("main.lynx.bundle", "detail.lynx.bundle"),
                    recovered.retainedLogicalStack(recoveredPrimary)
                        .map(LynxLogicalPage::entry),
                )
                recovered.close()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test fun committedFatalGenerationRejectsNewPagesAndManagedTransitions() {
        val root = temp()
        try {
            val failed = controller(root)
            val primary = failed.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            failed.confirm(primary)
            val detail = failed.pinSecondary(
                "detail.lynx.bundle",
                mapOf("case" to "fatal-gate"),
                1,
                "generation-a",
                sourceContextId = primary.id,
            )
            assertTrue(failed.fail(detail, "fatal detail evaluation"))
            val committed = journal(root).toString()

            val pageRejection = assertThrows(CatalogPolicy.Rejected::class.java) {
                failed.pinSecondary(
                    "detail.lynx.bundle",
                    mapOf("case" to "after-fatal"),
                    2,
                    "generation-a",
                    sourceContextId = detail.id,
                )
            }
            assertEquals("STALE_CONTEXT", pageRejection.code)
            val transitionRejection = assertThrows(
                CatalogPolicy.Rejected::class.java,
            ) {
                failed.acceptManagedTransition(
                    primary,
                    "generation-a",
                    failed.retainedLogicalStack(primary),
                    "reload",
                )
            }
            assertEquals("STALE_CONTEXT", transitionRejection.code)
            assertEquals(committed, journal(root).toString())
            assertEquals(
                "verified-fatal",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("terminal"),
            )
            assertTrue(journal(root).has("generationFailure"))
            failed.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun interruptedEmbeddedPageFailsClosedAfterProcessRecreation() {
        val root = temp()
        try {
            val interrupted = controller(root)
            val primary = interrupted.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            interrupted.confirm(primary)
            interrupted.pinSecondary(
                "detail.lynx.bundle",
                mapOf("title" to "Unfinished"),
                1,
                "generation-a",
            )
            interrupted.close()

            val recovered = controller(root)
            assertThrows(IllegalStateException::class.java) {
                recovered.pinPrimary(generationId = "generation-recovered")
            }
            assertEquals(
                embeddedId,
                journal(root).getJSONObject("failedEmbedded")
                    .getString("bundleId"),
            )
            recovered.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun closeIsIdempotentAndRejectsStaleControllerWork() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary()
            val stateBeforeClose = journal(root).toString()

            controller.close()
            controller.close()

            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.state(primary)
            }
            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.diagnostics(primary)
            }
            assertThrows(IllegalStateException::class.java) {
                controller.setChannel("stale")
            }
            assertFalse(controller.fail(primary, "late failure"))
            assertEquals(stateBeforeClose, journal(root).toString())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun confirmationReturnsEachBundleTransitionExactlyOnce() {
        val root = temp()
        try {
            withController(root) { initial ->
                initial.pinPrimary().also {
                    it.firstScreen = true
                    initial.confirm(it)
                }
            }
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { firstUpdate ->
                val session = firstUpdate.pinPrimary().also { it.firstScreen = true }
                val confirmation = firstUpdate.confirm(session)
                assertEquals("CONFIRMED", confirmation.getString("status"))
                val transition = confirmation.getJSONObject("transition")
                assertEquals("UPDATE_APPLIED", transition.getString("kind"))
                assertEquals(
                    embeddedId,
                    transition.getJSONObject("from").getString("bundleId"),
                )
                assertEquals(
                    bundleB,
                    transition.getJSONObject("to").getString("bundleId"),
                )
                assertEquals(
                    JSONObject.NULL,
                    firstUpdate.confirm(session).opt("transition"),
                )
            }
            plantNext(root, releaseC, bundleC, "C")
            val state = journal(root)
            val currentCatalog = catalog(releaseC, bundleC)
            currentCatalog.getJSONArray("rollbackReleases").put(
                catalog(releaseB, bundleB).getJSONArray("releases")
                    .getJSONObject(0),
            )
            state.put("catalog", currentCatalog.toString())
            state.getJSONObject("catalogs").put(
                digestString("$catalogId\u0000$scopeKey"),
                currentCatalog.toString(),
            )
            File(store(root), "state.json").writeText(state.toString())
            withController(root) { secondUpdate ->
                val session = secondUpdate.pinPrimary().also { it.firstScreen = true }
                val confirmation = secondUpdate.confirm(session)
                val transition = confirmation.getJSONObject("transition")
                assertEquals("UPDATE_APPLIED", transition.getString("kind"))
                assertEquals(
                    bundleB,
                    transition.getJSONObject("from").getString("bundleId"),
                )
                assertEquals(
                    releaseB,
                    transition.getJSONObject("from").getString("releaseId"),
                )
                assertEquals(
                    bundleC,
                    transition.getJSONObject("to").getString("bundleId"),
                )
                assertEquals(
                    releaseC,
                    transition.getJSONObject("to").getString("releaseId"),
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun rollbackReportsRevokedConfirmedReleaseAsItsHistoricalOrigin() {
        val root = temp()
        val releaseA = "01900000-0000-7000-8000-000000000110"
        try {
            controller(root).close()
            plantNext(root, releaseC, bundleC, "C")
            withController(root) { initial ->
                initial.pinPrimary().also { it.firstScreen = true; initial.confirm(it) }
            }
            // Each replacement catalog contains only the rollback target.
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { rollback ->
                val session = rollback.pinPrimary().also { it.firstScreen = true }
                val id = journal(root).getJSONObject("launchTransition").getString("transitionId")
                val confirmation = rollback.confirm(session)
                val transition = confirmation.getJSONObject("transition")
                assertEquals("UPDATE_APPLIED", transition.getString("kind"))
                assertEquals(bundleC, transition.getJSONObject("from").getString("bundleId"))
                assertEquals(releaseC, transition.getJSONObject("from").getString("releaseId"))
                assertEquals(bundleB, transition.getJSONObject("to").getString("bundleId"))
                assertEquals(releaseB, transition.getJSONObject("to").getString("releaseId"))
                assertEquals(id, confirmation.getString("transitionId"))
                assertEquals(JSONObject.NULL, rollback.confirm(session).opt("transition"))
            }
            plantEmbeddedNext(root, releaseA)
            withController(root) { rollback ->
                val session = rollback.pinPrimary().also { it.firstScreen = true }
                val id = journal(root).getJSONObject("launchTransition").getString("transitionId")
                val confirmation = rollback.confirm(session)
                val transition = confirmation.getJSONObject("transition")
                assertEquals("UPDATE_APPLIED", transition.getString("kind"))
                assertEquals(bundleB, transition.getJSONObject("from").getString("bundleId"))
                assertEquals(releaseB, transition.getJSONObject("from").getString("releaseId"))
                assertEquals("EMBEDDED", transition.getJSONObject("to").getString("kind"))
                assertEquals(embeddedId, transition.getJSONObject("to").getString("bundleId"))
                assertEquals(releaseA, transition.getJSONObject("to").getString("releaseId"))
                assertEquals(id, confirmation.getString("transitionId"))
                assertEquals(JSONObject.NULL, rollback.confirm(session).opt("transition"))
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun cohortValidationAndJournalFailureLeaveThePreviousValue() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary()
            controller.setCohort("  0007\ufeff")
            assertEquals("7", controller.state(primary).getString("cohort"))
            val previous = journal(root).toString()

            listOf("", "   ", "with space", "under_score", "0", "1001", "a".repeat(65)).forEach {
                assertThrows(CatalogPolicy.Rejected::class.java) {
                    controller.setCohort(it)
                }
                assertEquals(previous, journal(root).toString())
                assertEquals("7", controller.state(primary).getString("cohort"))
            }

            val stateFile = File(store(root), "state.json")
            val saved = File(root, "saved-cohort-state.json")
            assertTrue(stateFile.renameTo(saved))
            assertTrue(stateFile.mkdir())
            try {
                assertThrows(Throwable::class.java) {
                    controller.setCohort("next-cohort")
                }
            } finally {
                assertTrue(stateFile.deleteRecursively())
                assertTrue(saved.renameTo(stateFile))
            }
            assertEquals("7", controller.state(primary).getString("cohort"))
            controller.close()

            val restarted = controller(root)
            assertEquals("7", restarted.state(restarted.pinPrimary()).getString("cohort"))
            restarted.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun staleStageConsumesEveryPreparedTokenWithoutExhaustingCapacity() =
        kotlinx.coroutines.runBlocking {
            val root = temp()
            try {
                val first = controller(root)
                first.pinPrimary().also {
                    it.firstScreen = true
                    first.confirm(it)
                }
                first.close()
                plantNext(root, releaseB, bundleB, "B")

                val controller = controller(root)
                val primary = controller.pinPrimary().also {
                    it.firstScreen = true
                    controller.confirm(it)
                }
                val updatedCatalog = catalog(releaseC, bundleB)
                    .put("generation", 3)
                    .put("catalogHash", "sha256:" + "b".repeat(64))
                val state = controller.state(primary)
                val guard = controller.accept(
                    primary,
                    JSONObject()
                        .put("catalog", updatedCatalog)
                        .put("expectedRevision", state.getString("revision"))
                        .put("targetChannel", channel)
                        .put("explicitScopeSwitch", false)
                        .put(
                            "selectionContextHash",
                            CatalogPolicy.selectionContextHash(
                                nativeSnapshot(state),
                                scopeKey,
                            ),
                        ),
                )
                val selection = CatalogPolicy.Receipt(
                    "BUNDLE",
                    releaseC,
                    bundleB,
                    guard.getString("catalogId"),
                    guard.getString("scopeKey"),
                    guard.getLong("generation"),
                    guard.getString("catalogHash"),
                    guard.getString("channel"),
                    guard.getString("selectionContextHash"),
                ).toJson()
                val stale = LynxLaunchSession(
                    controller,
                    primary.installation,
                    primary.id,
                    true,
                    primary.launchReleaseId,
                )

                repeat(20) {
                    assertTrue(
                        controller.validate(
                            primary,
                            JSONObject()
                                .put("guard", guard)
                                .put("selection", selection),
                        ).getBoolean("validated"),
                    )
                }

                val fullCapacity = (0 until 16).map {
                    controller.prepare(
                        primary,
                        JSONObject()
                            .put("guard", guard)
                            .put("selection", selection),
                    )
                }
                val capacityError = runCatching {
                    controller.prepare(
                        primary,
                        JSONObject()
                            .put("guard", guard)
                            .put("selection", selection),
                    )
                }.exceptionOrNull()
                assertTrue(
                    capacityError is IllegalStateException &&
                        capacityError.message ==
                        "Too many outstanding preparations",
                )
                fullCapacity.forEach {
                    assertTrue(
                        runCatching {
                            controller.stage(stale, it.getString("preparedId"))
                        }.exceptionOrNull() is CatalogPolicy.Rejected,
                    )
                }

                repeat(20) {
                    val prepared = controller.prepare(
                        primary,
                        JSONObject().put("guard", guard).put("selection", selection),
                    )
                    val error = runCatching {
                        controller.stage(stale, prepared.getString("preparedId"))
                    }.exceptionOrNull()
                    assertTrue(error is CatalogPolicy.Rejected)
                }

                val prepared = controller.prepare(
                    primary,
                    JSONObject().put("guard", guard).put("selection", selection),
                )
                assertEquals(
                    "ADOPTED",
                    controller.stage(primary, prepared.getString("preparedId"))
                        .getString("status"),
                )
                val confirmation = controller.confirm(primary)
                assertEquals("ALREADY_CONFIRMED", confirmation.getString("status"))
                val transition = confirmation.getJSONObject("transition")
                assertEquals("UNCHANGED", transition.getString("kind"))
                assertEquals(
                    bundleB,
                    transition.getJSONObject("from").getString("bundleId"),
                )
                assertEquals(
                    releaseB,
                    transition.getJSONObject("from").getString("releaseId"),
                )
                assertEquals(
                    bundleB,
                    transition.getJSONObject("to").getString("bundleId"),
                )
                assertEquals(
                    releaseC,
                    transition.getJSONObject("to").getString("releaseId"),
                )
                assertTrue(confirmation.getString("transitionId").isNotEmpty())
                assertEquals(
                    JSONObject.NULL,
                    controller.confirm(primary).opt("transition"),
                )
                controller.close()
            } finally {
                root.deleteRecursively()
            }
        }

    @Test fun malformedInterruptedStateCannotSilentlyReenableARelease() {
        val validRecord = JSONObject().put("bundleId", bundleB).put("retryReady", true)
            .put("holdProcessToken", "10000000-0000-4000-8000-000000000001")
        val malformed = listOf<Any>(
            "not-an-object",
            JSONObject().put(releaseB, JSONObject(validRecord.toString()).put("holdProcessToken", "invalid")),
            JSONObject().put(releaseB, JSONObject(validRecord.toString()).put("retryReady", "true")),
        )
        for (value in malformed) {
            val root = temp()
            try {
                withController(root) { }
                val state = journal(root).put("interruptedReleases", value)
                val file = File(store(root), "state.json")
                file.writeText(state.toString())
                assertThrows(Exception::class.java) { controller(root) }
                assertEquals(state.toString(), file.readText())
                state.remove("interruptedReleases")
                file.writeText(state.toString())
                // Rejection must release ownership so repaired state can open.
                withController(root) { it.pinPrimary() }
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun recoveryReservesTheInterruptedReleaseBeforeChoosingAnotherCandidate() {
        val root = temp()
        try {
            withController(root) { initial ->
                val session = initial.pinPrimary()
                session.firstScreen = true
                initial.confirm(session)
            }
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { it.pinPrimary() }
            plantNext(root, releaseC, bundleC, "C")
            val persisted = journal(root)
            persisted.put("unconfirmed", JSONArray((1..127).map { "01900000-0000-7000-8000-%012d".format(1000 + it) }))
            File(store(root), "state.json").writeText(persisted.toString())
            withController(root) { recovery ->
                val session = recovery.pinPrimary()
                assertEquals(embeddedId, session.installation.bundleId)
                session.firstScreen = true
                val transition = recovery.confirm(session).getJSONObject("transition")
                assertEquals(bundleB, transition.getJSONObject("from").getString("bundleId"))
                assertEquals(embeddedId, transition.getJSONObject("to").getString("bundleId"))
                assertEquals(128, recovery.state(session).getJSONArray("unconfirmedReleaseIds").length())
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun fatalRepublishedBytesPermanentlySuppressOlderInterruptedReleases() {
        val root = temp()
        try {
            withController(root) { it.pinPrimary() }
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { it.pinPrimary() }
            withController(root) { it.pinPrimary() }
            plantNext(root, releaseC, bundleB, "B")
            withController(root) { trial ->
                val session = trial.pinPrimary()
                assertEquals(bundleB, session.installation.bundleId)
                trial.fail(session, "verified fatal republished bundle")
            }
            withController(root) { recovery ->
                val state = recovery.state(recovery.pinPrimary())
                assertEquals(setOf(releaseB, releaseC), jsonStrings(state.getJSONArray("unconfirmedReleaseIds")).toSet())
                assertEquals(listOf(bundleB), jsonStrings(state.getJSONArray("crashedBundleIds")))
                assertEquals(0, journal(root).optJSONObject("interruptedReleases")?.length() ?: 0)
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun interruptedPrimaryRetriesOnlyAfterReadyFallbackAndANewProcess() {
        assertInterruptedPrimaryRetry(retryConfirms = true)
    }

    @Test fun secondInterruptedPrimaryBecomesPermanent() {
        assertInterruptedPrimaryRetry(retryConfirms = false)
    }

    private fun assertInterruptedPrimaryRetry(retryConfirms: Boolean) {
        val root = temp()
        val p1 = java.util.UUID.randomUUID().toString()
        val p2 = java.util.UUID.randomUUID().toString()
        val p3 = java.util.UUID.randomUUID().toString()
        val p4 = java.util.UUID.randomUUID().toString()
        try {
            controller(root, p1).also { initial ->
                val session = initial.pinPrimary()
                session.firstScreen = true
                initial.confirm(session)
                initial.close()
            }
            plantNext(root, releaseB, bundleB, "B")
            controller(root, p1).also { trial ->
                assertEquals(bundleB, trial.pinPrimary().installation.bundleId)
                trial.close()
            }
            // Recovery itself can be interrupted before its fallback is ready.
            controller(root, p2).also { recovery ->
                val session = recovery.pinPrimary()
                assertEquals(embeddedId, session.installation.bundleId)
                assertThrows(IllegalStateException::class.java) { recovery.confirm(session) }
                assertFalse(journal(root).getJSONObject("interruptedReleases")
                    .getJSONObject(releaseB).getBoolean("retryReady"))
                recovery.close()
            }
            controller(root, p3).also { recovery ->
                val session = recovery.pinPrimary()
                assertEquals(listOf(releaseB), jsonStrings(recovery.state(session).getJSONArray("unconfirmedReleaseIds")))
                session.firstScreen = true
                recovery.confirm(session)
                val record = journal(root).getJSONObject("interruptedReleases").getJSONObject(releaseB)
                assertTrue(record.getBoolean("retryReady"))
                assertEquals(p3, record.getString("holdProcessToken"))
                val revision = recovery.state(session).getString("revision")
                recovery.confirm(session)
                assertEquals(revision, recovery.state(session).getString("revision"))
                assertEquals(0, recovery.state(session).getJSONArray("crashedBundleIds").length())
                recovery.close()
            }
            plantNext(root, releaseB, bundleB, "B")
            controller(root, p3).also { recreated ->
                val session = recreated.pinPrimary()
                assertEquals(embeddedId, session.installation.bundleId)
                assertEquals(listOf(releaseB), jsonStrings(recreated.state(session).getJSONArray("unconfirmedReleaseIds")))
                recreated.close()
            }
            plantNext(root, releaseB, bundleB, "B")
            controller(root, p4).also { retry ->
                val session = retry.pinPrimary()
                assertEquals(bundleB, session.installation.bundleId)
                assertEquals(emptyList<String>(), jsonStrings(retry.state(session).getJSONArray("unconfirmedReleaseIds")))
                if (retryConfirms) {
                    session.firstScreen = true
                    retry.confirm(session)
                    assertFalse(journal(root).has("interruptedReleases"))
                }
                retry.close()
            }
            controller(root, java.util.UUID.randomUUID().toString()).also { after ->
                val session = after.pinPrimary()
                assertEquals(if (retryConfirms) bundleB else embeddedId, session.installation.bundleId)
                assertEquals(if (retryConfirms) emptyList<String>() else listOf(releaseB),
                    jsonStrings(after.state(session).getJSONArray("unconfirmedReleaseIds")))
                assertEquals(0, after.state(session).getJSONArray("crashedBundleIds").length())
                assertFalse(journal(root).optJSONObject("interruptedReleases")?.has(releaseB) ?: false)
                after.close()
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun unconfirmedBThenCCannotReenableB() {
        val root = temp()
        try {
            val first = controller(root)
            val primary = first.pinPrimary()
            primary.firstScreen = true
            first.confirm(primary)
            first.close()
            plantNext(root, releaseB, bundleB, "B")
            val trialB = controller(root)
            val sessionB = trialB.pinPrimary()
            assertEquals(bundleB, trialB.state(sessionB).getJSONObject("runningSelection").getString("bundleId"))
            trialB.close()
            val afterB = controller(root)
            val recoveredB = afterB.state(afterB.pinPrimary())
            assertEquals(embeddedId, recoveredB.getJSONObject("runningSelection").getString("bundleId"))
            assertEquals(listOf(releaseB), (0 until recoveredB.getJSONArray("unconfirmedReleaseIds").length()).map {
                recoveredB.getJSONArray("unconfirmedReleaseIds").getString(it)
            })
            afterB.close()
            plantNext(root, releaseC, bundleC, "C")
            val trialC = controller(root)
            val sessionC = trialC.pinPrimary()
            assertEquals(bundleC, trialC.state(sessionC).getJSONObject("runningSelection").getString("bundleId"))
            trialC.close()
            val afterC = controller(root)
            val recoveredC = afterC.state(afterC.pinPrimary())
            assertEquals(embeddedId, recoveredC.getJSONObject("runningSelection").getString("bundleId"))
            assertEquals(setOf(releaseB, releaseC), (0 until recoveredC.getJSONArray("unconfirmedReleaseIds").length()).map {
                recoveredC.getJSONArray("unconfirmedReleaseIds").getString(it)
            }.toSet())
            assertEquals(0, recoveredC.getJSONArray("crashedBundleIds").length())
            afterC.close()
            plantNext(root, releaseB, bundleB, "B")
            val retryB = controller(root)
            val stillEmbedded = retryB.state(retryB.pinPrimary())
            assertEquals(embeddedId, stillEmbedded.getJSONObject("runningSelection").getString("bundleId"))
            assertEquals(setOf(releaseB, releaseC), (0 until stillEmbedded.getJSONArray("unconfirmedReleaseIds").length()).map {
                stillEmbedded.getJSONArray("unconfirmedReleaseIds").getString(it)
            }.toSet())
            retryB.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun fatalPendingSuppressesReleaseAndRecordsBundleCrash() {
        val root = temp()
        try {
            val first = controller(root)
            val primary = first.pinPrimary()
            primary.firstScreen = true
            first.confirm(primary)
            first.close()
            plantNext(root, releaseB, bundleB, "B")
            val trial = controller(root)
            val session = trial.pinPrimary()
            assertEquals(bundleB, trial.state(session).getJSONObject("runningSelection").getString("bundleId"))
            trial.fail(session, "fatal template")
            trial.close()
            val recovered = controller(root)
            val state = recovered.state(recovered.pinPrimary())
            assertEquals(listOf(bundleB), (0 until state.getJSONArray("crashedBundleIds").length()).map {
                state.getJSONArray("crashedBundleIds").getString(it)
            })
            assertEquals(
                listOf(releaseB),
                (0 until state.getJSONArray("unconfirmedReleaseIds").length())
                    .map { state.getJSONArray("unconfirmedReleaseIds").getString(it) },
            )
            assertEquals(embeddedId, state.getJSONObject("runningSelection").getString("bundleId"))
            recovered.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun failedBetaCandidateRecoversConfirmedProductionCatalogAndChannel() {
        val root = temp()
        try {
            val initial = controller(root)
            initial.pinPrimary().also {
                it.firstScreen = true
                initial.confirm(it)
            }
            initial.close()
            plantNext(root, releaseB, bundleB, "B")
            val production = controller(root)
            production.pinPrimary().also {
                it.firstScreen = true
                production.confirm(it)
            }
            production.close()

            val beta = "beta"
            val betaScope =
                "v1:app-version:android:${CatalogPolicy.channelKey(beta)}"
            plantNext(
                root,
                releaseC,
                bundleC,
                "C",
                selectionChannel = beta,
                selectionCatalogId = "lynx-beta",
                selectionScope = betaScope,
                generation = 1,
                hash = "sha256:" + "e".repeat(64),
            )
            val candidate = controller(root)
            val candidateSession = candidate.pinPrimary()
            assertEquals(bundleC, candidate.diagnostics(candidateSession).bundleId)
            assertTrue(candidate.fail(candidateSession, "beta failed"))
            candidate.close()

            val recovered = controller(root)
            val recoveredSession = recovered.pinPrimary()
            assertEquals(bundleB, recovered.diagnostics(recoveredSession).bundleId)
            assertEquals(channel, recovered.state(recoveredSession).getString("channel"))
            recoveredSession.firstScreen = true
            val confirmation = recovered.confirm(recoveredSession)
            assertEquals("ALREADY_CONFIRMED", confirmation.getString("status"))
            val transition = confirmation.getJSONObject("transition")
            assertEquals("RECOVERED", transition.getString("kind"))
            assertEquals(
                bundleC,
                transition.getJSONObject("from").getString("bundleId"),
            )
            assertEquals(
                bundleB,
                transition.getJSONObject("to").getString("bundleId"),
            )
            assertEquals(
                JSONObject.NULL,
                recovered.confirm(recoveredSession).opt("transition"),
            )
            recovered.close()
            val later = controller(root)
            val laterSession = later.pinPrimary().also { it.firstScreen = true }
            assertEquals(
                JSONObject.NULL,
                later.confirm(laterSession).opt("transition"),
            )
            later.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun failPersistsCrashedIdentityAndRecordsOnlyOnce() {
        val root = temp()
        try {
            val first = controller(root)
            val confirmed = first.pinPrimary()
            confirmed.firstScreen = true
            first.confirm(confirmed)
            first.close()
            plantNext(root, releaseB, bundleB, "B")
            val controller = controller(root)
            val primary = controller.pinPrimary()
            assertTrue(controller.fail(primary, "fatal template"))
            val persisted = journal(root)
            assertTrue(persisted.getJSONObject("pending").getBoolean("fatal"))
            assertEquals(bundleB, persisted.getJSONArray("crashed").getString(0))
            assertFalse(persisted.has("confirmed") && persisted.getJSONObject("confirmed").optString("bundleId") == bundleB)
            assertFalse(controller.fail(primary, "duplicate error"))
            assertEquals(persisted.toString(), journal(root).toString())
            controller.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun fatalStateWriteFailureDoesNotMarkTheSessionAndCanRetry() {
        val root = temp()
        try {
            val first = controller(root)
            first.pinPrimary().also {
                it.firstScreen = true
                first.confirm(it)
            }
            first.close()
            plantNext(root, releaseB, bundleB, "B")
            val controller = controller(root)
            val primary = controller.pinPrimary()
            var rejectedReadiness = 0
            primary.notifyReady { if (it.isFailure) rejectedReadiness += 1 }
            assertEquals(0, rejectedReadiness)
            val stateFile = File(store(root), "state.json")
            val saved = File(root, "saved-fatal-state.json")
            assertTrue(stateFile.renameTo(saved))
            assertTrue(stateFile.mkdir())
            try {
                assertThrows(Throwable::class.java) {
                    controller.fail(primary, "failed write")
                }
            } finally {
                assertTrue(stateFile.deleteRecursively())
                assertTrue(saved.renameTo(stateFile))
            }

            assertFalse(primary.failed)
            primary.flushReady()
            assertEquals(1, rejectedReadiness)
            primary.notifyReady { if (it.isFailure) rejectedReadiness += 1 }
            assertEquals(2, rejectedReadiness)
            primary.firstScreen = true
            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.confirm(primary)
            }
            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.pinSecondary("detail.lynx.bundle", emptyMap(), 1, primary.generationId)
            }
            assertTrue(controller.fail(primary, "retry"))
            assertTrue(primary.failed)
            assertTrue(journal(root).getJSONObject("pending").getBoolean("fatal"))
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun secondaryFatalStateWriteFailureKeepsThePendingAttemptRetryable() {
        val root = temp()
        try {
            val controller = controller(root)
            val primary = controller.pinPrimary(generationId = "generation-a")
            primary.firstScreen = true
            controller.confirm(primary)
            val detail = controller.pinSecondary(
                "detail.lynx.bundle",
                mapOf("title" to "Pending"),
                1,
                "generation-a",
            )
            var rejectedReadiness = 0
            detail.notifyReady { if (it.isFailure) rejectedReadiness += 1 }
            assertEquals(0, rejectedReadiness)
            val stateFile = File(store(root), "state.json")
            val saved = File(root, "saved-secondary-fatal-state.json")
            assertTrue(stateFile.renameTo(saved))
            assertTrue(stateFile.mkdir())
            try {
                assertThrows(Throwable::class.java) {
                    controller.fail(detail, "failed write")
                }
            } finally {
                assertTrue(stateFile.deleteRecursively())
                assertTrue(saved.renameTo(stateFile))
            }

            assertFalse(detail.failed)
            detail.flushReady()
            assertEquals(1, rejectedReadiness)
            detail.notifyReady { if (it.isFailure) rejectedReadiness += 1 }
            primary.notifyReady { if (it.isFailure) rejectedReadiness += 1 }
            assertEquals(3, rejectedReadiness)
            detail.firstScreen = true
            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.admitSecondary(detail)
            }
            assertThrows(CatalogPolicy.Rejected::class.java) {
                controller.primaryAdmissionReady(primary)
            }
            assertEquals(
                detail.id,
                journal(root).getJSONObject("pageAttempt")
                    .getString("attemptId"),
            )
            assertTrue(controller.fail(detail, "retry"))
            assertTrue(detail.failed)
            assertFalse(journal(root).has("pageAttempt"))
            assertEquals(
                "verified-fatal",
                journal(root).getJSONObject("lastPageAttempt")
                    .getString("terminal"),
            )
            controller.close()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun failedConfirmedFallbackAdvancesToEmbeddedRecovery() {
        val root = temp()
        try {
            withController(root) { initial ->
                val primary = initial.pinPrimary()
                primary.firstScreen = true
                initial.confirm(primary)
            }
            plantNext(root, releaseB, bundleB, "B")
            withController(root) { candidateB ->
                val primary = candidateB.pinPrimary()
                assertEquals(bundleB, candidateB.diagnostics(primary).bundleId)
                primary.firstScreen = true
                candidateB.confirm(primary)
            }
            plantNext(root, releaseC, bundleC, "C")
            val retained = journal(root)
            val retainedCatalog = catalog(releaseC, bundleC)
            retainedCatalog.getJSONArray("rollbackReleases").put(
                catalog(releaseB, bundleB).getJSONArray("releases").getJSONObject(0),
            )
            retained.put("catalog", retainedCatalog.toString())
            retained.getJSONObject("catalogs").put(
                digestString("$catalogId\u0000$scopeKey"),
                retainedCatalog.toString(),
            )
            File(store(root), "state.json").writeText(retained.toString())
            withController(root) { candidateC ->
                val primary = candidateC.pinPrimary()
                assertEquals(bundleC, candidateC.diagnostics(primary).bundleId)
                assertTrue(candidateC.fail(primary, "C failed"))
            }
            withController(root) { confirmedFallback ->
                val primary = confirmedFallback.pinPrimary()
                assertEquals(bundleB, confirmedFallback.diagnostics(primary).bundleId)
                assertTrue(primary.recordGenerationFailure("B reconstruction failed"))
            }
            withController(root) { embeddedFallback ->
                val primary = embeddedFallback.pinPrimary()
                assertEquals(embeddedId, embeddedFallback.diagnostics(primary).bundleId)
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun staleContextWithoutPendingAuthorityCannotRecordFatalFailure() {
        for (scenario in listOf("destroyed", "confirmed", "unrelated")) {
            val root = temp()
            try {
                controller(root).close()
                plantNext(root, releaseB, bundleB, "B")
                val controller = controller(root)
                try {
                    val primary = controller.pinPrimary()
                    val failedContext = when (scenario) {
                        "destroyed" -> primary.also { controller.destroy(it) }
                        "confirmed" -> primary.also { it.firstScreen = true; controller.confirm(it) }
                        else -> LynxLaunchSession(
                            controller,
                            primary.installation,
                            primary.id,
                            true,
                            null,
                        )
                    }
                    val previous = journal(root).toString()
                    assertFalse(controller.fail(failedContext, "late $scenario error"))
                    assertEquals(scenario, previous, journal(root).toString())
                    assertFalse(scenario, primary.failed)
                } finally { controller.close() }
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun capacityKeepsConfirmedBuiltinInsteadOfStartingAnotherUnconfirmedCandidate() {
        val root = temp()
        try {
            val first = controller(root)
            val primary = first.pinPrimary()
            primary.firstScreen = true
            first.confirm(primary)
            first.close()
            val file = File(store(root), "state.json")
            val state = JSONObject(file.readText())
            val excluded = JSONArray()
            repeat(128) { index ->
                excluded.put("01900000-0000-7000-8000-" + String.format("%012x", 1000 + index))
            }
            assertFalse(jsonStrings(excluded).contains(releaseB))
            state.put("unconfirmed", excluded)
            file.writeText(state.toString())
            plantNext(root, releaseB, bundleB, "B")
            val recovered = controller(root)
            val snapshot = recovered.state(recovered.pinPrimary())
            assertEquals(embeddedId, snapshot.getJSONObject("runningSelection").getString("bundleId"))
            assertEquals(true, snapshot.getBoolean("runningConfirmed"))
            assertEquals(128, snapshot.getJSONArray("unconfirmedReleaseIds").length())
            recovered.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun confirmedOtaNeverExceedsRecoveryCapacity() {
        for (historySize in listOf(127, 128)) {
            val root = temp()
            try {
                withController(root) { first ->
                    first.pinPrimary().also { it.firstScreen = true; first.confirm(it) }
                }
                plantNext(root, releaseB, bundleB, "B")
                withController(root) { trial ->
                    trial.pinPrimary().also { it.firstScreen = true; trial.confirm(it) }
                }
                val file = File(store(root), "state.json")
                val state = JSONObject(file.readText())
                assertEquals(releaseB, state.getJSONObject("confirmed").getString("releaseId"))
                val excluded = (0 until historySize).map {
                    "01900000-0000-7000-8000-" + String.format("%012x", 1000 + it)
                }
                assertFalse(excluded.contains(releaseB))
                state.put("unconfirmed", JSONArray(excluded))
                file.writeText(state.toString())
                withController(root) { restarted ->
                    val page = restarted.pinPrimary()
                    assertEquals(if (historySize == 127) bundleB else embeddedId, restarted.diagnostics(page).bundleId)
                    assertEquals(excluded, jsonStrings(restarted.state(page).getJSONArray("unconfirmedReleaseIds")))
                    if (historySize == 127) {
                        assertTrue(restarted.fail(page, "confirmed fatal", allowConfirmed = true))
                        assertEquals(excluded + releaseB, jsonStrings(journal(root).getJSONArray("unconfirmed")))
                    }
                }
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun pinPrimaryFallsBackToBuiltinWhenPersistedCatalogScopeDoesNotMatch() {
        val root = temp()
        try {
            val first = controller(root)
            val primary = first.pinPrimary()
            primary.firstScreen = true
            first.confirm(primary)
            first.close()
            plantNext(root, releaseB, bundleB, "B")
            val file = File(store(root), "state.json")
            val state = JSONObject(file.readText())
            val otherScope = "v1:app-version:android:YmV0YQ"
            val catalog = JSONObject(state.getString("catalog"))
                .put("scopeKey", otherScope)
            state.put("catalog", catalog.toString())
            state.getJSONObject("catalogs").put(
                digestString("$catalogId\u0000$scopeKey"),
                catalog.toString(),
            )
            file.writeText(state.toString())
            val recovered = controller(root)
            val snapshot = recovered.state(recovered.pinPrimary())
            assertEquals(embeddedId, snapshot.getJSONObject("runningSelection").getString("bundleId"))
            recovered.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun journalWriteFailureLeavesThePreviousPersistedSelection() {
        val root = temp()
        try {
            val directory = File(root, "journal")
            val store = LynxStateStore(directory)
            store.update { it.put("marker", "confirmed") }
            val original = File(directory, "state.json").readBytes()
            val disk = File(directory, "state.json")
            val saved = File(directory, "saved.json")
            assertTrue(disk.renameTo(saved))
            assertTrue(disk.mkdir())
            try {
                store.update { it.put("pending", "candidate") }
                fail("Journal replace should fail when the destination is a directory")
            } catch (_: Throwable) {}
            assertFalse(store.value.has("pending"))
            assertEquals("confirmed", store.value.getString("marker"))
            assertTrue(disk.delete())
            assertTrue(saved.renameTo(disk))
            assertTrue(disk.readBytes().contentEquals(original))
        } finally { root.deleteRecursively() }
    }

    @Test fun acceptKeepsHighWaterPerCatalogScopeAfterChannelSwitch() {
        val root = temp()
        try {
            val controller = controller(root)
            val session = controller.pinPrimary()
            val production = catalog(releaseB, bundleB)
            val before = controller.state(session)
            controller.accept(
                session,
                JSONObject()
                    .put("catalog", production)
                    .put("expectedRevision", before.getString("revision"))
                    .put("targetChannel", channel)
                    .put("explicitScopeSwitch", false)
                    .put(
                        "selectionContextHash",
                        CatalogPolicy.selectionContextHash(
                            nativeSnapshot(before),
                            scopeKey,
                        ),
                    ),
            )
            controller.setChannel("beta")
            val betaScope = "v1:app-version:android:${CatalogPolicy.channelKey("beta")}"
            val betaCatalog = catalog(releaseC, bundleC)
                .put("catalogId", "lynx-beta")
                .put("scopeKey", betaScope)
            val after = controller.state(session)
            val guard = controller.accept(
                session,
                JSONObject()
                    .put("catalog", betaCatalog)
                    .put("expectedRevision", after.getString("revision"))
                    .put("targetChannel", "beta")
                    .put("explicitScopeSwitch", false)
                    .put(
                        "selectionContextHash",
                        CatalogPolicy.selectionContextHash(
                            nativeSnapshot(after),
                            betaScope,
                        ),
                    ),
            )
            assertEquals("lynx-beta", guard.getString("catalogId"))
            assertEquals(betaScope, guard.getString("scopeKey"))
            val journal = journal(root)
            assertTrue(journal.getJSONObject("highWaters").length() >= 2)
            controller.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun explicitChannelSwitchCommitsOnlyWithSelectionAndCanRetryFailure() =
        kotlinx.coroutines.runBlocking {
            val root = temp()
            try {
                val controller = controller(root)
                val primary = controller.pinPrimary().also {
                    it.firstScreen = true
                    controller.confirm(it)
                }
                val targetChannel = "beta"
                val targetScope =
                    "v1:app-version:android:${CatalogPolicy.channelKey(targetChannel)}"
                val targetHash = "sha256:" + "d".repeat(64)
                val descriptor = JSONObject()
                    .put("releaseId", releaseB)
                    .put("kind", "EMBEDDED")
                    .put("bundleId", JSONObject.NULL)
                    .put("rolloutCohortCount", 1000)
                    .put("targetCohorts", JSONArray())
                    .put("shouldForceUpdate", false)
                    .put("message", JSONObject.NULL)
                val targetCatalog = JSONObject()
                    .put("schemaVersion", 1)
                    .put("catalogId", "lynx-beta")
                    .put("scopeKey", targetScope)
                    .put("generation", 1)
                    .put("catalogHash", targetHash)
                    .put(
                        "fallbackPolicy",
                        "BUILTIN_IF_ACTIVE_INELIGIBLE",
                    )
                    .put("releases", JSONArray().put(descriptor))
                val before = controller.state(primary)
                val projected = projectedSwitchSnapshot(before, targetChannel)
                val contextHash = CatalogPolicy.selectionContextHash(
                    projected,
                    targetScope,
                )
                val guard = controller.accept(
                    primary,
                    JSONObject()
                        .put("catalog", targetCatalog)
                        .put("expectedRevision", before.getString("revision"))
                        .put("selectionContextHash", contextHash)
                        .put("targetChannel", targetChannel)
                        .put("explicitScopeSwitch", true),
                )
                val selection = CatalogPolicy.Receipt(
                    "EMBEDDED",
                    releaseB,
                    embeddedId,
                    "lynx-beta",
                    targetScope,
                    1,
                    targetHash,
                    targetChannel,
                    contextHash,
                ).toJson()
                val params = JSONObject()
                    .put("guard", guard)
                    .put("selection", selection)

                val failedPreparation = controller.prepare(primary, params)
                val stateFile = File(store(root), "state.json")
                val saved = File(root, "saved-channel-state.json")
                assertTrue(stateFile.renameTo(saved))
                assertTrue(stateFile.mkdir())
                val failure = try {
                    runCatching {
                        controller.stage(
                            primary,
                            failedPreparation.getString("preparedId"),
                        )
                    }.exceptionOrNull()
                } finally {
                    assertTrue(stateFile.deleteRecursively())
                    assertTrue(saved.renameTo(stateFile))
                }
                assertTrue(failure != null)
                assertEquals(channel, controller.state(primary).getString("channel"))
                assertEquals(
                    JSONObject.NULL,
                    controller.state(primary).opt("nextSelection"),
                )

                val retry = controller.prepare(primary, params)
                assertEquals(
                    "STAGED",
                    controller.stage(primary, retry.getString("preparedId"))
                        .getString("status"),
                )
                val switched = controller.state(primary)
                assertEquals(targetChannel, switched.getString("channel"))
                assertEquals(
                    targetChannel,
                    switched.getJSONObject("nextSelection").getString("channel"),
                )

                val rejected = assertThrows(CatalogPolicy.Rejected::class.java) {
                    controller.accept(
                        primary,
                        JSONObject()
                            .put("catalog", targetCatalog)
                            .put(
                                "expectedRevision",
                                switched.getString("revision"),
                            )
                            .put("selectionContextHash", contextHash)
                            .put("targetChannel", "gamma")
                            .put("explicitScopeSwitch", true),
                    )
                }
                assertEquals("CHANNEL_ALREADY_SWITCHED", rejected.code)
                controller.close()

                val betaController = controller(root)
                val betaSession = betaController.pinPrimary().also {
                    it.firstScreen = true
                }
                assertEquals(
                    targetChannel,
                    betaController.state(betaSession).getString("channel"),
                )
                betaController.confirm(betaSession)
                assertTrue(betaController.resetChannel())
                val reset = betaController.state(betaSession)
                assertEquals(channel, reset.getString("channel"))
                assertEquals(JSONObject.NULL, reset.opt("nextSelection"))
                assertEquals(JSONObject.NULL, reset.opt("confirmedSelection"))
                betaController.close()

                val defaultController = controller(root)
                val defaultSession = defaultController.pinPrimary()
                assertEquals(
                    embeddedId,
                    defaultController.diagnostics(defaultSession).bundleId,
                )
                assertEquals(
                    channel,
                    defaultController.state(defaultSession).getString("channel"),
                )
                defaultController.close()
            } finally {
                root.deleteRecursively()
            }
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
            jsonStrings(state.getJSONArray("crashedBundleIds")),
            jsonStrings(state.getJSONArray("unconfirmedReleaseIds")),
            state.optString("fingerprintHash").takeIf { it.isNotEmpty() },
        )
    }

    private fun projectedSwitchSnapshot(
        state: JSONObject,
        targetChannel: String,
    ) = CatalogPolicy.NativeSnapshot(
        state.getString("revision"),
        state.getString("appVersion"),
        targetChannel,
        state.getString("runtimeId"),
        state.getString("embeddedBundleId"),
        state.getString("minimumBundleId"),
        state.getString("cohort"),
        CatalogPolicy.Receipt(
            "BUILTIN",
            null,
            state.getString("minimumBundleId"),
            null,
            null,
            null,
            null,
            targetChannel,
            null,
        ),
        null,
        jsonStrings(state.getJSONArray("crashedBundleIds")),
        jsonStrings(state.getJSONArray("unconfirmedReleaseIds")),
        state.optString("fingerprintHash").takeIf { it.isNotEmpty() },
    )

    private fun jsonStrings(array: JSONArray) =
        (0 until array.length()).map { array.getString(it) }

    private fun JSONArray.objects() =
        (0 until length()).map { getJSONObject(it) }
}
