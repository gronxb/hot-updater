package com.hotupdater.lynx

import com.hotupdater.lynx.internal.HashUtils
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        File(directory, "main.lynx.bundle").writeText("entry-A")
        return VerifiedLynxInstallation(
            embeddedId, directory, "main.lynx.bundle", runtime, "embedded-digest",
            setOf("main.lynx.bundle", "hot-updater-lynx.json", "assets/probe.png"),
        )
    }

    private fun config() = LynxHostConfiguration(
        runtimeId = runtime, channel = channel, appVersion = "1.0.0",
        embeddedAssetDirectory = "ota/react/A", cohort = "1",
    )

    private fun controller(root: File) = LynxUpdaterController(root, binary(root), embedded(root), config())

    private fun store(root: File): File = File(root, "hot-updater-lynx/scopes").listFiles()!!.single { it.isDirectory }

    private fun journal(root: File): JSONObject = JSONObject(File(store(root), "state.json").readText())

    private fun catalog(releaseId: String, bundleId: String): JSONObject {
        val descriptor = JSONObject()
            .put("releaseId", releaseId).put("kind", "BUNDLE").put("bundleId", bundleId)
            .put("rolloutCohortCount", 1000).put("targetCohorts", JSONArray())
            .put("shouldForceUpdate", false).put("message", JSONObject.NULL)
        return JSONObject()
            .put("schemaVersion", 1).put("catalogId", catalogId).put("scopeKey", scopeKey)
            .put("generation", 2).put("catalogHash", catalogHash)
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

    private fun plantNext(root: File, releaseId: String, bundleId: String, marker: String) {
        val home = store(root)
        val install = File(home, "artifacts/installations/$bundleId").canonicalFile
        val payload = File(install, "payload")
        val digest = writeTree(payload, bundleId, marker)
        val archive = File(install, "archive").apply { writeText("archive-$marker") }
        val fileHash = HashUtils.calculateSHA256(archive)
        val receipt = JSONObject()
            .put("kind", "BUNDLE").put("releaseId", releaseId).put("bundleId", bundleId)
            .put("catalogId", catalogId).put("scopeKey", scopeKey).put("generation", 2)
            .put("catalogHash", catalogHash).put("channel", channel)
            .put("selectionContextHash", "v1:0123456789abcdef")
        val file = File(home, "state.json")
        val state = JSONObject(file.readText())
        val artifacts = state.optJSONObject("artifacts") ?: JSONObject()
        artifacts.put(
            bundleId,
            JSONObject().put("bundleId", bundleId).put("fileUrl", "http://127.0.0.1/unused")
                .put("fileHash", fileHash).put("manifestFileHash", digest)
                .put("verifiedManifestHash", digest),
        )
        state.put("artifacts", artifacts)
        state.put("catalog", catalog(releaseId, bundleId).toString())
        state.put(
            "highWater",
            JSONObject().put("catalogId", catalogId).put("scopeKey", scopeKey)
                .put("generation", 2).put("catalogHash", catalogHash),
        )
        state.put("next", receipt)
        file.writeText(state.toString())
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
            primary.firstScreen = true
            assertEquals("CONFIRMED", controller.confirm(primary))
            val secondary = controller.pinSecondary()
            assertFalse(secondary.isPrimary)
            val state = controller.state(primary)
            assertEquals(true, state.getBoolean("runningConfirmed"))
            assertEquals(embeddedId, state.getJSONObject("runningSelection").getString("bundleId"))
            controller.close()
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

    @Test fun failPersistsCrashedIdentityBeforeTheProcessExits() {
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
            controller.fail(primary, "fatal template")
            val persisted = journal(root)
            assertTrue(persisted.getJSONObject("pending").getBoolean("fatal"))
            assertEquals(bundleB, persisted.getJSONArray("crashed").getString(0))
            assertFalse(persisted.has("confirmed") && persisted.getJSONObject("confirmed").optString("bundleId") == bundleB)
            controller.close()
        } finally { root.deleteRecursively() }
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
            val catalog = JSONObject(state.getString("catalog")).put("scopeKey", otherScope)
            state.put("catalog", catalog.toString())
            state.getJSONObject("highWater").put("scopeKey", otherScope)
            state.getJSONObject("next").put("channel", "beta").put("scopeKey", otherScope)
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

    private fun jsonStrings(array: JSONArray) =
        (0 until array.length()).map { array.getString(it) }
}
