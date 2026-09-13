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
    private val runtime = "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2"
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
        return VerifiedLynxInstallation(
            embeddedId, directory, "main.lynx.bundle", runtime, "e".repeat(64),
            mapOf("main.lynx.bundle" to HashUtils.calculateSHA256(entry)),
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
        LynxUpdaterController(root, binary(root), embedded(root), config())

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
            "main.lynx.bundle" to "entry-$marker".toByteArray(),
            "assets/probe.png" to byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47),
            "hot-updater-lynx.json" to JSONObject()
                .put("schemaVersion", 1).put("bundleId", bundleId).put("platform", "android")
                .put("entry", "main.lynx.bundle").put("runtimeId", runtime).toString().toByteArray(),
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
            val secondary = controller.pinSecondary()
            assertFalse(secondary.isPrimary)
            val secondaryDiagnostics = controller.diagnostics(secondary)
            assertFalse(secondaryDiagnostics.contextId == primaryDiagnostics.contextId)
            assertEquals(primaryDiagnostics.startupAttemptId, secondaryDiagnostics.startupAttemptId)
            assertEquals(embeddedId, secondaryDiagnostics.bundleId)
            assertEquals(null, secondaryDiagnostics.releaseId)
            val state = controller.state(primary)
            assertEquals(true, state.getBoolean("runningConfirmed"))
            assertEquals(embeddedId, state.getJSONObject("runningSelection").getString("bundleId"))
            controller.close()
        } finally { root.deleteRecursively() }
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

    @Test fun fatalPendingIsCrashedHistoryNotUnconfirmedExclusion() {
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
            assertEquals(0, state.getJSONArray("unconfirmedReleaseIds").length())
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
            assertTrue(controller.fail(primary, "duplicate error"))
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

    @Test fun failedContextWithoutPendingPrimaryAuthorityCannotRecordFatalFailure() {
        for (scenario in listOf("secondary", "destroyed", "confirmed", "unrelated")) {
            val root = temp()
            try {
                controller(root).close()
                plantNext(root, releaseB, bundleB, "B")
                val controller = controller(root)
                try {
                    val primary = controller.pinPrimary()
                    val failedContext = when (scenario) {
                        "secondary" -> controller.pinSecondary()
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
}
