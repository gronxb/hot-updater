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

    private fun embedded(root: File): VerifiedLynxInstallation {
        val directory = File(root, "embedded").apply { mkdirs() }
        val entry = File(directory, "main.lynx.bundle").apply {
            writeText("entry-A")
        }
        val detail = File(directory, "detail.lynx.bundle").apply {
            writeText("detail-A")
        }
        return VerifiedLynxInstallation(
            embeddedId, directory, "main.lynx.bundle", runtime, "e".repeat(64),
            mapOf(
                "main.lynx.bundle" to HashUtils.calculateSHA256(entry),
                "detail.lynx.bundle" to HashUtils.calculateSHA256(detail),
            ),
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

    private fun controller(root: File) =
        LynxUpdaterController(
            root,
            binary(root),
            embedded(root),
            config(),
            processIdentity = { "4321" },
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

    private fun writeTree(payload: File, bundleId: String, marker: String): String {
        val root = payload.canonicalFile
        root.mkdirs()
        val files = mapOf(
            "detail.lynx.bundle" to "detail-$marker".toByteArray(),
            "main.lynx.bundle" to "entry-$marker".toByteArray(),
            "assets/probe.png" to byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47),
            "hot-updater-lynx.json" to JSONObject()
                .put("schemaVersion", 1).put("bundleId", bundleId).put("platform", "android")
                .put("entry", "main.lynx.bundle").put("runtimeId", runtime)
                .put(
                    "pageEntries",
                    JSONArray().put("detail.lynx.bundle").put("main.lynx.bundle"),
                )
                .put(
                    "pageEssentialResources",
                    JSONArray()
                        .put(
                            JSONObject()
                                .put("entry", "detail.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray().put("detail.lynx.bundle"),
                                ),
                        )
                        .put(
                            JSONObject()
                                .put("entry", "main.lynx.bundle")
                                .put(
                                    "resources",
                                    JSONArray().put("main.lynx.bundle"),
                                ),
                        ),
                )
                .toString().toByteArray(),
        )
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
    ) {
        val home = store(root)
        val install = File(home, "artifacts/installations/$bundleId").canonicalFile
        val payload = File(install, "payload")
        val digest = writeTree(payload, bundleId, marker)
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

            val malformed = journal(root)
            malformed.getJSONObject("launchTransition").put("transitionId", "")
            stateFile.writeText(malformed.toString())
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
                .put("transitionId", "launch-id")
            mismatched.put(
                "managedTransition",
                JSONObject().put("transitionId", "managed-id"),
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
            assertFalse(journal(root).has("managedTransition"))
            freshDetail.close()
            fresh.close()
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
                excluded.put("01900000-0000-7000-8000-" + String.format("%012x", 200 + index))
            }
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
